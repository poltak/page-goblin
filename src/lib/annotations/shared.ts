/** Small helpers that the files of this module share. */

/** One line of text: each run of white space becomes one space, and the ends have none. */
export function collapseWhiteSpace(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

/** A position in the book from 0 to 1. A value that is not a number gives 0. */
export function clampFraction(fraction: number): number {
    // The comparison is false for NaN, so NaN gives 0.
    return fraction > 0 ? Math.min(fraction, 1) : 0
}
