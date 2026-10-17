import { Blob as NodeBlob } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLibraryStorage, type LibraryFileStorage } from '$lib/storage/library-storage'
import type { BookRecord } from '$lib/storage/types'
import { readSyncConfig, SYNC_STORAGE_KEY } from '$lib/sync/config'
import { SyncError } from '$lib/sync/types'
import type { SyncStatus } from '$lib/sync/types'
import { mountPage } from '../app/testing/page'
import { clearToasts } from '../app/toast'
import type { SyncControllerOptions } from './controller'
import { createSyncHost } from './host'

const mocks = vi.hoisted(() => ({
    created: [] as Array<{ onStatus(status: SyncStatus): void }>,
    controller: {
        start: vi.fn(),
        schedule: vi.fn(),
        syncNow: vi.fn(async () => {}),
        downloadFile: vi.fn(async () => {}),
        removeDownload: vi.fn(async () => true),
        destroy: vi.fn(async () => {}),
    },
    show: vi.fn(),
}))

vi.mock('./controller', () => ({
    createSyncController: vi.fn(async (options: SyncControllerOptions) => {
        mocks.created.push(options)
        return mocks.controller
    }),
}))

vi.mock('./dialog', () => ({
    createSyncDialog: () => ({ show: mocks.show }),
}))

const CONFIG = { server: 'https://sync.test.workers.dev', code: 'ABCD' }

let storage: LibraryFileStorage

function makeBook(id: string, changes: Partial<BookRecord> = {}): BookRecord {
    return {
        id,
        title: id,
        author: '',
        language: null,
        identifier: null,
        publisher: null,
        description: null,
        published: null,
        subjects: [],
        series: null,
        fileName: `${id}.epub`,
        fileSize: 1,
        fileHash: id.repeat(64).slice(0, 64),
        hasCover: false,
        spineStats: [],
        totalChars: 0,
        totalWords: 0,
        addedAt: 1,
        lastOpenedAt: null,
        ...changes,
    }
}

const toastTexts = () =>
    Array.from(document.querySelectorAll('#toasts .toast span')).map((item) => item.textContent)

beforeEach(() => {
    mountPage()
    vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('requestIdleCallback', (work: () => void) => {
        work()
        return 0
    })
    localStorage.clear()
    mocks.created.length = 0
    for (const method of Object.values(mocks.controller)) method.mockClear()
    mocks.show.mockClear()
    storage = createLibraryStorage({ indexedDB: new IDBFactory() })
})

afterEach(() => {
    storage.close()
    clearToasts()
    vi.unstubAllGlobals()
})

describe('createSyncHost', () => {
    it('loads nothing and tracks nothing while the sync is off', async () => {
        const host = createSyncHost({ onChanges: () => {} })
        host.connectStorage(storage)
        host.start()
        await Promise.resolve()

        expect(host.isOn()).toBe(false)
        expect(host.tracker.isOn()).toBe(false)
        expect(mocks.created).toEqual([])
        await expect(host.downloadFile({ id: 'a', fileHash: 'h' })).rejects.toThrow(
            'Turn on sync to download this book.',
        )
    })

    it('starts the sync at the start when it is on', async () => {
        localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(CONFIG))
        const host = createSyncHost({ onChanges: () => {} })
        host.connectStorage(storage)
        host.start()

        await vi.waitFor(() => expect(mocks.controller.start).toHaveBeenCalledTimes(1))
        expect(host.tracker.isOn()).toBe(true)

        host.tracker.onChange()
        await vi.waitFor(() => expect(mocks.controller.schedule).toHaveBeenCalledTimes(1))
        expect(mocks.created).toHaveLength(1)
    })

    it('saves the config and starts the sync when it turns on', async () => {
        const host = createSyncHost({ onChanges: () => {} })
        host.connectStorage(storage)

        await host.turnOn(CONFIG)

        expect(readSyncConfig()).toEqual(CONFIG)
        expect(host.config()).toEqual(CONFIG)
        await vi.waitFor(() => expect(mocks.controller.start).toHaveBeenCalledTimes(1))
    })

    it('stops the sync and removes the books that have no file here', async () => {
        const onChanges = vi.fn()
        await storage.addBook({ record: makeBook('a'), file: new Blob(['a']), cover: null })
        await storage.addBook({
            record: makeBook('b', { remoteOnly: true }),
            file: new Blob(['b']),
            cover: null,
        })
        localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(CONFIG))
        const host = createSyncHost({ onChanges })
        host.connectStorage(storage)
        await host.syncNow()

        await host.turnOff()

        expect(mocks.controller.destroy).toHaveBeenCalledTimes(1)
        expect(readSyncConfig()).toBeNull()
        expect(host.isOn()).toBe(false)
        expect((await storage.listBooks()).map((book) => book.id)).toEqual(['a'])
        expect(onChanges).toHaveBeenCalledWith({ books: ['b'], progress: [], annotations: [] })
    })

    it('shows one toast for a wrong sync code, and tells the status listeners', async () => {
        localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(CONFIG))
        const host = createSyncHost({ onChanges: () => {} })
        host.connectStorage(storage)
        const listener = vi.fn()
        host.onStatus(listener)
        await host.syncNow()
        const error = new SyncError('unauthorized', 'The sync code is not correct.')
        const failed: SyncStatus = { phase: 'error', syncedAt: null, error }

        mocks.created[0].onStatus(failed)
        mocks.created[0].onStatus(failed)

        expect(listener).toHaveBeenCalledWith(failed)
        expect(host.status()).toBe(failed)
        expect(toastTexts()).toEqual(['Sync stopped. The sync code is not correct.'])
    })

    it('shows no toast when the network is down', async () => {
        localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(CONFIG))
        const host = createSyncHost({ onChanges: () => {} })
        host.connectStorage(storage)
        await host.syncNow()

        mocks.created[0].onStatus({
            phase: 'error',
            syncedAt: null,
            error: new SyncError('offline', 'No answer.'),
        })

        expect(toastTexts()).toEqual([])
    })

    it('opens the dialog with the server and the code of a link', async () => {
        const host = createSyncHost({ onChanges: () => {} })

        host.openDialog(null, CONFIG)

        await vi.waitFor(() =>
            expect(mocks.show).toHaveBeenCalledWith({ opener: null, link: CONFIG }),
        )
    })
})
