/**
 * Opens an EPUB file. `openEpub` reads only the ZIP directory and the small files that
 * describe the book. Chapters, images and fonts are read later, one entry for each request.
 */

import { deobfuscate, fontKey, readEncryption, type FontObfuscation } from './encryption'
import { mediaTypeFromPath } from './media-type'
import { parseNav } from './nav'
import { parseNcx } from './ncx'
import { readPackage, type CoverCandidate } from './package'
import { resolveHref, resolvePath } from './path'
import { decodeText } from './text'
import type { TocContext } from './toc'
import { EpubError, type EpubBook, type ManifestItem, type TocItem } from './types'
import { attribute, descendants, localName, parseContentDocument, parseXml } from './xml'
import { openZip, type ZipEntry } from './zip'

const CONTAINER_PATH = 'META-INF/container.xml'
const ENCRYPTION_PATH = 'META-INF/encryption.xml'
const PACKAGE_MEDIA_TYPE = 'application/oebps-package+xml'
/** A cover page is small. A larger document is not read at open, to keep the open fast. */
const MAX_COVER_PAGE_SIZE = 256 * 1024

export async function openEpub(file: Blob): Promise<EpubBook> {
    const archive = await openZip(file)

    const readOptionalText = async (path: string): Promise<string | null> => {
        const entry = archive.find(path)
        return entry ? decodeText(await archive.read(entry)) : null
    }
    const [containerText, encryptionText] = await Promise.all([
        readOptionalText(CONTAINER_PATH),
        readOptionalText(ENCRYPTION_PATH),
    ])

    const encryption = encryptionText === null ? null : readEncryption(encryptionText)
    if (encryption?.drmAlgorithm) {
        throw new EpubError('drm', 'The book has DRM protection, so the reader cannot open it.')
    }

    const opfPath = rootfilePath(containerText)
    const opfEntry = archive.find(opfPath)
    if (!opfEntry) {
        throw new EpubError('invalid-package', `The package document is missing: ${opfPath}`)
    }
    const opfDocument = parseXml(decodeText(await archive.read(opfEntry)))
    if (!opfDocument) {
        throw new EpubError('invalid-package', 'The package document is not well-formed XML.')
    }

    const data = readPackage({
        document: opfDocument,
        opfPath: opfEntry.path,
        lookup: (path) => archive.find(path),
    })
    const { manifest, spine } = data
    if (!spine.length) throw new EpubError('no-content', 'The book has no readable chapters.')

    const spineIndexes = new Map(spine.map((item) => [item.path, item.index]))
    const manifestByPath = new Map<string, ManifestItem>()
    for (const item of manifest) {
        if (!manifestByPath.has(item.path)) manifestByPath.set(item.path, item)
    }

    // The encryption file writes paths from the container root. The key here is the entry name.
    const obfuscatedFonts = new Map<string, FontObfuscation>()
    for (const [path, algorithm] of encryption?.fonts ?? []) {
        obfuscatedFonts.set(archive.find(path)?.path ?? path, algorithm)
    }
    const fontKeys = new Map<FontObfuscation, Promise<Uint8Array | null>>()
    const fontKeyFor = (algorithm: FontObfuscation) => {
        let key = fontKeys.get(algorithm)
        if (!key) {
            key = fontKey(algorithm, {
                uniqueIdentifier: data.uniqueIdentifierText,
                identifiers: data.identifiers,
            })
            fontKeys.set(algorithm, key)
        }
        return key
    }

    /** The entry name for a path that can differ in letter case, or the path itself. */
    const canonical = (path: string) => archive.find(path)?.path ?? path

    const entryOf = (path: string): ZipEntry => {
        const entry = archive.find(path)
        if (!entry) throw new EpubError('missing-file', `File not found in the book: ${path}`)
        return entry
    }

    const mediaTypeOf: EpubBook['mediaTypeOf'] = (path) =>
        (manifestByPath.get(path) ?? manifestByPath.get(canonical(path)))?.mediaType ??
        mediaTypeFromPath(path)

    const spineIndexOf: EpubBook['spineIndexOf'] = (path) =>
        spineIndexes.get(path) ?? spineIndexes.get(canonical(path)) ?? -1

    const resolve: EpubBook['resolve'] = (fromPath, href) => {
        const resolved = resolveHref(fromPath, href)
        if (resolved && resolved.path !== fromPath) resolved.path = canonical(resolved.path)
        return resolved
    }

    const readBytes: EpubBook['readBytes'] = async (path) => {
        const entry = entryOf(path)
        const bytes = await archive.read(entry)
        const algorithm = obfuscatedFonts.get(entry.path)
        const key = algorithm && (await fontKeyFor(algorithm))
        if (algorithm && key) deobfuscate(bytes, key, algorithm)
        return bytes
    }

    const readText: EpubBook['readText'] = async (path) => decodeText(await readBytes(path))

    const readBlob: EpubBook['readBlob'] = async (path) => {
        const entry = entryOf(path)
        const type = mediaTypeOf(path) ?? 'application/octet-stream'
        return obfuscatedFonts.has(entry.path)
            ? new Blob([await readBytes(path)], { type })
            : archive.readBlob(entry, type)
    }

    const readToc = async (): Promise<TocItem[]> => {
        const sources = [
            { path: data.navPath, parse: parseNav },
            { path: data.ncxPath, parse: parseNcx },
        ]
        for (const { path, parse } of sources) {
            if (!path) continue
            try {
                const context: TocContext = { fromPath: path, resolve, spineIndexOf }
                const items = parse(await readText(path), context)
                if (items.length) return items
            } catch {
                // A damaged table of contents must not stop the book from opening.
            }
        }
        return []
    }

    const findCover = async (candidates: CoverCandidate[]): Promise<string | null> => {
        let pageWasRead = false
        for (const candidate of candidates) {
            if (candidate.kind === 'image') return candidate.path
            // One cover page is the only content document that is read at open.
            if (pageWasRead || candidate.size > MAX_COVER_PAGE_SIZE) continue
            pageWasRead = true
            try {
                const text = await readText(candidate.path)
                const document = parseContentDocument(text)
                for (const href of imageHrefs(document)) {
                    const target = resolve(candidate.path, href)
                    if (
                        target &&
                        archive.find(target.path) &&
                        mediaTypeOf(target.path)?.startsWith('image/')
                    ) {
                        return target.path
                    }
                }
            } catch {
                // The next candidate can still give a cover.
            }
        }
        return null
    }

    const [toc, coverPath] = await Promise.all([readToc(), findCover(data.coverCandidates)])

    return {
        metadata: data.metadata,
        manifest,
        spine,
        toc,
        coverPath,
        pageProgression: data.pageProgression,
        has: (path) => archive.find(path) !== undefined,
        mediaTypeOf,
        spineIndexOf,
        resolve,
        readText,
        readBytes,
        readBlob,
    }
}

