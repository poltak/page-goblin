/**
 * The sync engine. One run sends the outbox, then gets the changes of the other devices, then
 * uploads new book files and downloads missing covers.
 *
 * The run gets all pages of changes before it writes them, in one transaction with the new
 * cursor. A book and its notes can be on different pages, and a note needs its book.
 */

import { FONT_MEDIA_TYPES } from '$lib/fonts/import'
import { sniffFont } from '$lib/fonts/sfnt'
import { sha256Hex } from '$lib/storage/crypto'
import type { LibraryFileStorage } from '$lib/storage/library-storage'
import { FIRST_SYNC_KINDS } from '$lib/storage/sync-store'
import type { ApplyResult, OutboxBatch, OutboxFile, SyncStore } from '$lib/storage/sync-store'
import type {
    BookRecord,
    OutboxEntry,
    SyncItem,
    SyncRecordKind,
    SyncState,
} from '$lib/storage/types'
import { MAX_PUSH_CHANGES, parseChange } from '../../../sync-server/src/protocol'
import { fromChange, toChange } from './records'
import { SyncError } from './types'
import type { StoredChange, SyncBackend, SyncStatus } from './types'

/** A run stops after this many pushes, so a device that changes all the time cannot hold it. */
const MAX_PUSH_ROUNDS = 200
/** The largest number of files that one run uploads. The next run uploads more. */
const MAX_UPLOADS = 20
/** The largest number of covers that one run downloads. */
const MAX_COVERS = 50
/** A cover that the server did not have is not asked for again before this time. */
export const COVER_RETRY_MS = 60 * 60_000
/** The largest number of font files that one run downloads. */
const MAX_FONT_DOWNLOADS = 20
/**
 * A font file that the server did not have, or that was damaged, waits this time. A device
 * uploads a font file before the family, so a miss is rare.
 */
export const FONT_RETRY_MS = 10 * 60_000

/** The kinds that this version syncs, when the server keeps them too. */
export const APP_KINDS: readonly SyncRecordKind[] = [
    'book',
    'progress',
    'bookmark',
    'highlight',
    'font',
    'setting',
]
/** Errors that stop the run. With other errors, a file or a cover waits for the next run. */
const STOP_CODES = new Set(['offline', 'unauthorized', 'not-set-up'])

export interface SyncEngineOptions {
    store: SyncStore
    storage: Pick<LibraryFileStorage, 'getBook' | 'getFile' | 'getCover' | 'getFontFile'>
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
    /**
     * Removes the file of a book from this device. Resolves false, and keeps the file, when the
     * server does not have the file. Rejects when the server does not answer.
     */
    removeDownload(bookId: string): Promise<boolean>
}

function emptyChanges(): ApplyResult {
    return { books: [], progress: [], annotations: [], fonts: false }
}

function hasChanges(changes: ApplyResult): boolean {
    return (
        changes.books.length > 0 ||
        changes.annotations.length > 0 ||
        changes.fonts === true ||
        Object.keys(changes.settings ?? {}).length > 0
    )
}

function merge(target: ApplyResult, more: ApplyResult): void {
    for (const id of more.books) if (!target.books.includes(id)) target.books.push(id)
    for (const id of more.annotations) {
        if (!target.annotations.includes(id)) target.annotations.push(id)
    }
    target.progress.push(...more.progress)
    if (more.fonts) target.fonts = true
    if (more.settings) target.settings = { ...target.settings, ...more.settings }
}

/** The kinds that the cursor of the state covers. */
function kindsOf(state: SyncState | undefined): readonly SyncRecordKind[] {
    return state?.kinds ?? FIRST_SYNC_KINDS
}

/** The kinds that this version and a server both keep. A server with no list has the first. */
function sharedKinds(serverKinds: readonly string[] | undefined): SyncRecordKind[] {
    const server = serverKinds ?? FIRST_SYNC_KINDS
    return APP_KINDS.filter((kind) => server.includes(kind))
}

/** The bytes of a downloaded font file when they have the hash and the form of a font. */
async function checkedFont(blob: Blob, hash: string): Promise<Blob | null> {
    const bytes = await blob.arrayBuffer()
    if ((await sha256Hex(bytes)) !== hash) return null
    const kind = sniffFont(new Uint8Array(bytes))
    if (!kind || kind === 'collection') return null
    return new Blob([bytes], { type: FONT_MEDIA_TYPES[kind] })
}

