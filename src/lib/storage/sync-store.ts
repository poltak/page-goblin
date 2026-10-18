/**
 * The transactions of the sync on the library database. The sync module loads this file at its
 * first use, so it is not in the first chunk.
 *
 * A write here does not write the outbox: a change from the server must not go back to it.
 */

import { createId } from './crypto'
import type { Database, StoreName } from './db'
import { outboxEntry, removeUnusedFontFiles, syncedSettingKey, withFile } from './library-storage'
import type {
    BookmarkRecord,
    BookRecord,
    FontRecord,
    HighlightRecord,
    OutboxEntry,
    ProgressRecord,
    SyncBookValue,
    SyncedSetting,
    SyncedSettingName,
    SyncFontValue,
    SyncItem,
    SyncRecordKind,
    SyncState,
    SyncValues,
} from './types'

const STATE_KEY = 'state'

/**
 * The order of the changes in a push and of the writes of a pull. A book comes before its
 * progress and notes, so a device that pulls between two pushes has the book first.
 */
const KIND_ORDER: Record<OutboxEntry['kind'], number> = {
    book: 0,
    file: 1,
    progress: 2,
    bookmark: 3,
    highlight: 4,
    font: 5,
    fontFile: 6,
    setting: 7,
}

/** The kinds of outbox entry that are uploads of files and not records. */
const UPLOAD_KINDS = new Set<OutboxEntry['kind']>(['file', 'fontFile'])

/** The kinds that a server with no list of kinds keeps. */
export const FIRST_SYNC_KINDS: readonly SyncRecordKind[] = [
    'book',
    'progress',
    'bookmark',
    'highlight',
]

export interface OutboxFile {
    entry: OutboxEntry
    bookId: string
    hasCover: boolean
}

export interface OutboxBatch {
    /** The changes to send. Each has the value that the record has now. */
    changes: { entry: OutboxEntry; item: SyncItem }[]
    /** The books whose file and cover must go to the server. */
    files: OutboxFile[]
    /** The font files that must go to the server. The key of each entry is the hash. */
    fontFiles: OutboxEntry[]
    /** Entries whose record is not in the library any more. Remove them. */
    stale: OutboxEntry[]
}

export interface ApplyResult {
    /** Local ids of the books that were added, changed or removed, also by their progress. */
    books: string[]
    /** Progress from the server that is now in storage. */
    progress: ProgressRecord[]
    /** Local ids of the books whose bookmarks or highlights changed. */
    annotations: string[]
    /** True when a font family or a font file changed. */
    fonts?: boolean
    /** The settings that a different device changed. The app writes them to its settings. */
    settings?: Partial<Record<SyncedSettingName, string>>
}

export interface ApplyRemoteOptions {
    items: readonly SyncItem[]
    /** Written in the same transaction, so the cursor always agrees with the data. */
    state?: SyncState
}

export interface SyncStore {
    readState(): Promise<SyncState | undefined>
    writeState(state: SyncState): Promise<void>
    /** Puts an entry in the outbox for each record of the library that has none. */
    seedOutbox(): Promise<void>
    /**
     * The first `limit` record entries of the outbox, books first, with the values of their
     * records. Also the first `limit` file entries, the oldest first. Only the entries of
     * `kinds` come. The other entries stay for a server that keeps their kind. The default is
     * each kind.
     */
    readOutbox(limit: number, kinds?: readonly SyncRecordKind[]): Promise<OutboxBatch>
    /** Moves a file entry to the end of the uploads, after an upload that failed. */
    postponeUpload(entry: OutboxEntry, now: number): Promise<void>
    /** Removes the entries that did not change since `readOutbox`. */
    removeOutbox(entries: readonly OutboxEntry[]): Promise<void>
    /** Writes changes from the server. A newer change of this device in the outbox wins. */
    applyRemote(options: ApplyRemoteOptions): Promise<ApplyResult>
    /** Writes a file from the server. The book then has its file on this device. */
    storeFile(bookId: string, file: Blob): Promise<void>
    storeCover(bookId: string, cover: Blob): Promise<void>
    /** Writes a font file from the server. Does nothing when no font family uses it. */
    storeFontFile(hash: string, file: Blob): Promise<void>
    /** The hashes of the font files that families use and that are not on this device. */
    missingFontFiles(): Promise<string[]>
    /** The books that have a cover on the server and not on this device. */
    booksWithoutCover(): Promise<BookRecord[]>
    /**
     * Removes the file of a book from this device. The book stays in the library. Resolves
     * false and keeps the file when the server does not have the file yet.
     */
    removeDownload(bookId: string): Promise<boolean>
    /**
     * Ends the sync on this device: removes the state, the books that have no file here and
     * the font families that do not have all their files here. The outbox stays. Resolves
     * with the ids of the removed books.
     */
    reset(): Promise<string[]>
}

