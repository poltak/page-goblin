/** Text and numbers of the reader screen. All functions are pure. */

import type { RelocateInfo } from '$lib/reader/types'
// Not from the index file of the storage module, which also has the importer.
import { locateFraction } from '$lib/storage/progress'
import type { SpineStats } from '$lib/storage/types'
import type { Locator } from '$lib/types'

/** The progress slider goes from 0 to this value. */
export const SLIDER_MAX = 1000

/** The messages that the session sends with an 'error' event. They are plain text for the user. */
export const SESSION_MESSAGES: ReadonlySet<string> = new Set([
    'The reading position could not be saved.',
    'This link cannot be opened.',
    'This link points to a file that is not in the book.',
])

export const UNKNOWN_ERROR_MESSAGE = 'Something went wrong.'

/** Whole percent from 0 to 100. Only the start shows 0 and only the end shows 100. */
export function percentOf(fraction: number): number {
    // The comparison is false for NaN.
    if (!(fraction > 0)) return 0
    if (fraction >= 1) return 100
    return Math.min(99, Math.max(1, Math.round(fraction * 100)))
}

export function percentText(fraction: number): string {
    return `${percentOf(fraction)}%`
}

/** 'Page 3 of 12' in the paged view. '' in the scroll view, which has no pages. */
export function pageText(info: Pick<RelocateInfo, 'page' | 'pageCount'> | null): string {
    if (!info || info.page === null || info.pageCount === null) return ''
    return `Page ${info.page} of ${info.pageCount}`
}

export interface TimeLeftOptions {
    /** Words to the end of the chapter. */
    words: number
    /** Reading speed in words for each minute. */
    wpm: number
}

/** '6 min left in chapter'. '' when the reading speed is not a positive number. */
export function timeLeftText({ words, wpm }: TimeLeftOptions): string {
    if (!(wpm > 0) || !(words >= 0)) return ''
    const minutes = words / wpm
    const amount = minutes < 1 ? 'less than 1 min' : `${Math.ceil(minutes)} min`
    return `${amount} left in chapter`
}

export interface ProgressTextOptions {
    /** Position in the whole book from 0 to 1. */
    fraction: number
    /** Words to the end of the chapter, or null when the position is not known yet. */
    chapterWords: number | null
    wpm: number
}

/** The right side of the running foot, for example '34% · 6 min left in chapter'. */
export function progressText({ fraction, chapterWords, wpm }: ProgressTextOptions): string {
    const percent = percentText(fraction)
    const time = chapterWords === null ? '' : timeLeftText({ words: chapterWords, wpm })
    return time ? `${percent} · ${time}` : percent
}

/** The slider value for a position in the whole book. */
export function sliderValue(fraction: number): number {
    if (!(fraction > 0)) return 0
    return Math.min(SLIDER_MAX, Math.round(fraction * SLIDER_MAX))
}

/** The position in the whole book, from 0 to 1, for the value of the slider. */
export function sliderFraction(value: number | string): number {
    const number = typeof value === 'string' ? Number(value) : value
    if (!(number > 0)) return 0
    return Math.min(1, number / SLIDER_MAX)
}

/**
 * The start of the text at a fraction of the whole book. The chapter length is the estimate
 * of the import, so the offset is near the position and not exact. This is sufficient to find
 * the contents entry of a slider position.
 */
export function locatorAtFraction(spineStats: readonly SpineStats[], fraction: number): Locator {
    const { spineIndex, chapterFraction } = locateFraction({ spineStats, fraction })
    const chars = spineStats[spineIndex]?.chars ?? 0
    return { spineIndex, offset: Math.round(chapterFraction * chars) }
}

export interface SliderLabelOptions {
    /** Title of the contents entry, or '' when there is none. */
    title: string
    fraction: number
}

/** The label above the thumb of the slider, for example 'Chapter One · 34%'. */
export function sliderLabel({ title, fraction }: SliderLabelOptions): string {
    const percent = percentText(fraction)
    const name = title.trim()
    return name ? `${name} · ${percent}` : percent
}

/** The message of a toast for an 'error' event of the session. */
export function errorMessage(error: unknown): string {
    if (error instanceof Error && SESSION_MESSAGES.has(error.message)) return error.message
    return UNKNOWN_ERROR_MESSAGE
}
