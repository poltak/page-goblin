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
 * - `syncState`  out-of-line keys. The state of the sync: its cursor at key `state`, and the
 *                copy of each setting that syncs at key `setting:` + the name of the setting.
 * - `fonts`      key `id`. One record for each font family that the user added.
 * - `fontFiles`  key = SHA-256 of the file. The font files as Blobs. Families share a file.
 */

import type { FontFallback, FontFormat, FontStyle } from '$lib/fonts/sfnt'
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

/** One file of a font family, for example the bold italic. */
export interface FontFaceRecord {
    /** SHA-256 of the file as lower-case hex. The key of the file in `fontFiles`. */
    hash: string
    format: FontFormat
    /** A CSS `font-weight` value: '400', or '100 900' for a variable font. */
    weight: string
    style: FontStyle
    /** A CSS `font-stretch` value: '100%', or '75% 100%' for a variable font. */
    stretch: string
    /** File size in bytes. */
    size: number
}

/** A font family that the user added. */
export interface FontRecord {
    /** `crypto.randomUUID()`. The same on all devices. */
    id: string
    /** The name in the font menu. It comes from the font file, and the user can change it. */
    name: string
    /** The generic family that shows the characters that the font does not have. */
    fallback: FontFallback
    faces: FontFaceRecord[]
    /** Epoch milliseconds. */
    addedAt: number
    /** Epoch milliseconds of the last change. */
    updatedAt: number
}

export interface NewFont {
    record: FontRecord
    /** The files of the faces by hash. A file that the storage has already can be left out. */
    files: ReadonlyMap<string, Blob>
}

/** A kind of record that the sync copies between devices. */
export type SyncRecordKind = 'book' | 'progress' | 'bookmark' | 'highlight' | 'font' | 'setting'

/** The settings that sync. The other settings stay on each device. */
export type SyncedSettingName = 'fontId'

/**
 * The copy of a setting that syncs, in the `syncState` store. The settings themselves are in
 * localStorage. The copy has the time of the last change, so the newer change wins.
 */
export interface SyncedSetting {
    value: string
    /** Epoch milliseconds. */
    updatedAt: number
}

/**
 * One change on this device that the sync did not send yet. The storage writes it in the same
 * transaction as the change, and only while the sync is on.
 *
 * Kind 'file' asks the sync to upload the file and the cover of a book. Kind 'fontFile' asks it
 * to upload a font file. Its key is the SHA-256 of the file.
 */
export interface OutboxEntry {
    /** `${kind}:${key}`. A later change of the same record replaces the entry. */
    id: string
    kind: SyncRecordKind | 'file' | 'fontFile'
    /**
     * The key of the record on all devices. A book has a different `id` on each device, so a
     * book, its progress and its file use the file hash. A bookmark, a highlight and a font
     * use their own id.
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
/** A font family has the same id on all devices. The key of the change is that id. */
export type SyncFontValue = Omit<FontRecord, 'id'>
/** The key of the change is the name of the setting. */
export interface SyncSettingValue {
    value: string
}

export interface SyncValues {
    book: SyncBookValue
    progress: SyncProgressValue
    bookmark: SyncBookmarkValue
    highlight: SyncHighlightValue
    font: SyncFontValue
    setting: SyncSettingValue
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
    /**
     * The kinds that the cursor covers: the kinds that this device and the server both keep,
     * at the last pull. A state with no list covers the first four kinds. The sync sends only
     * these kinds, because a server refuses a whole push with a kind that it does not keep.
     */
    kinds?: SyncRecordKind[]
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

    /** The font families that have all their files on this device. */
    listFonts(): Promise<FontRecord[]>
    getFontFile(hash: string): Promise<Blob | undefined>
    /**
     * Writes a font family and the new files of its faces in one transaction, and removes the
     * files that no family uses after the write. Rejects and writes nothing when a face has no
     * file in `files` and none in storage.
     */
    putFont(font: NewFont): Promise<void>
    /** Removes the family, and the files that no other family uses. */
    deleteFont(id: string): Promise<void>

    /**
     * Keeps a copy of a setting that syncs and puts it in the outbox, in one transaction. Does
     * nothing while the sync is off, and for the value that the copy has already. So a value
     * from the server, or from a different tab, does not go back to the server.
     */
    putSyncedSetting(setting: { name: SyncedSettingName; value: string }): Promise<void>

    /** Close the connection. The next call opens it again. */
    close(): void
}
