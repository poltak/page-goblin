/**
 * Builds real EPUB files for tests. It is not part of the application build.
 *
 * `buildEpub({})` gives a valid EPUB 3 book with three chapters. `packEpub` puts a
 * hand-written package document into a container, for tests of unusual books.
 */

import { mediaTypeFromPath } from '../media-type'
import { createZip, type ZipContent, type ZipFileSpec } from './zip-writer'

export const DEFAULT_IDENTIFIER = 'urn:uuid:00000000-0000-4000-8000-000000000000'

/** A valid PNG image of 1 by 1 pixel. */
export const TINY_PNG: Uint8Array<ArrayBuffer> = Uint8Array.from(
    atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    ),
    (char) => char.charCodeAt(0),
)

export interface BuildEpubCreator {
    name: string
    /** A MARC relator code, for example 'aut' or 'trl'. */
    role?: string
}

export interface BuildEpubMetadata {
    /** Null leaves out `dc:title`. Default: 'Test Book'. */
    title?: string | null
    /** Default: ['Test Author']. */
    creators?: Array<string | BuildEpubCreator>
    /** Null leaves out `dc:language`. Default: 'en'. */
    language?: string | null
    /** Null leaves out `dc:identifier`. Default: `DEFAULT_IDENTIFIER`. */
    identifier?: string | null
    publisher?: string
    description?: string
    published?: string
    subjects?: string[]
    /** EPUB 3 writes `belongs-to-collection`. EPUB 2 writes the `calibre:series` meta elements. */
    series?: { name: string; position?: number }
}

export interface BuildEpubChapter {
    /** Path relative to the OPF directory. Default: 'text/chapter-N.xhtml'. */
    path?: string
    /** Default: 'Chapter N'. */
    title?: string
    /** Markup for the inside of `body`. Default: a heading and two paragraphs. */
    body?: string
    /** The full content document. It replaces `title` and `body` in the file. */
    xhtml?: string
    /** False writes `linear="no"`. */
    linear?: boolean
    /** Default: 'application/xhtml+xml'. */
    mediaType?: string
    /** True lists the chapter in the manifest and the spine but leaves the file out. */
    missing?: boolean
}

export interface BuildEpubTocEntry {
    title: string
    /** Target relative to the OPF directory, with an optional fragment. Omit for a heading. */
    href?: string
    children?: BuildEpubTocEntry[]
}

export type BuildEpubCoverVariant =
    /** A manifest item with `properties="cover-image"`. */
    | 'cover-image'
    /** `<meta name="cover">` with the manifest id of the image. */
    | 'meta'
    /** `<meta name="cover">` with the href of the image, as some bad books have it. */
    | 'meta-href'
    /** A guide reference of type "cover" to a page with an `img` element. */
    | 'guide'
    /** A guide reference of type "cover" to a page with an SVG `image` element. */
    | 'guide-svg'
    /** A manifest page with `properties="cover"` and an `img` element. */
    | 'page-property'
    /** Only the path of the image has the word "cover". */
    | 'name'

export interface BuildEpubCover {
    variant: BuildEpubCoverVariant
    /** Image path relative to the OPF directory. Default: 'images/front.png'. */
    path?: string
    /** Default: `TINY_PNG`. */
    data?: Uint8Array<ArrayBuffer>
}

export interface BuildEpubOptions {
    /** Default: 3. */
    version?: 2 | 3
    metadata?: BuildEpubMetadata
    /** Default: three chapters. */
    chapters?: BuildEpubChapter[]
    /** Stylesheets by path relative to the OPF directory. Each default chapter links to them. */
    css?: Record<string, string>
    /** Other manifest files (images, fonts) by path relative to the OPF directory. */
    files?: Record<string, ZipContent>
    /** Write an EPUB 3 nav document. Default: true for version 3. */
    nav?: boolean
    /** Write an NCX file. Default: true for version 2. */
    ncx?: boolean
    /** Path of the nav document relative to the OPF directory. Default: 'nav.xhtml'. */
    navPath?: string
    /** Default: one entry for each chapter. */
    toc?: BuildEpubTocEntry[]
    /** The cover page of the guide variants is in the manifest but not in the spine. */
    cover?: BuildEpubCoverVariant | BuildEpubCover
    /** Directory of the package document, for example 'OEBPS/', or '' for the root. */
    opfDir?: string
    pageProgression?: 'ltr' | 'rtl'
    /** Files by container path that the manifest does not list, such as META-INF/encryption.xml. */
    rawFiles?: Record<string, ZipContent>
    /** Raw XML to add at the end of `metadata`. */
    extraMetadata?: string
    /** Raw XML to add at the end of `manifest`. */
    extraManifest?: string
    /** Deflate the entries. Default: true. */
    compress?: boolean
}

