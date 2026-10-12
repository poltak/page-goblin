import type { TextModel } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import type { Locator, TextRange } from '$lib/types'
import type { SearchResult } from '../types'
import { matchExcerpt } from './excerpt'

/** A search stops at this number of results. */
export const SEARCH_RESULT_LIMIT = 500
export const SEARCH_MIN_QUERY_LENGTH = 2

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/g

/** A typed quotation mark also finds the typographic marks that most books use. */
const QUOTE_CLASSES: Record<string, string> = {
    "'": "['\u2018\u2019]",
    '"': '["\u201c\u201d]',
}

function wordPattern(word: string): string {
    return word.replace(REGEXP_SYNTAX, '\\$&').replace(/['"]/g, (quote) => QUOTE_CLASSES[quote])
}

/**
 * The pattern for a query, or null when the query is too short. Upper and lower case are the
 * same, and each run of white space in the query matches one or more white-space characters.
 */
export function buildSearchPattern(query: string): RegExp | null {
    const words = query.split(/\s+/).filter(Boolean)
    // The length is that of the query with single spaces and no space at the ends.
    const length = words.reduce((sum, word) => sum + word.length, 0) + words.length - 1
    if (length < SEARCH_MIN_QUERY_LENGTH) return null
    return new RegExp(words.map(wordPattern).join('\\s+'), 'giu')
}

/** The spine indexes in search order: the linear items, then the others (notes, popups). */
export function searchOrder(spine: EpubBook['spine']): number[] {
    const linear: number[] = []
    const other: number[] = []
    for (const item of spine) (item.linear ? linear : other).push(item.index)
    return linear.concat(other)
}

/** The longest time that the search runs between two timer waits. */
const TIMER_YIELD_INTERVAL_MS = 10
let lastTimerYield = 0

/**
 * Gives control back to the event loop, so that input and painting can run.
 *
 * A browser with no `scheduler.yield` (Safari) gets a timer. A nested timer waits 4 ms or more,
 * which is more than the search of a short chapter. Thus the timer runs only when the search
 * had control for some milliseconds.
 */
export function yieldToEventLoop(): Promise<void> {
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield()
    }
    if (performance.now() - lastTimerYield < TIMER_YIELD_INTERVAL_MS) return Promise.resolve()
    return new Promise((resolve) =>
        setTimeout(() => {
            lastTimerYield = performance.now()
            resolve()
        }, 0),
    )
}

export interface ChapterSearchOptions {
    model: Pick<TextModel, 'text' | 'blocks'>
    spineIndex: number
    pattern: RegExp
    /** The largest number of matches to return. */
    limit: number
}

export type ChapterMatch = Omit<SearchResult, 'chapterTitle'>

/** All matches of the pattern in the text of one chapter, in reading order. */
export function searchChapter({
    model,
    spineIndex,
    pattern,
    limit,
}: ChapterSearchOptions): ChapterMatch[] {
    const matches: ChapterMatch[] = []
    pattern.lastIndex = 0
    while (matches.length < limit) {
        const match = pattern.exec(model.text)
        if (!match) break
        const start = match.index
        const end = start + match[0].length
        matches.push({
            range: { spineIndex, start, end },
            ...matchExcerpt({ model, start, end }),
        })
    }
    pattern.lastIndex = 0
    return matches
}

export interface RunSearchOptions {
    pattern: RegExp
    spine: EpubBook['spine']
    loadText(spineIndex: number): Promise<Pick<TextModel, 'text' | 'blocks'>>
    /** False stops the search. The search asks after each step that waits. */
    isActive(): boolean
    /**
     * Called for a chapter that has matches, before `titleAt`. The search waits for the
     * promise, so the caller can get the data that the titles of this chapter need.
     */
    prepareTitles?(spineIndex: number): Promise<void>
    titleAt(locator: Locator): string
    onResults(results: SearchResult[]): void
    onProgress?(done: number, total: number): void
    limit?: number
    yieldControl?: () => Promise<void>
}

/**
 * Searches the book chapter by chapter. Resolves with the ranges of all matches, or with null
 * when `isActive` stopped the search. After a stop the search calls nothing more.
 */
export async function runSearch({
    pattern,
    spine,
    loadText,
    isActive,
    prepareTitles,
    titleAt,
    onResults,
    onProgress,
    limit = SEARCH_RESULT_LIMIT,
    yieldControl = yieldToEventLoop,
}: RunSearchOptions): Promise<TextRange[] | null> {
    const ranges: TextRange[] = []
    const order = searchOrder(spine)

    for (let done = 0; done < order.length; done++) {
        if (done > 0) {
            await yieldControl()
            if (!isActive()) return null
        }

        const spineIndex = order[done]
        let model: Pick<TextModel, 'text' | 'blocks'> | null = null
        try {
            model = await loadText(spineIndex)
        } catch {
            // A chapter that does not load has no results. The other chapters still count.
        }
        if (!isActive()) return null

        if (model) {
            const matches = searchChapter({
                model,
                spineIndex,
                pattern,
                limit: limit - ranges.length,
            })
            if (matches.length > 0) {
                if (prepareTitles) {
                    await prepareTitles(spineIndex)
                    if (!isActive()) return null
                }
                for (const match of matches) ranges.push(match.range)
                onResults(
                    matches.map((match) => ({
                        ...match,
                        chapterTitle: titleAt({ spineIndex, offset: match.range.start }),
                    })),
                )
                // The callback can stop the search.
                if (!isActive()) return null
            }
        }
        if (onProgress) {
            onProgress(done + 1, order.length)
            // The callback can stop the search also.
            if (!isActive()) return null
        }
        if (ranges.length >= limit) break
    }
    return ranges
}
