/**
 * The import of book files: the queue, the status region and the call of the importer.
 *
 * The library screen loads this file when the user adds the first file. The importer and the
 * EPUB parser are two more chunks that load here, at the first file that looks like an EPUB.
 */

import { requestPersistentStorage } from '$lib/storage/storage-info'
import type { BookRecord, LibraryStorage } from '$lib/storage/types'
import { createImportQueue, hasZipSignature, notZipError } from './import-queue'
import type { ImportSummary } from './import-queue'
import { createImportStatusView } from './import-status'

export interface ImportFlowOptions {
    storage: LibraryStorage
    /** The `#import-status` element. */
    statusRoot: HTMLElement
    onAdded(book: BookRecord): void
    onDuplicate(book: BookRecord): void
}

export interface ImportFlow {
    /** Imports the files after the files that wait already. Resolves when they are done. */
    add(files: readonly File[]): Promise<ImportSummary>
}

export function createImportFlow(options: ImportFlowOptions): ImportFlow {
    const { storage } = options
    const status = createImportStatusView(options.statusRoot)
    let askedToPersist = false

    const queue = createImportQueue({
        async importFile(file, onProgress) {
            if (!(await hasZipSignature(file))) throw notZipError()
            const [{ importBook }, { openEpub }] = await Promise.all([
                import('$lib/storage/import'),
                import('$lib/epub'),
            ])
            return importBook({ file, storage, open: openEpub, onProgress })
        },
        onFileStart: ({ file, position, total }) =>
            status.start({ fileName: file.name, position, total }),
        onProgress: status.progress,
        onAdded(book) {
            options.onAdded(book)
            // The browser can remove the data of a site when the device has little space. A
            // library is worth a request to keep it. The answer changes nothing in the app.
            if (!askedToPersist) {
                askedToPersist = true
                void requestPersistentStorage()
            }
        },
        onDuplicate: options.onDuplicate,
        onFailure: status.fail,
        onIdle: status.idle,
    })

    return { add: (files) => queue.add(files) }
}
