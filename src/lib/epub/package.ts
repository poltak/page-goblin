/**
 * Reads the package document (OPF): metadata, manifest, spine and the cover candidates.
 */

import { HTML_MEDIA_TYPES, mediaTypeFromPath } from './media-type'
import { dirname, resolvePath } from './path'
import type { EpubMetadata, ManifestItem, PageProgression, SpineItem } from './types'
import { attribute, firstDescendant, htmlToText, localName, textOf } from './xml'

const NCX_MEDIA_TYPE = 'application/x-dtbncx+xml'
/** Media type of content documents in books that were made from the older OEB format. */
const OEB_DOCUMENT_MEDIA_TYPE = 'text/x-oeb1-document'

/** A file in the container, as the ZIP reader has it. */
export interface ContainerFile {
    path: string
    size: number
}

/**
 * A possible cover, in the order of the cover rules. An 'image' is the cover itself. A 'page'
 * is a content document whose first image is the cover.
 */
export interface CoverCandidate {
    kind: 'image' | 'page'
    path: string
    /** Uncompressed size in bytes. */
    size: number
}

export interface PackageData {
    metadata: EpubMetadata
    /** All `dc:identifier` values. The Adobe font key comes from one of them. */
    identifiers: string[]
    /** The text of the unique identifier as written. The IDPF font key comes from it. */
    uniqueIdentifierText: string | null
    manifest: ManifestItem[]
    spine: SpineItem[]
    pageProgression: PageProgression
    navPath: string | null
    ncxPath: string | null
    coverCandidates: CoverCandidate[]
}

export interface ReadPackageOptions {
    document: Document
    /** Container path of the package document. Manifest hrefs are relative to it. */
    opfPath: string
    /** The container file for a path, or undefined when the file is not there. */
    lookup(path: string): ContainerFile | undefined
}

interface MetadataIndex {
    /** Elements that are not `meta`, by lower-case local name. */
    elements: Map<string, Element[]>
    /** The EPUB 2 form. It maps `meta name` to `content`. The first value wins. */
    named: Map<string, string>
    /** The EPUB 3 form. These `meta property` elements do not refine another element. */
    properties: Element[]
    /** Element id to property to values, from `meta refines` elements. A creator can have many roles. */
    refinements: Map<string, Map<string, string[]>>
}

