/**
 * The backup file for reading positions, bookmarks and highlights.
 *
 * A backup has no book files. The restore finds each book in the library by the hash of its
 * file, so the user adds the books on the other device first. The restore merges and never
 * deletes, so a second restore of the same file changes nothing.
 */

import type {
    BookmarkRecord,
    BookRecord,
    HighlightRecord,
    ProgressRecord,
} from '$lib/storage/types'
import { HIGHLIGHT_COLORS } from '$lib/types'
import type { HighlightColor, Locator } from '$lib/types'
import { clampFraction } from './shared'
import type {
    BackupBook,
    BackupBookmark,
    BackupFile,
    BackupHighlight,
    BackupStorage,
    RestoreResult,
} from './types'

export const BACKUP_FORMAT = 'web-ereader-backup'
export const BACKUP_VERSION = 1

const NOT_A_BACKUP = 'This file is not a Web eReader backup.'
const SHA_256_HEX = /^[0-9a-f]{64}$/
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/
/**
 * The application makes UUIDs. Other characters are not necessary, and an id from a file can
 * go into the page as an attribute or a key.
 */
const RECORD_ID = /^[\w.:-]{1,128}$/
/** The largest time that a Date can hold. */
const MAX_TIME = 8.64e15
/** The storage runs one transaction for each call. This limits how many run at the same time. */
const BATCH_SIZE = 32

export interface CreateBackupOptions {
    storage: BackupStorage
    /** Gives the time of the export in epoch milliseconds. The default is `Date.now`. */
    now?: () => number
}

export interface RestoreBackupOptions {
    storage: BackupStorage
    /** The content of a backup file: the JSON text or the parsed value. It is not trusted. */
    backup: unknown
}

interface Annotations {
    bookmarks: BookmarkRecord[]
    highlights: HighlightRecord[]
}

async function mapInBatches<T, R>(
    items: readonly T[],
    work: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = []
    for (let start = 0; start < items.length; start += BATCH_SIZE) {
        const batch = items.slice(start, start + BATCH_SIZE)
        results.push(...(await Promise.all(batch.map(work))))
    }
    return results
}

