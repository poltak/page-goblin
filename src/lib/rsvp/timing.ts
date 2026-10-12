import type { WordToken } from '$lib/content/types'
import { getPunctuationMultiplier } from './punctuation'
import type { RsvpSettings } from './types'

/** The shortest base time for one word. It limits the true speed to 1200 words for each minute. */
export const MIN_WORD_INTERVAL_MS = 50

export const LONG_WORD_LETTERS = 8
export const LONG_WORD_STEP = 0.04
export const LONG_WORD_LIMIT = 0.6

export const RAMP_WORDS = 5
export const RAMP_START_FACTOR = 1.6

export const REWIND_MAX_WPM = 800
export const MIN_REWIND_INTERVAL_MS = 25

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu
/** More letters than this do not add time, so the count stops here. */
const LONG_WORD_COUNT_LIMIT = LONG_WORD_LETTERS + Math.ceil(LONG_WORD_LIMIT / LONG_WORD_STEP)

function longWordFactor(text: string): number {
    // A word with 8 code units or fewer cannot have more than 8 letters.
    if (text.length <= LONG_WORD_LETTERS) return 1

    let count = 0
    LETTER_OR_DIGIT.lastIndex = 0
    while (count < LONG_WORD_COUNT_LIMIT && LETTER_OR_DIGIT.test(text)) count++

    const extra = count - LONG_WORD_LETTERS
    return extra > 0 ? 1 + Math.min(extra * LONG_WORD_STEP, LONG_WORD_LIMIT) : 1
}

export interface WordDelayOptions {
    word: WordToken
    /** Settings that are in their valid ranges. */
    settings: RsvpSettings
    /** True when the word is the last word of a heading block. */
    isHeadingEnd?: boolean
    /** See `rampFactorAt`. The default is 1. */
    rampFactor?: number
}

/** The time that a word stays on screen, in milliseconds. */
export function wordDelayMs({
    word,
    settings,
    isHeadingEnd = false,
    rampFactor = 1,
}: WordDelayOptions): number {
    const base = Math.max(60000 / settings.wpm, MIN_WORD_INTERVAL_MS)

    let multiplier = getPunctuationMultiplier(word.text, settings)
    if (word.endsBlock) {
        const blockMultiplier = isHeadingEnd
            ? settings.headingMultiplier
            : settings.paragraphMultiplier
        multiplier = Math.max(multiplier, blockMultiplier)
    }

    const longWord = settings.longWordDelay ? longWordFactor(word.text) : 1
    return base * multiplier * longWord * rampFactor
}

/**
 * The delay factor for a word after playback starts. `wordsSinceStart` is 0 for the word that is
 * on screen when playback starts. The factor goes down in equal steps from 1.6 and is 1 from the
 * sixth word.
 */
export function rampFactorAt(wordsSinceStart: number): number {
    if (wordsSinceStart >= RAMP_WORDS) return 1
    const remaining = 1 - Math.max(wordsSinceStart, 0) / RAMP_WORDS
    return 1 + (RAMP_START_FACTOR - 1) * remaining
}

/** The time between two words during a rewind. Punctuation does not change it. */
export function rewindIntervalMs(wpm: number): number {
    return Math.max(60000 / Math.min(wpm * 2, REWIND_MAX_WPM), MIN_REWIND_INTERVAL_MS)
}