interface Version {
    updatedAt: number
    deleted: boolean
}

/** True when `a` wins over `b`. At the same time a delete wins. */
export function isNewer(a: Version, b: Version): boolean {
    return a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.deleted && !b.deleted)
}

function resultOf<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

interface AsyncRunOptions<T> {
    stores: StoreName | StoreName[]
    mode: IDBTransactionMode
    failureMessage: string
    /** It may wait only for requests of the transaction. Any other wait ends the transaction. */
    body: (transaction: IDBTransaction) => Promise<T>
}

async function runAsync<T>(database: Database, options: AsyncRunOptions<T>): Promise<T> {
    const { stores, mode, failureMessage, body } = options
    let bodyError: unknown = null
    try {
        return await database.run<T>({
            stores,
            mode,
            failureMessage,
            work: (transaction) => {
                let value: T
                body(transaction).then(
                    (result) => {
                        value = result
                    },
                    (error: unknown) => {
                        bodyError = error
                        try {
                            transaction.abort()
                        } catch {
                            // The transaction is already finished.
                        }
                    },
                )
                return () => value
            },
        })
    } catch (error) {
        throw bodyError ?? error
    }
}

function byKind(a: { kind: OutboxEntry['kind'] }, b: { kind: OutboxEntry['kind'] }): number {
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
}

function syncBook(book: BookRecord): SyncBookValue {
    const { id: _, remoteOnly: __, ...value } = book
    return value
}

function syncFont(font: FontRecord): SyncFontValue {
    const { id: _, ...value } = font
    return value
}

/** The kind of record that an outbox entry needs the server to keep. */
function recordKindOf(kind: OutboxEntry['kind']): SyncRecordKind {
    if (kind === 'file') return 'book'
    if (kind === 'fontFile') return 'font'
    return kind
}

function liveItem<K extends SyncRecordKind>(
    kind: K,
    key: string,
    updatedAt: number,
    value: SyncValues[K],
): SyncItem {
    // TypeScript cannot match a generic kind to one member of the union.
    return { kind, key, updatedAt, deleted: false, value } as SyncItem
}

const NOTE_STORE = { bookmark: 'bookmarks', highlight: 'highlights' } as const

/** Reads books by file hash and keeps them for the rest of the transaction. */
function bookFinder(books: IDBObjectStore) {
    const known = new Map<string, BookRecord | null>()
    return {
        async find(fileHash: string): Promise<BookRecord | null> {
            if (!known.has(fileHash)) {
                const book = await resultOf<BookRecord | undefined>(
                    books.index('fileHash').get(fileHash),
                )
                known.set(fileHash, book ?? null)
            }
            return known.get(fileHash)!
        },
        set(fileHash: string, book: BookRecord | null): void {
            known.set(fileHash, book)
        },
    }
}

/** Deletes a book with its file, cover, progress, bookmarks and highlights. */
async function deleteLocalBook(transaction: IDBTransaction, id: string): Promise<void> {
    for (const name of ['books', 'files', 'covers', 'progress']) {
        transaction.objectStore(name).delete(id)
    }
    for (const name of ['bookmarks', 'highlights']) {
        const store = transaction.objectStore(name)
        const keys = await resultOf(store.index('bookId').getAllKeys(id))
        for (const key of keys) store.delete(key)
    }
}

const ALL_STORES: StoreName[] = [
    'books',
    'files',
    'covers',
    'progress',
    'bookmarks',
    'highlights',
    'outbox',
    'syncState',
    'fonts',
    'fontFiles',
]

