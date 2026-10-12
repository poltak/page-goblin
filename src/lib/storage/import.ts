import type { EpubBook } from '$lib/epub/types'
import { makeCoverThumbnail } from './cover'
import { createId, sha256Hex } from './crypto'
import type { LibraryFileStorage } from './library-storage'
import { estimateTextStats } from './text-stats'
import type { BookRecord, LibraryStorage, SpineStats } from './types'

export type ImportPhase = 'hash' | 'open' | 'cover' | 'measure' | 'save'

export interface ImportProgress {
    phase: ImportPhase
    /** Finished steps of this phase. Each phase starts with an event that has `done` 0. */
    done: number
    total: number
}

export interface ImportBookOptions {
    /** The EPUB file. The name of a `File` becomes `BookRecord.fileName`. */
    file: Blob
    /**
     * The storage of the app also has `getFile` and `putFile`. With these two, the import
     * repairs a book of the library whose stored file is missing.
     */
    storage: Pick<LibraryStorage, 'findBookByHash' | 'addBook'> &
        Partial<Pick<LibraryFileStorage, 'getFile' | 'putFile'>>
    /** Opens the EPUB container. It is an input so that this module does not load the parser. */
    open: (file: Blob) => Promise<EpubBook>
    onProgress?: (progress: ImportProgress) => void
    /** Epoch milliseconds. The default is `Date.now`. */
    now?: () => number
}

export interface ImportResult {
    book: BookRecord
    /**
     * True when the library already had this file. Then `book` is the record that was there.
     * If its stored file was missing, the library now has the file again.
     */
    duplicate: boolean
}

/** The longest time that the measure loop keeps the main thread. */
const YIELD_AFTER_MS = 12

function yieldToEventLoop(): Promise<void> {
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield()
    }
    return new Promise((resolve) => setTimeout(resolve, 0))
}

function fileNameOf(file: Blob): string {
    const name = (file as Partial<File>).name
    return typeof name === 'string' && name ? name : 'book.epub'
}

/**
 * Read the file one time. The result has the hash and a copy of the file in memory.
 *
 * A File from a file picker is a pointer to a file on the disk. That file can change or go
 * away before the browser stores it. The copy does not depend on it. The parser and the
 * storage use the copy, so they get the same bytes that the hash is for.
 */
async function readFile(file: Blob): Promise<{ fileHash: string; copy: Blob }> {
    const bytes = await file.arrayBuffer()
    return {
        fileHash: await sha256Hex(bytes),
        copy: new Blob([bytes], { type: file.type || 'application/epub+zip' }),
    }
}

async function readCover(book: EpubBook): Promise<Blob | null> {
    if (!book.coverPath) return null
    try {
        return await makeCoverThumbnail(await book.readBlob(book.coverPath))
    } catch {
        // A cover that cannot be read does not stop the import.
        return null
    }
}

interface StoredFileOptions {
    storage: ImportBookOptions['storage']
    /** The id of a book that is in the library. */
    id: string
    /** The copy of the file that the user added. It has the bytes of the stored file. */
    file: Blob
}

/** True when the library has the file of the book and the browser can read it. */
async function hasStoredFile({ storage, id, file }: StoredFileOptions): Promise<boolean> {
    try {
        const stored = await storage.getFile?.(id)
        // The two files have the same hash, so a different size is a file with lost data.
        if (!stored || stored.size !== file.size) return false
        // A browser can lose the data of a stored Blob. Then each read of the Blob rejects.
        await stored.slice(0, 1).arrayBuffer()
        return true
    } catch {
        return false
    }
}

/**
 * Write the file of a book of the library again when the stored file is missing or not
 * readable. The reader cannot open such a book and tells the user to add the book again.
 * The record, the reading position, the bookmarks and the highlights stay as they are.
 */
async function restoreStoredFile(options: StoredFileOptions): Promise<void> {
    const { storage, id, file } = options
    if (!storage.getFile || !storage.putFile) return
    if (await hasStoredFile(options)) return
    await storage.putFile(id, file)
}

/**
 * Add an EPUB file to the library. The storage gets the bytes of the file, a small cover image
 * and a small record for the library view.
 *
 * When the library has a book with the same bytes, the result is that book. The import then
 * only makes sure that the library has the file of the book.
 *
 * An `EpubError` from `open` and an error from the storage go to the caller.
 */
export async function importBook(options: ImportBookOptions): Promise<ImportResult> {
    const { file, storage, open, now = Date.now } = options
    const report = (progress: ImportProgress) => options.onProgress?.(progress)

    report({ phase: 'hash', done: 0, total: 1 })
    const { fileHash, copy } = await readFile(file)
    report({ phase: 'hash', done: 1, total: 1 })

    const existing = await storage.findBookByHash(fileHash)
    if (existing) {
        await restoreStoredFile({ storage, id: existing.id, file: copy })
        return { book: existing, duplicate: true }
    }

    report({ phase: 'open', done: 0, total: 1 })
    const book = await open(copy)
    report({ phase: 'open', done: 1, total: 1 })

    report({ phase: 'cover', done: 0, total: 1 })
    const cover = await readCover(book)
    report({ phase: 'cover', done: 1, total: 1 })

    const spineStats: SpineStats[] = []
    const total = book.spine.length
    let totalChars = 0
    let totalWords = 0
    let lastYield = performance.now()
    report({ phase: 'measure', done: 0, total })
    for (const item of book.spine) {
        let stats: SpineStats = { chars: 0, words: 0 }
        try {
            stats = estimateTextStats(await book.readText(item.path))
        } catch {
            // One bad chapter does not stop the import. It gets no weight in the progress.
        }
        spineStats.push(stats)
        totalChars += stats.chars
        totalWords += stats.words
        report({ phase: 'measure', done: spineStats.length, total })

        if (performance.now() - lastYield > YIELD_AFTER_MS) {
            await yieldToEventLoop()
            lastYield = performance.now()
        }
    }

    const { metadata } = book
    const record: BookRecord = {
        id: createId(),
        title: metadata.title,
        author: metadata.author,
        language: metadata.language,
        identifier: metadata.identifier,
        publisher: metadata.publisher,
        description: metadata.description,
        published: metadata.published,
        subjects: [...metadata.subjects],
        series: metadata.series ? { ...metadata.series } : null,
        fileName: fileNameOf(file),
        fileSize: file.size,
        fileHash,
        hasCover: cover !== null,
        spineStats,
        totalChars,
        totalWords,
        addedAt: now(),
        lastOpenedAt: null,
    }

    report({ phase: 'save', done: 0, total: 1 })
    try {
        await storage.addBook({ record, file: copy, cover })
    } catch (error) {
        // The storage refuses a second book with the same file hash. That occurs when a
        // different import of this file saved its book after the duplicate check above.
        const isRefused = (error as { name?: unknown } | null)?.name === 'ConstraintError'
        const stored = isRefused ? await storage.findBookByHash(fileHash) : undefined
        if (!stored) throw error
        return { book: stored, duplicate: true }
    }
    report({ phase: 'save', done: 1, total: 1 })

    return { book: record, duplicate: false }
}
