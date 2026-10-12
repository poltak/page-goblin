/** Text for the book details sheet. Pure functions, apart from the locale of the browser. */

import type { BookRecord } from '$lib/storage/types'

/** A file size with a unit that fits, for example '340 kB' or '1.2 MB'. */
export function formatBytes(bytes: number): string {
    if (!(bytes > 0)) return '0 kB'
    if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} kB`
    if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

/**
 * The year of a `dc:date` value, or null when it has none. The value is free text, so this
 * takes the first number of four digits. Calibre writes the year 0101 for an unknown date, so
 * a year below 1000 counts as unknown.
 */
export function publicationYear(published: string | null): number | null {
    const match = /(?:^|\D)(\d{4})(?!\d)/.exec(published ?? '')
    if (!match) return null
    const year = Number(match[1])
    return year >= 1000 ? year : null
}

/** 'Book 2 of NAME', or only the name when the position is not known. */
export function seriesText(series: BookRecord['series']): string | null {
    if (!series || !series.name.trim()) return null
    const { name, position } = series
    return position === null || !Number.isFinite(position) ? name : `Book ${position} of ${name}`
}

/** The name of a language tag in the language of the browser, or the tag itself. */
export function languageName(tag: string | null): string | null {
    const code = tag?.trim()
    if (!code) return null
    try {
        return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code
    } catch {
        // The tag of the book is not valid, or the browser has no display names.
        return code
    }
}

/** A long date in the locale of the browser. */
export function formatDate(time: number): string {
    try {
        return new Date(time).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        })
    } catch {
        return new Date(time).toDateString()
    }
}

/** A title as a file name: no characters that a file system refuses, and not too long. */
export function safeFileName(title: string): string {
    const name = title
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[.\s]+/, '')
        .slice(0, 80)
        .trim()
    return name || 'book'
}
