import { describe, expect, it } from 'vitest'
import { EpubError, openEpub } from './index'
import { buildEpub, chapterXhtml, containerXml, packEpub, TINY_PNG } from './testing/build-epub'
import { noiseBytes, recordReads } from './testing/recording-blob'
import { createZip } from './testing/zip-writer'
import { readBlobBytes } from './zip'

const MINIMAL_OPF = `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine>
</package>`

const chapter = chapterXhtml({ title: 'One', body: '<p>One</p>' })

describe('buildEpub', () => {
    it('gives a valid book with three chapters by default', async () => {
        const blob = await buildEpub({})
        expect(blob.type).toBe('application/epub+zip')

        const book = await openEpub(blob)
        expect(book.metadata).toMatchObject({
            title: 'Test Book',
            author: 'Test Author',
            language: 'en',
            identifier: 'urn:uuid:00000000-0000-4000-8000-000000000000',
        })
        expect(book.spine.map((item) => item.path)).toEqual([
            'OEBPS/text/chapter-1.xhtml',
            'OEBPS/text/chapter-2.xhtml',
            'OEBPS/text/chapter-3.xhtml',
        ])
        expect(book.toc.map((item) => [item.title, item.spineIndex])).toEqual([
            ['Chapter 1', 0],
            ['Chapter 2', 1],
            ['Chapter 3', 2],
        ])
        expect(book.coverPath).toBeNull()
        expect(book.pageProgression).toBe('ltr')
        expect(await book.readText('OEBPS/text/chapter-1.xhtml')).toContain(
            '<p>This is paragraph 1 of chapter 1.</p>',
        )
    })

    it('links each chapter to the stylesheets', async () => {
        const book = await openEpub(
            await buildEpub({ version: 2, css: { 'styles/main.css': 'p { margin: 0 }' } }),
        )
        const text = await book.readText(book.spine[0].path)
        expect(text).toContain('href="../styles/main.css"')
        expect(await book.readText('OEBPS/styles/main.css')).toBe('p { margin: 0 }')
        expect(book.toc).toHaveLength(3)
    })
})

