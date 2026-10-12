/** Object URLs for the cover images of the library. One URL for each book. */

import type { LibraryStorage } from '$lib/storage/types'

export interface CoverStore {
    /**
     * The object URL of the cover of a book, or null when the book has none. The first call
     * reads the image from storage. The URL stays valid until `release`.
     */
    url(bookId: string): Promise<string | null>
    /** Revokes the URL of a book that left the library. */
    release(bookId: string): void
}

export function createCoverStore(storage: Pick<LibraryStorage, 'getCover'>): CoverStore {
    const urls = new Map<string, Promise<string | null>>()

    async function read(bookId: string): Promise<string | null> {
        try {
            const blob = await storage.getCover(bookId)
            // The test environment has no object URLs.
            if (!blob || typeof URL.createObjectURL !== 'function') return null
            return URL.createObjectURL(blob)
        } catch {
            // A cover that cannot be read shows as a book with no cover.
            return null
        }
    }

    return {
        url(bookId) {
            let url = urls.get(bookId)
            if (!url) {
                url = read(bookId)
                urls.set(bookId, url)
            }
            return url
        },
        release(bookId) {
            const pending = urls.get(bookId)
            if (!pending) return
            urls.delete(bookId)
            void pending.then((url) => {
                if (url) URL.revokeObjectURL(url)
            })
        },
    }
}
