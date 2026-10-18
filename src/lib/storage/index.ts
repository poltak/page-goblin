/**
 * Public interface of the storage module.
 *
 * Only the import of a book needs `importBook`, `estimateTextStats` and `makeCoverThumbnail`.
 * To keep them out of the first load, load `$lib/storage/import` with a dynamic import and do
 * not take `importBook` from this file.
 */

export { DATABASE_NAME, DATABASE_VERSION } from './db'
export { createLibraryStorage } from './library-storage'
export type { LibraryFileStorage, LibraryStorageOptions } from './library-storage'
export { importBook } from './import'
export type { ImportBookOptions, ImportPhase, ImportProgress, ImportResult } from './import'
export { estimateTextStats } from './text-stats'
export { makeCoverThumbnail } from './cover'
export { createId } from './crypto'
export { getStorageEstimate, isQuotaError, requestPersistentStorage } from './storage-info'
export type { StorageEstimate } from './storage-info'
export { bookFraction, locateFraction, wordsRemaining } from './progress'
export type {
    BookPosition,
    ChapterPosition,
    LocateFractionOptions,
    WordsRemaining,
} from './progress'
export type {
    BookmarkRecord,
    BookRecord,
    FontFaceRecord,
    FontRecord,
    HighlightRecord,
    LibraryStorage,
    NewBook,
    NewFont,
    ProgressRecord,
    SpineStats,
} from './types'
