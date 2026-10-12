/**
 * The text selection of the user inside the chapter frames.
 *
 * The chapter text is in shadow roots. `document.getSelection()` hides the real ends of such
 * a selection, so the code asks for the composed range.
 */

import type { Frame } from './frame'
import { unionRect } from './measure'
import type { SelectionInfo } from './types'

export const SELECTION_DELAY_MS = 120

interface RangeEnds {
    startContainer: Node
    startOffset: number
    endContainer: Node
    endOffset: number
}

type ComposedRanges = (...inputs: unknown[]) => RangeEnds[]

export interface SelectionWatcherOptions {
    /** The frames that are mounted now. */
    frames(): readonly Frame[]
    /** The visible area of the view in viewport coordinates. */
    viewport(): DOMRect
    onSelection(selection: SelectionInfo | null): void
}

export interface SelectionWatcher {
    /** Read the selection now. */
    check(): void
    destroy(): void
}

/** True when the page has a selection that is not empty, in the book or outside it. */
export function hasTextSelection(): boolean {
    if (typeof document === 'undefined' || typeof document.getSelection !== 'function') {
        return false
    }
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return false
    // A selection in a shadow root can look collapsed from the document.
    return selection.type === 'Range' || !selection.isCollapsed
}

function frameOf(node: Node, frames: readonly Frame[]): Frame | null {
    const root = node.getRootNode()
    for (const frame of frames) {
        if (frame.shadow === root) return frame
    }
    return null
}

function inFrames(range: RangeEnds | null | undefined, frames: readonly Frame[]): boolean {
    return (
        !!range && !!frameOf(range.startContainer, frames) && !!frameOf(range.endContainer, frames)
    )
}

/** The ends of the selection inside the shadow roots, or null. */
function readSelectionRange(frames: readonly Frame[]): RangeEnds | null {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const roots = frames.map((frame) => frame.shadow)

    const composed = (selection as unknown as { getComposedRanges?: ComposedRanges })
        .getComposedRanges
    if (typeof composed === 'function') {
        // The standard form takes one options object. Older Safari takes the roots as a list.
        for (const inputs of [[{ shadowRoots: roots }], roots]) {
            try {
                const range = composed.apply(selection, inputs)[0]
                if (inFrames(range, frames)) return range
            } catch {
                // Try the next form.
            }
        }
    }

    for (const root of roots) {
        const inner = (
            root as unknown as { getSelection?: () => Selection | null }
        ).getSelection?.()
        if (inner && inner.rangeCount > 0 && !inner.isCollapsed) {
            const range = inner.getRangeAt(0)
            if (inFrames(range, frames)) return range
        }
    }

    const range = selection.getRangeAt(0)
    return inFrames(range, frames) ? range : null
}

function readSelection(options: SelectionWatcherOptions): SelectionInfo | null {
    const frames = options.frames()
    if (!frames.length) return null
    const ends = readSelectionRange(frames)
    if (!ends) return null

    const frame = frameOf(ends.startContainer, frames)
    if (!frame || frame !== frameOf(ends.endContainer, frames)) return null

    const index = frame.index
    const start = index.offsetOf(ends.startContainer, ends.startOffset)
    const end = index.offsetOf(ends.endContainer, ends.endOffset)
    if (start < 0 || end <= start) return null

    const range = index.range(start, end)
    if (!range) return null
    const text = range.toString().replace(/\s+/g, ' ').trim()
    if (!text) return null

    const view = options.viewport()
    // jsdom has no layout, and its ranges do not have this function.
    const rects =
        typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
    const visible = (rect: DOMRect) =>
        (rect.width > 0 || rect.height > 0) &&
        rect.right > view.left &&
        rect.left < view.right &&
        rect.bottom > view.top &&
        rect.top < view.bottom
    const bounds = unionRect(rects, visible) ?? unionRect(rects) ?? new DOMRect()

    return { range: { spineIndex: frame.spineIndex, start, end }, text, bounds }
}

export function createSelectionWatcher(options: SelectionWatcherOptions): SelectionWatcher {
    let timer: ReturnType<typeof setTimeout> | null = null
    let last: SelectionInfo | null = null
    let destroyed = false

    function check(): void {
        if (timer !== null) {
            clearTimeout(timer)
            timer = null
        }
        if (destroyed) return

        const next = readSelection(options)
        if (!next) {
            if (last) {
                last = null
                options.onSelection(null)
            }
            return
        }
        const same =
            last &&
            last.range.spineIndex === next.range.spineIndex &&
            last.range.start === next.range.start &&
            last.range.end === next.range.end
        if (same) return
        last = next
        options.onSelection(next)
    }

    function schedule(): void {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(check, SELECTION_DELAY_MS)
    }

    function onPointerUp(): void {
        // The browser changes the selection after this event, for example on a double click.
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(check, 0)
    }

    document.addEventListener('selectionchange', schedule)
    document.addEventListener('pointerup', onPointerUp, true)

    return {
        check,
        destroy() {
            destroyed = true
            if (timer !== null) clearTimeout(timer)
            timer = null
            document.removeEventListener('selectionchange', schedule)
            document.removeEventListener('pointerup', onPointerUp, true)
        },
    }
}
