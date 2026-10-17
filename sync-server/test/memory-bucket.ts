/** The parts of R2 that the handler uses, in memory. */

import type { Bucket, ObjectInfo, StoredObject } from '../src/handler'

interface Entry {
    bytes: Uint8Array
    contentType?: string
}

export function createMemoryBucket(): Bucket & { keys(): string[] } {
    const entries = new Map<string, Entry>()

    function info(key: string): ObjectInfo | null {
        const entry = entries.get(key)
        if (!entry) return null
        return {
            size: entry.bytes.byteLength,
            httpEtag: `"${entry.bytes.byteLength}-${key}"`,
            httpMetadata: { contentType: entry.contentType },
        }
    }

    return {
        async head(key) {
            return info(key)
        },
        async get(key): Promise<StoredObject | null> {
            const found = info(key)
            if (!found) return null
            const body = new Response(entries.get(key)!.bytes as Uint8Array<ArrayBuffer>).body!
            return { ...found, body }
        },
        async put(key, value, options) {
            const bytes = new Uint8Array(await new Response(value).arrayBuffer())
            entries.set(key, { bytes, contentType: options?.httpMetadata?.contentType })
        },
        keys: () => [...entries.keys()],
    }
}