describe('openEpub', () => {
    it('reads only the directory and the files that describe the book', async () => {
        const image = noiseBytes(400_000, 3)
        const chapters = [1, 2, 3].map((number) => ({
            body: `<p>${'Words of the chapter. '.repeat(20_000)}${number}</p>`,
        }))
        const recording = recordReads(
            await buildEpub({
                version: 3,
                ncx: true,
                compress: false,
                chapters,
                files: { 'images/big.png': image, 'fonts/big.otf': noiseBytes(300_000, 4) },
                css: { 'styles/main.css': 'p { margin: 0 }' },
                // The cover page comes before the large files, and the small files come last.
                cover: 'cover-image',
            }),
        )
        expect(recording.blob.size).toBeGreaterThan(2_000_000)

        const book = await openEpub(recording.blob)
        // The tail with the directory, then the container file, the package document and the
        // nav document. The NCX file is not read, because the nav document has entries.
        expect(recording.reads).toHaveLength(4)
        expect(recording.bytesRead()).toBeLessThan(80_000)

        const before = recording.bytesRead()
        const text = await book.readText(book.spine[1].path)
        expect(text.length).toBeGreaterThan(400_000)
        expect(recording.reads).toHaveLength(5)
        expect(recording.bytesRead() - before).toBeLessThan(text.length + 500)

        // A stored image is a slice of the file. Only its local header is read.
        const blob = await book.readBlob('OEBPS/images/big.png')
        expect(blob.size).toBe(image.length)
        expect(recording.reads).toHaveLength(6)
        expect(await readBlobBytes(blob, 0, blob.size)).toEqual(image)
    })

    it('reads a package document that has HTML entities and text before the declaration', async () => {
        const book = await openEpub(
            await packEpub({
                // A byte order mark and a line break come before the XML declaration.
                opf: `\ufeff
<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Caf&eacute; &amp; Bar&nbsp;&mdash; R&D</dc:title>
</metadata>
<manifest><item id="c1" href="c1.xhtml?v=1&x=2" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine>
</package>`,
                files: { 'OEBPS/c1.xhtml': chapter },
            }),
        )
        expect(book.metadata.title).toBe('Café & Bar — R&D')
        expect(book.spine).toHaveLength(1)
    })

    it('reads a package document in UTF-16', async () => {
        const text = `<?xml version="1.0" encoding="UTF-16"?>${MINIMAL_OPF.replace(
            '<manifest>',
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>日本語の本</dc:title></metadata><manifest>',
        )}`
        const bytes = new Uint8Array(2 + text.length * 2)
        const view = new DataView(bytes.buffer)
        view.setUint16(0, 0xfeff, true)
        for (let index = 0; index < text.length; index++) {
            view.setUint16(2 + index * 2, text.charCodeAt(index), true)
        }

        const book = await openEpub(
            await packEpub({ opf: bytes, files: { 'OEBPS/c1.xhtml': chapter } }),
        )
        expect(book.metadata.title).toBe('日本語の本')
    })

    it('reads a book from a tool that writes backslashes', async () => {
        const blob = await createZip([
            { path: 'mimetype', data: 'application/epub+zip' },
            { path: 'META-INF\\container.xml', data: containerXml('OEBPS\\content.opf') },
            {
                path: 'OEBPS\\content.opf',
                data: `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<manifest>
<item id="c1" href="text\\c1.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="images\\a.png" media-type="image/png" properties="cover-image"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
</manifest>
<spine><itemref idref="c1"/></spine>
</package>`,
            },
            { path: 'OEBPS\\text\\c1.xhtml', data: chapter },
            { path: 'OEBPS\\images\\a.png', data: TINY_PNG },
            {
                path: 'OEBPS\\nav.xhtml',
                data: chapterXhtml({
                    title: 'Contents',
                    body: '<nav epub:type="toc"><ol><li><a href="text\\c1.xhtml#top">One</a></li></ol></nav>',
                }),
            },
        ])

        const book = await openEpub(blob)
        expect(book.spine.map((item) => item.path)).toEqual(['OEBPS/text/c1.xhtml'])
        expect(book.manifest.map((item) => [item.path, item.size > 0])).toEqual([
            ['OEBPS/text/c1.xhtml', true],
            ['OEBPS/images/a.png', true],
            ['OEBPS/nav.xhtml', true],
        ])
        expect(book.coverPath).toBe('OEBPS/images/a.png')
        expect(book.toc).toMatchObject([
            { title: 'One', path: 'OEBPS/text/c1.xhtml', fragment: 'top', spineIndex: 0 },
        ])
        expect(book.resolve('OEBPS/text/c1.xhtml', '..\\images\\a.png')).toEqual({
            path: 'OEBPS/images/a.png',
            fragment: null,
        })
        expect(await book.readBytes('OEBPS/images/a.png')).toEqual(TINY_PNG)
    })

    it('uses the rootfile that is a package document', async () => {
        const book = await openEpub(
            await packEpub({
                opf: MINIMAL_OPF,
                opfPath: 'book/package.opf',
                container: `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles>
<rootfile full-path="other/book.pdf" media-type="application/pdf"/>
<rootfile full-path="./book/package.opf" media-type="application/oebps-package+xml"/>
</rootfiles></container>`,
                files: { 'book/c1.xhtml': chapter },
            }),
        )
        expect(book.spine[0].path).toBe('book/c1.xhtml')
    })
})

