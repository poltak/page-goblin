import type { SpineStats } from '$lib/storage/types'
import type { Locator, TextRange } from '$lib/types'
import type { ReaderMode } from '../types'

/** A shorter time is a page flip, not reading. */
export const SAMPLE_MIN_MS = 3_000
/** A longer time means that the user left the page open. */
export const SAMPLE_MAX_MS = 300_000
export const SAMPLE_MIN_WPM = 60
export const SAMPLE_MAX_WPM = 900
/** Weight of a new sample in the moving average. */
export const AVERAGE_ALPHA = 0.2
/** The shortest time between two writes of the average to the settings. */
export const SPEED_WRITE_INTERVAL_MS = 30_000
/** Words for each character when the chapter has no statistics. */
const DEFAULT_WORDS_PER_CHAR = 1 / 6

/** One relocate, as the reading speed measure keeps it. */
export interface SpeedPoint {
    locator: Locator
    visible: TextRange
    /** Epoch milliseconds. */
    time: number
}

export interface ReadingSampleOptions {
    previous: SpeedPoint | null
    next: { locator: Locator; time: number }
    mode: ReaderMode
    /** True when the page was visible for the whole time between the two relocates. */
    visible: boolean
    /**
     * Words and characters of the chapter, when they are known. `chars` must count the text in
     * the same way as the offsets do (white space as written).
     */
    stats?: SpineStats
}

/**
 * The reading speed in words for each minute that two relocates show, or null.
 *
 * Only a move to the next page of the same chapter is a sample: the new position is the end of
 * the text that was visible before. A jump, a move back and a scroll of some lines give null.
 */
export function readingSample({
    previous,
    next,
    mode,
    visible,
    stats,
}: ReadingSampleOptions): number | null {
    if (!previous || mode !== 'read' || !visible) return null
    if (next.locator.spineIndex !== previous.locator.spineIndex) return null
    if (next.locator.offset !== previous.visible.end) return null

    const chars = next.locator.offset - previous.locator.offset
    const elapsed = next.time - previous.time
    // The comparisons are false for NaN.
    if (!(chars > 0) || !(elapsed >= SAMPLE_MIN_MS && elapsed <= SAMPLE_MAX_MS)) return null

    const wordsPerChar =
        stats && stats.chars > 0 && stats.words > 0
            ? stats.words / stats.chars
            : DEFAULT_WORDS_PER_CHAR
    const wpm = (chars * wordsPerChar * 60_000) / elapsed
    return wpm >= SAMPLE_MIN_WPM && wpm <= SAMPLE_MAX_WPM ? wpm : null
}

/** The exponential moving average after one more sample. */
export function nextAverage(average: number, sample: number): number {
    return average + AVERAGE_ALPHA * (sample - average)
}
