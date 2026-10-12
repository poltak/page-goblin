import type { EpubBook } from '$lib/epub/types'
import { makeCoverThumbnail } from './cover'
import { createId, sha256Hex } from './crypto'
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
    storage: Pick<LibraryStorage, 'findBookByHash' | 'addBook'>
    /** Opens the EPUB container. It is an input so that this module does not load the parser. */
    open: (file: Blob) => Promise<EpubBook>
    onProgress?: (progress: ImportProgress) => void
    /** Epoch milliseconds. The default is `Date.now`. */
    now?: () => number
}

export interface ImportResult {
    book: BookRecord
    /** True when the library already had this file. Then `book` is the record that was there. */
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

/**
 * Add an EPUB file to the library. The storage gets the bytes of the file, a small cover image
 * and a small record for the library view.
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
    if (existing) return { book: existing, duplicate: true }

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