function stopsTheRun(error: unknown): boolean {
    return error instanceof SyncError && STOP_CODES.has(error.code)
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
    /** Book ids, with the time when the server did not have their cover. */
    const coverMisses = new Map<string, number>()
    /** Font file hashes, with the time when the server did not have a good copy. */
    const fontMisses = new Map<string, number>()
    /** True when the server of the last pull does not keep fonts. */
    let oldServer = false
    /** The font uploads that this run tried already. */
    const triedUploads = new Set<string>()

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
    async function push({ keepalive = false, fonts = true } = {}): Promise<ApplyResult> {
        const changed = emptyChanges()
        // A server refuses a whole push with a kind that it does not keep. The entries of
        // such a kind stay in the outbox until the server keeps it.
        const kinds = kindsOf(await store.readState()).filter((kind) => fonts || kind !== 'font')
        for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
            const batch = await store.readOutbox(MAX_PUSH_CHANGES, kinds)
            await dropStale(batch)
            if (batch.changes.length === 0) break
            // The server refuses a push with one change that is not valid. Such a change would
            // stop all later pushes, so it stays on this device only.
            const changes = []
            for (const { item } of batch.changes) {
                const change = toChange(item)
                if (parseChange(change)) changes.push(change)
                else console.warn('The sync skips a record that the server refuses.', item)
            }
            const response =
                changes.length > 0 ? await backend.push(changes, { keepalive }) : { rejected: [] }
            await store.removeOutbox(batch.changes.map(({ entry }) => entry))
            if (response.rejected.length > 0) {
                merge(changed, await store.applyRemote({ items: itemsOf(response.rejected) }))
            }
        }
        return changed
    }

    /**
     * Gets the changes of the kinds in `kinds` from the start, up to the cursor. For a kind
     * that the cursor of this device does not cover yet.
     */
    async function pullFromStart(
        kinds: readonly SyncRecordKind[],
        until: number,
    ): Promise<StoredChange[]> {
        const changes: StoredChange[] = []
        let since = 0
        for (;;) {
            const page = await backend.pull({ since, kinds })
            if (page.more && page.cursor <= since) {
                throw new SyncError('bad-response', 'The answer of the sync server is not valid.')
            }
            changes.push(...page.changes)
            since = page.cursor
            // The changes after the cursor come in the normal pull.
            if (!page.more || since >= until) return changes
        }
    }

    /** Gets all changes after the cursor and writes them with the new cursor. */
    async function pull(): Promise<ApplyResult> {
        let state = await store.readState()
        /** The kinds that the push of this run sent. */
        const pushed = kindsOf(state)
        const changes: StoredChange[] = []
        let cursor = state?.cursor ?? 0
        let account: string | null = null
        let kinds: SyncRecordKind[] | null = null
        for (;;) {
            const page = await backend.pull({ since: cursor, kinds: APP_KINDS })
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
            // A server that gives more pages must also move the cursor, or this loop has no end.
            if (page.more && page.cursor <= cursor) {
                throw new SyncError('bad-response', 'The answer of the sync server is not valid.')
            }
            account = page.account
            kinds ??= sharedKinds(page.kinds)
            changes.push(...page.changes)
            cursor = page.cursor
            if (!page.more) break
        }
        const shared = kinds ?? [...FIRST_SYNC_KINDS]
        oldServer = !shared.includes('font')
        if (state) {
            // An older version of the app, or an older server, moved the cursor past the
            // changes of a kind that it did not keep. Those changes come from the start, once.
            const missing = shared.filter((kind) => !kindsOf(state).includes(kind))
            if (missing.length > 0) changes.push(...(await pullFromStart(missing, state.cursor)))
        }
        // The outbox can have changes of a kind that the server keeps now. The next run
        // sends them.
        if (shared.some((kind) => !pushed.includes(kind))) again = true
        return store.applyRemote({
            items: itemsOf(changes),
            state: { account: account!, cursor, kinds: shared },
        })
    }

    async function uploadFile({ entry, bookId, hasCover }: OutboxFile): Promise<void> {
        const hash = entry.key
        if (!(await backend.hasBlob({ folder: 'files', hash }))) {
            const file = await storage.getFile(bookId)
            // The book left the library, or its file is not on this device.
            if (!file) {
                await store.removeOutbox([entry])
                return
            }
            await backend.putBlob({ folder: 'files', hash }, file)
        }
        if (hasCover && !(await backend.hasBlob({ folder: 'covers', hash }))) {
            const cover = await storage.getCover(bookId)
            if (cover) await backend.putBlob({ folder: 'covers', hash }, cover)
        }
        await store.removeOutbox([entry])
    }

    async function uploadFontFile(entry: OutboxEntry): Promise<void> {
        const hash = entry.key
        if (!(await backend.hasBlob({ folder: 'fonts', hash }))) {
            const file = await storage.getFontFile(hash)
            if (!file) {
                await store.removeOutbox([entry])
                return
            }
            await backend.putBlob({ folder: 'fonts', hash }, file)
        }
        await store.removeOutbox([entry])
    }

    /** Runs one upload. An upload that fails does not stop the other uploads. */
    async function tryUpload(entry: OutboxEntry, upload: () => Promise<void>): Promise<void> {
        try {
            await upload()
        } catch (error) {
            if (stopsTheRun(error)) throw error
            if (error instanceof SyncError && error.code === 'too-large') {
                // The file stays on this device only.
                console.warn('The sync server refused a file that is too large.', entry.key)
                await store.removeOutbox([entry])
            } else {
                console.warn('A file did not upload. The next sync tries again.', error)
                await store.postponeUpload(entry, now())
            }
        }
    }

    async function uploadFiles(): Promise<void> {
        const kinds = kindsOf(await store.readState())
        const { files } = await store.readOutbox(MAX_UPLOADS, kinds)
        for (const file of files) await tryUpload(file.entry, () => uploadFile(file))
    }

    /**
     * Uploads the font files before the push, so a device that gets a family can also get its
     * files. A book downloads only when it opens, so its file can come after its record.
     */
    async function uploadFontFiles(): Promise<void> {
        const kinds = kindsOf(await store.readState())
        if (!kinds.includes('font')) return
        for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
            const { fontFiles } = await store.readOutbox(MAX_UPLOADS, kinds)
            const due = fontFiles.filter((entry) => !triedUploads.has(entry.id))
            if (due.length === 0) return
            for (const entry of due) {
                await tryUpload(entry, () => uploadFontFile(entry))
                // A failed upload waits for the next run, after the push.
                triedUploads.add(entry.id)
            }
        }
    }

    async function downloadCovers(): Promise<ApplyResult> {
        const changed = emptyChanges()
        const time = now()
        const books = (await store.booksWithoutCover()).filter(
            (book) => time - (coverMisses.get(book.id) ?? -Infinity) >= COVER_RETRY_MS,
        )
        for (const book of books.slice(0, MAX_COVERS)) {
            let cover: Blob | null
            try {
                cover = await backend.getBlob({ folder: 'covers', hash: book.fileHash })
            } catch (error) {
                if (stopsTheRun(error)) throw error
                cover = null
            }
            // The device that has the book did not upload its cover yet.
            if (!cover) {
                coverMisses.set(book.id, time)
                continue
            }
            await store.storeCover(book.id, cover)
            changed.books.push(book.id)
        }
        return changed
    }

    /** Downloads the font files that the families of this device need. */
    async function downloadFonts(): Promise<ApplyResult> {
        const changed = emptyChanges()
        if (!kindsOf(await store.readState()).includes('font')) return changed
        const time = now()
        const hashes = (await store.missingFontFiles()).filter(
            (hash) => time - (fontMisses.get(hash) ?? -Infinity) >= FONT_RETRY_MS,
        )
        for (const hash of hashes.slice(0, MAX_FONT_DOWNLOADS)) {
            let file: Blob | null = null
            try {
                const blob = await backend.getBlob({ folder: 'fonts', hash })
                file = blob && (await checkedFont(blob, hash))
            } catch (error) {
                if (stopsTheRun(error)) throw error
            }
            // The device of the font did not upload it yet, or the copy is damaged.
            if (!file) {
                fontMisses.set(hash, time)
                continue
            }
            await store.storeFontFile(hash, file)
            changed.fonts = true
        }
        return changed
    }

    async function runOnce(): Promise<void> {
        const state = await store.readState()
        // The first sync of this device sends each record of the library.
        if (!state) await store.seedOutbox()
        triedUploads.clear()
        await uploadFontFiles()
        const changed = await push()
        merge(changed, await pull())
        report(changed)
        await uploadFiles()
        const downloaded = await downloadCovers()
        merge(downloaded, await downloadFonts())
        report(downloaded)
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
                setStatus({ phase: 'idle', syncedAt: now(), error: null, oldServer })
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
        // A font goes in a full run, after its files.
        report(await push({ keepalive: true, fonts: false }))
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

    async function removeDownload(bookId: string): Promise<boolean> {
        const book = await storage.getBook(bookId)
        if (!book || book.remoteOnly) return false
        // The outbox can be empty for a file that the server never got, for example a file
        // that was too large. The file must not leave its last place.
        if (!(await backend.hasBlob({ folder: 'files', hash: book.fileHash }))) return false
        return store.removeDownload(bookId)
    }

    return {
        get status() {
            return status
        },
        sync,
        pushNow,
        downloadFile,
        removeDownload,
    }
}
