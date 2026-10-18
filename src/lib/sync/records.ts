/**
 * Converts the records of the library to the changes of the server API and back.
 *
 * A change from the server is not trusted: the server stores what a device sent. Each value
 * goes through the same checks as a backup file, and a change that fails them is dropped.
 */

import {
    isCount,
    isFraction,
    isRecord,
    isTime,
    parseBookmark,
    parseHighlight,
    parseLocator,
    SHA_256_HEX,
} from '$lib/annotations/backup'
import { MAX_FONT_FACES, MAX_FONT_FILE_BYTES } from '$lib/fonts/import'
import { cleanFontName } from '$lib/fonts/sfnt'
import type {
    FontFaceRecord,
    SpineStats,
    SyncBookValue,
    SyncFontValue,
    SyncItem,
} from '$lib/storage/types'
import type { Change, StoredChange } from './types'

/**
 * The format of `Change.data` that this version writes: the record as JSON text.
 *
 * An older version drops a change with a format that it cannot read, and its cursor moves past
 * that change. So the version that adds a format must pull again from cursor 0 one time.
 */
export const DATA_FORMAT = 1

export function toChange(item: SyncItem): Change {
    return {
        kind: item.kind,
        key: item.key,
        // The server takes whole milliseconds. A time from an old backup file can have a fraction.
        updatedAt: Math.round(item.updatedAt),
        deleted: item.deleted,
        format: DATA_FORMAT,
        data: item.deleted ? null : JSON.stringify(item.value),
    }
}

function isText(value: unknown): value is string {
    return typeof value === 'string'
}

function isTextOrNull(value: unknown): value is string | null {
    return value === null || typeof value === 'string'
}

function parseSpineStats(raw: unknown): SpineStats[] | null {
    if (!Array.isArray(raw)) return null
    const stats: SpineStats[] = []
    for (const item of raw) {
        if (!isRecord(item) || !isCount(item.chars) || !isCount(item.words)) return null
        stats.push({ chars: item.chars, words: item.words })
    }
    return stats
}

function parseSeries(raw: unknown): SyncBookValue['series'] | undefined {
    if (raw === null) return null
    if (!isRecord(raw) || !isText(raw.name)) return undefined
    const { position } = raw
    if (position !== null && !(typeof position === 'number' && Number.isFinite(position))) {
        return undefined
    }
    return { name: raw.name, position }
}

/** Names each field, so a field that is not in the contract cannot go into storage. */
function parseBook(raw: unknown, fileHash: string): SyncBookValue | null {
    if (!isRecord(raw) || raw.fileHash !== fileHash) return null
    const spineStats = parseSpineStats(raw.spineStats)
    const series = parseSeries(raw.series)
    const { title, author, language, identifier, publisher, description, published } = raw
    const { subjects, fileName, fileSize, hasCover, totalChars, totalWords } = raw
    const { addedAt, lastOpenedAt } = raw
    const valid =
        spineStats &&
        series !== undefined &&
        isText(title) &&
        isText(author) &&
        isTextOrNull(language) &&
        isTextOrNull(identifier) &&
        isTextOrNull(publisher) &&
        isTextOrNull(description) &&
        isTextOrNull(published) &&
        Array.isArray(subjects) &&
        subjects.every(isText) &&
        isText(fileName) &&
        isCount(fileSize) &&
        typeof hasCover === 'boolean' &&
        isCount(totalChars) &&
        isCount(totalWords) &&
        isTime(addedAt) &&
        (lastOpenedAt === null || isTime(lastOpenedAt))
    if (!valid) return null
    return {
        title,
        author,
        language,
        identifier,
        publisher,
        description,
        published,
        subjects: [...subjects],
        series,
        fileName,
        fileSize,
        fileHash,
        hasCover,
        spineStats,
        totalChars,
        totalWords,
        addedAt,
        lastOpenedAt,
    }
}

/**
 * The id of a font family. The CSS family name of its faces has the id, so it can have only
 * the characters of a CSS name. The app makes UUIDs.
 */
export const FONT_ID = /^[A-Za-z0-9_-]{1,64}$/

const FONT_FORMATS = new Set(['truetype', 'opentype', 'woff', 'woff2'])
const FONT_FALLBACKS = new Set(['serif', 'sans-serif', 'monospace'])
const FONT_STYLES = new Set(['normal', 'italic'])
const FONT_WEIGHT = /^(\d{1,4})(?: (\d{1,4}))?$/
const FONT_STRETCH = /^(\d{1,3}(?:\.\d)?)%(?: (\d{1,3}(?:\.\d)?)%)?$/

/** True for a CSS value with one number or two numbers from low to high, in a range. */
function isRange(match: RegExpExecArray | null, min: number, max: number): boolean {
    if (!match) return false
    const low = Number(match[1])
    const high = match[2] === undefined ? low : Number(match[2])
    return low >= min && high <= max && low <= high
}

