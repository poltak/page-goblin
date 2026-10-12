import type { EpubBook, TocItem } from '$lib/epub/types'
import type { Locator } from '$lib/types'
import type { TocEntry } from '../types'

/** A contents list with fewer entries than this is not useful. */
const MIN_USEFUL_ENTRIES = 2
/** The fallback list is only for a book with more linear spine items than this. */
const FALLBACK_MIN_SPINE_ITEMS = 3

/**
 * The nested table of contents as a flat list in reading order.
 *
 * An entry with no target in the book (a heading, or a link to a file that is not in the spine)
 * is left out. Its children take its depth, so the list has no step of two levels.
 */
export function flattenToc(items: readonly TocItem[]): TocEntry[] {
    const entries: TocEntry[] = []
    const visit = (list: readonly TocItem[], depth: number): void => {
        for (const item of list) {
            const hasTarget = item.path !== null && item.spineIndex >= 0
            if (hasTarget) {
                entries.push({
                    title: item.title,
                    depth,
                    spineIndex: item.spineIndex,
                    fragment: item.fragment,
                })
            }
            visit(item.children, hasTarget ? depth + 1 : depth)
        }
    }
    visit(items, 0)
    return entries
}

/** One entry for each linear spine item. */
export function fallbackToc(spine: EpubBook['spine']): TocEntry[] {
    const entries: TocEntry[] = []
    for (const item of spine) {
        if (!item.linear) continue
        entries.push({
            title: `Section ${entries.length + 1}`,
            depth: 0,
            spineIndex: item.index,
            fragment: null,
        })
    }
    return entries
}

/** The contents list of a book. Some real books have a table of contents with one entry or none. */
export function buildToc(book: Pick<EpubBook, 'toc' | 'spine'>): TocEntry[] {
    const entries = flattenToc(book.toc)
    if (entries.length >= MIN_USEFUL_ENTRIES) return entries
    const fallback = fallbackToc(book.spine)
    return fallback.length > FALLBACK_MIN_SPINE_ITEMS ? fallback : entries
}

export interface TocIndex {
    /** The last entry at or before the locator in reading order, or null. */
    find(locator: Locator): TocEntry | null
    /** True when an entry of this spine item has a fragment with an offset that is not known. */
    needsAnchors(spineIndex: number): boolean
    /**
     * Give the anchor offsets of a loaded chapter (`ChapterContent.anchors`). The index keeps
     * only the offsets of the fragments that the contents list uses.
     */
    setAnchors(spineIndex: number, anchors: ReadonlyMap<string, number>): void
}

interface IndexedEntry {
    entry: TocEntry
    /** Position in the flat list. */
    order: number
    /** Chapter offset of the fragment. 0 when the entry has no fragment or it is not known. */
    offset: number
}

function compareIndexed(a: IndexedEntry, b: IndexedEntry): number {
    return a.entry.spineIndex - b.entry.spineIndex || a.offset - b.offset || a.order - b.order
}

/**
 * Finds the contents entry of a position.
 *
 * Two entries of the same spine item differ only in their fragment. The offset of a fragment
 * is known only after its chapter loads. Until then the offset is 0.
 */
export function createTocIndex(toc: readonly TocEntry[]): TocIndex {
    const sorted: IndexedEntry[] = toc.map((entry, order) => ({ entry, order, offset: 0 }))
    sorted.sort(compareIndexed)

    /** Spine items that have an entry with a fragment and no offsets yet. */
    const pending = new Set<number>()
    for (const entry of toc) {
        if (entry.fragment !== null) pending.add(entry.spineIndex)
    }

    return {
        find(locator) {
            // Binary search for the last entry that is not after the locator.
            let low = 0
            let high = sorted.length
            while (low < high) {
                const middle = (low + high) >>> 1
                const { entry, offset } = sorted[middle]
                const after =
                    entry.spineIndex > locator.spineIndex ||
                    (entry.spineIndex === locator.spineIndex && offset > locator.offset)
                if (after) high = middle
                else low = middle + 1
            }
            return low > 0 ? sorted[low - 1].entry : null
        },
        needsAnchors: (spineIndex) => pending.has(spineIndex),
        setAnchors(spineIndex, anchors) {
            if (!pending.delete(spineIndex)) return
            let changed = false
            for (const indexed of sorted) {
                const { entry } = indexed
                if (entry.spineIndex !== spineIndex || entry.fragment === null) continue
                // A fragment that the chapter does not have stays at the chapter start.
                const offset = anchors.get(entry.fragment) ?? 0
                if (offset !== indexed.offset) {
                    indexed.offset = offset
                    changed = true
                }
            }
            if (changed) sorted.sort(compareIndexed)
        },
    }
}