describe('book methods', () => {
    const open = async () =>
        openEpub(
            await buildEpub({
                css: { 'styles/main.css': 'p { margin: 0 }' },
                files: {
                    'images/a.png': TINY_PNG,
                    'fonts/a.woff2': noiseBytes(64),
                    'data/unknown.xyz': 'x',
                },
                rawFiles: { 'extra/not-in-manifest.jpg': noiseBytes(32), 'extra/file': 'x' },
                extraManifest:
                    '<item id="odd" href="data/odd.bin" media-type="application/x-odd"/>',
            }),
        )

    it('has', async () => {
        const book = await open()
        expect(book.has('OEBPS/text/chapter-1.xhtml')).toBe(true)
        expect(book.has('OEBPS/TEXT/Chapter-1.xhtml')).toBe(true)
        expect(book.has('extra/not-in-manifest.jpg')).toBe(true)
        expect(book.has('META-INF/container.xml')).toBe(true)
        expect(book.has('OEBPS/text/chapter-9.xhtml')).toBe(false)
        expect(book.has('OEBPS/text')).toBe(false)
    })

    it('mediaTypeOf uses the manifest, then the file extension', async () => {
        const book = await open()
        expect(book.mediaTypeOf('OEBPS/text/chapter-1.xhtml')).toBe('application/xhtml+xml')
        expect(book.mediaTypeOf('OEBPS/styles/main.css')).toBe('text/css')
        expect(book.mediaTypeOf('OEBPS/fonts/a.woff2')).toBe('font/woff2')
        // In the manifest with a type that the extension does not give.
        expect(book.mediaTypeOf('OEBPS/data/odd.bin')).toBe('application/x-odd')
        expect(book.mediaTypeOf('OEBPS/data/unknown.xyz')).toBe('application/octet-stream')
        // Not in the manifest.
        expect(book.mediaTypeOf('extra/not-in-manifest.jpg')).toBe('image/jpeg')
        expect(book.mediaTypeOf('somewhere/else.SVG')).toBe('image/svg+xml')
        expect(book.mediaTypeOf('extra/file')).toBeNull()
        expect(book.mediaTypeOf('a.constructor')).toBeNull()
    })

    it('spineIndexOf', async () => {
        const book = await open()
        expect(book.spineIndexOf('OEBPS/text/chapter-1.xhtml')).toBe(0)
        expect(book.spineIndexOf('OEBPS/text/chapter-3.xhtml')).toBe(2)
        expect(book.spineIndexOf('OEBPS/nav.xhtml')).toBe(-1)
        expect(book.spineIndexOf('nothing')).toBe(-1)
    })

    it('resolve', async () => {
        const book = await open()
        const from = 'OEBPS/text/chapter-1.xhtml'

        expect(book.resolve(from, 'chapter-2.xhtml#top')).toEqual({
            path: 'OEBPS/text/chapter-2.xhtml',
            fragment: 'top',
        })
        expect(book.resolve(from, '../images/a.png')).toEqual({
            path: 'OEBPS/images/a.png',
            fragment: null,
        })
        expect(book.resolve(from, '/OEBPS/styles/main.css')).toEqual({
            path: 'OEBPS/styles/main.css',
            fragment: null,
        })
        // A fragment only resolves to the source document itself.
        expect(book.resolve(from, '#note1')).toEqual({ path: from, fragment: 'note1' })
        // The letter case of the href differs from the file. The result is the file name.
        expect(book.resolve(from, '../Images/A.PNG')).toEqual({
            path: 'OEBPS/images/a.png',
            fragment: null,
        })
        // A file that is not in the container still resolves.
        expect(book.resolve(from, 'missing.xhtml')).toEqual({
            path: 'OEBPS/text/missing.xhtml',
            fragment: null,
        })

        expect(book.resolve(from, 'https://example.com/page#x')).toBeNull()
        expect(book.resolve(from, 'mailto:a@example.com')).toBeNull()
        expect(book.resolve(from, '')).toBeNull()
        expect(book.resolve(from, '../../../outside.xhtml')).toBeNull()
    })

    it('readText, readBytes and readBlob', async () => {
        const book = await open()
        expect(await book.readText('OEBPS/styles/main.css')).toBe('p { margin: 0 }')
        expect(await book.readBytes('OEBPS/images/a.png')).toEqual(TINY_PNG)

        const image = await book.readBlob('OEBPS/images/a.png')
        expect(image.type).toBe('image/png')
        expect(await readBlobBytes(image, 0, image.size)).toEqual(TINY_PNG)
        expect((await book.readBlob('extra/not-in-manifest.jpg')).type).toBe('image/jpeg')
        expect((await book.readBlob('extra/file')).type).toBe('application/octet-stream')
        // The path can differ in letter case.
        expect(await book.readText('oebps/styles/MAIN.css')).toBe('p { margin: 0 }')
    })

    it('readText uses the encoding of the file', async () => {
        const windows1252 = Uint8Array.from(
            '<?xml version="1.0" encoding="windows-1252"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>\x93Caf\xe9\x94</p></body></html>',
            (char) => char.charCodeAt(0),
        )
        const book = await openEpub(
            await packEpub({ opf: MINIMAL_OPF, files: { 'OEBPS/c1.xhtml': windows1252 } }),
        )
        expect(await book.readText('OEBPS/c1.xhtml')).toContain('<p>“Café”</p>')
    })
})

