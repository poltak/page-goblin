/**
 * The queue of files that the user adds, and the text for an import that failed.
 *
 * This file has no DOM and does not load the importer. The caller gives the function that
 * imports one file.
 */

import type { ImportPhase, ImportProgress, ImportResult } from '$lib/storage/import'
import { isQuotaError } from '$lib/storage/storage-info'
import type { BookRecord } from '$lib/storage/types'

export const IMPORT_MESSAGES = {
    drm: 'This book has DRM protection and cannot be opened.',
    notEpub: 'This file is not an EPUB file, or it is damaged.',
    structure: 'This EPUB file has a structure that the reader cannot read.',
    quota: 'There is not enough storage space on this device for this book.',
    other: 'The book was not added.',
} as const

const MESSAGE_FOR_CODE: ReadonlyMap<unknown, string> = new Map([
    ['drm', IMPORT_MESSAGES.drm],
    ['not-zip', IMPORT_MESSAGES.notEpub],
    ['no-container', IMPORT_MESSAGES.structure],
    ['invalid-package', IMPORT_MESSAGES.structure],
    ['no-content', IMPORT_MESSAGES.structure],
])

export interface ImportErrorText {
    /** A sentence for the user. */
    message: string
    /** The message of the error itself, only for an error with no sentence of its own. */
    detail: string | null
}

/**
 * The text for an error of `importBook`. The parser is in a different chunk, so this reads
 * the name and the code of an `EpubError` and does not use `instanceof`.
 */
export function describeImportError(error: unknown): ImportErrorText {
    const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown }
    const known = name === 'EpubError' ? MESSAGE_FOR_CODE.get(code) : undefined
    if (known) return { message: known, detail: null }
    if (isQuotaError(error)) return { message: IMPORT_MESSAGES.quota, detail: null }

    const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    return { message: IMPORT_MESSAGES.other, detail: text.trim() || null }
}

/** An error with the shape of the parser error for a file that is not a ZIP archive. */
export function notZipError(): Error {
    return Object.assign(new Error('The file does not start with a ZIP signature.'), {
        name: 'EpubError',
        code: 'not-zip',
    })
}

/**
 * True when the file starts with the signature of a ZIP local file header, as each EPUB file
 * does. The check reads 4 bytes, so a large file of a different type fails before the app
 * loads the importer and reads the full file into memory.
 */
export async function hasZipSignature(file: Blob): Promise<boolean> {
    try {
        const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer())
        return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    } catch {
        // A folder or a file that went away cannot be read.
        return false
    }
}

const PHASE_LABELS: Readonly<Record<ImportPhase, string>> = {
    hash: 'Reading the file',
    open: 'Opening the book',
    cover: 'Making the cover',
    measure: 'Measuring the chapters',
    save: 'Saving to the library',
}

/** The part of the bar that each phase starts at, and its share. Measure is the long one. */
const PHASE_SPANS: Readonly<Record<ImportPhase, readonly [start: number, share: number]>> = {
    hash: [0, 0.1],
    open: [0.1, 0.1],
    cover: [0.2, 0.1],
    measure: [0.3, 0.6],
    save: [0.9, 0.1],
}

/** The phase in plain words. */
export function phaseLabel(phase: ImportPhase): string {
    return PHASE_LABELS[phase] ?? 'Adding the book'
}

/** The progress of one file from 0 to 1. */
export function importFraction({ phase, done, total }: ImportProgress): number {
    const [start, share] = PHASE_SPANS[phase] ?? [0, 0]
    const part = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0
    return start + share * part
}

export interface ImportFailure extends ImportErrorText {
    fileName: string
}

/** The result of the files of one `add` call. */
export interface ImportSummary {
    added: BookRecord[]
    duplicates: BookRecord[]
    failures: ImportFailure[]
}

export interface ImportQueueOptions {
    /** Imports one file. An error of the parser or of the storage rejects the promise. */
    importFile(file: File, onProgress: (progress: ImportProgress) => void): Promise<ImportResult>
    /** A file starts. `position` counts from 1 through the files since the queue was idle. */
    onFileStart?(info: { file: File; position: number; total: number }): void
    onProgress?(progress: ImportProgress): void
    onAdded?(book: BookRecord): void
    /** The file is in the library already. `book` is the stored record. */
    onDuplicate?(book: BookRecord): void
    onFailure?(failure: ImportFailure): void
    /** No file is in work and none waits. */
    onIdle?(): void
}

export interface ImportQueue {
    readonly busy: boolean
    /** Puts files at the end of the queue. Resolves when these files are done. */
    add(files: readonly File[]): Promise<ImportSummary>
}

interface Batch {
    summary: ImportSummary
    left: number
    resolve(summary: ImportSummary): void
}

/** Imports files one after the other. A file that fails does not stop the next file. */
export function createImportQueue(options: ImportQueueOptions): ImportQueue {
    const waiting: { file: File; batch: Batch }[] = []
    let busy = false
    let finished = 0

    async function importOne(file: File, summary: ImportSummary): Promise<void> {
        let result: ImportResult
        try {
            result = await options.importFile(file, (progress) => options.onProgress?.(progress))
        } catch (error) {
            const failure = { fileName: file.name, ...describeImportError(error) }
            summary.failures.push(failure)
            options.onFailure?.(failure)
            return
        }
        if (result.duplicate) {
            summary.duplicates.push(result.book)
            options.onDuplicate?.(result.book)
        } else {
            summary.added.push(result.book)
            options.onAdded?.(result.book)
        }
    }

    // An error of a listener must not stop the queue. Without this, the files of the batch
    // would wait with no end, and the promise of `add` would not resolve.
    function tell(listener: () => void): void {
        try {
            listener()
        } catch (error) {
            console.error(error)
        }
    }

    async function run(): Promise<void> {
        busy = true
        try {
            for (let next = waiting.shift(); next; next = waiting.shift()) {
                const { file, batch } = next
                const info = { file, position: finished + 1, total: finished + 1 + waiting.length }
                tell(() => options.onFileStart?.(info))
                try {
                    await importOne(file, batch.summary)
                } catch (error) {
                    // An error of a listener. The other files must still get their turn.
                    console.error(error)
                } finally {
                    finished += 1
                    batch.left -= 1
                    if (batch.left === 0) batch.resolve(batch.summary)
                }
            }
        } finally {
            busy = false
            finished = 0
        }
        tell(() => options.onIdle?.())
    }

    return {
        get busy() {
            return busy
        },
        add(files) {
            const summary: ImportSummary = { added: [], duplicates: [], failures: [] }
            if (files.length === 0) return Promise.resolve(summary)
            return new Promise((resolve) => {
                const batch: Batch = { summary, left: files.length, resolve }
                for (const file of files) waiting.push({ file, batch })
                if (!busy) void run()
            })
        },
    }
}
