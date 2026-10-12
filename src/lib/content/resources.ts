import type { EpubBook } from '$lib/epub/types'

/** URLs for files of one book, with a reference count for each path. */
export interface ResourceStore {
    /**
     * A URL for the file: an object URL, or a data URL for an SVG file. Concurrent calls for
     * one path share one read of the book.
     */
    acquire(path: string): Promise<string>
    /** Call one time for each `acquire` that resolved. The store revokes the URL at count 0. */
    release(path: string): void
    /** Revoke all URLs. Later `acquire` calls reject. */
    dispose(): void
}

const SVG_TYPE = 'image/svg+xml'
const INERT_TYPE = 'application/octet-stream'
// A browser shows these types as media, or downloads them. It never runs them as a document.
const PASSIVE_TYPE = /^(?:image|font|audio|video)\/[\w.-]+$/

function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error ?? new Error('The file cannot be read.'))
        reader.readAsDataURL(blob)
    })
}

/**
 * Make the URL that the reader DOM and the book CSS use for a file of the book.
 *
 * An object URL has the origin of the app. When the user opens one in a tab (for example with
 * "Open image in new tab"), a file with a document type (HTML, XML, SVG) runs its scripts with
 * access to the library. The media type comes from the book, so it is not safe. An image or a
 * font keeps its type, because a browser never runs these. An SVG file gets a data URL, which
 * has no origin. All other files get a type that a browser only downloads. An image element
 * and a font face find the format from the bytes of the file, so they do not need the type.
 */
function createUrl(blob: Blob): Promise<string> | string {
    const type = blob.type.split(';', 1)[0].trim().toLowerCase()
    if (type === SVG_TYPE) return readAsDataUrl(blob.slice(0, blob.size, SVG_TYPE))
    return URL.createObjectURL(
        PASSIVE_TYPE.test(type) ? blob : blob.slice(0, blob.size, INERT_TYPE),
    )
}

function revokeUrl(url: string): void {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

interface Entry {
    promise: Promise<string>
    url: string | null
    count: number
}

export function createResourceStore(book: EpubBook): ResourceStore {
    const entries = new Map<string, Entry>()
    let disposed = false

    function acquire(path: string): Promise<string> {
        if (disposed) return Promise.reject(new Error('The resource store is disposed.'))

        const existing = entries.get(path)
        if (existing) {
            existing.count++
            return existing.promise
        }

        const entry: Entry = { url: null, count: 1, promise: null as never }
        entry.promise = book
            .readBlob(path)
            .then(createUrl)
            .then(
                (url) => {
                    // The entry was released, or the store was disposed, during the read.
                    if (entries.get(path) !== entry) revokeUrl(url)
                    else entry.url = url
                    return url
                },
                (error) => {
                    if (entries.get(path) === entry) entries.delete(path)
                    throw error
                },
            )
        entries.set(path, entry)
        return entry.promise
    }

    function release(path: string): void {
        const entry = entries.get(path)
        if (!entry || --entry.count > 0) return
        entries.delete(path)
        if (entry.url) revokeUrl(entry.url)
    }

    function dispose(): void {
        disposed = true
        for (const entry of entries.values()) {
            if (entry.url) revokeUrl(entry.url)
        }
        entries.clear()
    }

    return { acquire, release, dispose }
}
