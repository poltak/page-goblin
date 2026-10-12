/**
 * Pure helpers for the position in the whole book.
 *
 * Each spine item has a weight, which is its estimated number of characters. When no item has
 * text, as in a book of images, each item has the weight 1.
 */

import type { SpineStats } from './types'

export interface ChapterPosition {
    spineIndex: number
    /** Position in the chapter from 0 to 1. */
    chapterFraction: number
}

export interface BookPosition extends ChapterPosition {
    spineStats: readonly SpineStats[]
}

export interface LocateFractionOptions {
    spineStats: readonly SpineStats[]
    /** Position in the whole book from 0 to 1. */
    fraction: number
}

export interface WordsRemaining {
    /** Words from the position to the end of its chapter. */
    chapter: number
    /** Words from the position to the end of the book. */
    book: number
}

interface Weights {
    total: number
    of: (index: number) => number
}

function clamp01(value: number): number {
    // The comparison is false for NaN, so NaN gives 0.
    return value > 0 ? Math.min(value, 1) : 0
}

function weightsOf(spineStats: readonly SpineStats[]): Weights {
    let total = 0
    for (const stats of spineStats) total += stats.chars
    if (total > 0) return { total, of: (index) => spineStats[index].chars }
    return { total: spineStats.length, of: () => 1 }
}

/** Position in the whole book from 0 to 1. */
export function bookFraction({ spineStats, spineIndex, chapterFraction }: BookPosition): number {
    const current = Math.floor(spineIndex)
    // The comparison is false for NaN, so NaN gives 0.
    if (spineStats.length === 0 || !(current >= 0)) return 0
    if (current >= spineStats.length) return 1

    const weights = weightsOf(spineStats)
    let before = 0
    for (let index = 0; index < current; index++) before += weights.of(index)
    return clamp01((before + weights.of(current) * clamp01(chapterFraction)) / weights.total)
}

/**
 * The chapter position of a fraction of the whole book. This is the inverse of `bookFraction`.
 *
 * A fraction on the border between two chapters gives the start of the second chapter. A
 * chapter with no weight is never the result, because no fraction is inside it.
 */
export function locateFraction({ spineStats, fraction }: LocateFractionOptions): ChapterPosition {
    if (spineStats.length === 0) return { spineIndex: 0, chapterFraction: 0 }

    const weights = weightsOf(spineStats)
    const target = clamp01(fraction) * weights.total
    // `bookFraction` divides and this function multiplies. The margin absorbs the rounding
    // error, so the start of a chapter does not become the end of the chapter before it.
    const margin = weights.total * 1e-12

    let before = 0
    let lastWithWeight = 0
    for (let index = 0; index < spineStats.length; index++) {
        const weight = weights.of(index)
        if (weight <= 0) continue
        if (before + weight > target + margin) {
            return { spineIndex: index, chapterFraction: clamp01((target - before) / weight) }
        }
        before += weight
        lastWithWeight = index
    }
    return { spineIndex: lastWithWeight, chapterFraction: 1 }
}

/** Estimated words that the user did not read yet. */
export function wordsRemaining(position: BookPosition): WordsRemaining {
    const { spineStats } = position
    const spineIndex = Math.floor(position.spineIndex)
    if (spineStats.length === 0 || spineIndex >= spineStats.length) return { chapter: 0, book: 0 }

    // An index that is negative or NaN is the start of the book.
    const index = spineIndex > 0 ? spineIndex : 0
    const read = spineIndex >= 0 ? clamp01(position.chapterFraction) : 0
    const chapter = Math.round(spineStats[index].words * (1 - read))
    let book = chapter
    for (let next = index + 1; next < spineStats.length; next++) book += spineStats[next].words
    return { chapter, book }
}
