/**
 * Runs the sync engine at the right times: at the start, when the app comes back to the
 * screen, when the network comes back, some seconds after a change, and every few minutes.
 * When the app goes to the background, it sends the changes at once.
 */

import type { LibraryFileStorage } from '$lib/storage/library-storage'
import { createSyncStore, type ApplyResult } from '$lib/storage/sync-store'
import type { BookRecord } from '$lib/storage/types'
import { createSyncClient } from '$lib/sync/client'
import { deriveToken } from '$lib/sync/code'
import { createSyncEngine } from '$lib/sync/engine'
import type { SyncBackend, SyncConfig, SyncStatus } from '$lib/sync/types'
import { on } from '../dom'

/** The time from a change on this device to the sync that sends it. */
export const CHANGE_DELAY_MS = 15_000
/** The time between two syncs while the app is on screen. */
export const INTERVAL_MS = 5 * 60_000
/** An app that comes back to the screen sooner than this after a sync does not sync again. */
export const RETURN_GAP_MS = 30_000

export interface SyncControllerOptions {
    storage: LibraryFileStorage
    config: SyncConfig
    onChanges(changes: ApplyResult): void
    onStatus(status: SyncStatus): void
    /** The default is the client of the server in the config. A test gives its own. */
    backend?: SyncBackend
    now?: () => number
}

export interface SyncController {
    /** Starts the first sync and the listeners. Errors go to the status. */
    start(): void
    /** A change on this device. A sync follows after `CHANGE_DELAY_MS`. */
    schedule(): void
    /** Rejects with a SyncError when the sync fails. */
    syncNow(): Promise<void>
    downloadFile(book: Pick<BookRecord, 'id' | 'fileHash'>): Promise<void>
    removeDownload(bookId: string): Promise<boolean>
    /** Stops the listeners and the timers, and waits for a sync that runs. */
    destroy(): Promise<void>
}

function ignore(): void {}

export async function createSyncController(
    options: SyncControllerOptions,
): Promise<SyncController> {
    const { storage, config } = options
    const now = options.now ?? Date.now
    const store = createSyncStore(storage.database)
    const backend =
        options.backend ??
        createSyncClient({ server: config.server, token: await deriveToken(config.code) })
    const engine = createSyncEngine({
        store,
        storage,
        backend,
        onChanges: options.onChanges,
        onStatus: options.onStatus,
        now,
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    let interval: ReturnType<typeof setInterval> | undefined
    let lastRun = 0
    let started = false
    let destroyed = false
    let current: Promise<void> = Promise.resolve()
    const stops: Array<() => void> = []

    function run(): Promise<void> {
        if (destroyed) return Promise.resolve()
        clearTimeout(timer)
        timer = undefined
        lastRun = now()
        current = engine.sync()
        return current
    }

    /** For the runs that no user action started. The status has the error. */
    function runQuietly(): void {
        run().catch(ignore)
    }

    return {
        start() {
            if (started || destroyed) return
            started = true
            stops.push(
                on(document, 'visibilitychange', () => {
                    if (document.visibilityState === 'hidden') {
                        engine.pushNow().catch(ignore)
                    } else if (now() - lastRun > RETURN_GAP_MS) {
                        runQuietly()
                    }
                }),
                on(window, 'online', runQuietly),
            )
            interval = setInterval(() => {
                if (document.visibilityState === 'visible') runQuietly()
            }, INTERVAL_MS)
            runQuietly()
        },
        schedule() {
            if (destroyed || timer !== undefined) return
            timer = setTimeout(runQuietly, CHANGE_DELAY_MS)
        },
        syncNow: run,
        downloadFile: (book) => engine.downloadFile(book),
        removeDownload: (bookId) => store.removeDownload(bookId),
        async destroy() {
            destroyed = true
            clearTimeout(timer)
            clearInterval(interval)
            for (const stop of stops.splice(0)) stop()
            await current.catch(ignore)
        },
    }
}
