export interface StorageEstimate {
    /** Bytes that this site uses now. */
    usage: number
    /** Bytes that the browser lets this site use. */
    quota: number
}

function storageManager(): StorageManager | undefined {
    // navigator.storage is not there on a page without HTTPS.
    return typeof navigator === 'undefined' ? undefined : navigator.storage
}

/** Used and available space, or null when the browser does not tell. Never rejects. */
export async function getStorageEstimate(): Promise<StorageEstimate | null> {
    try {
        const estimate = await storageManager()?.estimate?.()
        if (typeof estimate?.usage !== 'number' || typeof estimate.quota !== 'number') return null
        return { usage: estimate.usage, quota: estimate.quota }
    } catch {
        return null
    }
}

/**
 * Ask the browser to keep the library when the device has little free space. The result is
 * true when the storage is persistent after the call. Never rejects.
 */
export async function requestPersistentStorage(): Promise<boolean> {
    try {
        const storage = storageManager()
        if (typeof storage?.persist !== 'function') return false
        // Firefox shows a permission prompt for persist(), so do not ask a second time.
        if (typeof storage.persisted === 'function' && (await storage.persisted())) return true
        return await storage.persist()
    } catch {
        return false
    }
}

/** True for the error of a write that failed because the site has no space left. */
export function isQuotaError(error: unknown): boolean {
    for (let current = error, depth = 0; current && depth < 4; depth++) {
        const { name, cause } = current as { name?: unknown; cause?: unknown }
        if (name === 'QuotaExceededError') return true
        current = cause
    }
    return false
}