describe('errors', () => {
    const code = (value: string) => ({ name: 'EpubError', code: value })

    it('not-zip: the file is not a ZIP archive', async () => {
        await expect(openEpub(new Blob(['%PDF-1.4 not a book']))).rejects.toMatchObject(
            code('not-zip'),
        )
        await expect(openEpub(new Blob([]))).rejects.toBeInstanceOf(EpubError)
    })

    it('not-zip: a damaged entry', async () => {
        const blob = await buildEpub({
            chapters: [{ body: `<p>${'Some text. '.repeat(500)}</p>` }],
            nav: false,
        })
        const bytes = await readBlobBytes(blob, 0, blob.size)
        const book = await openEpub(blob)
        expect(book.spine).toHaveLength(1)

        // Destroy the deflate data of the chapter. The offset comes from the local headers.
        const text = new TextDecoder('latin1').decode(bytes)
        const dataStart =
            text.indexOf('OEBPS/text/chapter-1.xhtml') + 'OEBPS/text/chapter-1.xhtml'.length
        bytes.fill(0xff, dataStart, dataStart + 30)
        const damaged = await openEpub(new Blob([bytes]))
        await expect(damaged.readText(damaged.spine[0].path)).rejects.toMatchObject(code('not-zip'))
    })

    it('no-container: no container file', async () => {
        const blob = await packEpub({ opf: MINIMAL_OPF, container: null })
        await expect(openEpub(blob)).rejects.toMatchObject(code('no-container'))
        await expect(openEpub(await createZip({ 'a.txt': 'A' }))).rejects.toMatchObject(
            code('no-container'),
        )
    })

    it('no-container: no rootfile', async () => {
        const containers = [
            '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles/></container>',
            '<container><rootfiles><rootfile media-type="application/oebps-package+xml"/></rootfiles></container>',
            '<container><rootfiles><rootfile full-path="../outside.opf"/></rootfiles></container>',
            '<container><rootfiles>',
        ]
        for (const container of containers) {
            const blob = await packEpub({ opf: MINIMAL_OPF, container })
            await expect(openEpub(blob)).rejects.toMatchObject(code('no-container'))
        }
    })

    it('invalid-package: the package document is missing', async () => {
        const blob = await packEpub({
            opf: MINIMAL_OPF,
            container: containerXml('OEBPS/other.opf'),
            files: { 'OEBPS/c1.xhtml': chapter },
        })
        await expect(openEpub(blob)).rejects.toMatchObject(code('invalid-package'))
    })

    it('invalid-package: the package document is not well-formed XML', async () => {
        for (const opf of ['<package><manifest></package>', 'not xml at all', '']) {
            const blob = await packEpub({ opf, files: { 'OEBPS/c1.xhtml': chapter } })
            await expect(openEpub(blob)).rejects.toMatchObject(code('invalid-package'))
        }
    })

    it('drm: an encryption algorithm that is not font obfuscation', async () => {
        const blob = await buildEpub({
            rawFiles: {
                'META-INF/encryption.xml': `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
<enc:CipherData><enc:CipherReference URI="OEBPS/text/chapter-1.xhtml"/></enc:CipherData></enc:EncryptedData>
</encryption>`,
            },
        })
        await expect(openEpub(blob)).rejects.toMatchObject(code('drm'))
    })

    it('no-content: the spine has no content documents', async () => {
        const emptySpine = await packEpub({
            opf: MINIMAL_OPF.replace('<itemref idref="c1"/>', ''),
            files: { 'OEBPS/c1.xhtml': chapter },
        })
        await expect(openEpub(emptySpine)).rejects.toMatchObject(code('no-content'))

        const fileMissing = await packEpub({ opf: MINIMAL_OPF })
        await expect(openEpub(fileMissing)).rejects.toMatchObject(code('no-content'))

        const imageOnly = await packEpub({
            opf: MINIMAL_OPF.replace(
                'c1.xhtml" media-type="application/xhtml+xml"',
                'c1.svg" media-type="image/svg+xml"',
            ),
            files: { 'OEBPS/c1.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
        })
        await expect(openEpub(imageOnly)).rejects.toMatchObject(code('no-content'))

        const noSpine = await packEpub({ opf: '<package/>' })
        await expect(openEpub(noSpine)).rejects.toMatchObject(code('no-content'))
    })

    it('missing-file: a path that is not in the container', async () => {
        const book = await openEpub(await buildEpub({}))
        const missing = code('missing-file')
        await expect(book.readText('OEBPS/text/nothing.xhtml')).rejects.toMatchObject(missing)
        await expect(book.readBytes('OEBPS/images/nothing.png')).rejects.toMatchObject(missing)
        await expect(book.readBlob('nothing')).rejects.toMatchObject(missing)
        await expect(book.readText('')).rejects.toThrow('File not found in the book: ')
    })

    it('unsupported-compression: an entry that is not stored or deflated', async () => {
        const blob = await createZip([
            { path: 'mimetype', data: 'application/epub+zip' },
            { path: 'META-INF/container.xml', data: containerXml('OEBPS/content.opf') },
            { path: 'OEBPS/content.opf', data: MINIMAL_OPF },
            { path: 'OEBPS/c1.xhtml', data: chapter, compress: false, methodOverride: 14 },
        ])
        const book = await openEpub(blob)
        const unsupported = code('unsupported-compression')
        await expect(book.readText('OEBPS/c1.xhtml')).rejects.toMatchObject(unsupported)
        await expect(book.readBytes('OEBPS/c1.xhtml')).rejects.toMatchObject(unsupported)
        await expect(book.readBlob('OEBPS/c1.xhtml')).rejects.toMatchObject(unsupported)

        const packageCompressed = await createZip([
            { path: 'META-INF/container.xml', data: containerXml('OEBPS/content.opf') },
            { path: 'OEBPS/content.opf', data: MINIMAL_OPF, compress: false, methodOverride: 14 },
        ])
        await expect(openEpub(packageCompressed)).rejects.toMatchObject(unsupported)
    })
})
