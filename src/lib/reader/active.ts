/**
 * The moving marker for speech and the marks of a search.
 *
 * With the CSS Custom Highlight API the marks are ranges, so the chapter DOM does not
 * change. Without it, the marker is a `mark` element and the search has no marks.
 */

import type { TextRange } from '$lib/types'
import type { Frame } from './frame'
import { ACTIVE_CLASS, unwrapMarks, wrapRange } from './marks'

export const ACTIVE_HIGHLIGHT = 'rd-active'
export const SEARCH_HIGHLIGHT = 'rd-search'

export interface ActiveMarks {
    setActive(range: TextRange | null): void
    setSearch(ranges: readonly TextRange[]): void
    /** Make all marks again. Call after the mounted frames or their Text nodes change. */
    refresh(): void
    destroy(): void
}

interface HighlightRegistry {
    get(name: string): Highlight | undefined
    set(name: string, highlight: Highlight): unknown
    delete(name: string): boolean
}

function highlightRegistry(): HighlightRegistry | null {
    if (typeof CSS === 'undefined' || typeof Highlight !== 'function') return null
    const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights
    return registry ?? null
}

/** A range that does not follow DOM changes. It costs less than a live range. */
function rangeFor(
    frame: Frame,
    { start, end }: { start: number; end: number },
): AbstractRange | null {
    const index = frame.index
    const from = Math.max(0, Math.min(start, index.length))
    const to = Math.max(0, Math.min(end, index.length))
    if (from >= to) return null
    if (typeof StaticRange !== 'function') return index.range(from, to)

    const first = index.locate(from)
    // The last character, so that the range ends in the node that has it.
    const last = index.locate(to - 1)
    if (!first || !last) return null
    return new StaticRange({
        startContainer: first.node,
        startOffset: first.offset,
        endContainer: last.node,
        endOffset: last.offset + 1,
    })
}

export function createActiveMarks(frames: () => readonly Frame[]): ActiveMarks {
    const registry = highlightRegistry()
    const activeHighlight = registry ? new Highlight() : null
    const searchHighlight = registry ? new Highlight() : null
    let active: TextRange | null = null
    let search = new Map<number, TextRange[]>()
    let marked = false
    let destroyed = false

    if (registry && activeHighlight && searchHighlight) {
        // The marker shows on top of a search match.
        activeHighlight.priority = 1
        registry.set(ACTIVE_HIGHLIGHT, activeHighlight)
        registry.set(SEARCH_HIGHLIGHT, searchHighlight)
    }

    function paintActive(): void {
        if (activeHighlight) {
            activeHighlight.clear()
            if (!active) return
            for (const frame of frames()) {
                if (frame.spineIndex !== active.spineIndex) continue
                const range = rangeFor(frame, active)
                if (range) activeHighlight.add(range)
            }
            return
        }

        for (const frame of frames()) {
            if (marked && unwrapMarks(frame.body, ACTIVE_CLASS)) frame.rebuildIndex()
            if (!active || frame.spineIndex !== active.spineIndex) continue
            wrapRange({
                frame,
                start: active.start,
                end: active.end,
                create: () => {
                    const mark = frame.body.ownerDocument.createElement('mark')
                    mark.className = ACTIVE_CLASS
                    return mark
                },
            })
        }
        marked = active !== null
    }

    function paintSearch(): void {
        if (!searchHighlight) return
        searchHighlight.clear()
        if (!search.size) return
        for (const frame of frames()) {
            const ranges = search.get(frame.spineIndex)
            if (!ranges) continue
            for (const match of ranges) {
                const range = rangeFor(frame, match)
                if (range) searchHighlight.add(range)
            }
        }
    }

    return {
        setActive(range) {
            if (destroyed) return
            active = range && range.end > range.start ? { ...range } : null
            paintActive()
        },
        setSearch(ranges) {
            if (destroyed) return
            search = new Map()
            for (const range of ranges) {
                const list = search.get(range.spineIndex)
                if (list) list.push(range)
                else search.set(range.spineIndex, [range])
            }
            paintSearch()
        },
        refresh() {
            if (destroyed) return
            paintActive()
            paintSearch()
        },
        destroy() {
            if (destroyed) return
            destroyed = true
            active = null
            search = new Map()
            if (registry) {
                activeHighlight?.clear()
                searchHighlight?.clear()
                // A newer view can own the names now.
                if (registry.get(ACTIVE_HIGHLIGHT) === activeHighlight) {
                    registry.delete(ACTIVE_HIGHLIGHT)
                }
                if (registry.get(SEARCH_HIGHLIGHT) === searchHighlight) {
                    registry.delete(SEARCH_HIGHLIGHT)
                }
            } else if (marked) {
                for (const frame of frames()) {
                    if (unwrapMarks(frame.body, ACTIVE_CLASS)) frame.rebuildIndex()
                }
            }
        },
    }
}
