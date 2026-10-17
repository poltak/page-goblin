/**
 * The sync engine. One run sends the outbox, then gets the changes of the other devices, then
 * uploads new book files and downloads missing covers.
 *
 * The run gets all pages of changes before it writes them, in one transaction with the new
 * cursor. A book and its notes can be on different pages, and a note needs its book.
 */

import { sha256Hex } from '$lib/storage/crypto'
import type { LibraryFileStorage } from '$lib/storage/library-storage'
import type { ApplyResult, OutboxBatch, SyncStore } from '$lib/storage/sync-store'
import type { BookRecord, SyncItem } from '$lib/storage/types'
import { MAX_PUSH_CHANGES } from '../../../sync-server/src/protocol'
import { fromChange, toChange } from './records'
import { SyncError } from './types'
import type { StoredChange, SyncBackend, SyncStatus } from './types'

/** A run stops after this many pushes, so a device that changes all the time cannot hold it. */
const MAX_PUSH_ROUNDS = 50
/** The largest number of files that one run uploads. The next run uploads more. */
const MAX_UPLOADS = 20
/** The largest number of covers that one run downloads. */
const MAX_COVERS = 50
const ALL_ENTRIES = 1_000_000

export interface SyncEngineOptions {
    store: SyncStore
    storage: Pick<LibraryFileStorage, 'getFile' | 'getCover'>
    backend: SyncBackend
    /** Gets what a run changed in the library of this device. */
    onChanges?(changes: ApplyResult): void
    onStatus?(status: SyncStatus): void
    now?: () => number
}

export interface SyncEngine {
    readonly status: SyncStatus
    /**
     * Runs a full sync. A call during a run starts one more run after it, and resolves after
     * that run. Rejects with a SyncError when the run fails.
     */
    sync(): Promise<void>
    /** Sends the outbox only. For the moment when the page goes to the background. */
    pushNow(): Promise<void>
    /** Downloads the file of a book, checks its hash and stores it. */
    downloadFile(book: Pick<BookRecord, 'id' | 'fileHash'>): Promise<void>
}

function emptyChanges(): ApplyResult {
    return { books: [], progress: [], annotations: [] }
}

function hasChanges(changes: ApplyResult): boolean {
    return changes.books.length > 0 || changes.annotations.length > 0
}

function merge(target: ApplyResult, more: ApplyResult): void {
    for (const id of more.books) if (!target.books.includes(id)) target.books.push(id)
    for (const id of more.annotations) {
        if (!target.annotations.includes(id)) target.annotations.push(id)
    }
    target.progress.push(...more.progress)
}

function toSyncError(error: unknown): SyncError {
    if (error instanceof SyncError) return error
    return new SyncError('server', 'The sync failed on this device.', { cause: error })
}

