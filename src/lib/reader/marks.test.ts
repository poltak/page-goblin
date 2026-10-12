import { describe, expect, it } from 'vitest'
import { buildTextModel, createTextIndex } from '$lib/content'
import type { HighlightMark } from './types'
import {
    ACTIVE_CLASS,
    HIGHLIGHT_CLASS,
    applyHighlights,
    createMarkTarget,
    highlightKey,
    unwrapMarks,
    wrapRange,
} from './marks'

function makeBody(html: string): HTMLElement {
    const body = document.createElement('rd-body')
    body.innerHTML = html
    document.body.appendChild(body)
    return body
}

function mark(partial: Partial<HighlightMark> & { id: string; start: number; end: number }) {
    return { spineIndex: 0, color: 'yellow', hasNote: false, ...partial } as HighlightMark
}

function markedText(body: HTMLElement, id: string): string {
    return [...body.querySelectorAll(`mark.${HIGHLIGHT_CLASS}[data-id="${id}"]`)]
        .map((element) => element.textContent)
        .join('')
}

const CHAPTER =
    '<h1>Chapter one</h1>\n<p>The quick <em>brown fox</em> jumps over the lazy dog.</p>\n' +
    '<p>A second paragraph with <a data-rd-path="x.xhtml">a link</a> in it.</p>'

