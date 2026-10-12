import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureChapter } from '$lib/content'
import type { ChapterContent } from '$lib/content/types'
import { createFrame, type Frame } from './frame'
import { SELECTION_DELAY_MS, createSelectionWatcher, hasTextSelection } from './selection'
import { createSheet } from './sheets'
import type { SelectionInfo } from './types'

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

interface Ends {
    startContainer: Node
    startOffset: number
    endContainer: Node
    endOffset: number
}

interface FakeSelection {
    rangeCount: number
    isCollapsed: boolean
    type: string
    getRangeAt(index: number): Ends
    getComposedRanges?: (...inputs: unknown[]) => Ends[]
}

const sheet = createSheet('')
let frames: Frame[] = []
let selection: FakeSelection | null = null

function textOf(frame: Frame, selector: string): Text {
    return frame.body.querySelector(selector)!.firstChild as Text
}

/** A selection as `document.getSelection()` gives it for a range in a shadow root. */
function select(ends: Ends | null, form: 'options' | 'list' | 'none' = 'options'): void {
    if (!ends) {
        selection = { rangeCount: 0, isCollapsed: true, type: 'None', getRangeAt: () => ends! }
        return
    }
    // From the document, the ends of the range are the host element.
    const host = frames[0].host
    const hidden: Ends = { startContainer: host, startOffset: 0, endContainer: host, endOffset: 0 }
    selection = {
        rangeCount: 1,
        isCollapsed: true,
        type: 'Range',
        getRangeAt: () => (form === 'none' ? ends : hidden),
    }
    if (form === 'options') {
        selection.getComposedRanges = (input) => {
            const roots = (input as { shadowRoots?: ShadowRoot[] } | undefined)?.shadowRoots
            return [Array.isArray(roots) && roots.length ? ends : hidden]
        }
    }
    if (form === 'list') {
        selection.getComposedRanges = (...inputs) => {
            if (!inputs.every((input) => input instanceof ShadowRoot))
                throw new TypeError('Not a shadow root.')
            return [inputs.length ? ends : hidden]
        }
    }
}

function watch() {
    const onSelection = vi.fn<(info: SelectionInfo | null) => void>()
    const watcher = createSelectionWatcher({
        frames: () => frames,
        viewport: () => new DOMRect(0, 0, 800, 600),
        onSelection,
    })
    return { watcher, onSelection }
}