export interface PackEpubOptions {
    /** The text of the package document. */
    opf: ZipContent
    /** Default: 'OEBPS/content.opf'. */
    opfPath?: string
    /** All other files by container path. */
    files?: Record<string, ZipContent>
    /** The text of META-INF/container.xml. Null leaves the file out. Default: made from `opfPath`. */
    container?: string | null
}

export function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

export function containerXml(opfPath: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="${escapeXml(opfPath)}" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`
}

/** A content document. `stylesheets` are hrefs relative to the document. */
export function chapterXhtml(options: {
    title: string
    body: string
    stylesheets?: string[]
}): string {
    const links = (options.stylesheets ?? [])
        .map((href) => `<link rel="stylesheet" type="text/css" href="${escapeXml(href)}"/>\n`)
        .join('')
    return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
<title>${escapeXml(options.title)}</title>
${links}</head>
<body>
${options.body}
</body>
</html>`
}

/** Put a hand-written package document and other files into an EPUB container. */
export function packEpub(options: PackEpubOptions): Promise<Blob> {
    const opfPath = options.opfPath ?? 'OEBPS/content.opf'
    const files: Record<string, ZipContent> = { mimetype: 'application/epub+zip' }
    if (options.container !== null) {
        files['META-INF/container.xml'] = options.container ?? containerXml(opfPath)
    }
    files[opfPath] = options.opf
    return createZip({ ...files, ...options.files }, { type: 'application/epub+zip' })
}

/** Percent-encode each segment of a path, so that '#', '?' and spaces are part of the name. */
function encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/')
}

/** An href from one file to another. The two paths have the same base directory. */
function relativeHref(fromPath: string, target: string): string {
    const [toPath, fragment] = target.split('#')
    const from = fromPath.split('/').slice(0, -1)
    const to = toPath.split('/')
    let common = 0
    while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++
    const parts = [...from.slice(common).map(() => '..'), ...to.slice(common)]
    return encodePath(parts.join('/')) + (fragment ? `#${fragment}` : '')
}

