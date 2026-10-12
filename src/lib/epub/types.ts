/**
 * Public types of the EPUB module.
 *
 * This module has no imports from the rest of the app, so it can move to the
 * `poltak-epub-parser` package later without changes.
 */

export interface EpubMetadata {
    /** `dc:title`, or 'Unknown Title'. */
    title: string
    /** All `dc:creator` values joined with ', ', or 'Unknown Author'. */
    author: string
    creators: string[]
    /** `dc:language` as written (a BCP 47 tag), or null. */
    language: string | null
    /** The unique identifier that the package `unique-identifier` attribute points to, or null. */
    identifier: string | null
    publisher: string | null
    /** `dc:description` as plain text (markup removed), or null. */
    description: string | null
    /** `dc:date` as written, or null. */
    published: string | null
    subjects: string[]
    /** From `belongs-to-collection` (EPUB 3) or `calibre:series` (EPUB 2), or null. */
    series: { name: string; position: number | null } | null
}

export interface ManifestItem {
    id: string
    /** Normalised path inside the ZIP container (no leading slash, percent-decoded). */
    path: string
    /**
     * Lower-case media type. For stylesheet, image and font files the file extension has
     * priority over the declared type, because real books declare many wrong types. Fonts are
     * always `font/ttf`, `font/otf`, `font/woff` or `font/woff2`.
     */
    mediaType: string
    properties: string[]
    /** Uncompressed size in bytes. 0 when the file is not in the container. */
    size: number
}

export interface SpineItem {
    /** Position in `EpubBook.spine`. */
    index: number
    idref: string
    /** Normalised path of the content document inside the ZIP container. */
    path: string
    mediaType: string
    /** False for `linear="no"` items (notes, popups). Normal page turns skip them. */
    linear: boolean
    /** Uncompressed size in bytes. */
    size: number
    /** The itemref properties, then the manifest item properties, with no duplicates. */
    properties: string[]
}

export interface TocItem {
    title: string
    /** Path of the target document, or null when the entry is a heading with no link. */
    path: string | null
    /** Fragment identifier without '#', or null. */
    fragment: string | null
    /** Index into `EpubBook.spine`, or -1 when the target is not in the spine. */
    spineIndex: number
    children: TocItem[]
}

export interface ResolvedHref {
    /** Normalised container path. */
    path: string
    /** Fragment identifier without '#', or null. */
    fragment: string | null
}

export type PageProgression = 'ltr' | 'rtl'

export interface EpubBook {
    readonly metadata: EpubMetadata
    readonly manifest: readonly ManifestItem[]
    /** All spine items whose manifest entry is an (X)HTML document that is in the container. */
    readonly spine: readonly SpineItem[]
    /** Nested table of contents. Empty when the book has no nav document and no NCX. */
    readonly toc: readonly TocItem[]
    /** Container path of the cover image, or null. */
    readonly coverPath: string | null
    readonly pageProgression: PageProgression

    /** True when the container has a file at this normalised path. */
    has(path: string): boolean
    /** Media type from the manifest, then from the file extension, or null. */
    mediaTypeOf(path: string): string | null
    /** Index of the spine item with this path, or -1. */
    spineIndexOf(path: string): number
    /**
     * Resolve an href that is written in the document at `fromPath`.
     * Returns null for external URLs (any scheme), empty hrefs and paths that leave the container.
     * An href that is only a fragment ('#note1') resolves to `fromPath` itself.
     */
    resolve(fromPath: string, href: string): ResolvedHref | null
    /**
     * Read a file as text. The encoding comes from the byte order mark or the XML declaration;
     * the default is UTF-8. Rejects with `EpubError('missing-file')` when the path is not there.
     */
    readText(path: string): Promise<string>
    /** Read a file as bytes. Obfuscated fonts are returned in their clear form. */
    readBytes(path: string): Promise<Uint8Array<ArrayBuffer>>
    /** Read a file as a Blob with the media type from `mediaTypeOf`. */
    readBlob(path: string): Promise<Blob>
}

export type EpubErrorCode =
    /** The file is not a ZIP archive, or the archive is damaged. */
    | 'not-zip'
    /** `META-INF/container.xml` is missing or has no rootfile. */
    | 'no-container'
    /** The package document (OPF) is missing or is not well-formed XML. */
    | 'invalid-package'
    /** The book has DRM encryption (not font obfuscation). */
    | 'drm'
    /** The spine has no readable content documents. */
    | 'no-content'
    /** A requested file is not in the container. */
    | 'missing-file'
    /** A file uses a compression method other than stored or deflate. */
    | 'unsupported-compression'

export class EpubError extends Error {
    readonly code: EpubErrorCode

    constructor(code: EpubErrorCode, message: string) {
        super(message)
        this.name = 'EpubError'
        this.code = code
    }
}
