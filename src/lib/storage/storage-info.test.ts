import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStorageEstimate, isQuotaError, requestPersistentStorage } from './storage-info'

function stubStorage(storage: Partial<StorageManager> | undefined): void {
    vi.stubGlobal('navigator', { storage })
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('getStorageEstimate', () => {
    it('gives the usage and the quota', async () => {
        stubStorage({ estimate: async () => ({ usage: 1234, quota: 5000, other: 1 }) })

        expect(await getStorageEstimate()).toEqual({ usage: 1234, quota: 5000 })
    })

    it('gives null when the browser has no storage manager', async () => {
        // jsdom has no navigator.storage.
        expect(await getStorageEstimate()).toBeNull()

        stubStorage(undefined)
        expect(await getStorageEstimate()).toBeNull()

        vi.stubGlobal('navigator', undefined)
        expect(await getStorageEstimate()).toBeNull()
    })

    it('gives null when the storage manager has no estimate function', async () => {
        stubStorage({})

        expect(await getStorageEstimate()).toBeNull()
    })

    it('gives null when the estimate has no numbers', async () => {
        stubStorage({ estimate: async () => ({}) })
        expect(await getStorageEstimate()).toBeNull()

        stubStorage({ estimate: async () => ({ usage: 10 }) })
        expect(await getStorageEstimate()).toBeNull()
    })

    it('gives null when the estimate fails', async () => {
        stubStorage({ estimate: () => Promise.reject(new Error('No estimate.')) })
        expect(await getStorageEstimate()).toBeNull()

        stubStorage({
            estimate: () => {
                throw new Error('No estimate.')
            },
        })
        expect(await getStorageEstimate()).toBeNull()
    })
})

describe('requestPersistentStorage', () => {
    it('asks the browser and gives the answer', async () => {
        const persist = vi.fn(async () => true)
        stubStorage({ persisted: async () => false, persist })

        expect(await requestPersistentStorage()).toBe(true)
        expect(persist).toHaveBeenCalledOnce()
    })

    it('gives false when the browser refuses', async () => {
        stubStorage({ persisted: async () => false, persist: async () => false })

        expect(await requestPersistentStorage()).toBe(false)
    })

    it('does not ask again when the storage is persistent', async () => {
        const persist = vi.fn(async () => true)
        stubStorage({ persisted: async () => true, persist })

        expect(await requestPersistentStorage()).toBe(true)
        expect(persist).not.toHaveBeenCalled()
    })

    it('asks when the browser has no persisted function', async () => {
        stubStorage({ persist: async () => true })

        expect(await requestPersistentStorage()).toBe(true)
    })

    it('gives false when the browser has no storage manager or no persist function', async () => {
        // jsdom has no navigator.storage.
        expect(await requestPersistentStorage()).toBe(false)

        stubStorage({})
        expect(await requestPersistentStorage()).toBe(false)

        vi.stubGlobal('navigator', undefined)
        expect(await requestPersistentStorage()).toBe(false)
    })

    it('gives false when a call fails', async () => {
        stubStorage({
            persisted: () => Promise.reject(new Error('Blocked.')),
            persist: async () => true,
        })
        expect(await requestPersistentStorage()).toBe(false)

        stubStorage({
            persisted: async () => false,
            persist: () => Promise.reject(new Error('Blocked.')),
        })
        expect(await requestPersistentStorage()).toBe(false)
    })
})

describe('isQuotaError', () => {
    it('is true for a quota error', () => {
        expect(isQuotaError(new DOMException('No space.', 'QuotaExceededError'))).toBe(true)
    })

    it('is true when a quota error is the cause of the error', () => {
        const cause = new DOMException('No space.', 'QuotaExceededError')

        expect(isQuotaError(new Error('Unable to save the book.', { cause }))).toBe(true)
    })

    it('is false for other values', () => {
        expect(isQuotaError(new DOMException('In use.', 'ConstraintError'))).toBe(false)
        expect(isQuotaError(new Error('Unable to save the book.'))).toBe(false)
        expect(isQuotaError('QuotaExceededError')).toBe(false)
        expect(isQuotaError(null)).toBe(false)
        expect(isQuotaError(undefined)).toBe(false)
    })

    it('stops on a chain of causes that has no end', () => {
        const error: { name: string; cause?: unknown } = { name: 'Error' }
        error.cause = error

        expect(isQuotaError(error)).toBe(false)
    })
})
