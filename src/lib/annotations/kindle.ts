/**
 * Export of highlights in the format of the Kindle file "My Clippings.txt".
 *
 * Each entry has a title line, a metadata line, an empty line, the text and a separator line:
 *
 *     Title (Author)
 *     - Your Highlight at location 4200-4201 | Added on Tuesday, 5 March 2024 14:03:09
 *
 *     The highlighted text.
 *     ==========
 *
 * This is what a Kindle with British English writes for a book that has no page numbers. The
 * package kindle-highlights-parser reads only this form: its metadata pattern needs the word
 * "at", and its date pattern needs the day before the month and a 24-hour time.
 */

import type { HighlightRecord } from '$lib/storage/types'
import { clampFraction, collapseWhiteSpace } from './shared'
import type { ExportSource } from './types'

const SEPARATOR = '=========='
const LINE_END = '\r\n'

/** An EPUB has no Kindle locations, so the book is divided into this number of them. */
const LOCATIONS_IN_BOOK = 10000
/** A Kindle location is 128 bytes of the book. */
const CHARS_IN_LOCATION = 128

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
]

interface Entry {
    heading: string
    kind: 'Highlight' | 'Note'
    location: string
    /** Epoch milliseconds. */
    addedAt: number
    body: string
}

/**
 * One line of text that cannot end an entry. Many parsers split the file at each run of ten
 * equals signs.
 */
function cleanLine(text: string): string {
    return collapseWhiteSpace(text).replace(/={10,}/g, '=========')
}

/**
 * Parsers find the author in the parentheses of the title line. Some use the first parenthesis
 * and some use the last one, so the line must have only the pair around the author.
 */
function cleanName(text: string): string {
    return cleanLine(text).replace(/\(/g, '[').replace(/\)/g, ']')
}

function headingOf({ title, author }: ExportSource['book']): string {
    const name = cleanName(title) || 'Untitled'
    const writer = cleanName(author)
    return writer ? `${name} (${writer})` : name
}

function twoDigits(value: number): string {
    return String(value).padStart(2, '0')
}

/** The local time, as a Kindle writes it. An invalid time gives an empty string. */
function addedOn(time: number): string {
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return ''
    const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits).join(':')
    const day = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
    return ` | Added on ${WEEKDAYS[date.getDay()]}, ${day} ${clock}`
}

function formatEntry({ heading, kind, location, addedAt, body }: Entry): string {
    const metadata = `- Your ${kind} at location ${location}${addedOn(addedAt)}`
    return [heading, metadata, '', body, SEPARATOR, ''].join(LINE_END)
}

function entriesOf(highlight: HighlightRecord, heading: string): string {
    const text = cleanLine(highlight.text)
    const note = cleanLine(highlight.note)
    // Kindle locations start at 1.
    const start = Math.max(1, Math.round(clampFraction(highlight.fraction) * LOCATIONS_IN_BOOK))
    const end = start + Math.floor(text.length / CHARS_IN_LOCATION)

    let entries = ''
    if (text) {
        entries += formatEntry({
            heading,
            kind: 'Highlight',
            location: `${start}-${end}`,
            addedAt: highlight.createdAt,
            body: text,
        })
    }
    if (note) {
        // A Kindle gives a note the last location of its highlight. Tools use it to join the two.
        entries += formatEntry({
            heading,
            kind: 'Note',
            location: String(end),
            addedAt: highlight.updatedAt,
            body: note,
        })
    }
    return entries
}

/**
 * The highlights of one book as the text of a Kindle "My Clippings.txt" file, with CRLF line
 * ends. A highlight with a note gives a highlight entry and then a note entry. Bookmarks are not
 * in the output, because tools for Kindle highlights do not use them.
 */
export function highlightsToKindleClippings({ book, highlights }: ExportSource): string {
    const heading = headingOf(book)
    let output = ''
    for (const highlight of highlights) output += entriesOf(highlight, heading)
    return output
}
