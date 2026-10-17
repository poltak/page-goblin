/**
 * The sync settings of this device, in localStorage. The first chunk loads this file to know
 * if the sync is on, so it must stay small and import no other module.
 */

import type { SyncConfig } from './types'

export const SYNC_STORAGE_KEY = 'page-goblin:sync'

/** The part of the Storage interface that the config uses. */
export interface ConfigStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

function pageStorage(): ConfigStorage | null {
    try {
        return globalThis.localStorage ?? null
    } catch {
        // Some browsers throw here when site data is blocked.
        return null
    }
}

/** The config of the sync, or null when the sync is off on this device. */
export function readSyncConfig(storage = pageStorage()): SyncConfig | null {
    let raw: unknown
    try {
        raw = JSON.parse(storage?.getItem(SYNC_STORAGE_KEY) ?? 'null')
    } catch {
        return null
    }
    if (typeof raw !== 'object' || raw === null) return null
    const { server, code } = raw as Record<string, unknown>
    if (typeof server !== 'string' || typeof code !== 'string' || !server || !code) return null
    return { server, code }
}

export function writeSyncConfig(config: SyncConfig, storage = pageStorage()): void {
    if (!storage) throw new Error('This browser does not let the app save the sync settings.')
    storage.setItem(SYNC_STORAGE_KEY, JSON.stringify({ server: config.server, code: config.code }))
}

export function clearSyncConfig(storage = pageStorage()): void {
    storage?.removeItem(SYNC_STORAGE_KEY)
}