/** The container path of the package document, from `META-INF/container.xml`. */
function rootfilePath(containerText: string | null): string {
    if (containerText === null) {
        throw new EpubError(
            'no-container',
            'The file is not an EPUB book. It has no container file.',
        )
    }

    const document = parseXml(containerText)
    const paths: string[] = []
    let packagePath: string | undefined
    for (const rootfile of document ? descendants(document, 'rootfile') : []) {
        const fullPath = attribute(rootfile, 'full-path')
        const path = fullPath ? resolvePath('', fullPath) : null
        if (path === null) continue
        paths.push(path)
        if (attribute(rootfile, 'media-type')?.toLowerCase() === PACKAGE_MEDIA_TYPE) {
            packagePath ??= path
        }
    }

    const path = packagePath ?? paths[0]
    if (!path) {
        throw new EpubError('no-container', 'The container file of the book names no package.')
    }
    return path
}

/** The `src` of each `img` and the `href` of each SVG `image`, in document order. */
function* imageHrefs(document: Document): Generator<string> {
    for (const element of document.getElementsByTagName('*')) {
        const name = localName(element)
        const href =
            name === 'img'
                ? attribute(element, 'src')
                : name === 'image'
                  ? attribute(element, 'href')
                  : null
        if (href) yield href
    }
}
