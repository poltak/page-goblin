import { describe, expect, it } from 'vitest'
import { clearSyncConfig, readSyncConfig, SYNC_STORAGE_KEY, writeSyncConfig } from './config'

function memoryStorage(initial: Record<string, string> = {}) {
    const items = new Map(Object.entries(initial))
    return {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
    }
}

describe('sync config', () => {
    it('is null when the sync is off', () => {
        expect(readSyncConfig(memoryStorage())).toBeNull()
        expect(readSyncConfig(null)).toBeNull()
    })

    it('writes, reads and clears the config', () => {
        const storage = memoryStorage()
        const config = { server: 'https://sync.example.workers.dev', code: 'ABCD-EFGH' }
        writeSyncConfig(config, storage)
        expect(readSyncConfig(storage)).toEqual(config)
        clearSyncConfig(storage)
        expect(readSyncConfig(storage)).toBeNull()
    })

    it('ignores a value that is not a config', () => {
        for (const value of ['{nope', '1', '{"server":"x"}', '{"server":"","code":"c"}']) {
            expect(readSyncConfig(memoryStorage({ [SYNC_STORAGE_KEY]: value }))).toBeNull()
        }
    })

    it('throws when the browser gives no storage', () => {
        expect(() => writeSyncConfig({ server: 's', code: 'c' }, null)).toThrow()
    })
})