function itemsOf(changes: readonly StoredChange[]): SyncItem[] {
    const items: SyncItem[] = []
    for (const change of changes) {
        const item = fromChange(change)
        if (item) items.push(item)
    }
    return items
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
    const { store, storage, backend } = options
    const now = options.now ?? Date.now
    let status: SyncStatus = { phase: 'idle', syncedAt: null, error: null }
    let running: Promise<void> | null = null
    let again = false

    function setStatus(next: Partial<SyncStatus>): void {
        status = { ...status, ...next }
        try {
            options.onStatus?.(status)
        } catch (error) {
            console.error(error)
        }
    }

    function report(changes: ApplyResult): void {
        if (!hasChanges(changes)) return
        try {
            options.onChanges?.(changes)
        } catch (error) {
            console.error(error)
        }
    }

    async function dropStale(batch: OutboxBatch): Promise<void> {
        if (batch.stale.length > 0) await store.removeOutbox(batch.stale)
    }

    /** Sends the outbox. A change that lost on the server comes back and goes into storage. */
    async function push({ keepalive = false } = {}): Promise<ApplyResult> {
        const changed = emptyChanges()
        for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
            const batch = await store.readOutbox(MAX_PUSH_CHANGES)
            await dropStale(batch)
            if (batch.changes.length === 0) break
            const response = await backend.push(
                batch.changes.map(({ item }) => toChange(item)),
                { keepalive },
            )
            await store.removeOutbox(batch.changes.map(({ entry }) => entry))
            if (response.rejected.length > 0) {
                merge(changed, await store.applyRemote({ items: itemsOf(response.rejected) }))
            }
        }
        return changed
    }

    /** Gets all changes after the cursor and writes them with the new cursor. */
    async function pull(): Promise<ApplyResult> {
        let state = await store.readState()
        const changes: StoredChange[] = []
        let cursor = state?.cursor ?? 0
        let account: string | null = null
        for (;;) {
            const page = await backend.pull({ since: cursor })
            if (account === null && state && state.account !== page.account) {
                // The server started again with no data, or it is a different server. This
                // device sends all its records again and gets all records of the server.
                await store.seedOutbox()
                state = undefined
                cursor = 0
                changes.length = 0
                account = page.account
                // The records of this device go to the server in the next run.
                again = true
                continue
            }
            account = page.account
            changes.push(...page.changes)
            cursor = page.cursor
            if (!page.more) break
        }
        return store.applyRemote({ items: itemsOf(changes), state: { account, cursor } })
    }

    async function uploadFiles(): Promise<void> {
        const { files } = await store.readOutbox(ALL_ENTRIES)
        for (const { entry, bookId, hasCover } of files.slice(0, MAX_UPLOADS)) {
            const hash = entry.key
            if (!(await backend.hasBlob({ folder: 'files', hash }))) {
                const file = await storage.getFile(bookId)
                // The book left the library, or its file is not on this device.
                if (!file) {
                    await store.removeOutbox([entry])
                    continue
                }
                await backend.putBlob({ folder: 'files', hash }, file)
            }
            if (hasCover && !(await backend.hasBlob({ folder: 'covers', hash }))) {
                const cover = await storage.getCover(bookId)
                if (cover) await backend.putBlob({ folder: 'covers', hash }, cover)
            }
            await store.removeOutbox([entry])
        }
    }

    async function downloadCovers(): Promise<ApplyResult> {
        const changed = emptyChanges()
        const books = await store.booksWithoutCover()
        for (const book of books.slice(0, MAX_COVERS)) {
            const cover = await backend.getBlob({ folder: 'covers', hash: book.fileHash })
            // The device that has the book did not upload its cover yet.
            if (!cover) continue
            await store.storeCover(book.id, cover)
            changed.books.push(book.id)
        }
        return changed
    }

    async function runOnce(): Promise<void> {
        const state = await store.readState()
        // The first sync of this device sends each record of the library.
        if (!state) await store.seedOutbox()
        const changed = await push()
        merge(changed, await pull())
        report(changed)
        await uploadFiles()
        report(await downloadCovers())
    }

    function sync(): Promise<void> {
        if (running) {
            again = true
            return running
        }
        setStatus({ phase: 'syncing' })
        running = (async () => {
            try {
                do {
                    again = false
                    await runOnce()
                } while (again)
                setStatus({ phase: 'idle', syncedAt: now(), error: null })
            } catch (error) {
                const failure = toSyncError(error)
                setStatus({ phase: 'error', error: failure })
                throw failure
            } finally {
                running = null
            }
        })()
        return running
    }

    async function pushNow(): Promise<void> {
        if (running) return running
        // A device that never synced has no state. Its first run sends all records.
        if (!(await store.readState())) return
        report(await push({ keepalive: true }))
    }

    async function downloadFile(book: Pick<BookRecord, 'id' | 'fileHash'>): Promise<void> {
        const blob = await backend.getBlob({ folder: 'files', hash: book.fileHash })
        if (!blob) {
            throw new SyncError(
                'not-found',
                'The sync server does not have the file of this book yet. Open the app on the device where you added the book, so it can upload the file.',
            )
        }
        const bytes = await blob.arrayBuffer()
        if ((await sha256Hex(bytes)) !== book.fileHash) {
            throw new SyncError('integrity', 'The downloaded file is damaged. Try again.')
        }
        await store.storeFile(book.id, new Blob([bytes], { type: 'application/epub+zip' }))
    }

    return {
        get status() {
            return status
        },
        sync,
        pushNow,
        downloadFile,
    }
}
