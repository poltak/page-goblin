/**
 * Public types of the speed reader engine.
 *
 * The engine shows the words of one chapter, one word at a time. It has no DOM code. The caller
 * gives it the words of a chapter and draws each word that the engine reports.
 */

import type { TextBlock, WordToken } from '$lib/content/types'

export interface RsvpSettings {
    /** Words for each minute. Valid from 50 to 1000. */
    wpm: number
    /** Delay multiplier for a word that ends with a period. All multipliers are valid from 1 to 10. */
    periodMultiplier: number
    commaMultiplier: number
    /** Also for the colon. */
    semicolonMultiplier: number
    /** Also for the question mark. */
    exclamationMultiplier: number
    /** Minimum multiplier for the last word of a block that is not a heading. */
    paragraphMultiplier: number
    /** Minimum multiplier for the last word of a heading. */
    headingMultiplier: number
    /** Give more time to a word that has more than 8 letters. */
    longWordDelay: boolean
    /** Start slower after each start of playback. */
    rampUp: boolean
}

/** `idle` means that there is no word to show. */
export type RsvpStatus = 'idle' | 'playing' | 'paused' | 'rewinding'

export interface RsvpState {
    status: RsvpStatus
    /** Index of the word on screen. 0 when there are no words. */
    index: number
    wordCount: number
}

export interface RsvpWordEvent {
    index: number
    word: WordToken
}

export interface RsvpCallbacks {
    /**
     * The word on screen changed, or the caller loaded a chapter. The engine does not call this
     * for a chapter that has no words.
     */
    onWord?(event: RsvpWordEvent): void
    /** The status, the index or the word count changed. The engine also calls this on each load. */
    onStateChange?(state: RsvpState): void
    /**
     * Playback passed the last word of the chapter. The engine is paused on the last word.
     * The engine also calls this when the caller calls `play` on a loaded chapter that has no
     * words, so that the caller can go to the next chapter.
     */
    onChapterEnd?(): void
}

/** The clock and timer functions that the engine uses. Tests give a fake. */
export interface RsvpTimer {
    setTimeout(callback: () => void, delayMs: number): unknown
    clearTimeout(handle: unknown): void
    /** A monotonic time in milliseconds. */
    now(): number
}

export interface RsvpEngineOptions {
    settings?: Partial<RsvpSettings>
    callbacks?: RsvpCallbacks
    timer?: RsvpTimer
}

export interface RsvpLoadOptions {
    /** The words of one chapter in reading order. The engine keeps this array and does not copy it. */
    words: readonly WordToken[]
    /** The blocks of the same chapter. `WordToken.block` is an index into this array. */
    blocks: readonly TextBlock[]
    /** The word to show first. The default is 0. */
    index?: number
}

export type RsvpDirection = 'previous' | 'next'

/** All methods are safe to call in each status and after `destroy`. */
export interface RsvpEngine {
    /** Replace the chapter. The engine stops playback and shows the word at `index`. */
    load(options: RsvpLoadOptions): void
    play(): void
    pause(): void
    /** Pause when playing. In all other statuses, play. */
    toggle(): void
    /** Show the word at this index. Returns true when the index changed. */
    seek(index: number): boolean
    /** Show the first word whose end is above this chapter offset. Returns true when the index changed. */
    seekToOffset(offset: number): boolean
    /** Move by this number of words. A negative number goes back. Returns true when the index changed. */
    stepWords(count: number): boolean
    /**
     * Go to the start of the next or the previous sentence. Returns false when the index did not
     * change, which tells the caller that the target is in a different chapter.
     */
    stepSentence(direction: RsvpDirection): boolean
    /**
     * Go back one word at a time until `stopRewind`. Does nothing when the engine is at the first
     * word. When a rewind gets to the first word, the engine waits there in the status `rewinding`.
     */
    startRewind(): void
    /** Return to the status that the engine had before `startRewind`. */
    stopRewind(): void
    /** Change some settings. Values that are not valid keep their current value. */
    setSettings(patch: Partial<RsvpSettings>): void
    getSettings(): RsvpSettings
    getState(): RsvpState
    getCurrentWord(): WordToken | null
    /** Stop the timer and release the chapter. No callback runs after this. */
    destroy(): void
}
