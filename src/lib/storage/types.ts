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
    /** Merges `patch` into the record. Does nothing when the book is not there. */
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
