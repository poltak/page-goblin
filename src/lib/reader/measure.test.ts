import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTextIndex } from '$lib/content'
import type { ChapterContent } from '$lib/content/types'
import { imagesSettled, lowestWhere, rectOfOffset, unionRect } from './measure'

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('lowestWhere', () => {
    it('finds the first value that passes the test', () => {
        expect(lowestWhere({ low: 0, high: 100, test: (value) => value >= 37 })).toBe(37)
        expect(lowestWhere({ low: 0, high: 100, test: (value) => value >= 0 })).toBe(0)
        expect(lowestWhere({ low: 0, high: 100, test: (value) => value >= 99 })).toBe(99)
    })

    it('gives the upper limit when no value passes', () => {
        expect(lowestWhere({ low: 0, high: 100, test: () => false })).toBe(100)
    })

    it('does not look below the lower limit', () => {
        const seen: number[] = []
        const found = lowestWhere({
            low: 40,
            high: 100,
            test: (value) => {
                seen.push(value)
                return value >= 10
            },
        })
        expect(found).toBe(40)
        expect(Math.min(...seen)).toBeGreaterThanOrEqual(40)
    })

    it('gives the lower limit for an empty interval', () => {
        expect(lowestWhere({ low: 5, high: 5, test: () => true })).toBe(5)
    })

    it('needs about log2 of the size in tests', () => {
        let calls = 0
        lowestWhere({
            low: 0,
            high: 1_000_000,
            test: (value) => {
                calls++
                return value >= 654_321
            },
        })
        expect(calls).toBeLessThanOrEqual(20)
    })
})

describe('unionRect', () => {
    it('gives the box around all boxes that have a size', () => {
        const box = unionRect([
            new DOMRect(10, 20, 30, 10),
            new DOMRect(0, 0, 0, 0),
            new DOMRect(5, 40, 100, 10),
        ])
        expect(box).toMatchObject({ left: 5, top: 20, width: 100, height: 30 })
    })

    it('uses only the boxes that the filter keeps', () => {
        const box = unionRect(
            [new DOMRect(10, 20, 30, 10), new DOMRect(500, 20, 30, 10)],
            (rect) => rect.left < 100,
        )
        expect(box).toMatchObject({ left: 10, top: 20, width: 30, height: 10 })
    })

    it('gives null for no boxes', () => {
        expect(unionRect([])).toBeNull()
        expect(unionRect([new DOMRect(3, 3, 0, 0)])).toBeNull()
    })
})

