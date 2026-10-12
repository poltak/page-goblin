import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureChapter } from '$lib/content'
import type { ChapterContent } from '$lib/content/types'
import { ACTIVE_HIGHLIGHT, SEARCH_HIGHLIGHT, createActiveMarks } from './active'
import { createFrame, type Frame } from './frame'
import { createSheet } from './sheets'

function chapter(html: string, spineIndex: number): ChapterContent {
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
        styles: [],
        length,
        anchors,
        lang: null,
        dir: null,
        imagesReady: Promise.resolve(),
    }
}

const sheet = createSheet('')

function frameFor(html: string, spineIndex: number): Frame {
    const frame = createFrame({
        content: chapter(html, spineIndex),
        baseSheet: sheet,
        overrideSheet: sheet,
        publisherStyles: true,
    })
    document.body.appendChild(frame.host)
    return frame
}

/** The part of the CSS Custom Highlight API that the reader uses. jsdom does not have it. */
class FakeHighlight extends Set<AbstractRange> {
    priority = 0
}

function installHighlightApi(): Map<string, FakeHighlight> {
    const registry = new Map<string, FakeHighlight>()
    vi.stubGlobal('Highlight', FakeHighlight)
    vi.stubGlobal('CSS', { ...globalThis.CSS, highlights: registry })
    return registry
}

function textOf(range: AbstractRange): string {
    const live = document.createRange()
    live.setStart(range.startContainer, range.startOffset)
    live.setEnd(range.endContainer, range.endOffset)
    return live.toString()
}

afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
})