export function readPackage({ document, opfPath, lookup }: ReadPackageOptions): PackageData {
    const opfDirectory = dirname(opfPath)
    const index = indexMetadata(firstDescendant(document, 'metadata'))
    const uniqueId = document.documentElement
        ? attribute(document.documentElement, 'unique-identifier')
        : null

    const manifest: ManifestItem[] = []
    const present = new Set<ManifestItem>()
    const byId = new Map<string, ManifestItem>()
    const byPath = new Map<string, ManifestItem>()
    const manifestElement = firstDescendant(document, 'manifest')
    for (const element of manifestElement?.getElementsByTagName('*') ?? []) {
        if (localName(element) !== 'item') continue
        const href = attribute(element, 'href')
        const resolved = href ? resolvePath(opfDirectory, href) : null
        if (resolved === null) continue

        const file = lookup(resolved)
        const path = file?.path ?? resolved
        const item: ManifestItem = {
            id: attribute(element, 'id') ?? '',
            path,
            mediaType: manifestMediaType(attribute(element, 'media-type'), path),
            properties: tokens(attribute(element, 'properties')),
            size: file?.size ?? 0,
        }
        manifest.push(item)
        if (file) present.add(item)
        if (item.id && !byId.has(item.id)) byId.set(item.id, item)
        if (!byPath.has(path)) byPath.set(path, item)
    }

    const spine: SpineItem[] = []
    const spinePaths = new Set<string>()
    const spineElement = firstDescendant(document, 'spine')
    for (const element of spineElement?.getElementsByTagName('*') ?? []) {
        if (localName(element) !== 'itemref') continue
        const idref = attribute(element, 'idref')
        const item = idref ? byId.get(idref) : undefined
        const mediaType = item ? contentMediaType(item) : null
        // A second reference to the same file is left out, so each path has one spine index.
        if (!idref || !item || !mediaType || !present.has(item) || spinePaths.has(item.path)) {
            continue
        }
        spinePaths.add(item.path)
        spine.push({
            index: spine.length,
            idref,
            path: item.path,
            mediaType,
            linear: attribute(element, 'linear')?.toLowerCase() !== 'no',
            size: item.size,
            properties: [
                ...new Set([...tokens(attribute(element, 'properties')), ...item.properties]),
            ],
        })
    }

    const isPresentImage = (item: ManifestItem | undefined): item is ManifestItem =>
        item !== undefined && item.mediaType.startsWith('image/') && item.size > 0
    const isPresentPage = (item: ManifestItem | undefined): item is ManifestItem =>
        item !== undefined && present.has(item) && contentMediaType(item) !== null

    const navItem = manifest.find((item) => item.properties.includes('nav') && present.has(item))
    const tocId = spineElement ? attribute(spineElement, 'toc') : null
    const tocItem = tocId ? byId.get(tocId) : undefined
    const ncxItem =
        tocItem && present.has(tocItem)
            ? tocItem
            : manifest.find(
                  (item) =>
                      present.has(item) &&
                      (item.mediaType === NCX_MEDIA_TYPE ||
                          item.path.toLowerCase().endsWith('.ncx')),
              )

    // The candidates are added in the order of the cover rules. The first usable one wins.
    const coverCandidates: CoverCandidate[] = []
    const addCover = (kind: CoverCandidate['kind'], item: ManifestItem | undefined) => {
        const isCandidate = kind === 'image' ? isPresentImage(item) : isPresentPage(item)
        if (item && isCandidate) coverCandidates.push({ kind, path: item.path, size: item.size })
    }
    const itemForHref = (href: string): ManifestItem | undefined => {
        const resolved = resolvePath(opfDirectory, href)
        if (resolved === null) return undefined
        const file = lookup(resolved)
        if (!file) return undefined
        const known = byPath.get(file.path)
        if (known) return known
        // A cover file that the manifest does not list.
        const item: ManifestItem = {
            id: '',
            path: file.path,
            mediaType: mediaTypeFromPath(file.path) ?? 'application/octet-stream',
            properties: [],
            size: file.size,
        }
        present.add(item)
        return item
    }

    addCover(
        'image',
        manifest.find((item) => item.properties.includes('cover-image')),
    )

    const coverMeta = index.named.get('cover')
    const metaItem = coverMeta ? (byId.get(coverMeta) ?? itemForHref(coverMeta)) : undefined
    addCover('image', metaItem)

    // The type "cover" comes first. Other types that some tools write come after it, such as
    // "coverimagestandard" and "other.ms-coverimage-standard".
    const coverHrefs: string[] = []
    const otherCoverHrefs: string[] = []
    const guideElement = firstDescendant(document, 'guide')
    for (const element of guideElement?.getElementsByTagName('*') ?? []) {
        if (localName(element) !== 'reference') continue
        const type = attribute(element, 'type')?.toLowerCase() ?? ''
        const href = attribute(element, 'href')
        if (!href || !type.includes('cover') || type.includes('back')) continue
        if (type === 'cover') coverHrefs.push(href)
        else otherCoverHrefs.push(href)
    }
    for (const href of [...coverHrefs, ...otherCoverHrefs]) {
        const item = itemForHref(href)
        addCover('image', item)
        addCover('page', item)
    }
    addCover(
        'page',
        manifest.find((item) => item.properties.includes('cover')),
    )
    // Some books point the cover meta at the cover page and not at the image.
    addCover('page', metaItem)

    addCover(
        'image',
        manifest.find(
            (item) => isPresentImage(item) && (/cover/i.test(item.id) || /cover/i.test(item.path)),
        ),
    )

    return {
        ...readMetadata(index, uniqueId),
        manifest,
        spine,
        pageProgression:
            spineElement &&
            attribute(spineElement, 'page-progression-direction')?.toLowerCase() === 'rtl'
                ? 'rtl'
                : 'ltr',
        navPath: navItem?.path ?? null,
        ncxPath: ncxItem?.path ?? null,
        coverCandidates,
    }
}

/**
 * The media type of a manifest item. Real books write types such as "txt/css" and
 * "image/jpg", and many different names for one font format. For stylesheets, images and
 * fonts the file extension is the better source, so it has priority.
 */
function manifestMediaType(declared: string | null, path: string): string {
    const fromPath = mediaTypeFromPath(path)
    if (fromPath !== null && /^(?:text\/css$|image\/|font\/)/.test(fromPath)) return fromPath
    return declared?.split(';', 1)[0].trim().toLowerCase() || fromPath || 'application/octet-stream'
}

function tokens(value: string | null): string[] {
    return value ? value.toLowerCase().split(/\s+/) : []
}

/**
 * The media type of a content document, or null when the item is not one. Some books give a
 * content document a wrong media type, so the file extension is the second test.
 */
function contentMediaType(item: ManifestItem): string | null {
    if (HTML_MEDIA_TYPES.has(item.mediaType)) return item.mediaType
    if (item.mediaType === OEB_DOCUMENT_MEDIA_TYPE) return 'text/html'
    if (item.mediaType.startsWith('image/')) return null
    const fromPath = mediaTypeFromPath(item.path)
    return fromPath !== null && HTML_MEDIA_TYPES.has(fromPath) ? fromPath : null
}