function parseFace(raw: unknown): FontFaceRecord | null {
    if (!isRecord(raw)) return null
    const { hash, format, weight, style, stretch, size } = raw
    const valid =
        typeof hash === 'string' &&
        SHA_256_HEX.test(hash) &&
        typeof format === 'string' &&
        FONT_FORMATS.has(format) &&
        typeof weight === 'string' &&
        isRange(FONT_WEIGHT.exec(weight), 1, 1000) &&
        typeof style === 'string' &&
        FONT_STYLES.has(style) &&
        typeof stretch === 'string' &&
        isRange(FONT_STRETCH.exec(stretch), 50, 200) &&
        isCount(size) &&
        size <= MAX_FONT_FILE_BYTES
    if (!valid) return null
    return {
        hash,
        format: format as FontFaceRecord['format'],
        weight,
        style: style as FontFaceRecord['style'],
        stretch,
        size,
    }
}

/** Names each field. The name is text for the page, so it is cleaned as a name from a file. */
function parseFont(raw: Record<string, unknown>): SyncFontValue | null {
    const { name, fallback, faces, addedAt, updatedAt } = raw
    if (typeof name !== 'string' || typeof fallback !== 'string') return null
    if (!FONT_FALLBACKS.has(fallback) || !isTime(addedAt) || !isTime(updatedAt)) return null
    if (!Array.isArray(faces) || faces.length === 0 || faces.length > MAX_FONT_FACES) return null
    const parsed: FontFaceRecord[] = []
    for (const face of faces) {
        const value = parseFace(face)
        if (!value) return null
        parsed.push(value)
    }
    const cleanName = cleanFontName(name)
    if (!cleanName) return null
    return {
        name: cleanName,
        fallback: fallback as SyncFontValue['fallback'],
        faces: parsed,
        addedAt,
        updatedAt,
    }
}

/** The settings that sync. A different name from the server is not a setting of the app. */
export const SYNCED_SETTINGS: readonly string[] = ['fontId']

/** A font id is short. A font of a book has its family name in the id. */
const MAX_SETTING_LENGTH = 300

/** The record of a change from the server, or null when the change is not valid. */
export function fromChange(change: StoredChange): SyncItem | null {
    const { kind, key, updatedAt, deleted } = change
    // The server can keep kinds that this version does not use.
    if (
        kind !== 'book' &&
        kind !== 'progress' &&
        kind !== 'bookmark' &&
        kind !== 'highlight' &&
        kind !== 'font' &&
        kind !== 'setting'
    ) {
        return null
    }
    if (kind === 'font' && !FONT_ID.test(key)) return null
    if (kind === 'setting' && !SYNCED_SETTINGS.includes(key)) return null
    if (deleted) return { kind, key, updatedAt, deleted: true, value: null }
    // A later version of the app can write a format that this version cannot read.
    if (change.format !== DATA_FORMAT || change.data === null) return null
    let raw: unknown
    try {
        raw = JSON.parse(change.data)
    } catch {
        return null
    }
    if (!isRecord(raw)) return null

    if (kind === 'book') {
        if (!SHA_256_HEX.test(key)) return null
        const value = parseBook(raw, key)
        return value && { kind, key, updatedAt, deleted: false, value }
    }
    if (kind === 'font') {
        const value = parseFont(raw)
        return value && { kind, key, updatedAt, deleted: false, value }
    }
    if (kind === 'setting') {
        // The settings store checks the value again, as it does with the saved settings.
        const { value } = raw
        if (typeof value !== 'string' || value === '' || value.length > MAX_SETTING_LENGTH) {
            return null
        }
        return { kind, key, updatedAt, deleted: false, value: { value } }
    }

    const { fileHash } = raw
    if (typeof fileHash !== 'string' || !SHA_256_HEX.test(fileHash)) return null

    if (kind === 'progress') {
        const locator = parseLocator(raw.locator)
        const { fraction } = raw
        const time = raw.updatedAt
        if (fileHash !== key || !locator || !isFraction(fraction) || !isTime(time)) return null
        return {
            kind,
            key,
            updatedAt,
            deleted: false,
            value: { fileHash, locator, fraction, updatedAt: time },
        }
    }
    if (kind === 'bookmark') {
        const bookmark = parseBookmark(raw)
        if (!bookmark || bookmark.id !== key) return null
        return { kind, key, updatedAt, deleted: false, value: { ...bookmark, fileHash } }
    }
    const highlight = parseHighlight(raw)
    if (!highlight || highlight.id !== key) return null
    return { kind, key, updatedAt, deleted: false, value: { ...highlight, fileHash } }
}
