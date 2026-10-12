/** Layout reads that both views use. Call them only when the view is at rest. */

import type { ChapterContent, TextIndex } from '$lib/content/types'

const MAX_ATTEMPTS = 64
export const IMAGE_WAIT_MS = 1500

function hasSize(rect: DOMRect): boolean {
    return rect.width > 0 || rect.height > 0
}

function firstSizedRect(source: Range | Element | null): DOMRect | null {
    // jsdom has no layout, and its ranges do not have this function.
    if (!source || typeof source.getClientRects !== 'function') return null
    const rects = source.getClientRects()
    for (let i = 0; i < rects.length; i++) {
        if (hasSize(rects[i])) return rects[i]
    }
    return null
}

function lastSizedRect(source: Range | null): DOMRect | null {
    if (!source || typeof source.getClientRects !== 'function') return null
    const rects = source.getClientRects()
    for (let i = rects.length - 1; i >= 0; i--) {
        if (hasSize(rects[i])) return rects[i]
    }
    return null
}

/**
 * The box of the character at a chapter offset. Text that draws nothing (collapsed white
 * space, hidden elements) has no box, so the function then uses the next text that has one.
 * White space at the end of a chapter has no next text and uses the last text before it.
 * The last choice is the box of an ancestor element. Null when nothing has a box.
 */
export function rectOfOffset(index: TextIndex, offset: number): DOMRect | null {
    const length = index.length
    if (!length) return null

    const first = Math.max(0, Math.min(Math.floor(offset) || 0, length - 1))
    let at = first
    let lastNode: Node | null = null

    for (let attempt = 0; attempt < MAX_ATTEMPTS && at < length; attempt++) {
        const point = index.locate(at)
        if (!point) break
        lastNode = point.node

        // The last box. A character after a line break that the browser made with a hyphen
        // also has the box of that hyphen, which is on the line before.
        const rect = lastSizedRect(index.range(at, at + 1))
        if (rect) return rect

        // The rest of the Text node in one read. It finds the first character that draws.
        const nodeEnd = at + (point.node.data.length - point.offset)
        if (nodeEnd > at + 1) {
            const restRect = firstSizedRect(index.range(at + 1, nodeEnd))
            if (restRect) return restRect
        }
        at = Math.max(nodeEnd, at + 1)
    }

    // The box of an ancestor starts where the element starts, and that can be many pages
    // before the offset. The end of the text before the offset is the nearer place.
    let end = first
    for (let attempt = 0; attempt < MAX_ATTEMPTS && end > 0; attempt++) {
        const point = index.locate(end - 1)
        if (!point) break
        const nodeStart = end - 1 - point.offset
        const rect = lastSizedRect(index.range(nodeStart, end))
        if (rect) return rect
        end = nodeStart
    }

    for (let node = lastNode?.parentNode ?? null; node; node = node.parentNode) {
        if (node.nodeType !== 1) break
        const rect = firstSizedRect(node as Element)
        if (rect) return rect
        if ((node as Element).localName === 'rd-body') break
    }
    return null
}

/** The smallest box around the boxes for which `keep` is true. Null when there is none. */
export function unionRect(
    rects: Iterable<DOMRect>,
    keep: (rect: DOMRect) => boolean = hasSize,
): DOMRect | null {
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const rect of rects) {
        if (!keep(rect)) continue
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    if (left === Infinity) return null
    return new DOMRect(left, top, right - left, bottom - top)
}

/** Resolves when the images of a chapter have a size, or after the time limit. */
export function imagesSettled(content: ChapterContent, limitMs = IMAGE_WAIT_MS): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, limitMs)
        void content.imagesReady.then(() => {
            clearTimeout(timer)
            resolve()
        })
    })
}

/**
 * The lowest value in [low, high) for which `test` is true, or `high`. `test` must be false
 * for all values below the result and true from it on.
 */
export function lowestWhere({
    low,
    high,
    test,
}: {
    low: number
    high: number
    test: (value: number) => boolean
}): number {
    let from = low
    let to = high
    while (from < to) {
        const middle = (from + to) >>> 1
        if (test(middle)) to = middle
        else from = middle + 1
    }
    return from
}
