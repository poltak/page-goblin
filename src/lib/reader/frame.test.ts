import { afterEach, describe, expect, it } from 'vitest'
import { measureChapter } from '$lib/content'
import type { ChapterContent } from '$lib/content/types'
import { STYLE_OFF_ATTR, createFrame } from './frame'
import { createSheet } from './sheets'
import type { HighlightMark } from './types'

function chapter(html: string, spineIndex = 0): ChapterContent {
    const root = document.createElement('rd-html')
    const body = document.createElement('rd-body')
    body.innerHTML = html
    root.appendChild(body)
    const { length, anchors } = measureChapter(body)
    return {
        spineIndex,
        path: `text/${spineIndex}.xhtml`,
        root,
        body,
        styles: [createSheet('p { color: red }')],
        length,
        anchors,
        lang: null,
        dir: null,
        imagesReady: Promise.resolve(),
    }
}

const baseSheet = createSheet('rd-html { display: block }')
const overrideSheet = createSheet('rd-body { margin: 0 }')

function frameFor(content: ChapterContent, publisherStyles = true) {
    const frame = createFrame({ content, baseSheet, overrideSheet, publisherStyles })
    document.body.appendChild(frame.host)
    return frame
}

const HIGHLIGHT: HighlightMark = {
    id: 'a',
    spineIndex: 0,
    start: 4,
    end: 9,
    color: 'yellow',
    hasNote: false,
}

afterEach(() => {
    document.body.innerHTML = ''
})

describe('createFrame', () => {
    it('marks the blocks that have an image and no text', () => {
        const content = chapter(
            '<p class="a"><img alt=""></p>' +
                '<p class="b"><span><a><img alt=""></a></span>\n\u00a0</p>' +
                '<p class="c">Text with <img alt=""> in it.</p>' +
                '<div class="d"><svg></svg><span><div></div></span></div>' +
                '<div class="e"><img alt=""><p>A paragraph in the same block.</p></div>',
        )
        const frame = frameFor(content)
        const marked = [...frame.body.querySelectorAll('[data-rd-media]')].map(
            (element) => element.className,
        )
        expect(marked).toEqual(['a', 'b', 'd'])
        expect(frame.body.hasAttribute('data-rd-media')).toBe(false)
    })

    it('does not mark the chapter body for an image with no block around it', () => {
        const frame = frameFor(chapter('<img alt="">'))
        expect(frame.body.hasAttribute('data-rd-media')).toBe(false)
    })

    it('puts the chapter into an open shadow root of the host', () => {
        const content = chapter('<p>The quick brown fox.</p>')
        const frame = frameFor(content)
        expect(frame.host.localName).toBe('div')
        expect(frame.host.shadowRoot).toBe(frame.shadow)
        expect(content.root.parentNode).toBe(frame.shadow)
        expect(frame.spineIndex).toBe(0)
        expect(frame.host.getAttribute('data-rd-spine')).toBe('0')
        expect(frame.root).toBe(content.root)
        expect(frame.body).toBe(content.body)
    })

    it('gives each frame its own id and contains its layout', () => {
        const one = frameFor(chapter('<p>one</p>'))
        const two = frameFor(chapter('<p>two</p>', 1))
        expect(one.id).not.toBe(two.id)
        expect(one.host.getAttribute('data-rd-frame')).toBe(String(one.id))
        expect(one.host.style.contain).toBe('layout paint')
    })

    it('adopts the base sheet, the book sheets and the override sheet in that order', () => {
        const content = chapter('<p>text</p>')
        const frame = frameFor(content)
        expect(frame.shadow.adoptedStyleSheets).toEqual([
            baseSheet,
            ...content.styles,
            overrideSheet,
        ])
    })

    it('has a text index for the chapter', () => {
        const frame = frameFor(chapter('<p>The quick brown fox.</p>'))
        expect(frame.index.length).toBe(20)
        expect(frame.index.range(4, 9)?.toString()).toBe('quick')
        // The same object until the Text nodes change.
        expect(frame.index).toBe(frame.index)
    })

    it('takes the important flag off the style attributes', () => {
        const content = chapter('<p style="color: red !important; margin-top: 4px">text</p>')
        frameFor(content)
        const style = content.body.querySelector('p')!.style
        expect(style.getPropertyValue('color')).toBe('red')
        expect(style.getPropertyPriority('color')).toBe('')
        expect(style.getPropertyValue('margin-top')).toBe('4px')
    })
})