function indexMetadata(metadataElement: Element | undefined): MetadataIndex {
    const index: MetadataIndex = {
        elements: new Map(),
        named: new Map(),
        properties: [],
        refinements: new Map(),
    }

    // Old books nest the elements in dc-metadata and x-metadata, so this reads all descendants.
    for (const element of metadataElement?.getElementsByTagName('*') ?? []) {
        const name = localName(element)
        if (name !== 'meta') {
            const list = index.elements.get(name)
            if (list) list.push(element)
            else index.elements.set(name, [element])
            continue
        }

        const metaName = attribute(element, 'name')?.toLowerCase()
        if (metaName) {
            if (!index.named.has(metaName)) {
                index.named.set(metaName, attribute(element, 'content') ?? '')
            }
            continue
        }

        const property = attribute(element, 'property')
        if (!property) continue
        const refines = attribute(element, 'refines')
        if (!refines) {
            index.properties.push(element)
            continue
        }
        const value = textOf(element)
        if (!value) continue
        const id = refines.replace(/^#/, '')
        let values = index.refinements.get(id)
        if (!values) index.refinements.set(id, (values = new Map()))
        const list = values.get(property)
        if (list) list.push(value)
        else values.set(property, [value])
    }

    return index
}

function readMetadata(
    index: MetadataIndex,
    uniqueId: string | null,
): Pick<PackageData, 'metadata' | 'identifiers' | 'uniqueIdentifierText'> {
    const all = (name: string) => index.elements.get(name) ?? []
    const firstText = (name: string): string | null => {
        for (const element of all(name)) {
            const text = textOf(element)
            if (text) return text
        }
        return null
    }
    const refinements = (element: Element, property: string): string[] => {
        const id = element.getAttribute('id')
        return (id && index.refinements.get(id)?.get(property)) || []
    }

    let title = ''
    for (const element of all('title')) {
        const text = textOf(element)
        if (!text) continue
        if (!title) title = text
        if (refinements(element, 'title-type')[0] === 'main') {
            title = text
            break
        }
    }

    const allCreators: string[] = []
    const authors: string[] = []
    for (const element of all('creator')) {
        // Some tools leave a list separator at the end of a name ("Andy Weir;").
        const name = textOf(element).replace(/[\s;,]+$/, '')
        if (!name || allCreators.includes(name)) continue
        const role = attribute(element, 'role')
        const roles = (role ? [role] : refinements(element, 'role')).map((value) =>
            value.toLowerCase(),
        )
        allCreators.push(name)
        if (!roles.length || roles.includes('aut')) authors.push(name)
    }
    const creators = authors.length ? authors : allCreators

    const identifiers: string[] = []
    let uniqueElement: Element | undefined
    for (const element of all('identifier')) {
        const text = textOf(element)
        if (!text) continue
        if (!identifiers.length) uniqueElement = element
        identifiers.push(text)
    }
    if (uniqueId) {
        uniqueElement =
            all('identifier').find(
                (element) => element.getAttribute('id') === uniqueId && textOf(element),
            ) ?? uniqueElement
    }

    const dates = all('date').filter((element) => textOf(element))
    const date =
        dates.find((element) => attribute(element, 'event')?.toLowerCase() === 'publication') ??
        dates.find((element) => !attribute(element, 'event')) ??
        dates[0]

    const description = firstText('description')

    return {
        metadata: {
            title: title || 'Unknown Title',
            author: creators.join(', ') || 'Unknown Author',
            creators,
            language: firstText('language'),
            identifier: uniqueElement ? textOf(uniqueElement) : null,
            publisher: firstText('publisher'),
            description: description === null ? null : htmlToText(description) || null,
            // Calibre writes the year 0101 when it does not know the date.
            published: date && !textOf(date).startsWith('0101-01-01') ? textOf(date) : null,
            subjects: [...new Set(all('subject').map(textOf).filter(Boolean))],
            series: readSeries(index),
        },
        identifiers,
        uniqueIdentifierText: uniqueElement?.textContent ?? null,
    }
}

function readSeries(index: MetadataIndex): EpubMetadata['series'] {
    for (const element of index.properties) {
        if (attribute(element, 'property') !== 'belongs-to-collection') continue
        const name = textOf(element)
        if (!name) continue
        const id = element.getAttribute('id')
        const position = id ? index.refinements.get(id)?.get('group-position')?.[0] : undefined
        return { name, position: parsePosition(position) }
    }

    const name = index.named.get('calibre:series')
    return name ? { name, position: parsePosition(index.named.get('calibre:series_index')) } : null
}

function parsePosition(value: string | undefined): number | null {
    const position = Number.parseFloat(value ?? '')
    return Number.isFinite(position) ? position : null
}