/** The bookmarks and highlights of each book, in the order of `books`. */
function readAnnotations(
    storage: BackupStorage,
    books: readonly BookRecord[],
): Promise<Annotations[]> {
    return mapInBatches(books, async (book) => {
        const [bookmarks, highlights] = await Promise.all([
            storage.listBookmarks(book.id),
            storage.listHighlights(book.id),
        ])
        return { bookmarks, highlights }
    })
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

// The functions below name each field, so a field that is not in the contract cannot go into
// the file. They also put each fraction into the range from 0 to 1, because the restore drops a
// record with a fraction out of that range.

function toBackupProgress(progress: ProgressRecord | undefined): BackupBook['progress'] {
    if (!progress) return null
    const { spineIndex, offset } = progress.locator
    return {
        locator: { spineIndex, offset },
        fraction: clampFraction(progress.fraction),
        updatedAt: progress.updatedAt,
    }
}

function toBackupBookmark(bookmark: BookmarkRecord): BackupBookmark {
    const { spineIndex, offset } = bookmark.locator
    return {
        id: bookmark.id,
        locator: { spineIndex, offset },
        fraction: clampFraction(bookmark.fraction),
        chapterTitle: bookmark.chapterTitle,
        excerpt: bookmark.excerpt,
        createdAt: bookmark.createdAt,
    }
}

function toBackupHighlight(highlight: HighlightRecord): BackupHighlight {
    return {
        id: highlight.id,
        spineIndex: highlight.spineIndex,
        start: highlight.start,
        end: highlight.end,
        text: highlight.text,
        color: highlight.color,
        note: highlight.note,
        chapterTitle: highlight.chapterTitle,
        fraction: clampFraction(highlight.fraction),
        createdAt: highlight.createdAt,
        updatedAt: highlight.updatedAt,
    }
}

/**
 * Reads the position, the bookmarks and the highlights of each book. A book that has none of
 * them is not in the backup. The books are in title order.
 */
export async function createBackup({
    storage,
    now = Date.now,
}: CreateBackupOptions): Promise<BackupFile> {
    const [books, progress] = await Promise.all([storage.listBooks(), storage.listProgress()])
    const progressOf = new Map(progress.map((record) => [record.bookId, record]))
    const annotations = await readAnnotations(storage, books)

    const entries: BackupBook[] = []
    for (const [index, book] of books.entries()) {
        const { bookmarks, highlights } = annotations[index]
        const position = progressOf.get(book.id)
        if (!position && bookmarks.length === 0 && highlights.length === 0) continue
        entries.push({
            fileHash: book.fileHash,
            title: book.title,
            author: book.author,
            progress: toBackupProgress(position),
            bookmarks: bookmarks.map(toBackupBookmark),
            highlights: highlights.map(toBackupHighlight),
        })
    }
    entries.sort((a, b) => compareText(a.title, b.title) || compareText(a.fileHash, b.fileHash))

    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date(now()).toISOString(),
        books: entries,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A spine index or a text offset. */
function isCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

// The comparisons below are false for NaN and for an infinite number. JSON text can give an
// infinite number: `1e999` parses to Infinity.

function isFraction(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1
}

function isTime(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= MAX_TIME
}

function isId(value: unknown): value is string {
    return typeof value === 'string' && RECORD_ID.test(value)
}

function isColor(value: unknown): value is HighlightColor {
    return typeof value === 'string' && (HIGHLIGHT_COLORS as readonly string[]).includes(value)
}

function parseLocator(raw: unknown): Locator | null {
    if (!isRecord(raw)) return null
    const { spineIndex, offset } = raw
    return isCount(spineIndex) && isCount(offset) ? { spineIndex, offset } : null
}

function parseProgress(raw: unknown): BackupBook['progress'] {
    if (!isRecord(raw)) return null
    const locator = parseLocator(raw.locator)
    const { fraction, updatedAt } = raw
    return locator && isFraction(fraction) && isTime(updatedAt)
        ? { locator, fraction, updatedAt }
        : null
}

function parseBookmark(raw: unknown): BackupBookmark | null {
    if (!isRecord(raw)) return null
    const locator = parseLocator(raw.locator)
    const { id, fraction, chapterTitle, excerpt, createdAt } = raw
    const valid =
        locator &&
        isId(id) &&
        isFraction(fraction) &&
        typeof chapterTitle === 'string' &&
        typeof excerpt === 'string' &&
        isTime(createdAt)
    return valid ? { id, locator, fraction, chapterTitle, excerpt, createdAt } : null
}

function parseHighlight(raw: unknown): BackupHighlight | null {
    if (!isRecord(raw)) return null
    const { id, spineIndex, start, end, text, color, note } = raw
    const { chapterTitle, fraction, createdAt, updatedAt } = raw
    const valid =
        isId(id) &&
        isCount(spineIndex) &&
        isCount(start) &&
        isCount(end) &&
        start < end &&
        typeof text === 'string' &&
        isColor(color) &&
        typeof note === 'string' &&
        typeof chapterTitle === 'string' &&
        isFraction(fraction) &&
        isTime(createdAt) &&
        isTime(updatedAt)
    return valid
        ? {
              id,
              spineIndex,
              start,
              end,
              text,
              color,
              note,
              chapterTitle,
              fraction,
              createdAt,
              updatedAt,
          }
        : null
}

/** The valid entries of `raw` with ids that are not in `seenIds`. It adds their ids to the set. */
function parseEntries<T extends { id: string }>(
    raw: unknown[],
    { parse, seenIds }: { parse: (raw: unknown) => T | null; seenIds: Set<string> },
): T[] {
    const entries: T[] = []
    for (const item of raw) {
        const entry = parse(item)
        if (!entry || seenIds.has(entry.id)) continue
        seenIds.add(entry.id)
        entries.push(entry)
    }
    return entries
}

/** The date and time in the form that `Date.prototype.toISOString` gives, or null. */
function parseExportedAt(raw: unknown): string | null {
    // Date.parse reads other forms in a different way in each browser, so only this form passes.
    if (typeof raw !== 'string' || !ISO_DATE_TIME.test(raw)) return null
    const time = Date.parse(raw)
    return isTime(time) ? new Date(time).toISOString() : null
}

/**
 * Validates the content of a backup file. The input is the JSON text or the parsed value.
 *
 * The result has only the fields of the contract. An entry (a book, a position, a bookmark or a
 * highlight) with a field that is missing or has a wrong type or value is not in the result. An
 * entry that repeats the file hash or the id of an earlier entry is also not in the result, so a
 * restore never writes one key two times.
 *
 * @throws An Error when the input is not a backup of this application.
 */
export function parseBackup(raw: unknown): BackupFile {
    let file = raw
    if (typeof raw === 'string') {
        try {
            file = JSON.parse(raw)
        } catch {
            throw new Error(NOT_A_BACKUP)
        }
    }
    if (!isRecord(file) || file.format !== BACKUP_FORMAT || file.version !== BACKUP_VERSION) {
        throw new Error(NOT_A_BACKUP)
    }
    const exportedAt = parseExportedAt(file.exportedAt)
    if (exportedAt === null || !Array.isArray(file.books)) throw new Error(NOT_A_BACKUP)

    const fileHashes = new Set<string>()
    const bookmarkIds = new Set<string>()
    const highlightIds = new Set<string>()
    const books: BackupBook[] = []
    for (const item of file.books) {
        if (!isRecord(item)) continue
        const { fileHash, title, author, bookmarks, highlights } = item
        const valid =
            typeof fileHash === 'string' &&
            SHA_256_HEX.test(fileHash) &&
            !fileHashes.has(fileHash) &&
            typeof title === 'string' &&
            typeof author === 'string' &&
            Array.isArray(bookmarks) &&
            Array.isArray(highlights)
        if (!valid) continue
        fileHashes.add(fileHash)
        books.push({
            fileHash,
            title,
            author,
            progress: parseProgress(item.progress),
            bookmarks: parseEntries(bookmarks, { parse: parseBookmark, seenIds: bookmarkIds }),
            highlights: parseEntries(highlights, { parse: parseHighlight, seenIds: highlightIds }),
        })
    }
    return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, books }
}

function locatorKey({ spineIndex, offset }: Locator): string {
    return `${spineIndex}:${offset}`
}

/**
 * Merges a backup into the library. Books match by file hash. Data of a book that is not in the
 * library is not restored.
 *
 * - A bookmark is added when its id is not in use and its book has no bookmark at that position.
 * - A highlight is added when its id is not in use. It replaces the stored highlight with the
 *   same id when the backup has the later change.
 * - A position is written when the book has none or the backup has the later one.
 *
 * Each record gets the id of the local book. A record that points to a spine item that the
 * local book does not have is ignored. The writes are not one transaction: when one of them
 * fails, the promise rejects and the earlier writes stay. It is safe to run the restore again.
 *
 * @throws An Error when the input is not a backup of this application.
 */
export async function restoreBackup({
    storage,
    backup,
}: RestoreBackupOptions): Promise<RestoreResult> {
    const file = parseBackup(backup)
    const result: RestoreResult = {
        booksMatched: 0,
        booksMissing: 0,
        bookmarksAdded: 0,
        highlightsAdded: 0,
        highlightsUpdated: 0,
        progressUpdated: 0,
    }
    if (file.books.length === 0) return result

    const [books, progress] = await Promise.all([storage.listBooks(), storage.listProgress()])
    const progressOf = new Map(progress.map((record) => [record.bookId, record]))
    const annotations = await readAnnotations(storage, books)

    // An id is the key of a record in the whole database. The ids of all books are necessary,
    // so that a record of the backup cannot replace a record of a different book.
    const localOf = new Map<string, { book: BookRecord; annotations: Annotations }>()
    const bookmarkIds = new Set<string>()
    const highlightIds = new Set<string>()
    for (const [index, book] of books.entries()) {
        localOf.set(book.fileHash, { book, annotations: annotations[index] })
        for (const bookmark of annotations[index].bookmarks) bookmarkIds.add(bookmark.id)
        for (const highlight of annotations[index].highlights) highlightIds.add(highlight.id)
    }

    const writes: (() => Promise<void>)[] = []
    for (const entry of file.books) {
        const match = localOf.get(entry.fileHash)
        if (!match) {
            result.booksMissing++
            continue
        }
        result.booksMatched++
        const local = match.annotations
        const bookId = match.book.id
        const spineLength = match.book.spineStats.length
        const isInBook = (spineIndex: number) => spineLength === 0 || spineIndex < spineLength

        const stored = progressOf.get(bookId)
        const position = entry.progress
        if (
            position &&
            isInBook(position.locator.spineIndex) &&
            (!stored || position.updatedAt > stored.updatedAt)
        ) {
            writes.push(async () => {
                await storage.saveProgress({ ...position, bookId })
                result.progressUpdated++
            })
        }

        const positions = new Set(local.bookmarks.map((bookmark) => locatorKey(bookmark.locator)))
        for (const bookmark of entry.bookmarks) {
            const key = locatorKey(bookmark.locator)
            if (!isInBook(bookmark.locator.spineIndex)) continue
            if (bookmarkIds.has(bookmark.id) || positions.has(key)) continue
            positions.add(key)
            writes.push(async () => {
                await storage.putBookmark({ ...bookmark, bookId })
                result.bookmarksAdded++
            })
        }

        const updatedAtOf = new Map(
            local.highlights.map((highlight) => [highlight.id, highlight.updatedAt]),
        )
        for (const highlight of entry.highlights) {
            if (!isInBook(highlight.spineIndex)) continue
            const storedUpdatedAt = updatedAtOf.get(highlight.id)
            if (storedUpdatedAt === undefined) {
                // The id is in use by a highlight of a different book.
                if (highlightIds.has(highlight.id)) continue
                writes.push(async () => {
                    await storage.putHighlight({ ...highlight, bookId })
                    result.highlightsAdded++
                })
            } else if (highlight.updatedAt > storedUpdatedAt) {
                writes.push(async () => {
                    await storage.putHighlight({ ...highlight, bookId })
                    result.highlightsUpdated++
                })
            }
        }
    }

    await mapInBatches(writes, (write) => write())
    return result
}
