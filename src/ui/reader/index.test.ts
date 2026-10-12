import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { LibraryStorage } from '$lib/storage/types'
import { clearToasts } from '../app/toast'
import type { ReaderMountOptions } from './types'

interface Started {
    resolve(): void
    reject(error: unknown): void
    destroy: Mock<() => Promise<void>>
}

const mocks = vi.hoisted(() => ({
    started: [] as Started[],
    startReader: vi.fn(),
    openReaderSession: vi.fn(),
}))

// The real modules load the two reader views. This file tests only the entry point.
vi.mock('./session', () => ({ openReaderSession: mocks.openReaderSession }))
vi.mock('./screen/part-modules', () => ({ partModules: {} }))
vi.mock('./screen/start', () => ({ startReader: mocks.startReader }))

function options(): ReaderMountOptions & { onExit: Mock<() => void> } {
    return {
        root: document.createElement('div'),
        bookId: 'book-1',
        storage: {} as LibraryStorage,
        onExit: vi.fn<() => void>(),
    }
}

async function flush(): Promise<void> {
    for (let round = 0; round < 10; round++) await Promise.resolve()
}

function toastText(): string | null {
    return document.querySelector('#toasts .toast')?.textContent ?? null
}

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.startReader.mockImplementation(() => {
        let resolve!: () => void
        let reject!: (error: unknown) => void
        const ready = new Promise<void>((done, fail) => {
            resolve = done
            reject = fail
        })
        const destroy = vi.fn<() => Promise<void>>(async () => {})
        mocks.started.push({ resolve, reject, destroy })
        return { ready, destroy }
    })
})

afterEach(() => {
    mocks.started.length = 0
    clearToasts()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.clearAllMocks()
})

describe('mountReader', () => {
    it('starts the reader with the real session and gives its destroy function at once', async () => {
        const { mountReader } = await import('./index')
        const given = options()
        // The book still opens. The app shell must get the reader now, so it can close it.
        const reader = await mountReader(given)

        expect(mocks.startReader).toHaveBeenCalledTimes(1)
        const [mountOptions, deps] = mocks.startReader.mock.calls[0]
        expect(mountOptions).toBe(given)
        expect(deps.openSession).toBe(mocks.openReaderSession)

        await reader.destroy()
        expect(mocks.started[0].destroy).toHaveBeenCalledTimes(1)
    })

    it('shows no message for a book that opens', async () => {
        const { mountReader } = await import('./index')
        const given = options()
        await mountReader(given)
        mocks.started[0].resolve()
        await flush()
        expect(toastText()).toBeNull()
        expect(given.onExit).not.toHaveBeenCalled()
    })

    it('shows a message and leaves the reader for a book with no file in the library', async () => {
        const { mountReader, MISSING_FILE_MESSAGE } = await import('./index')
        const given = options()
        await mountReader(given)
        mocks.started[0].reject(new Error('book-not-found'))
        await flush()
        expect(toastText()).toBe(MISSING_FILE_MESSAGE)
        expect(given.onExit).toHaveBeenCalledTimes(1)
    })
})