describe('applyHighlights', () => {
    it('wraps the text of a range in one Text node', () => {
        const body = makeBody('<p>The quick brown fox.</p>')
        const frame = createMarkTarget(0, body)
        applyHighlights({ frame, highlights: [mark({ id: 'a', start: 4, end: 9 })] })

        const marks = body.querySelectorAll('mark.rd-hl')
        expect(marks).toHaveLength(1)
        expect(marks[0].textContent).toBe('quick')
        expect(marks[0].getAttribute('data-id')).toBe('a')
        expect(marks[0].getAttribute('data-color')).toBe('yellow')
        expect(marks[0].hasAttribute('data-note')).toBe(false)
        expect(body.innerHTML).toBe(
            '<p>The <mark class="rd-hl" data-id="a" data-color="yellow">quick</mark> brown fox.</p>',
        )
    })

    it('sets the colour and the note attribute', () => {
        const body = makeBody('<p>The quick brown fox.</p>')
        const frame = createMarkTarget(0, body)
        applyHighlights({
            frame,
            highlights: [mark({ id: 'n', start: 0, end: 3, color: 'purple', hasNote: true })],
        })
        const element = body.querySelector('mark.rd-hl')
        expect(element?.getAttribute('data-color')).toBe('purple')
        expect(element?.hasAttribute('data-note')).toBe(true)
    })

    it('wraps each Text node of a range that crosses elements', () => {
        const body = makeBody(CHAPTER)
        const text = buildTextModel(body).text
        const start = text.indexOf('quick')
        const end = text.indexOf('jumps') + 'jumps'.length
        const frame = createMarkTarget(0, body)
        applyHighlights({ frame, highlights: [mark({ id: 'a', start, end })] })

        expect(markedText(body, 'a')).toBe('quick brown fox jumps')
        // One mark in the paragraph, one in the em element, one after it.
        expect(body.querySelectorAll('mark.rd-hl')).toHaveLength(3)
        expect(body.querySelector('em > mark.rd-hl')?.textContent).toBe('brown fox')
    })

    it('does not change the chapter text or its length', () => {
        const body = makeBody(CHAPTER)
        const before = buildTextModel(body).text
        const frame = createMarkTarget(0, body)
        applyHighlights({
            frame,
            highlights: [
                mark({ id: 'a', start: 3, end: 40 }),
                mark({ id: 'b', start: 20, end: 70, color: 'blue' }),
                mark({ id: 'c', start: 60, end: before.length }),
            ],
        })
        expect(buildTextModel(body).text).toBe(before)
        expect(frame.index.length).toBe(before.length)
        expect(createTextIndex(body).length).toBe(before.length)
    })

    it('makes the index again, so that offsets map to the new Text nodes', () => {
        const body = makeBody('<p>The quick brown fox.</p>')
        const frame = createMarkTarget(0, body)
        const old = frame.index
        applyHighlights({ frame, highlights: [mark({ id: 'a', start: 4, end: 9 })] })

        expect(frame.index).not.toBe(old)
        const point = frame.index.locate(5)
        expect(point?.node.parentElement?.localName).toBe('mark')
        expect(point?.offset).toBe(1)
        expect(frame.index.range(4, 9)?.toString()).toBe('quick')
        expect(frame.index.range(10, 15)?.toString()).toBe('brown')
        const inMark = body.querySelector('mark')?.firstChild as Text
        expect(frame.index.offsetOf(inMark, 2)).toBe(6)
    })

    it('gives a mark inside a mark for highlights that overlap', () => {
        const body = makeBody('<p>The quick brown fox jumps.</p>')
        const frame = createMarkTarget(0, body)
        applyHighlights({
            frame,
            highlights: [
                mark({ id: 'a', start: 4, end: 15 }),
                mark({ id: 'b', start: 10, end: 19, color: 'green' }),
            ],
        })

        expect(markedText(body, 'a')).toBe('quick brown')
        expect(markedText(body, 'b')).toBe('brown fox')
        const nested = body.querySelector('mark[data-id="a"] > mark[data-id="b"]')
        expect(nested?.textContent).toBe('brown')
        expect(buildTextModel(body).text).toBe('The quick brown fox jumps.')
    })

    it('puts a highlight that is inside a longer one into the longer one', () => {
        const body = makeBody('<p>The quick brown fox jumps.</p>')
        const frame = createMarkTarget(0, body)
        applyHighlights({
            frame,
            highlights: [
                mark({ id: 'inner', start: 10, end: 15, color: 'pink' }),
                mark({ id: 'outer', start: 4, end: 19 }),
            ],
        })
        expect(markedText(body, 'outer')).toBe('quick brown fox')
        expect(
            body.querySelector('mark[data-id="outer"] > mark[data-id="inner"]')?.textContent,
        ).toBe('brown')
    })

    it('removes the old marks and joins the Text nodes when the list changes', () => {
        const body = makeBody(CHAPTER)
        const html = body.innerHTML
        const frame = createMarkTarget(0, body)
        applyHighlights({
            frame,
            highlights: [
                mark({ id: 'a', start: 3, end: 40 }),
                mark({ id: 'b', start: 20, end: 70 }),
            ],
        })
        expect(body.innerHTML).not.toBe(html)

        applyHighlights({ frame, highlights: [mark({ id: 'c', start: 0, end: 7 })] })
        expect(body.querySelectorAll('mark.rd-hl')).toHaveLength(1)
        expect(markedText(body, 'c')).toBe('Chapter')

        applyHighlights({ frame, highlights: [] })
        expect(body.innerHTML).toBe(html)
        // No split Text nodes stay.
        expect(body.querySelector('h1')?.childNodes).toHaveLength(1)
        expect(frame.index.range(0, 7)?.toString()).toBe('Chapter')
    })

    it('ignores the highlights of other chapters', () => {
        const body = makeBody('<p>The quick brown fox.</p>')
        const frame = createMarkTarget(3, body)
        applyHighlights({
            frame,
            highlights: [
                mark({ id: 'a', start: 0, end: 3 }),
                mark({ id: 'b', spineIndex: 3, start: 4, end: 9 }),
            ],
        })
        expect(body.querySelectorAll('mark.rd-hl')).toHaveLength(1)
        expect(markedText(body, 'b')).toBe('quick')
    })

    it('clamps a range to the chapter and ignores an empty range', () => {
        const body = makeBody('<p>Short.</p>')
        const frame = createMarkTarget(0, body)
        applyHighlights({
            frame,
            highlights: [
                mark({ id: 'a', start: 3, end: 500 }),
                mark({ id: 'b', start: 2, end: 2 }),
                mark({ id: 'c', start: 900, end: 950 }),
                mark({ id: 'd', start: 4, end: 1 }),
            ],
        })
        expect(markedText(body, 'a')).toBe('rt.')
        expect(body.querySelectorAll('mark.rd-hl')).toHaveLength(1)
    })

    it('does not wrap white space between two blocks', () => {
        const body = makeBody(
            '<table><tbody>\n<tr><td>one</td>\n<td>two</td></tr>\n<tr><td>three</td></tr>\n</tbody></table>',
        )
        const length = buildTextModel(body).text.length
        const frame = createMarkTarget(0, body)
        applyHighlights({ frame, highlights: [mark({ id: 'a', start: 0, end: length })] })

        expect(markedText(body, 'a')).toBe('onetwothree')
        for (const element of body.querySelectorAll('mark.rd-hl')) {
            expect(element.parentElement?.localName).toBe('td')
        }
        expect(buildTextModel(body).text.length).toBe(length)
    })

    it('wraps a space between two inline elements', () => {
        const body = makeBody('<p><i>one</i> <b>two</b></p>')
        const frame = createMarkTarget(0, body)
        applyHighlights({ frame, highlights: [mark({ id: 'a', start: 0, end: 7 })] })
        expect(markedText(body, 'a')).toBe('one two')
    })

    it('does not count text that the text model skips', () => {
        const body = makeBody('<p>one <ruby>kan<rt>ji</rt></ruby> two</p>')
        const text = buildTextModel(body).text
        expect(text).toBe('one kan two')
        const frame = createMarkTarget(0, body)
        applyHighlights({ frame, highlights: [mark({ id: 'a', start: 4, end: 11 })] })
        expect(markedText(body, 'a')).toBe('kan two')
        expect(body.querySelector('rt')?.innerHTML).toBe('ji')
    })

    it('works for a chapter with no text', () => {
        const body = makeBody('<div><img alt=""></div>')
        const frame = createMarkTarget(0, body)
        applyHighlights({ frame, highlights: [mark({ id: 'a', start: 0, end: 5 })] })
        expect(body.querySelector('mark')).toBeNull()
    })
})

