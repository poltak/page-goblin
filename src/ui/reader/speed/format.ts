/** Text of the status line of the speed reader. */

export interface TimeLeftOptions {
    /** Number of words after the word on screen. */
    wordsLeft: number
    /** Words for each minute. */
    wpm: number
}

/** For example '4 min left' or '1 h 5 min left'. The time has no punctuation pauses. */
export function timeLeft({ wordsLeft, wpm }: TimeLeftOptions): string {
    const minutes = wpm > 0 && wordsLeft > 0 ? Math.ceil(wordsLeft / wpm) : 0
    if (minutes < 60) return `${minutes} min left`
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`
}

/** A fraction from 0 to 1 as a whole percent. Only a full fraction gives 100. */
export function percent(fraction: number): number {
    if (!(fraction > 0)) return 0
    // The small number corrects a product such as 0.29 * 100, which is a little below 29.
    return fraction >= 1 ? 100 : Math.floor(fraction * 100 + 1e-9)
}

export interface StatusTextOptions extends TimeLeftOptions {
    /** Position of the word on screen in the whole book, from 0 to 1. */
    bookFraction: number
}

/** For example 'Chapter: 4 min left · Book: 62%'. */
export function statusText(options: StatusTextOptions): string {
    return `Chapter: ${timeLeft(options)} · Book: ${percent(options.bookFraction)}%`
}