describe('rectOfOffset', () => {
    function indexFor(html: string) {
        const body = document.createElement('rd-body')
        body.innerHTML = html
        document.body.appendChild(body)
        return { body, index: createTextIndex(body) }
    }

    /** jsdom has no layout. The tests give boxes to chosen Text nodes. */
    function fakeLayout(boxes: Map<Node, DOMRect>) {
        const original = document.createRange.bind(document)
        vi.spyOn(document, 'createRange').mockImplementation(() => {
            const range = original()
            Object.defineProperty(range, 'getClientRects', {
                value: () => {
                    const box = boxes.get(range.startContainer)
                    return box ? [box] : []
                },
            })
            return range
        })
    }

    it('gives null for a chapter with no text', () => {
        const { index } = indexFor('<p><img alt=""></p>')
        expect(rectOfOffset(index, 0)).toBeNull()
    })

    it('gives null when nothing has a box', () => {
        const { index } = indexFor('<p>Some text.</p>')
        expect(rectOfOffset(index, 3)).toBeNull()
    })

    it('gives the box of the character', () => {
        const { body, index } = indexFor('<p>one</p><p>two</p>')
        const second = body.querySelectorAll('p')[1].firstChild!
        fakeLayout(new Map([[second, new DOMRect(7, 8, 9, 10)]]))
        expect(rectOfOffset(index, 4)).toMatchObject({ left: 7, top: 8 })
    })

    it('uses the next text that has a box for text that draws nothing', () => {
        const { body, index } = indexFor('<p>one</p>\n   <p hidden>two</p><p>three</p>')
        const third = body.querySelectorAll('p')[2].firstChild!
        fakeLayout(new Map([[third, new DOMRect(40, 50, 9, 10)]]))
        // Offset 3 is the white space between the paragraphs.
        expect(rectOfOffset(index, 3)).toMatchObject({ left: 40, top: 50 })
        expect(rectOfOffset(index, 8)).toMatchObject({ left: 40, top: 50 })
    })

    it('uses the last character for an offset at the end of the chapter', () => {
        const { body, index } = indexFor('<p>one</p><p>two</p>')
        const second = body.querySelectorAll('p')[1].firstChild!
        fakeLayout(new Map([[second, new DOMRect(7, 8, 9, 10)]]))
        expect(rectOfOffset(index, index.length)).toMatchObject({ left: 7 })
        expect(rectOfOffset(index, 9999)).toMatchObject({ left: 7 })
    })

    it('uses the last box of a character after a hyphen of the browser', () => {
        const { body, index } = indexFor('<p>instructed</p>')
        const text = body.querySelector('p')!.firstChild!
        const original = document.createRange.bind(document)
        vi.spyOn(document, 'createRange').mockImplementation(() => {
            const range = original()
            Object.defineProperty(range, 'getClientRects', {
                // The character after the break also has the box of the hyphen, which is at
                // the end of the line before, on the page before.
                value: () =>
                    range.startContainer === text && range.startOffset === 8
                        ? [new DOMRect(324, 712, 10, 20), new DOMRect(416, 37, 13, 20)]
                        : [new DOMRect(100, 712, 10, 20)],
            })
            return range
        })
        expect(rectOfOffset(index, 8)).toMatchObject({ left: 416, top: 37 })
        expect(rectOfOffset(index, 7)).toMatchObject({ left: 100, top: 712 })
    })

    it('uses the text before it for white space at the end of the chapter', () => {
        const { body, index } = indexFor('<div><p>one</p><p>two</p>\n  </div>\n ')
        const second = body.querySelectorAll('p')[1].firstChild!
        fakeLayout(new Map([[second, new DOMRect(400, 8, 9, 10)]]))
        // The box of the parent starts on the first page. The white space is on the last one.
        vi.spyOn(body.querySelector('div')!, 'getClientRects').mockReturnValue([
            new DOMRect(0, 0, 300, 40),
        ] as unknown as DOMRectList)
        expect(rectOfOffset(index, 6)).toMatchObject({ left: 400, top: 8 })
        expect(rectOfOffset(index, index.length - 1)).toMatchObject({ left: 400, top: 8 })
        expect(rectOfOffset(index, index.length)).toMatchObject({ left: 400, top: 8 })
    })

    it('uses the box of a parent element when no text has a box', () => {
        const { body, index } = indexFor('<div><p>one</p></div>')
        fakeLayout(new Map())
        vi.spyOn(body.querySelector('div')!, 'getClientRects').mockReturnValue([
            new DOMRect(1, 2, 300, 40),
        ] as unknown as DOMRectList)
        expect(rectOfOffset(index, 1)).toMatchObject({ left: 1, top: 2, width: 300 })
    })
})

describe('imagesSettled', () => {
    function content(imagesReady: Promise<void>): ChapterContent {
        return { imagesReady } as ChapterContent
    }

    it('resolves when the images are ready', async () => {
        vi.useFakeTimers()
        let ready: () => void = () => {}
        const done = vi.fn()
        void imagesSettled(content(new Promise((resolve) => (ready = resolve)))).then(done)
        await vi.advanceTimersByTimeAsync(200)
        expect(done).not.toHaveBeenCalled()
        ready()
        await vi.advanceTimersByTimeAsync(0)
        expect(done).toHaveBeenCalledTimes(1)
    })

    it('resolves after 1500 milliseconds when an image is slow', async () => {
        vi.useFakeTimers()
        const done = vi.fn()
        void imagesSettled(content(new Promise(() => {}))).then(done)
        await vi.advanceTimersByTimeAsync(1499)
        expect(done).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(done).toHaveBeenCalledTimes(1)
    })
})
