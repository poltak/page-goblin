/**
 * Saved highlights as `mark` elements around the Text nodes of a chapter.
 *
 * A mark changes no text, so the chapter offsets stay the same. The marks are inline boxes
 * with no padding, so the layout stays the same also.
 */

import { createTextIndex } from '$lib/content'
import type { TextIndex } from '$lib/content/types'
import type { HighlightMark } from './types'

export const HIGHLIGHT_CLASS = 'rd-hl'
export const ACTIVE_CLASS = 'rd-active'

const BLOCK_NAMES = new Set(
    (
        'address article aside blockquote caption col colgroup dd details div dl dt figcaption ' +
        'figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table ' +
        'tbody td tfoot th thead tr ul'
    ).split(' '),
)

/** The part of a frame that the mark functions use. */
export interface MarkTarget {
    readonly spineIndex: number
    readonly body: HTMLElement
    readonly index: TextIndex
    /** Make the text index again. The Text nodes changed. */
    rebuildIndex(): void
}

export interface ApplyHighlightsOptions {
    frame: MarkTarget
    highlights: readonly HighlightMark[]
}

export interface WrapRangeOptions {
    frame: MarkTarget
    start: number
    /** Exclusive. */
    end: number
    /** Makes the wrapper for one Text node. */
    create(): HTMLElement
}

function isBlock(node: Node | null): boolean {
    return !node || (node.nodeType === 1 && BLOCK_NAMES.has((node as Element).localName))
}

/**
 * White space between two blocks draws nothing. A wrapper around it can change the layout,
 * for example as a new cell between two table rows.
 */
function isLayoutSpace(node: Text): boolean {
    if (/\S/.test(node.data)) return false
    return isBlock(node.previousSibling) && isBlock(node.nextSibling)
}

/** Replace each wrapper with its children and join the Text nodes again. */
export function unwrapMarks(body: HTMLElement, className: string): boolean {
    const marks = body.querySelectorAll(`mark.${className}`)
    if (!marks.length) return false

    const parents = new Set<Node>()
    for (const mark of marks) {
        const parent = mark.parentNode
        if (!parent) continue
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
        parent.removeChild(mark)
        parents.add(parent)
    }
    for (const parent of parents) {
        // A wrapper inside a wrapper is not in the document now.
        if (parent === body || body.contains(parent)) parent.normalize()
    }
    return true
}

/** Split the Text nodes so that each offset is on a node boundary. The index is then old. */
function splitAt(index: TextIndex, offsets: Iterable<number>): void {
    // From the end to the start. A split keeps the first part in the node that the index
    // knows, so each earlier offset still maps to the right place.
    const sorted = [...new Set(offsets)].sort((a, b) => b - a)
    for (const offset of sorted) {
        if (offset <= 0 || offset >= index.length) continue
        const point = index.locate(offset)
        if (point && point.offset > 0 && point.offset < point.node.data.length) {
            point.node.splitText(point.offset)
        }
    }
}

/** Wrap each Text node of [start, end). All range ends must be on node boundaries. */
function wrapNodes({ frame, start, end, create }: WrapRangeOptions): void {
    const index = frame.index
    let offset = start
    while (offset < end) {
        const point = index.locate(offset)
        if (!point) return
        const node = point.node
        const size = node.data.length - point.offset
        if (size <= 0) return
        offset += size
        const parent = node.parentNode
        if (point.offset !== 0 || !parent || isLayoutSpace(node)) continue
        const wrapper = create()
        parent.insertBefore(wrapper, node)
        wrapper.appendChild(node)
    }
}

function clampRange(start: number, end: number, length: number): [number, number] | null {
    const from = Math.max(0, Math.min(Math.floor(start) || 0, length))
    const to = Math.max(0, Math.min(Math.floor(end) || 0, length))
    return from < to ? [from, to] : null
}

/** Wrap one range. The function makes the index again before it returns. */
export function wrapRange(options: WrapRangeOptions): void {
    const { frame } = options
    const range = clampRange(options.start, options.end, frame.index.length)
    if (!range) return
    splitAt(frame.index, range)
    frame.rebuildIndex()
    wrapNodes({ ...options, start: range[0], end: range[1] })
    frame.rebuildIndex()
}

function createHighlightElement(document: Document, highlight: HighlightMark): HTMLElement {
    const mark = document.createElement('mark')
    mark.className = HIGHLIGHT_CLASS
    mark.setAttribute('data-id', highlight.id)
    mark.setAttribute('data-color', highlight.color)
    if (highlight.hasNote) mark.setAttribute('data-note', '')
    return mark
}

/** A text that changes when the marks of a chapter must change. */
export function highlightKey(spineIndex: number, highlights: readonly HighlightMark[]): string {
    let key = ''
    for (const highlight of highlights) {
        if (highlight.spineIndex !== spineIndex) continue
        const note = highlight.hasNote ? 1 : 0
        key += `${highlight.id}\n${highlight.start}:${highlight.end}:${highlight.color}:${note}\n`
    }
    return key
}

/**
 * Remove all highlight marks of a chapter and add the marks for the given list. Highlights
 * that overlap give marks inside marks.
 */
export function applyHighlights({ frame, highlights }: ApplyHighlightsOptions): void {
    if (unwrapMarks(frame.body, HIGHLIGHT_CLASS)) frame.rebuildIndex()

    const length = frame.index.length
    const ranges: { highlight: HighlightMark; start: number; end: number }[] = []
    for (const highlight of highlights) {
        if (highlight.spineIndex !== frame.spineIndex) continue
        const range = clampRange(highlight.start, highlight.end, length)
        if (range) ranges.push({ highlight, start: range[0], end: range[1] })
    }
    if (!ranges.length) return

    splitAt(
        frame.index,
        ranges.flatMap((range) => [range.start, range.end]),
    )
    // Wrappers do not change the Text nodes, so one new index is correct for all of them.
    frame.rebuildIndex()

    // The longer range first, so that it is the outer mark.
    ranges.sort((a, b) => a.start - b.start || b.end - a.end)
    const document = frame.body.ownerDocument
    for (const { highlight, start, end } of ranges) {
        wrapNodes({
            frame,
            start,
            end,
            create: () => createHighlightElement(document, highlight),
        })
    }
    frame.rebuildIndex()
}

/** A mark target for a chapter body that is in no frame. The tests use it. */
export function createMarkTarget(spineIndex: number, body: HTMLElement): MarkTarget {
    let index = createTextIndex(body)
    return {
        spineIndex,
        body,
        get index() {
            return index
        },
        rebuildIndex() {
            index = createTextIndex(body)
        },
    }
}