export function createSyncStore(database: Database): SyncStore {
    async function readOutboxIn(
        transaction: IDBTransaction,
        limit: number,
        kinds: readonly SyncRecordKind[] | undefined,
    ): Promise<OutboxBatch> {
        const outbox = transaction.objectStore('outbox')
        const books = bookFinder(transaction.objectStore('books'))
        const all = (await resultOf<OutboxEntry[]>(outbox.getAll())).filter(
            (entry) => !kinds || kinds.includes(recordKindOf(entry.kind)),
        )
        // Records and files have their own limit, so many waiting uploads cannot hold back a
        // reading position. The file that waited longest comes first.
        const records = all.filter((entry) => !UPLOAD_KINDS.has(entry.kind)).sort(byKind)
        const uploads = all
            .filter((entry) => UPLOAD_KINDS.has(entry.kind))
            .sort((a, b) => a.changedAt - b.changedAt)
        const entries = [...records.slice(0, limit), ...uploads.slice(0, limit)]
        const batch: OutboxBatch = { changes: [], files: [], fontFiles: [], stale: [] }

        for (const entry of entries) {
            const { kind, key, changedAt: updatedAt } = entry
            if (kind === 'file') {
                const book = await books.find(key)
                if (!book || book.remoteOnly) batch.stale.push(entry)
                else batch.files.push({ entry, bookId: book.id, hasCover: book.hasCover })
                continue
            }
            if (kind === 'fontFile') {
                const file = await resultOf(transaction.objectStore('fontFiles').getKey(key))
                if (file === undefined) batch.stale.push(entry)
                else batch.fontFiles.push(entry)
                continue
            }
            if (entry.deleted) {
                batch.changes.push({
                    entry,
                    item: { kind, key, updatedAt, deleted: true, value: null },
                })
                continue
            }

            let item: SyncItem | null = null
            if (kind === 'book') {
                const book = await books.find(key)
                if (book) item = liveItem(kind, key, updatedAt, syncBook(book))
            } else if (kind === 'font') {
                const font = await resultOf<FontRecord | undefined>(
                    transaction.objectStore('fonts').get(key),
                )
                if (font) item = liveItem(kind, key, updatedAt, syncFont(font))
            } else if (kind === 'setting') {
                const copy = await resultOf<SyncedSetting | undefined>(
                    transaction.objectStore('syncState').get(syncedSettingKey(key)),
                )
                if (copy) item = liveItem(kind, key, updatedAt, { value: copy.value })
            } else if (kind === 'progress') {
                const book = await books.find(key)
                const progress = book
                    ? await resultOf<ProgressRecord | undefined>(
                          transaction.objectStore('progress').get(book.id),
                      )
                    : undefined
                if (progress) {
                    const { bookId: _, ...rest } = progress
                    item = liveItem(kind, key, updatedAt, { ...rest, fileHash: key })
                }
            } else {
                const record = await resultOf<BookmarkRecord | HighlightRecord | undefined>(
                    transaction.objectStore(NOTE_STORE[kind]).get(key),
                )
                const book = record
                    ? await resultOf<BookRecord | undefined>(
                          transaction.objectStore('books').get(record.bookId),
                      )
                    : undefined
                if (record && book) {
                    const { bookId: _, ...rest } = record
                    const value = { ...rest, fileHash: book.fileHash } as SyncValues[typeof kind]
                    item = liveItem(kind, key, updatedAt, value)
                }
            }
            if (item) batch.changes.push({ entry, item })
            else batch.stale.push(entry)
        }
        return batch
    }

    async function applyIn(
        transaction: IDBTransaction,
        { items, state }: ApplyRemoteOptions,
    ): Promise<ApplyResult> {
        const outbox = transaction.objectStore('outbox')
        const booksStore = transaction.objectStore('books')
        const progressStore = transaction.objectStore('progress')
        const books = bookFinder(booksStore)
        const changedBooks = new Set<string>()
        const annotations = new Set<string>()
        const progress: ProgressRecord[] = []
        let fonts = false
        const settings: Partial<Record<SyncedSettingName, string>> = {}

        for (const item of [...items].sort(byKind)) {
            const pendingId = `${item.kind}:${item.key}`
            const pending = await resultOf<OutboxEntry | undefined>(outbox.get(pendingId))
            if (pending) {
                const local = { updatedAt: pending.changedAt, deleted: pending.deleted }
                // The change of this device is newer. The next push sends it.
                if (isNewer(local, item)) continue
                outbox.delete(pendingId)
            }

            if (item.kind === 'book') {
                const existing = await books.find(item.key)
                if (item.deleted) {
                    if (!existing) continue
                    await deleteLocalBook(transaction, existing.id)
                    books.set(item.key, null)
                    changedBooks.add(existing.id)
                    continue
                }
                if (existing) {
                    // The time of the last open on this device stays.
                    const next: BookRecord = {
                        ...existing,
                        ...item.value,
                        id: existing.id,
                        lastOpenedAt: existing.lastOpenedAt,
                    }
                    if (JSON.stringify(next) === JSON.stringify(existing)) continue
                    booksStore.put(next)
                    books.set(item.key, next)
                    changedBooks.add(existing.id)
                } else {
                    const record: BookRecord = { ...item.value, id: createId(), remoteOnly: true }
                    booksStore.add(record)
                    books.set(item.key, record)
                    changedBooks.add(record.id)
                }
                continue
            }

            if (item.kind === 'setting') {
                // A setting has no delete. Each device always has a value.
                if (item.deleted) continue
                const state = transaction.objectStore('syncState')
                const key = syncedSettingKey(item.key)
                const copy = await resultOf<SyncedSetting | undefined>(state.get(key))
                if (copy && copy.updatedAt >= item.updatedAt) continue
                const next: SyncedSetting = { value: item.value.value, updatedAt: item.updatedAt }
                state.put(next, key)
                if (copy?.value !== next.value) {
                    settings[item.key as SyncedSettingName] = next.value
                }
                continue
            }

            if (item.kind === 'font') {
                const store = transaction.objectStore('fonts')
                const current = await resultOf<FontRecord | undefined>(store.get(item.key))
                if (item.deleted) {
                    if (!current) continue
                    store.delete(item.key)
                } else {
                    if (current && current.updatedAt > item.value.updatedAt) continue
                    const record: FontRecord = { ...item.value, id: item.key }
                    if (JSON.stringify(record) === JSON.stringify(current)) continue
                    store.put(record)
                }
                // The files of the faces that the family does not have now.
                if (current)
                    removeUnusedFontFiles(
                        transaction,
                        current.faces.map((f) => f.hash),
                    )
                fonts = true
                continue
            }

            if (item.kind === 'progress') {
                const book = await books.find(item.key)
                if (!book) continue
                const current = await resultOf<ProgressRecord | undefined>(
                    progressStore.get(book.id),
                )
                if (item.deleted) {
                    if (!current) continue
                    progressStore.delete(book.id)
                    changedBooks.add(book.id)
                    continue
                }
                const { fileHash: _, ...rest } = item.value
                const record: ProgressRecord = { ...rest, bookId: book.id }
                if (current && current.updatedAt >= record.updatedAt) continue
                progressStore.put(record)
                progress.push(record)
                changedBooks.add(book.id)
                continue
            }

            const store = transaction.objectStore(NOTE_STORE[item.kind])
            const current = await resultOf<BookmarkRecord | HighlightRecord | undefined>(
                store.get(item.key),
            )
            if (item.deleted) {
                if (!current) continue
                store.delete(item.key)
                annotations.add(current.bookId)
                continue
            }
            const book = await books.find(item.value.fileHash)
            if (!book) continue
            // A bookmark does not change after it is made. A highlight has its own time.
            const currentTime = current && 'updatedAt' in current ? current.updatedAt : null
            if (currentTime !== null && currentTime > item.updatedAt) continue
            const { fileHash: _, ...rest } = item.value
            store.put({ ...rest, bookId: book.id })
            annotations.add(book.id)
        }

        if (state) transaction.objectStore('syncState').put(state, STATE_KEY)
        return {
            books: [...changedBooks],
            progress,
            annotations: [...annotations],
            fonts,
            settings,
        }
    }

    return {
        readState: () =>
            runAsync(database, {
                stores: 'syncState',
                mode: 'readonly',
                failureMessage: 'Unable to read the sync state.',
                body: async (transaction) =>
                    resultOf<SyncState | undefined>(
                        transaction.objectStore('syncState').get(STATE_KEY),
                    ),
            }),

        writeState: (state) =>
            database.run({
                stores: 'syncState',
                mode: 'readwrite',
                failureMessage: 'Unable to save the sync state.',
                work: (transaction) => {
                    transaction.objectStore('syncState').put(state, STATE_KEY)
                },
            }),

        seedOutbox: () =>
            runAsync(database, {
                stores: [
                    'books',
                    'progress',
                    'bookmarks',
                    'highlights',
                    'fonts',
                    'fontFiles',
                    'outbox',
                ],
                mode: 'readwrite',
                failureMessage: 'Unable to prepare the sync.',
                body: async (transaction) => {
                    const outbox = transaction.objectStore('outbox')
                    const [books, progress, bookmarks, highlights, fonts, fontFiles, keys] =
                        await Promise.all([
                            resultOf<BookRecord[]>(transaction.objectStore('books').getAll()),
                            resultOf<ProgressRecord[]>(
                                transaction.objectStore('progress').getAll(),
                            ),
                            resultOf<BookmarkRecord[]>(
                                transaction.objectStore('bookmarks').getAll(),
                            ),
                            resultOf<HighlightRecord[]>(
                                transaction.objectStore('highlights').getAll(),
                            ),
                            resultOf<FontRecord[]>(transaction.objectStore('fonts').getAll()),
                            resultOf(transaction.objectStore('fontFiles').getAllKeys()),
                            resultOf(outbox.getAllKeys()),
                        ])
                    const known = new Set(keys.map(String))
                    const add = (kind: OutboxEntry['kind'], key: string, changedAt: number) => {
                        const entry = outboxEntry(kind, key, { deleted: false, changedAt })
                        if (!known.has(entry.id)) outbox.put(entry)
                    }
                    const hashes = new Map<string, string>()
                    for (const book of books) {
                        hashes.set(book.id, book.fileHash)
                        add('book', book.fileHash, book.addedAt)
                        if (!book.remoteOnly) add('file', book.fileHash, book.addedAt)
                    }
                    for (const record of progress) {
                        const hash = hashes.get(record.bookId)
                        if (hash) add('progress', hash, record.updatedAt)
                    }
                    for (const record of bookmarks) {
                        if (hashes.has(record.bookId)) add('bookmark', record.id, record.createdAt)
                    }
                    for (const record of highlights) {
                        if (hashes.has(record.bookId)) add('highlight', record.id, record.updatedAt)
                    }
                    for (const font of fonts) add('font', font.id, font.updatedAt)
                    for (const hash of fontFiles) add('fontFile', String(hash), 0)
                },
            }),

        readOutbox: (limit, kinds) =>
            runAsync(database, {
                stores: [
                    'outbox',
                    'books',
                    'progress',
                    'bookmarks',
                    'highlights',
                    'fonts',
                    'fontFiles',
                    'syncState',
                ],
                mode: 'readonly',
                failureMessage: 'Unable to read the changes for the sync.',
                body: (transaction) => readOutboxIn(transaction, limit, kinds),
            }),

        postponeUpload: (entry, now) =>
            runAsync(database, {
                stores: 'outbox',
                mode: 'readwrite',
                failureMessage: 'Unable to update the changes for the sync.',
                body: async (transaction) => {
                    const outbox = transaction.objectStore('outbox')
                    const current = await resultOf<OutboxEntry | undefined>(outbox.get(entry.id))
                    if (current)
                        outbox.put({ ...current, changedAt: Math.max(now, current.changedAt) })
                },
            }),

        removeOutbox: (entries) =>
            runAsync(database, {
                stores: 'outbox',
                mode: 'readwrite',
                failureMessage: 'Unable to update the changes for the sync.',
                body: async (transaction) => {
                    const outbox = transaction.objectStore('outbox')
                    for (const entry of entries) {
                        const current = await resultOf<OutboxEntry | undefined>(
                            outbox.get(entry.id),
                        )
                        // A change during the push replaced the entry. It must go in the next push.
                        if (
                            current &&
                            current.changedAt === entry.changedAt &&
                            current.deleted === entry.deleted
                        ) {
                            outbox.delete(entry.id)
                        }
                    }
                },
            }),

        applyRemote: (options) =>
            runAsync(database, {
                stores: ALL_STORES,
                mode: 'readwrite',
                failureMessage: 'Unable to save the changes from the sync.',
                body: (transaction) => applyIn(transaction, options),
            }),

        storeFile: (bookId, file) =>
            runAsync(database, {
                stores: ['books', 'files'],
                mode: 'readwrite',
                failureMessage: 'Unable to save the book file.',
                body: async (transaction) => {
                    const books = transaction.objectStore('books')
                    const book = await resultOf<BookRecord | undefined>(books.get(bookId))
                    if (!book) return
                    transaction.objectStore('files').put(file, bookId)
                    books.put(withFile(book))
                },
            }),

        storeCover: (bookId, cover) =>
            runAsync(database, {
                stores: ['books', 'covers'],
                mode: 'readwrite',
                failureMessage: 'Unable to save the cover.',
                body: async (transaction) => {
                    const book = await resultOf(transaction.objectStore('books').getKey(bookId))
                    if (book !== undefined) transaction.objectStore('covers').put(cover, bookId)
                },
            }),

        storeFontFile: (hash, file) =>
            runAsync(database, {
                stores: ['fonts', 'fontFiles'],
                mode: 'readwrite',
                failureMessage: 'Unable to save the font file.',
                body: async (transaction) => {
                    const fonts = await resultOf<FontRecord[]>(
                        transaction.objectStore('fonts').getAll(),
                    )
                    // The family can be gone since the download started.
                    if (fonts.some((font) => font.faces.some((face) => face.hash === hash))) {
                        transaction.objectStore('fontFiles').put(file, hash)
                    }
                },
            }),

        missingFontFiles: () =>
            runAsync(database, {
                stores: ['fonts', 'fontFiles'],
                mode: 'readonly',
                failureMessage: 'Unable to read the fonts.',
                body: async (transaction) => {
                    const [fonts, keys] = await Promise.all([
                        resultOf<FontRecord[]>(transaction.objectStore('fonts').getAll()),
                        resultOf(transaction.objectStore('fontFiles').getAllKeys()),
                    ])
                    const present = new Set(keys.map(String))
                    const missing = new Set<string>()
                    for (const font of fonts) {
                        for (const { hash } of font.faces) if (!present.has(hash)) missing.add(hash)
                    }
                    return [...missing]
                },
            }),

        booksWithoutCover: () =>
            runAsync(database, {
                stores: ['books', 'covers'],
                mode: 'readonly',
                failureMessage: 'Unable to read the library.',
                body: async (transaction) => {
                    const [books, keys] = await Promise.all([
                        resultOf<BookRecord[]>(transaction.objectStore('books').getAll()),
                        resultOf(transaction.objectStore('covers').getAllKeys()),
                    ])
                    const covered = new Set(keys.map(String))
                    return books.filter((book) => book.hasCover && !covered.has(book.id))
                },
            }),

        removeDownload: (bookId) =>
            runAsync(database, {
                stores: ['books', 'files', 'outbox'],
                mode: 'readwrite',
                failureMessage: 'Unable to remove the download.',
                body: async (transaction) => {
                    const books = transaction.objectStore('books')
                    const book = await resultOf<BookRecord | undefined>(books.get(bookId))
                    if (!book) return false
                    const upload = await resultOf(
                        transaction.objectStore('outbox').getKey(`file:${book.fileHash}`),
                    )
                    if (upload !== undefined) return false
                    transaction.objectStore('files').delete(bookId)
                    books.put({ ...book, remoteOnly: true })
                    return true
                },
            }),

        reset: () =>
            runAsync(database, {
                stores: ALL_STORES,
                mode: 'readwrite',
                failureMessage: 'Unable to stop the sync.',
                body: async (transaction) => {
                    // The outbox stays. It can have changes that the server did not get yet,
                    // for example deletes, and they must go when the sync is on again.
                    transaction.objectStore('syncState').clear()
                    const books = await resultOf<BookRecord[]>(
                        transaction.objectStore('books').getAll(),
                    )
                    const removed: string[] = []
                    for (const book of books) {
                        if (!book.remoteOnly) continue
                        await deleteLocalBook(transaction, book.id)
                        removed.push(book.id)
                    }
                    // A family with a file that did not download cannot show.
                    const fontStore = transaction.objectStore('fonts')
                    const [fonts, keys] = await Promise.all([
                        resultOf<FontRecord[]>(fontStore.getAll()),
                        resultOf(transaction.objectStore('fontFiles').getAllKeys()),
                    ])
                    const present = new Set(keys.map(String))
                    for (const font of fonts) {
                        if (!font.faces.every((face) => present.has(face.hash))) {
                            fontStore.delete(font.id)
                        }
                    }
                    removeUnusedFontFiles(transaction, present)
                    return removed
                },
            }),
    }
}