describe('publisher styles', () => {
    it('leaves out the book sheets and the style attributes when they are off', () => {
        const content = chapter('<p style="color: red">one</p><p>two</p>')
        content.body.setAttribute('style', 'margin: 5px')
        const frame = frameFor(content, false)

        expect(frame.shadow.adoptedStyleSheets).toEqual([baseSheet, overrideSheet])
        const first = content.body.querySelector('p')!
        expect(first.hasAttribute('style')).toBe(false)
        expect(first.getAttribute(STYLE_OFF_ATTR)).toBe('color: red')
        expect(content.body.hasAttribute('style')).toBe(false)
        expect(content.body.getAttribute(STYLE_OFF_ATTR)).toBe('margin: 5px')
        expect(content.body.querySelectorAll(`[${STYLE_OFF_ATTR}]`)).toHaveLength(1)
    })

    it('restores them when the styles are on again', () => {
        const content = chapter('<p style="color: red">one</p>')
        const frame = frameFor(content, false)
        frame.setPublisherStyles(true)

        const first = content.body.querySelector('p')!
        expect(first.getAttribute('style')).toBe('color: red')
        expect(first.hasAttribute(STYLE_OFF_ATTR)).toBe(false)
        expect(frame.shadow.adoptedStyleSheets).toEqual([
            baseSheet,
            ...content.styles,
            overrideSheet,
        ])
    })

    it('can change more than one time', () => {
        const content = chapter('<p style="color: red">one</p>')
        const frame = frameFor(content)
        frame.setPublisherStyles(false)
        frame.setPublisherStyles(false)
        frame.setPublisherStyles(true)
        frame.setPublisherStyles(false)
        expect(content.body.querySelector('p')!.getAttribute(STYLE_OFF_ATTR)).toBe('color: red')
        frame.setPublisherStyles(true)
        expect(content.body.innerHTML).toBe('<p style="color: red">one</p>')
    })
})

describe('highlights', () => {
    it('paints the marks and makes the index again', () => {
        const frame = frameFor(chapter('<p>The quick brown fox.</p>'))
        const before = frame.index
        expect(frame.setHighlights([HIGHLIGHT])).toBe(true)
        expect(frame.body.querySelector('mark.rd-hl')?.textContent).toBe('quick')
        expect(frame.index).not.toBe(before)
        expect(frame.index.length).toBe(20)
    })

    it('does nothing when the highlights of the chapter are the same', () => {
        const frame = frameFor(chapter('<p>The quick brown fox.</p>'))
        frame.setHighlights([HIGHLIGHT])
        const mark = frame.body.querySelector('mark.rd-hl')
        const other = { ...HIGHLIGHT, id: 'b', spineIndex: 5 }
        expect(frame.setHighlights([{ ...HIGHLIGHT }, other])).toBe(false)
        expect(frame.body.querySelector('mark.rd-hl')).toBe(mark)
    })

    it('removes the marks for an empty list', () => {
        const frame = frameFor(chapter('<p>The quick brown fox.</p>'))
        frame.setHighlights([HIGHLIGHT])
        expect(frame.setHighlights([])).toBe(true)
        expect(frame.body.innerHTML).toBe('<p>The quick brown fox.</p>')
    })
})

describe('dispose', () => {
    it('gives the chapter back with no marks, with its styles and with no parent', () => {
        const content = chapter('<p style="color: red">The quick brown fox.</p>')
        const frame = frameFor(content, false)
        frame.setHighlights([HIGHLIGHT])
        const active = document.createElement('mark')
        active.className = 'rd-active'
        const paragraph = content.body.querySelector('p')!
        active.appendChild(paragraph.lastChild!)
        paragraph.appendChild(active)

        frame.dispose()
        expect(content.root.parentNode).toBeNull()
        expect(content.body.innerHTML).toBe('<p style="color: red">The quick brown fox.</p>')
        expect(content.body.querySelector('p')!.childNodes).toHaveLength(1)
        expect(frame.host.isConnected).toBe(false)
        expect(frame.shadow.adoptedStyleSheets).toEqual([])
    })

    it('can run two times and stops later calls', () => {
        const content = chapter('<p>The quick brown fox.</p>')
        const frame = frameFor(content)
        frame.dispose()
        frame.dispose()
        expect(frame.setHighlights([HIGHLIGHT])).toBe(false)
        frame.setPublisherStyles(false)
        expect(content.body.innerHTML).toBe('<p>The quick brown fox.</p>')
    })

    it('does not change a chapter that a new frame took', () => {
        const content = chapter('<p style="color: red">The quick brown fox.</p>')
        const old = frameFor(content)
        old.setHighlights([HIGHLIGHT])

        const next = frameFor(content, false)
        next.setHighlights([{ ...HIGHLIGHT, id: 'new', start: 0, end: 3 }])
        old.dispose()

        expect(content.root.parentNode).toBe(next.shadow)
        expect(content.body.querySelector('mark.rd-hl')?.getAttribute('data-id')).toBe('new')
        expect(content.body.querySelectorAll('mark.rd-hl')).toHaveLength(1)
        expect(content.body.querySelector('p')!.hasAttribute('style')).toBe(false)
    })
})
