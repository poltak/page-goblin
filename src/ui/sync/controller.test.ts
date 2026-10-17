import { Blob as NodeBlob } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLibraryStorage, type LibraryFileStorage } from '$lib/storage/library-storage'
import type { SyncBackend } from '$lib/sync/types'
import {
    CHANGE_DELAY_MS,
    createSyncController,
    INTERVAL_MS,
    RETURN_GAP_MS,
    type SyncController,
} from './controller'

let storage: LibraryFileStorage
let backend: { [K in keyof SyncBackend]: ReturnType<typeof vi.fn<SyncBackend[K]>> }
let controller: SyncController
let clock: number
let visibility: DocumentVisibilityState

const pulls = () => backend.pull.mock.calls.length

function setVisibility(state: DocumentVisibilityState): void {
    visibility = state
    document.dispatchEvent(new Event('visibilitychange'))
}

/** Lets a sync run that started finish. IndexedDB works on real timers. */
async function settle(): Promise<void> {
    for (let round = 0; round < 20; round++) {
        await vi.advanceTimersByTimeAsync(0)
        await new Promise((resolve) => setImmediate(resolve))
    }
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.stubGlobal('Blob', NodeBlob)
    clock = 100_000
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    storage = createLibraryStorage({
        indexedDB: new IDBFactory(),
        changes: { isOn: () => true, onChange: () => {} },
    })
    backend = {
        status: vi.fn(async () => ({ account: 'acc' })),
        pull: vi.fn(async () => ({ account: 'acc', changes: [], cursor: 0, more: false })),
        push: vi.fn(async () => ({ rejected: [] })),
        hasBlob: vi.fn(async () => true),
        putBlob: vi.fn(async () => {}),
        getBlob: vi.fn(async () => null),
    }
    controller = await createSyncController({
        storage,
        config: { server: 'https://sync.test.workers.dev', code: 'unused' },
        onChanges: () => {},
        onStatus: () => {},
        backend,
        now: () => clock,
    })
})

afterEach(async () => {
    await controller.destroy()
    storage.close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('createSyncController', () => {
    it('syncs at the start and every few minutes while the app is on screen', async () => {
        controller.start()
        await settle()
        expect(pulls()).toBe(1)

        await vi.advanceTimersByTimeAsync(INTERVAL_MS)
        await settle()
        expect(pulls()).toBe(2)

        visibility = 'hidden'
        await vi.advanceTimersByTimeAsync(INTERVAL_MS)
        await settle()
        expect(pulls()).toBe(2)
    })

    it('syncs some seconds after a change, one time for many changes', async () => {
        controller.start()
        await settle()

        controller.schedule()
        controller.schedule()
        await vi.advanceTimersByTimeAsync(CHANGE_DELAY_MS - 1)
        expect(pulls()).toBe(1)
        await vi.advanceTimersByTimeAsync(1)
        await settle()
        expect(pulls()).toBe(2)
    })

    it('sends the changes when the app goes to the background, and pulls nothing', async () => {
        await storage.addBook({
            record: {
                id: 'a',
                title: 'A',
                author: '',
                language: null,
                identifier: null,
                publisher: null,
                description: null,
                published: null,
                subjects: [],
                series: null,
                fileName: 'a.epub',
                fileSize: 1,
                fileHash: 'a'.repeat(64),
                hasCover: false,
                spineStats: [],
                totalChars: 0,
                totalWords: 0,
                addedAt: 1,
                lastOpenedAt: null,
            },
            file: new Blob(['a']),
            cover: null,
        })
        controller.start()
        await settle()
        const pushes = backend.push.mock.calls.length
        await storage.putBookmark({
            id: 'm',
            bookId: 'a',
            locator: { spineIndex: 0, offset: 0 },
            fraction: 0,
            chapterTitle: '',
            excerpt: '',
            createdAt: 1,
        })

        setVisibility('hidden')
        await settle()

        expect(pulls()).toBe(1)
        expect(backend.push).toHaveBeenCalledTimes(pushes + 1)
        const [changes, options] = backend.push.mock.calls[pushes]
        expect(changes.map((change) => change.key)).toEqual(['m'])
        expect(options).toEqual({ keepalive: true })
    })

    it('syncs when the app comes back after some time, and when the network comes back', async () => {
        controller.start()
        await settle()

        setVisibility('hidden')
        setVisibility('visible')
        await settle()
        expect(pulls()).toBe(1)

        clock += RETURN_GAP_MS + 1
        setVisibility('visible')
        await settle()
        expect(pulls()).toBe(2)

        window.dispatchEvent(new Event('online'))
        await settle()
        expect(pulls()).toBe(3)
    })

    it('stops all triggers after destroy()', async () => {
        controller.start()
        await settle()
        controller.schedule()

        await controller.destroy()
        window.dispatchEvent(new Event('online'))
        await vi.advanceTimersByTimeAsync(INTERVAL_MS)
        await settle()

        expect(pulls()).toBe(1)
        await controller.syncNow()
        expect(pulls()).toBe(1)
    })

    it('gives the error of a sync that the user started', async () => {
        backend.pull.mockRejectedValue(new Error('down'))

        await expect(controller.syncNow()).rejects.toMatchObject({ name: 'SyncError' })
    })
})