beforeEach(() => {
    vi.useFakeTimers()
    frames = [
        createFrame({
            content: chapter(
                '<p id="a">The quick brown fox.</p><p id="b">A second   paragraph.</p>',
                4,
            ),
            baseSheet: sheet,
            overrideSheet: sheet,
            publisherStyles: true,
        }),
        createFrame({
            content: chapter('<p id="c">The next chapter.</p>', 5),
            baseSheet: sheet,
            overrideSheet: sheet,
            publisherStyles: true,
        }),
    ]
    for (const frame of frames) document.body.appendChild(frame.host)
    selection = null
    vi.spyOn(document, 'getSelection').mockImplementation(() => selection as unknown as Selection)
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('createSelectionWatcher', () => {
    it('reports a selection in a frame with chapter offsets and collapsed text', () => {
        const { watcher, onSelection } = watch()
        const a = textOf(frames[0], '#a')
        const b = textOf(frames[0], '#b')
        select({ startContainer: a, startOffset: 4, endContainer: b, endOffset: 12 })
        watcher.check()

        expect(onSelection).toHaveBeenCalledTimes(1)
        const info = onSelection.mock.calls[0][0]!
        expect(info.range).toEqual({ spineIndex: 4, start: 4, end: 32 })
        expect(info.text).toBe('quick brown fox.A second p')
        expect(info.bounds).toBeInstanceOf(DOMRect)
        watcher.destroy()
    })

    it('reads the selection 120 milliseconds after the last change', () => {
        const { watcher, onSelection } = watch()
        const a = textOf(frames[0], '#a')
        select({ startContainer: a, startOffset: 0, endContainer: a, endOffset: 3 })
        document.dispatchEvent(new Event('selectionchange'))
        vi.advanceTimersByTime(SELECTION_DELAY_MS - 20)
        select({ startContainer: a, startOffset: 0, endContainer: a, endOffset: 9 })
        document.dispatchEvent(new Event('selectionchange'))
        vi.advanceTimersByTime(SELECTION_DELAY_MS - 20)
        expect(onSelection).not.toHaveBeenCalled()
        vi.advanceTimersByTime(20)
        expect(onSelection).toHaveBeenCalledTimes(1)
        expect(onSelection.mock.calls[0][0]?.text).toBe('The quick')
        watcher.destroy()
    })

    it('also reads the selection after a pointer release', () => {
        const { watcher, onSelection } = watch()
        const a = textOf(frames[0], '#a')
        select({ startContainer: a, startOffset: 4, endContainer: a, endOffset: 9 })
        document.dispatchEvent(new Event('pointerup'))
        vi.advanceTimersByTime(1)
        expect(onSelection.mock.calls[0][0]?.text).toBe('quick')
        watcher.destroy()
    })

    it('works with the older call form of getComposedRanges', () => {
        const { watcher, onSelection } = watch()
        const c = textOf(frames[1], '#c')
        select({ startContainer: c, startOffset: 4, endContainer: c, endOffset: 8 }, 'list')
        watcher.check()
        expect(onSelection.mock.calls[0][0]?.range).toEqual({ spineIndex: 5, start: 4, end: 8 })
        watcher.destroy()
    })

    it('works with a plain range when the browser has no composed ranges', () => {
        const { watcher, onSelection } = watch()
        const a = textOf(frames[0], '#a')
        select({ startContainer: a, startOffset: 10, endContainer: a, endOffset: 15 }, 'none')
        watcher.check()
        expect(onSelection.mock.calls[0][0]?.text).toBe('brown')
        watcher.destroy()
    })

    it('does not report the same range two times', () => {
        const { watcher, onSelection } = watch()
        const a = textOf(frames[0], '#a')
        select({ startContainer: a, startOffset: 4, endContainer: a, endOffset: 9 })
        watcher.check()
        watcher.check()
        document.dispatchEvent(new Event('pointerup'))
        vi.advanceTimersByTime(1)
        expect(onSelection).toHaveBeenCalledTimes(1)
        watcher.destroy()
    })

    it('reports null one time when the selection goes away', () => {
        const { watcher, onSelection } = watch()
        watcher.check()
        expect(onSelection).not.toHaveBeenCalled()

        const a = textOf(frames[0], '#a')
        select({ startContainer: a, startOffset: 4, endContainer: a, endOffset: 9 })
        watcher.check()
        select(null)
        watcher.check()
        watcher.check()
        expect(onSelection).toHaveBeenCalledTimes(2)
        expect(onSelection.mock.calls[1][0]).toBeNull()
        watcher.destroy()
    })

    it('reports null for a selection that is outside the book text', () => {
        const { watcher, onSelection } = watch()
        const a = textOf(frames[0], '#a')
        select({ startContainer: a, startOffset: 4, endContainer: a, endOffset: 9 })
        watcher.check()

        const outside = document.createElement('p')
        outside.textContent = 'A label of the app.'
        document.body.appendChild(outside)
        const node = outside.firstChild!
        select({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 5 }, 'none')
        watcher.check()
        expect(onSelection).toHaveBeenLastCalledWith(null)
        watcher.destroy()
    })

    it('ignores a selection that starts in one chapter and ends in a different one', () => {
        const { watcher, onSelection } = watch()
        select({
            startContainer: textOf(frames[0], '#b'),
            startOffset: 2,
            endContainer: textOf(frames[1], '#c'),
            endOffset: 5,
        })
        watcher.check()
        expect(onSelection).not.toHaveBeenCalled()
        watcher.destroy()
    })

    it('ignores an empty range and a range of white space', () => {
        const { watcher, onSelection } = watch()
        const a = textOf(frames[0], '#a')
        select({ startContainer: a, startOffset: 4, endContainer: a, endOffset: 4 })
        watcher.check()
        const b = textOf(frames[0], '#b')
        select({ startContainer: b, startOffset: 8, endContainer: b, endOffset: 11 })
        watcher.check()
        expect(onSelection).not.toHaveBeenCalled()
        watcher.destroy()
    })

    it('stops after destroy', () => {
        const { watcher, onSelection } = watch()
        const a = textOf(frames[0], '#a')
        select({ startContainer: a, startOffset: 4, endContainer: a, endOffset: 9 })
        document.dispatchEvent(new Event('selectionchange'))
        watcher.destroy()
        vi.advanceTimersByTime(500)
        document.dispatchEvent(new Event('selectionchange'))
        document.dispatchEvent(new Event('pointerup'))
        vi.advanceTimersByTime(500)
        watcher.check()
        expect(onSelection).not.toHaveBeenCalled()
    })
})

describe('hasTextSelection', () => {
    it('is false with no selection and for a caret', () => {
        select(null)
        expect(hasTextSelection()).toBe(false)
        selection = {
            rangeCount: 1,
            isCollapsed: true,
            type: 'Caret',
            getRangeAt: () => null as never,
        }
        expect(hasTextSelection()).toBe(false)
    })

    it('is true for a range, also when it looks collapsed from the document', () => {
        selection = {
            rangeCount: 1,
            isCollapsed: true,
            type: 'Range',
            getRangeAt: () => null as never,
        }
        expect(hasTextSelection()).toBe(true)
        selection = { rangeCount: 1, isCollapsed: false, type: '', getRangeAt: () => null as never }
        expect(hasTextSelection()).toBe(true)
    })
})
