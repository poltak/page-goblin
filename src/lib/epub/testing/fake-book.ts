/**
 * An in-memory `EpubBook` for tests of modules that use a book but do not test the EPUB parser.
 */

import {
    EpubError,
    type EpubBook,
    type EpubMetadata,
    type ManifestItem,
    type PageProgression,
    type ResolvedHref,
    type SpineItem,
    type TocItem,
} from '../types'

export interface FakeBookOptions {
    /** Container path to file content. Strings are stored as UTF-8. */
    files: Record<string, string | Uint8Array<ArrayBuffer>>
    /** Container paths of the content documents in reading order. */
    spine: string[]
    metadata?: Partial<EpubMetadata>
    toc?: TocItem[]
    coverPath?: string | null
    pageProgression?: PageProgression
    /** Spine paths that have `linear="no"`. */
    nonLinear?: string[]
}

const MEDIA_TYPES: Record<string, string> = {
    xhtml: 'application/xhtml+xml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    otf: 'font/otf',
    ttf: 'font/ttf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ncx: 'application/x-dtbncx+xml',
}

export function mediaTypeFromPath(path: string): string | null {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    return MEDIA_TYPES[extension] ?? null
}

export function resolveFakePath(fromPath: string, href: string): ResolvedHref | null {
    const trimmed = href.trim()
    if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return null

    const hashIndex = trimmed.indexOf('#')
    const rawPath = (hashIndex < 0 ? trimmed : trimmed.slice(0, hashIndex)).split('?', 1)[0]
    const fragment = hashIndex < 0 ? null : trimmed.slice(hashIndex + 1) || null
    if (!rawPath) return { path: fromPath, fragment }

    const baseDirectory = fromPath.slice(0, fromPath.lastIndexOf('/') + 1)
    const combined = rawPath.startsWith('/') ? rawPath.slice(1) : baseDirectory + rawPath
    const parts: string[] = []
    for (const part of decodeURIComponent(combined).split('/')) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (!parts.length) return null
            parts.pop()
            continue
        }
        parts.push(part)
    }

    return { path: parts.join('/'), fragment }
}

export function createFakeBook(options: FakeBookOptions): EpubBook {
    const encoder = new TextEncoder()
    const files = new Map<string, Uint8Array<ArrayBuffer>>()
    for (const [path, content] of Object.entries(options.files)) {
        files.set(path, typeof content === 'string' ? encoder.encode(content) : content)
    }

    const nonLinear = new Set(options.nonLinear ?? [])
    const manifest: ManifestItem[] = [...files.keys()].map((path, index) => ({
        id: `item-${index}`,
        path,
        mediaType: mediaTypeFromPath(path) ?? 'application/octet-stream',
        properties: [],
        size: files.get(path)?.byteLength ?? 0,
    }))
    const spine: SpineItem[] = options.spine.map((path, index) => ({
        index,
        idref: manifest.find((item) => item.path === path)?.id ?? `missing-${index}`,
        path,
        mediaType: mediaTypeFromPath(path) ?? 'application/xhtml+xml',
        linear: !nonLinear.has(path),
        size: files.get(path)?.byteLength ?? 0,
        properties: [],
    }))

    const metadata: EpubMetadata = {
        title: 'Test Book',
        author: 'Test Author',
        creators: ['Test Author'],
        language: 'en',
        identifier: 'urn:uuid:00000000-0000-4000-8000-000000000000',
        publisher: null,
        description: null,
        published: null,
        subjects: [],
        series: null,
        ...options.metadata,
    }

    const readBytes = async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
        const bytes = files.get(path)
        if (!bytes) throw new EpubError('missing-file', `File not found in the book: ${path}`)
        return bytes
    }

    return {
        metadata,
        manifest,
        spine,
        toc: options.toc ?? [],
        coverPath: options.coverPath ?? null,
        pageProgression: options.pageProgression ?? 'ltr',
        has: (path) => files.has(path),
        mediaTypeOf: (path) =>
            manifest.find((item) => item.path === path)?.mediaType ?? mediaTypeFromPath(path),
        spineIndexOf: (path) => spine.findIndex((item) => item.path === path),
        resolve: resolveFakePath,
        readBytes,
        readText: async (path) => new TextDecoder().decode(await readBytes(path)),
        readBlob: async (path) =>
            new Blob([await readBytes(path)], {
                type: mediaTypeFromPath(path) ?? 'application/octet-stream',
            }),
    }
}
