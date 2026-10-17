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
import type { SpineStats, SyncBookValue, SyncItem } from '$lib/storage/types'
import type { Change, StoredChange } from './types'

/** The format of `Change.data` that this version writes: the record as JSON text. */
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

/** The record of a change from the server, or null when the change is not valid. */
export function fromChange(change: StoredChange): SyncItem | null {
    const { kind, key, updatedAt, deleted } = change
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