describe('unwrapMarks', () => {
    it('removes only the marks of one class', () => {
        const body = makeBody('<p>The quick brown fox.</p>')
        const frame = createMarkTarget(0, body)
        applyHighlights({ frame, highlights: [mark({ id: 'a', start: 4, end: 9 })] })
        wrapRange({
            frame,
            start: 10,
            end: 15,
            create: () => {
                const element = document.createElement('mark')
                element.className = ACTIVE_CLASS
                return element
            },
        })
        expect(body.querySelector(`mark.${ACTIVE_CLASS}`)?.textContent).toBe('brown')

        expect(unwrapMarks(body, ACTIVE_CLASS)).toBe(true)
        expect(body.querySelector(`mark.${ACTIVE_CLASS}`)).toBeNull()
        expect(body.querySelector(`mark.${HIGHLIGHT_CLASS}`)?.textContent).toBe('quick')
        expect(unwrapMarks(body, ACTIVE_CLASS)).toBe(false)
    })

    it('removes marks that are inside other marks', () => {
        const body = makeBody('<p>The quick brown fox jumps.</p>')
        const frame = createMarkTarget(0, body)
        applyHighlights({
            frame,
            highlights: [
                mark({ id: 'a', start: 4, end: 15 }),
                mark({ id: 'b', start: 10, end: 19 }),
            ],
        })
        expect(unwrapMarks(body, HIGHLIGHT_CLASS)).toBe(true)
        expect(body.innerHTML).toBe('<p>The quick brown fox jumps.</p>')
        expect(body.querySelector('p')?.childNodes).toHaveLength(1)
    })
})

describe('wrapRange', () => {
    it('wraps a range and keeps the index correct', () => {
        const body = makeBody('<p>The quick <em>brown</em> fox.</p>')
        const frame = createMarkTarget(0, body)
        wrapRange({
            frame,
            start: 6,
            end: 13,
            create: () => {
                const element = document.createElement('mark')
                element.className = ACTIVE_CLASS
                return element
            },
        })
        const wrapped = [...body.querySelectorAll(`mark.${ACTIVE_CLASS}`)].map((m) => m.textContent)
        expect(wrapped).toEqual(['ick ', 'bro'])
        expect(frame.index.length).toBe('The quick brown fox.'.length)
        expect(frame.index.range(6, 13)?.toString()).toBe('ick bro')
    })
})

describe('highlightKey', () => {
    const list = [
        mark({ id: 'a', start: 1, end: 5 }),
        mark({ id: 'b', spineIndex: 2, start: 1, end: 5 }),
    ]

    it('is the same for the same highlights of a chapter', () => {
        expect(highlightKey(0, list)).toBe(highlightKey(0, [mark({ id: 'a', start: 1, end: 5 })]))
        expect(highlightKey(7, list)).toBe('')
    })

    it('changes with the range, the colour and the note', () => {
        const base = highlightKey(0, list)
        expect(highlightKey(0, [mark({ id: 'a', start: 1, end: 6 })])).not.toBe(base)
        expect(highlightKey(0, [mark({ id: 'a', start: 1, end: 5, color: 'blue' })])).not.toBe(base)
        expect(highlightKey(0, [mark({ id: 'a', start: 1, end: 5, hasNote: true })])).not.toBe(base)
    })
})
