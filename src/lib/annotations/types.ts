/**
 * Contract of the annotations module: export of highlights and the backup file.
 */

import type {
    BookmarkRecord,
    BookRecord,
    HighlightRecord,
    LibraryStorage,
} from '$lib/storage/types'
import type { Locator } from '$lib/types'

/** A bookmark in a backup file. The book is known from the entry that holds it. */
export type BackupBookmark = Omit<BookmarkRecord, 'bookId'>

/** A highlight in a backup file. */
export type BackupHighlight = Omit<HighlightRecord, 'bookId'>

export interface BackupBook {
    /** SHA-256 of the EPUB file. The restore finds the book on the other device with it. */
    fileHash: string
    title: string
    author: string
    progress: { locator: Locator; fraction: number; updatedAt: number } | null
    bookmarks: BackupBookmark[]
    highlights: BackupHighlight[]
}

/** The JSON file that holds the positions and annotations of all books. It has no book files. */
export interface BackupFile {
    format: 'page-goblin-backup'
    version: 1
    /** ISO 8601 date and time. */
    exportedAt: string
    books: BackupBook[]
}

export interface RestoreResult {
    /** Books of the backup that are in this library. */
    booksMatched: number
    /** Books of the backup that are not in this library. Their data is not restored. */
    booksMissing: number
    bookmarksAdded: number
    highlightsAdded: number
    highlightsUpdated: number
    progressUpdated: number
}

export interface ExportSource {
    book: Pick<BookRecord, 'title' | 'author'>
    /** Sorted by position. */
    highlights: readonly HighlightRecord[]
    /** Sorted by position. */
    bookmarks?: readonly BookmarkRecord[]
}

export type BackupStorage = Pick<
    LibraryStorage,
    | 'listBooks'
    | 'listProgress'
    | 'getProgress'
    | 'saveProgress'
    | 'listBookmarks'
    | 'putBookmark'
    | 'listHighlights'
    | 'putHighlight'
>
