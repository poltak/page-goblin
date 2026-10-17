/**
 * Records of the IndexedDB database and the interface of the library storage.
 *
 * Database name: `page-goblin`. Object stores:
 * - `books`      key `id`. Small records for the library view. No file data, no cover data.
 * - `files`      key = book id. The original EPUB file as a Blob.
 * - `covers`     key = book id. A small cover image as a Blob.
 * - `progress`   key `bookId`. One record for each book.
 * - `bookmarks`  key `id`, index `bookId`.
 * - `highlights` key `id`, index `bookId`.
 * - `outbox`     key `id`. The changes that the sync did not send yet. See `OutboxEntry`.
 * - `syncState`  out-of-line keys. The state of the sync, for example its cursor.
 */

import type { HighlightColor, Locator } from '$lib/types'

export interface SpineStats {
    /** Estimated number of text characters in the content document. */
    chars: number
    /** Estimated number of words in the content document. */
    words: number
}

export interface BookRecord {
    /** `crypto.randomUUID()`. */
    id: string
    title: string
    author: string
    language: string | null
    identifier: string | null
    publisher: string | null
    description: string | null
    published: string | null
    subjects: string[]
    series: { name: string; position: number | null } | null
    fileName: string
    /** File size in bytes. */
    fileSize: number
    /** SHA-256 of the file as lower-case hex. The import uses it to find a duplicate. */
    fileHash: string
    hasCover: boolean
    /** One entry for each item of `EpubBook.spine`, in the same order. */
    spineStats: SpineStats[]
    totalChars: number
    totalWords: number
    /** Epoch milliseconds. */
    addedAt: number
    /** Epoch milliseconds, or null when the book was never opened. */
    lastOpenedAt: number | null
    /**
     * True when the file of the book is not on this device. The sync made the record from the
     * server, and it downloads the file when the book opens. A record with no such field has
     * its file.
     */
    remoteOnly?: boolean
}

export interface ProgressRecord {
    bookId: string
    locator: Locator
    /** Position in the whole book from 0 to 1. */
    fraction: number
    /** Epoch milliseconds. */
    updatedAt: number
}

export interface BookmarkRecord {
    id: string
    bookId: string
    locator: Locator
    /** Position in the whole book from 0 to 1. */
    fraction: number
    chapterTitle: string
    /** The first words at the bookmark, for the list. */
    excerpt: string
    createdAt: number
}

export interface HighlightRecord {
    id: string
    bookId: string
    spineIndex: number
    start: number
    /** Exclusive. */
    end: number
    /** The highlighted text, with white space collapsed. */
    text: string
    color: HighlightColor
    /** Empty string when there is no note. */
    note: string
    chapterTitle: string
    /** Position of `start` in the whole book from 0 to 1. */
    fraction: number
    createdAt: number
    updatedAt: number
}

export interface NewBook {
    record: BookRecord
    file: Blob
    cover: Blob | null
}

/** A kind of record that the sync copies between devices. */
export type SyncRecordKind = 'book' | 'progress' | 'bookmark' | 'highlight'

/**
 * One change on this device that the sync did not send yet. The storage writes it in the same
 * transaction as the change, and only while the sync is on.
 *
 * Kind 'file' asks the sync to upload the file and the cover of a book.
 */
export interface OutboxEntry {
    /** `${kind}:${key}`. A later change of the same record replaces the entry. */
    id: string
    kind: SyncRecordKind | 'file'
    /**
     * The key of the record on all devices. A book has a different `id` on each device, so a
     * book, its progress and its file use the file hash. A bookmark and a highlight use their
     * own id.
     */
    key: string
    deleted: boolean
    /**
     * The version of the change in epoch milliseconds. The newer change wins on the server.
     * It is the time of the record itself where the record has one: `updatedAt` of progress
     * and highlights, `createdAt` of bookmarks.
     */
    changedAt: number
}

/** A book as the sync sends it. The local id and the file state stay on the device. */
export type SyncBookValue = Omit<BookRecord, 'id' | 'remoteOnly'>
/** Progress, a bookmark and a highlight name their book by the file hash. */
export type SyncProgressValue = Omit<ProgressRecord, 'bookId'> & { fileHash: string }
export type SyncBookmarkValue = Omit<BookmarkRecord, 'bookId'> & { fileHash: string }
export type SyncHighlightValue = Omit<HighlightRecord, 'bookId'> & { fileHash: string }

export interface SyncValues {
    book: SyncBookValue
    progress: SyncProgressValue
    bookmark: SyncBookmarkValue
    highlight: SyncHighlightValue
}

/** A record as the sync sends and receives it. `key` is the key of `OutboxEntry`. */
export type SyncItem =
    | {
          [K in SyncRecordKind]: {
              kind: K
              key: string
              /** The version. See `OutboxEntry.changedAt`. */
              updatedAt: number
              deleted: false
              value: SyncValues[K]
          }
      }[SyncRecordKind]
    | { kind: SyncRecordKind; key: string; updatedAt: number; deleted: true; value: null }

/** The state of the sync on this device, in the `syncState` store. */
export interface SyncState {
    /** The id of the account on the server. A different id means that the server started again. */
    account: string
    /** The sequence number of the last server change that this device has. */
    cursor: number
}

/** Tells the storage when to write the outbox. */
export interface ChangeTracker {
    /** True while the sync is on. */
    isOn(): boolean
    /** Runs after a transaction that wrote to the outbox is complete. */
    onChange(): void
}

/**
 * All methods run one transaction and settle when that transaction completes or aborts.
 * When the browser closed the connection, a method opens the database again one time.
 */
export interface LibraryStorage {
    listBooks(): Promise<BookRecord[]>
    getBook(id: string): Promise<BookRecord | undefined>
    findBookByHash(fileHash: string): Promise<BookRecord | undefined>
    /** Writes the record, the file and the cover in one transaction. */
    addBook(book: NewBook): Promise<void>
    /**
     * Merges `patch` into the record. Does nothing when the book is not there. A change of
     * `lastOpenedAt` only does not go to the sync.
     */
    updateBook(id: string, patch: Partial<Omit<BookRecord, 'id'>>): Promise<void>
    /** Removes the book with its file, cover, progress, bookmarks and highlights in one transaction. */
    deleteBook(id: string): Promise<void>
    getFile(id: string): Promise<Blob | undefined>
    getCover(id: string): Promise<Blob | undefined>

    listProgress(): Promise<ProgressRecord[]>
    getProgress(bookId: string): Promise<ProgressRecord | undefined>
    saveProgress(progress: ProgressRecord): Promise<void>

    listBookmarks(bookId: string): Promise<BookmarkRecord[]>
    putBookmark(bookmark: BookmarkRecord): Promise<void>
    deleteBookmark(id: string): Promise<void>

    listHighlights(bookId: string): Promise<HighlightRecord[]>
    putHighlight(highlight: HighlightRecord): Promise<void>
    deleteHighlight(id: string): Promise<void>

    /** Close the connection. The next call opens it again. */
    close(): void
}
