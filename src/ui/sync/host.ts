/**
 * The part of the sync that is in the first chunk. It knows if the sync is on, gives the
 * change tracker to the storage, and loads the sync engine and the sync dialog at their first
 * use. With the sync off, it loads nothing.
 */

import type { LibraryFileStorage } from '$lib/storage/library-storage'
import type { ApplyResult } from '$lib/storage/sync-store'
import type { BookRecord, ChangeTracker } from '$lib/storage/types'
import { clearSyncConfig, readSyncConfig, writeSyncConfig } from '$lib/sync/config'
import type { SyncConfig, SyncStatus } from '$lib/sync/types'
import { showToast } from '../app/toast'
import { qs } from '../dom'
import { reportLoadError } from '../library/lazy'
import type { SyncController } from './controller'
import type { SyncDialog } from './dialog'

export interface SyncHostOptions {
    /** A sync changed the library of this device. */
    onChanges(changes: ApplyResult): void
}

export interface SyncHost {
    readonly tracker: ChangeTracker
    isOn(): boolean
    /** Call it one time, before `start`. */
    connectStorage(storage: LibraryFileStorage): void
    /** Starts the sync when it is on. The engine loads when the browser has time. */
    start(): void
    config(): SyncConfig | null
    status(): SyncStatus
    /** Returns the function that removes the listener. */
    onStatus(listener: (status: SyncStatus) => void): () => void
    /** Saves the config and starts the sync. The caller checked the config with the server. */
    turnOn(config: SyncConfig): Promise<void>
    /** Stops the sync on this device. The books with no file here leave the library. */
    turnOff(): Promise<void>
    /** Rejects with a SyncError when the sync fails. */
    syncNow(): Promise<void>
    /** Downloads the file of a book that has only its record on this device. */
    downloadFile(book: Pick<BookRecord, 'id' | 'fileHash'>): Promise<void>
    /** Resolves false when the server does not have the file yet. */
    removeDownload(bookId: string): Promise<boolean>
    /** With `link`, the dialog shows the server and the code of a sync link. */
    openDialog(opener: Element | null, link?: SyncConfig): void
}

const IDLE: SyncStatus = { phase: 'idle', syncedAt: null, error: null }

export function createSyncHost(options: SyncHostOptions): SyncHost {
    let current = readSyncConfig()
    let storage: LibraryFileStorage | null = null
    let controller: Promise<SyncController> | null = null
    let dialog: Promise<SyncDialog> | null = null
    let status = IDLE
    const listeners = new Set<(status: SyncStatus) => void>()
    /** The code of the last error that showed a toast. The same error shows it one time only. */
    let toastedCode: string | null = null

    function setStatus(next: SyncStatus): void {
        status = next
        for (const listener of listeners) {
            try {
                listener(next)
            } catch (error) {
                console.error(error)
            }
        }
        const code = next.error?.code ?? null
        // Only an error that the user must act on gets a toast. No network is normal.
        if (code === 'unauthorized' || code === 'not-set-up') {
            if (toastedCode !== code) {
                showToast({ message: `Sync stopped. ${next.error!.message}`, tone: 'error' })
            }
            toastedCode = code
        } else if (next.phase === 'idle') {
            toastedCode = null
        }
    }

    function loadController(): Promise<SyncController> {
        const config = current
        const target = storage
        if (!config || !target) return Promise.reject(new Error('The sync is off.'))
        if (!controller) {
            const loading = import('./controller').then(({ createSyncController }) =>
                createSyncController({
                    storage: target,
                    config,
                    onChanges: options.onChanges,
                    onStatus: setStatus,
                }),
            )
            controller = loading
            // The next call tries again, for example after the network comes back.
            loading.catch(() => {
                if (controller === loading) controller = null
            })
        }
        return controller
    }

    function startController(): void {
        loadController().then(
            (loaded) => loaded.start(),
            (error: unknown) => console.error(error),
        )
    }

    const tracker: ChangeTracker = {
        isOn: () => current !== null,
        onChange() {
            if (current) loadController().then((loaded) => loaded.schedule(), console.error)
        },
    }

    const host: SyncHost = {
        tracker,
        isOn: () => current !== null,
        connectStorage(target) {
            storage = target
        },
        start() {
            if (!current) return
            const whenIdle: (work: () => void) => void =
                window.requestIdleCallback?.bind(window) ?? ((work) => setTimeout(work, 1000))
            whenIdle(startController)
        },
        config: () => current,
        status: () => status,
        onStatus(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        async turnOn(config) {
            writeSyncConfig(config)
            current = config
            setStatus(IDLE)
            startController()
        },
        async turnOff() {
            const running = controller
            current = null
            controller = null
            clearSyncConfig()
            if (running) await (await running.catch(() => null))?.destroy()
            const target = storage
            if (target) {
                const { createSyncStore } = await import('$lib/storage/sync-store')
                const removed = await createSyncStore(target.database).reset()
                // The reset also removes the fonts that did not download.
                options.onChanges({ books: removed, progress: [], annotations: [], fonts: true })
            }
            setStatus(IDLE)
        },
        async syncNow() {
            await (await loadController()).syncNow()
        },
        async downloadFile(book) {
            if (!current) throw new Error('Turn on sync to download this book.')
            await (await loadController()).downloadFile(book)
        },
        async removeDownload(bookId) {
            return (await loadController()).removeDownload(bookId)
        },
        openDialog(opener, link) {
            dialog ??= import('./dialog').then(({ createSyncDialog }) =>
                createSyncDialog({ dialog: qs<HTMLDialogElement>('#sync-dialog'), host }),
            )
            dialog.then(
                (loaded) => loaded.show({ opener, link }),
                (error: unknown) => {
                    dialog = null
                    reportLoadError(error)
                },
            )
        },
    }
    return host
}
