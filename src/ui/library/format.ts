/**
 * Text for the library grid. All functions are pure.
 *
 * Only the text that the first screen needs is here. The text for the details sheet and for
 * the app menu is in details-format.ts and app-format.ts, which load with those parts.
 */

/** From this fraction a book counts as finished. */
export const FINISHED_FRACTION = 0.995

export function isFinished(fraction: number): boolean {
    return fraction >= FINISHED_FRACTION
}

/** Whole percent from 0 to 100. Progress above 0 never shows as 0. */
export function progressPercent(fraction: number): number {
    if (!(fraction > 0)) return 0
    return Math.min(100, Math.max(1, Math.round(fraction * 100)))
}

/** '' for no progress, 'Finished' at the end, else a percent such as '42%'. */
export function progressText(fraction: number): string {
    if (!(fraction > 0)) return ''
    return isFinished(fraction) ? 'Finished' : `${progressPercent(fraction)}%`
}

/** A number with its noun, for example '1 book' or '3 books'. */
export function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`
}

/** '12 books', or '3 of 12 books' when a search hides some. */
export function bookCountText(shown: number, total: number): string {
    return shown === total ? plural(total, 'book', 'books') : `${shown} of ${total} books`
}