describe('with the highlight API', () => {
    it('registers one highlight for the marker and one for the search', () => {
        const registry = installHighlightApi()
        const marks = createActiveMarks(() => [])
        expect([...registry.keys()].sort()).toEqual([ACTIVE_HIGHLIGHT, SEARCH_HIGHLIGHT])
        // The marker shows on top of a search match.
        expect(registry.get(ACTIVE_HIGHLIGHT)!.priority).toBeGreaterThan(
            registry.get(SEARCH_HIGHLIGHT)!.priority,
        )
        marks.destroy()
        expect(registry.size).toBe(0)
    })

    it('sets the marker range in the frame of its chapter and changes no DOM', () => {
        const registry = installHighlightApi()
        const frames = [
            frameFor('<p>The quick brown fox.</p>', 2),
            frameFor('<p>Other text.</p>', 3),
        ]
        const html = frames[0].body.innerHTML
        const marks = createActiveMarks(() => frames)

        marks.setActive({ spineIndex: 2, start: 4, end: 9 })
        const active = registry.get(ACTIVE_HIGHLIGHT)!
        expect(active.size).toBe(1)
        expect(textOf([...active][0])).toBe('quick')
        expect(frames[0].body.innerHTML).toBe(html)

        marks.setActive({ spineIndex: 2, start: 10, end: 15 })
        expect(active.size).toBe(1)
        expect(textOf([...active][0])).toBe('brown')

        marks.setActive(null)
        expect(active.size).toBe(0)
        marks.destroy()
    })

    it('ends a range in the node that has its last character', () => {
        const registry = installHighlightApi()
        const frames = [frameFor('<p>one <em>two</em> three</p>', 0)]
        const marks = createActiveMarks(() => frames)
        marks.setActive({ spineIndex: 0, start: 4, end: 7 })
        const range = [...registry.get(ACTIVE_HIGHLIGHT)!][0]
        expect(textOf(range)).toBe('two')
        expect(range.endContainer.parentElement?.localName).toBe('em')
        marks.destroy()
    })

    it('has no marker for a chapter that is not mounted or for an empty range', () => {
        const registry = installHighlightApi()
        const frames = [frameFor('<p>The quick brown fox.</p>', 2)]
        const marks = createActiveMarks(() => frames)
        marks.setActive({ spineIndex: 7, start: 0, end: 5 })
        expect(registry.get(ACTIVE_HIGHLIGHT)!.size).toBe(0)
        marks.setActive({ spineIndex: 2, start: 5, end: 5 })
        expect(registry.get(ACTIVE_HIGHLIGHT)!.size).toBe(0)
        marks.setActive({ spineIndex: 2, start: 500, end: 600 })
        expect(registry.get(ACTIVE_HIGHLIGHT)!.size).toBe(0)
        marks.destroy()
    })

    it('marks the search matches of the mounted chapters', () => {
        const registry = installHighlightApi()
        const frames = [frameFor('<p>The quick brown fox.</p>', 2)]
        const marks = createActiveMarks(() => frames)
        marks.setSearch([
            { spineIndex: 2, start: 0, end: 3 },
            { spineIndex: 2, start: 16, end: 19 },
            { spineIndex: 5, start: 0, end: 5 },
        ])
        const search = registry.get(SEARCH_HIGHLIGHT)!
        expect([...search].map(textOf)).toEqual(['The', 'fox'])

        marks.setSearch([])
        expect(search.size).toBe(0)
        marks.destroy()
    })

    it('makes the ranges again for a chapter that is mounted later', () => {
        const registry = installHighlightApi()
        const frames = [frameFor('<p>The quick brown fox.</p>', 2)]
        const marks = createActiveMarks(() => frames)
        marks.setSearch([{ spineIndex: 5, start: 6, end: 10 }])
        marks.setActive({ spineIndex: 5, start: 0, end: 5 })
        expect(registry.get(SEARCH_HIGHLIGHT)!.size).toBe(0)

        frames.push(frameFor('<p>Other text.</p>', 5))
        marks.refresh()
        expect([...registry.get(SEARCH_HIGHLIGHT)!].map(textOf)).toEqual(['text'])
        expect([...registry.get(ACTIVE_HIGHLIGHT)!].map(textOf)).toEqual(['Other'])
        marks.destroy()
    })

    it('makes the ranges again after the Text nodes changed', () => {
        const registry = installHighlightApi()
        const frames = [frameFor('<p>The quick brown fox.</p>', 0)]
        const marks = createActiveMarks(() => frames)
        marks.setActive({ spineIndex: 0, start: 4, end: 15 })
        frames[0].setHighlights([
            { id: 'h', spineIndex: 0, start: 8, end: 12, color: 'yellow', hasNote: false },
        ])
        marks.refresh()
        expect([...registry.get(ACTIVE_HIGHLIGHT)!].map(textOf)).toEqual(['quick brown'])
        marks.destroy()
    })

    it('does not remove the highlights of a newer view on destroy', () => {
        const registry = installHighlightApi()
        const old = createActiveMarks(() => [])
        const next = createActiveMarks(() => [])
        const owned = registry.get(ACTIVE_HIGHLIGHT)
        old.destroy()
        expect(registry.get(ACTIVE_HIGHLIGHT)).toBe(owned)
        next.destroy()
        expect(registry.size).toBe(0)
    })

    it('does nothing after destroy', () => {
        const registry = installHighlightApi()
        const frames = [frameFor('<p>The quick brown fox.</p>', 2)]
        const marks = createActiveMarks(() => frames)
        marks.destroy()
        marks.setActive({ spineIndex: 2, start: 0, end: 3 })
        marks.setSearch([{ spineIndex: 2, start: 0, end: 3 }])
        marks.refresh()
        expect(registry.size).toBe(0)
    })
})

describe('without the highlight API', () => {
    it('wraps the marker in a mark element and moves it', () => {
        const frames = [frameFor('<p>The quick brown fox.</p>', 2)]
        const marks = createActiveMarks(() => frames)

        marks.setActive({ spineIndex: 2, start: 4, end: 9 })
        expect(frames[0].body.querySelector('mark.rd-active')?.textContent).toBe('quick')
        marks.setActive({ spineIndex: 2, start: 10, end: 19 })
        expect(frames[0].body.querySelectorAll('mark.rd-active')).toHaveLength(1)
        expect(frames[0].body.querySelector('mark.rd-active')?.textContent).toBe('brown fox')
        expect(frames[0].index.length).toBe(20)

        marks.setActive(null)
        expect(frames[0].body.innerHTML).toBe('<p>The quick brown fox.</p>')
        marks.destroy()
    })

    it('has no search marks and removes the marker on destroy', () => {
        const frames = [frameFor('<p>The quick brown fox.</p>', 2)]
        const marks = createActiveMarks(() => frames)
        marks.setSearch([{ spineIndex: 2, start: 0, end: 3 }])
        expect(frames[0].body.querySelector('mark')).toBeNull()

        marks.setActive({ spineIndex: 2, start: 4, end: 9 })
        marks.destroy()
        expect(frames[0].body.innerHTML).toBe('<p>The quick brown fox.</p>')
        expect(frames[0].index.range(4, 9)?.toString()).toBe('quick')
    })
})