export async function buildEpub(options: BuildEpubOptions = {}): Promise<Blob> {
    const version = options.version ?? 3
    const root =
        options.opfDir === undefined
            ? 'OEBPS/'
            : options.opfDir && options.opfDir.replace(/\/?$/, '/')
    const metadata = options.metadata ?? {}
    const title = metadata.title === undefined ? 'Test Book' : metadata.title
    const identifier = metadata.identifier === undefined ? DEFAULT_IDENTIFIER : metadata.identifier
    const language = metadata.language === undefined ? 'en' : metadata.language
    const withNav = options.nav ?? version === 3
    const withNcx = options.ncx ?? version === 2
    const navPath = options.navPath ?? 'nav.xhtml'
    const ncxPath = 'toc.ncx'
    const cssPaths = Object.keys(options.css ?? {})

    const files: ZipFileSpec[] = []
    const addFile = (path: string, data: ZipContent) =>
        files.push({ path: root + path, data, compress: options.compress })
    const metadataLines: string[] = []
    const manifestLines: string[] = []
    const guideLines: string[] = []
    const addItem = (item: { id: string; path: string; mediaType?: string; properties?: string }) =>
        manifestLines.push(
            `<item id="${item.id}" href="${escapeXml(encodePath(item.path))}" media-type="${
                item.mediaType ?? mediaTypeFromPath(item.path) ?? 'application/octet-stream'
            }"${item.properties ? ` properties="${item.properties}"` : ''}/>`,
        )

    // Metadata
    if (identifier !== null) {
        metadataLines.push(`<dc:identifier id="book-id">${escapeXml(identifier)}</dc:identifier>`)
    }
    if (title !== null) metadataLines.push(`<dc:title>${escapeXml(title)}</dc:title>`)
    ;(metadata.creators ?? ['Test Author']).forEach((creator, index) => {
        const { name, role } = typeof creator === 'string' ? { name: creator } : creator
        const id = `creator-${index + 1}`
        if (role && version === 2) {
            metadataLines.push(`<dc:creator opf:role="${role}">${escapeXml(name)}</dc:creator>`)
            return
        }
        metadataLines.push(`<dc:creator id="${id}">${escapeXml(name)}</dc:creator>`)
        if (role) {
            metadataLines.push(
                `<meta refines="#${id}" property="role" scheme="marc:relators">${role}</meta>`,
            )
        }
    })
    if (language !== null) metadataLines.push(`<dc:language>${escapeXml(language)}</dc:language>`)
    if (metadata.publisher) {
        metadataLines.push(`<dc:publisher>${escapeXml(metadata.publisher)}</dc:publisher>`)
    }
    if (metadata.description) {
        metadataLines.push(`<dc:description>${escapeXml(metadata.description)}</dc:description>`)
    }
    if (metadata.published) {
        metadataLines.push(`<dc:date>${escapeXml(metadata.published)}</dc:date>`)
    }
    for (const subject of metadata.subjects ?? []) {
        metadataLines.push(`<dc:subject>${escapeXml(subject)}</dc:subject>`)
    }
    if (metadata.series && version === 3) {
        const { name, position } = metadata.series
        metadataLines.push(
            `<meta property="belongs-to-collection" id="series">${escapeXml(name)}</meta>`,
            '<meta refines="#series" property="collection-type">series</meta>',
        )
        if (position !== undefined) {
            metadataLines.push(
                `<meta refines="#series" property="group-position">${position}</meta>`,
            )
        }
    } else if (metadata.series) {
        const { name, position } = metadata.series
        metadataLines.push(`<meta name="calibre:series" content="${escapeXml(name)}"/>`)
        if (position !== undefined) {
            metadataLines.push(`<meta name="calibre:series_index" content="${position}"/>`)
        }
    }
    if (version === 3) {
        metadataLines.push('<meta property="dcterms:modified">2020-01-01T00:00:00Z</meta>')
    }

    // Chapters
    const chapters = (options.chapters ?? [{}, {}, {}]).map((chapter, index) => {
        const number = index + 1
        const chapterTitle = chapter.title ?? `Chapter ${number}`
        return {
            ...chapter,
            id: `chapter-${number}`,
            path: chapter.path ?? `text/chapter-${number}.xhtml`,
            title: chapterTitle,
            body:
                chapter.body ??
                `<h1 id="title">${escapeXml(chapterTitle)}</h1>\n` +
                    `<p>This is paragraph 1 of chapter ${number}.</p>\n` +
                    `<p>This is paragraph 2 of chapter ${number}.</p>`,
        }
    })
    const spineLines: string[] = []
    for (const chapter of chapters) {
        addItem(chapter)
        spineLines.push(
            `<itemref idref="${chapter.id}"${chapter.linear === false ? ' linear="no"' : ''}/>`,
        )
        if (chapter.missing) continue
        addFile(
            chapter.path,
            chapter.xhtml ??
                chapterXhtml({
                    title: chapter.title,
                    body: chapter.body,
                    stylesheets: cssPaths.map((path) => relativeHref(chapter.path, path)),
                }),
        )
    }

    // Stylesheets and other manifest files
    Object.entries(options.css ?? {}).forEach(([path, text], index) => {
        addItem({ id: `css-${index + 1}`, path })
        addFile(path, text)
    })
    Object.entries(options.files ?? {}).forEach(([path, data], index) => {
        addItem({ id: `file-${index + 1}`, path })
        addFile(path, data)
    })

    // Cover
    if (options.cover) {
        const cover = typeof options.cover === 'string' ? { variant: options.cover } : options.cover
        const { variant } = cover
        const imagePath =
            cover.path ?? (variant === 'name' ? 'images/cover.png' : 'images/front.png')
        const pagePath = 'text/front.xhtml'
        addFile(imagePath, cover.data ?? TINY_PNG)
        addItem({
            id: 'front-image',
            path: imagePath,
            properties: variant === 'cover-image' ? 'cover-image' : undefined,
        })
        if (variant === 'meta') metadataLines.push('<meta name="cover" content="front-image"/>')
        if (variant === 'meta-href') {
            metadataLines.push(`<meta name="cover" content="${escapeXml(encodePath(imagePath))}"/>`)
        }
        if (variant === 'guide' || variant === 'guide-svg' || variant === 'page-property') {
            const href = escapeXml(relativeHref(pagePath, imagePath))
            const body =
                variant === 'guide-svg'
                    ? `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><image width="1" height="1" xlink:href="${href}"/></svg>`
                    : `<div><img src="${href}" alt="Front"/></div>`
            addFile(pagePath, chapterXhtml({ title: 'Front', body }))
            addItem({
                id: 'front-page',
                path: pagePath,
                properties: variant === 'page-property' ? 'cover' : undefined,
            })
            if (variant !== 'page-property') {
                guideLines.push(`<reference type="cover" title="Front" href="${pagePath}"/>`)
            }
        }
    }

    // Table of contents
    const toc: BuildEpubTocEntry[] =
        options.toc ?? chapters.map((chapter) => ({ title: chapter.title, href: chapter.path }))

    if (withNav) {
        const list = (entries: BuildEpubTocEntry[]): string =>
            `<ol>\n${entries
                .map((entry) => {
                    const label = entry.href
                        ? `<a href="${escapeXml(relativeHref(navPath, entry.href))}">${escapeXml(entry.title)}</a>`
                        : `<span>${escapeXml(entry.title)}</span>`
                    return `<li>${label}${entry.children?.length ? `\n${list(entry.children)}` : ''}</li>`
                })
                .join('\n')}\n</ol>`
        addItem({ id: 'nav', path: navPath, mediaType: 'application/xhtml+xml', properties: 'nav' })
        addFile(
            navPath,
            chapterXhtml({
                title: 'Contents',
                body: `<nav epub:type="toc" id="toc">\n<h1>Contents</h1>\n${list(toc)}\n</nav>`,
            }),
        )
    }

    if (withNcx) {
        let playOrder = 0
        const points = (entries: BuildEpubTocEntry[]): string =>
            entries
                .map((entry) => {
                    const order = ++playOrder
                    const content = entry.href
                        ? `<content src="${escapeXml(relativeHref(ncxPath, entry.href))}"/>`
                        : ''
                    return `<navPoint id="np-${order}" playOrder="${order}"><navLabel><text>${escapeXml(
                        entry.title,
                    )}</text></navLabel>${content}${
                        entry.children?.length ? `\n${points(entry.children)}\n` : ''
                    }</navPoint>`
                })
                .join('\n')
        addItem({ id: 'ncx', path: ncxPath })
        addFile(
            ncxPath,
            `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeXml(identifier ?? '')}"/></head>
<docTitle><text>${escapeXml(title ?? '')}</text></docTitle>
<navMap>
${points(toc)}
</navMap>
</ncx>`,
        )
    }

    const spineAttributes =
        (withNcx ? ' toc="ncx"' : '') +
        (options.pageProgression ? ` page-progression-direction="${options.pageProgression}"` : '')
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
${metadataLines.join('\n')}
${options.extraMetadata ?? ''}
</metadata>
<manifest>
${manifestLines.join('\n')}
${options.extraManifest ?? ''}
</manifest>
<spine${spineAttributes}>
${spineLines.join('\n')}
</spine>
${guideLines.length ? `<guide>\n${guideLines.join('\n')}\n</guide>` : ''}
</package>`

    const opfPath = `${root}content.opf`
    return createZip(
        [
            { path: 'mimetype', data: 'application/epub+zip' },
            { path: 'META-INF/container.xml', data: containerXml(opfPath) },
            { path: opfPath, data: opf, compress: options.compress },
            ...files,
            ...Object.entries(options.rawFiles ?? {}).map(([path, data]) => ({
                path,
                data,
                compress: options.compress,
            })),
        ],
        { type: 'application/epub+zip' },
    )
}
