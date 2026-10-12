import { describe, expect, it } from 'vitest'
import { openEpub } from './index'
import { buildEpub, chapterXhtml, packEpub, TINY_PNG } from './testing/build-epub'

const chapter = (title = 'Chapter') => chapterXhtml({ title, body: `<p>${title}</p>` })

/** A package document with the usual namespaces around the given parts. */
function opf(parts: { metadata?: string; manifest?: string; spine?: string; rest?: string }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
${parts.metadata ?? '<dc:title>Book</dc:title>'}
</metadata>
<manifest>
${parts.manifest ?? '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>'}
</manifest>
${parts.spine ?? '<spine><itemref idref="c1"/></spine>'}
${parts.rest ?? ''}
</package>`
}

describe('metadata', () => {
    it('reads all fields', async () => {
        const book = await openEpub(
            await buildEpub({
                metadata: {
                    title: 'The Title',
                    creators: ['First Author', 'Second Author'],
                    language: 'pt-BR',
                    identifier: 'urn:isbn:9780000000001',
                    publisher: 'A Publisher',
                    description: 'A plain description.',
                    published: '2019-05-04',
                    subjects: ['Fiction', 'Adventure', 'Fiction'],
                },
            }),
        )

        expect(book.metadata).toEqual({
            title: 'The Title',
            author: 'First Author, Second Author',
            creators: ['First Author', 'Second Author'],
            language: 'pt-BR',
            identifier: 'urn:isbn:9780000000001',
            publisher: 'A Publisher',
            description: 'A plain description.',
            published: '2019-05-04',
            subjects: ['Fiction', 'Adventure'],
            series: null,
        })
    })

    it('gives defaults for missing metadata', async () => {
        const book = await openEpub(
            await buildEpub({
                metadata: { title: null, creators: [], language: null, identifier: null },
            }),
        )

        expect(book.metadata).toEqual({
            title: 'Unknown Title',
            author: 'Unknown Author',
            creators: [],
            language: null,
            identifier: null,
            publisher: null,
            description: null,
            published: null,
            subjects: [],
            series: null,
        })
    })

    it('gives defaults when the package has no metadata element', async () => {
        const book = await openEpub(
            await packEpub({
                opf: `<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine></package>`,
                files: { 'OEBPS/c1.xhtml': chapter() },
            }),
        )
        expect(book.metadata.title).toBe('Unknown Title')
        expect(book.metadata.author).toBe('Unknown Author')
        expect(book.spine).toHaveLength(1)
    })

    it('reads element names with prefixes', async () => {
        const book = await openEpub(
            await packEpub({
                opf: `<?xml version="1.0"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"
    version="2.0" unique-identifier="uid">
<opf:metadata>
<dc:title>Prefixed</dc:title>
<dc:creator opf:role="aut">An Author</dc:creator>
<dc:identifier id="uid">id-1</dc:identifier>
<dc:language>en</dc:language>
<opf:meta name="calibre:series" content="Saga"/>
</opf:metadata>
<opf:manifest>
<opf:item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<opf:item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
</opf:manifest>
<opf:spine page-progression-direction="rtl"><opf:itemref idref="c1"/><opf:itemref idref="c2" linear="no"/></opf:spine>
</opf:package>`,
                files: { 'OEBPS/c1.xhtml': chapter(), 'OEBPS/c2.xhtml': chapter() },
            }),
        )

        expect(book.metadata).toMatchObject({
            title: 'Prefixed',
            author: 'An Author',
            identifier: 'id-1',
            language: 'en',
            series: { name: 'Saga', position: null },
        })
        expect(book.spine.map((item) => [item.path, item.linear])).toEqual([
            ['OEBPS/c1.xhtml', true],
            ['OEBPS/c2.xhtml', false],
        ])
        expect(book.pageProgression).toBe('rtl')
    })

    it('reads a package document that uses a prefix with no declaration', async () => {
        // The prefix opf has no xmlns:opf declaration. A strict XML parser rejects the file.
        const book = await openEpub(
            await packEpub({
                opf: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>No Declaration</dc:title>
<dc:creator opf:role="trl">The Translator</dc:creator>
<dc:creator opf:role="aut">The Author</dc:creator>
<dc:identifier id="uid" opf:scheme="ISBN">9780000000001</dc:identifier>
</metadata>
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine>
</package>`,
                files: { 'OEBPS/c1.xhtml': chapter() },
            }),
        )
        expect(book.metadata).toMatchObject({
            title: 'No Declaration',
            creators: ['The Author'],
            identifier: '9780000000001',
        })
        expect(book.spine).toHaveLength(1)
    })

    it('reads the old OEB form with capital letters and nested groups', async () => {
        const book = await openEpub(
            await packEpub({
                opf: `<package unique-identifier="uid">
<metadata>
<dc-metadata xmlns:dc="http://purl.org/dc/elements/1.0/">
<dc:Title>Old Book</dc:Title>
<dc:Creator role="aut">Old Author</dc:Creator>
<dc:Identifier id="uid">old-1</dc:Identifier>
</dc-metadata>
<x-metadata><meta name="cover" content="img"/></x-metadata>
</metadata>
<manifest>
<item id="c1" href="c1.html" media-type="text/x-oeb1-document"/>
<item id="img" href="front.png" media-type="image/png"/>
</manifest>
<spine><itemref idref="c1"/></spine>
</package>`,
                files: {
                    'OEBPS/c1.html': '<html><body>Text</body></html>',
                    'OEBPS/front.png': TINY_PNG,
                },
            }),
        )

        expect(book.metadata).toMatchObject({
            title: 'Old Book',
            author: 'Old Author',
            identifier: 'old-1',
        })
        expect(book.spine).toMatchObject([{ path: 'OEBPS/c1.html', mediaType: 'text/html' }])
        expect(book.coverPath).toBe('OEBPS/front.png')
    })

    it('prefers the title that has the title-type main', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    metadata: `<dc:title id="t1">A Subtitle</dc:title>
<dc:title id="t2">The Main Title</dc:title>
<meta refines="#t1" property="title-type">subtitle</meta>
<meta refines="#t2" property="title-type">main</meta>`,
                }),
                files: { 'OEBPS/c1.xhtml': chapter() },
            }),
        )
        expect(book.metadata.title).toBe('The Main Title')
    })

    it('uses the first title that is not empty', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    metadata: '<dc:title> </dc:title><dc:title>Second\n  Title</dc:title>',
                }),
                files: { 'OEBPS/c1.xhtml': chapter() },
            }),
        )
        expect(book.metadata.title).toBe('Second Title')
    })

    it('leaves out creators with a role other than aut (EPUB 2 attribute)', async () => {
        const book = await openEpub(
            await buildEpub({
                version: 2,
                metadata: {
                    creators: [
                        { name: 'The Translator', role: 'trl' },
                        { name: 'The Author', role: 'aut' },
                        'No Role',
                        { name: 'The Illustrator', role: 'ill' },
                    ],
                },
            }),
        )
        expect(book.metadata.creators).toEqual(['The Author', 'No Role'])
        expect(book.metadata.author).toBe('The Author, No Role')
    })

    it('leaves out creators with a role other than aut (EPUB 3 refines)', async () => {
        const book = await openEpub(
            await buildEpub({
                version: 3,
                metadata: {
                    creators: [
                        { name: 'The Author', role: 'aut' },
                        { name: 'The Editor', role: 'edt' },
                    ],
                },
            }),
        )
        expect(book.metadata.creators).toEqual(['The Author'])
    })

    it('keeps a creator who has the role aut and one more role', async () => {
        const book = await openEpub(
            await buildEpub({
                version: 3,
                metadata: { creators: [] },
                extraMetadata: `<dc:creator id="a">Author And Illustrator</dc:creator>
<meta refines="#a" property="role" scheme="marc:relators">ill</meta>
<meta refines="#a" property="role" scheme="marc:relators">aut</meta>
<dc:creator id="b">The Editor</dc:creator>
<meta refines="#b" property="role" scheme="marc:relators">edt</meta>`,
            }),
        )
        expect(book.metadata.creators).toEqual(['Author And Illustrator'])
    })

    it('keeps all creators when no creator is an author', async () => {
        const book = await openEpub(
            await buildEpub({
                metadata: {
                    creators: [
                        { name: 'The Editor', role: 'edt' },
                        { name: 'The Translator', role: 'trl' },
                    ],
                },
            }),
        )
        expect(book.metadata.creators).toEqual(['The Editor', 'The Translator'])
        expect(book.metadata.author).toBe('The Editor, The Translator')
    })

    it('removes markup from the description', async () => {
        const book = await openEpub(
            await buildEpub({
                metadata: {
                    description:
                        '<div><p>First   <i>paragraph</i>.</p><p>Second &amp; last&nbsp;one.</p></div>',
                },
            }),
        )
        expect(book.metadata.description).toBe('First paragraph. Second & last one.')
    })

    it('uses the identifier that the package names as unique', async () => {
        const files = { 'OEBPS/c1.xhtml': chapter() }
        const named = await openEpub(
            await packEpub({
                opf: opf({
                    metadata: `<dc:identifier>urn:isbn:1</dc:identifier>
<dc:identifier id="uid">urn:uuid:2</dc:identifier>`,
                }),
                files,
            }),
        )
        expect(named.metadata.identifier).toBe('urn:uuid:2')

        const notNamed = await openEpub(
            await packEpub({
                opf: opf({
                    metadata: `<dc:identifier>urn:isbn:1</dc:identifier>
<dc:identifier id="other">urn:uuid:2</dc:identifier>`,
                }),
                files,
            }),
        )
        expect(notNamed.metadata.identifier).toBe('urn:isbn:1')
    })

    it('prefers the publication date', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    metadata: `<dc:date opf:event="modification">2020-02-02</dc:date>
<dc:date opf:event="publication">1999-01-01</dc:date>`,
                }),
                files: { 'OEBPS/c1.xhtml': chapter() },
            }),
        )
        expect(book.metadata.published).toBe('1999-01-01')
    })

    it('gives null for the date that calibre writes when it does not know the date', async () => {
        const book = await openEpub(
            await buildEpub({ metadata: { published: '0101-01-01T00:00:00+00:00' } }),
        )
        expect(book.metadata.published).toBeNull()
    })

    it('reads the series from belongs-to-collection', async () => {
        const book = await openEpub(
            await buildEpub({
                version: 3,
                metadata: { series: { name: 'The Saga', position: 2 } },
            }),
        )
        expect(book.metadata.series).toEqual({ name: 'The Saga', position: 2 })

        const noPosition = await openEpub(
            await buildEpub({ version: 3, metadata: { series: { name: 'The Saga' } } }),
        )
        expect(noPosition.metadata.series).toEqual({ name: 'The Saga', position: null })
    })

    it('reads the series from the calibre meta elements', async () => {
        const book = await openEpub(
            await buildEpub({
                version: 2,
                metadata: { series: { name: 'The Saga', position: 1.5 } },
            }),
        )
        expect(book.metadata.series).toEqual({ name: 'The Saga', position: 1.5 })
    })
})

describe('manifest', () => {
    it('lists the items with path, media type, properties and size', async () => {
        const css = 'p { margin: 0 }'
        const book = await openEpub(
            await buildEpub({
                css: { 'styles/main.css': css },
                files: { 'images/a.png': TINY_PNG },
                extraManifest:
                    '<item id="gone" href="images/Gone.JPG" media-type="IMAGE/JPEG" properties="Scripted SVG"/>' +
                    '<item id="remote" href="https://example.com/font.woff" media-type="font/woff"/>',
            }),
        )

        expect(book.manifest.map((item) => item.id)).toEqual([
            'chapter-1',
            'chapter-2',
            'chapter-3',
            'css-1',
            'file-1',
            'nav',
            'gone',
        ])
        expect(book.manifest.find((item) => item.id === 'css-1')).toEqual({
            id: 'css-1',
            path: 'OEBPS/styles/main.css',
            mediaType: 'text/css',
            properties: [],
            size: css.length,
        })
        expect(book.manifest.find((item) => item.id === 'file-1')).toMatchObject({
            path: 'OEBPS/images/a.png',
            mediaType: 'image/png',
            size: TINY_PNG.length,
        })
        expect(book.manifest.find((item) => item.id === 'nav')?.properties).toEqual(['nav'])
        // A file that is not in the container has the size 0.
        expect(book.manifest.find((item) => item.id === 'gone')).toEqual({
            id: 'gone',
            path: 'OEBPS/images/Gone.JPG',
            mediaType: 'image/jpeg',
            properties: ['scripted', 'svg'],
            size: 0,
        })
    })

    it('decodes percent-encoded hrefs', async () => {
        const book = await openEpub(
            await buildEpub({
                chapters: [{ path: 'text/chapter one & two.xhtml' }, { path: 'text/café.xhtml' }],
                files: { 'images/my image #1.png': TINY_PNG },
            }),
        )

        expect(book.spine.map((item) => item.path)).toEqual([
            'OEBPS/text/chapter one & two.xhtml',
            'OEBPS/text/café.xhtml',
        ])
        expect(book.has('OEBPS/images/my image #1.png')).toBe(true)
        expect(book.manifest.find((item) => item.id === 'file-1')?.size).toBe(TINY_PNG.length)
        expect(await book.readText('OEBPS/text/café.xhtml')).toContain('Chapter 2')
    })

    it('uses the entry name when the href has a different letter case', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="Text/C1.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="Images/A.PNG" media-type="image/png"/>`,
                }),
                files: { 'OEBPS/text/c1.xhtml': chapter(), 'OEBPS/images/a.png': TINY_PNG },
            }),
        )

        expect(book.spine[0].path).toBe('OEBPS/text/c1.xhtml')
        expect(book.manifest[1]).toMatchObject({
            path: 'OEBPS/images/a.png',
            size: TINY_PNG.length,
        })
        expect(book.mediaTypeOf('OEBPS/Images/A.PNG')).toBe('image/png')
        expect(book.spineIndexOf('OEBPS/Text/C1.xhtml')).toBe(0)
    })

    it('corrects wrong media types of stylesheets, images and fonts', async () => {
        // The wrong types are from real books.
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="main.css" media-type="txt/css"/>
<item id="img" href="a.JPG" media-type="image/jpg"/>
<item id="ttf" href="a.ttf" media-type="application/application/x-font-ttf"/>
<item id="otf" href="b.otf" media-type="application/vnd.ms-opentype"/>
<item id="tpl" href="page.xpgt" media-type="application/vnd.adobe-page-template+xml"/>
<item id="txt" href="notes.txt" media-type="text/plain; charset=utf-8"/>`,
                }),
                files: {
                    'OEBPS/c1.xhtml': chapter(),
                    'OEBPS/main.css': 'p {}',
                    'OEBPS/a.JPG': TINY_PNG,
                    'OEBPS/a.ttf': TINY_PNG,
                    'OEBPS/b.otf': TINY_PNG,
                    'OEBPS/page.xpgt': '<ade:template xmlns:ade="http://ns.adobe.com/2006/ade"/>',
                    'OEBPS/notes.txt': 'notes',
                },
            }),
        )

        expect(Object.fromEntries(book.manifest.map((item) => [item.id, item.mediaType]))).toEqual({
            c1: 'application/xhtml+xml',
            css: 'text/css',
            img: 'image/jpeg',
            ttf: 'font/ttf',
            otf: 'font/otf',
            tpl: 'application/vnd.adobe-page-template+xml',
            txt: 'text/plain',
        })
        expect(book.mediaTypeOf('OEBPS/main.css')).toBe('text/css')
        expect((await book.readBlob('OEBPS/a.JPG')).type).toBe('image/jpeg')
    })

    it('finds a media type for an item that has none', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="c1.xhtml"/>
<item id="data" href="data.bin"/>`,
                }),
                files: { 'OEBPS/c1.xhtml': chapter(), 'OEBPS/data.bin': 'x' },
            }),
        )
        expect(book.manifest.map((item) => item.mediaType)).toEqual([
            'application/xhtml+xml',
            'application/octet-stream',
        ])
        expect(book.spine).toHaveLength(1)
    })
})

describe('spine', () => {
    it('reads a package document at the container root', async () => {
        const book = await openEpub(await buildEpub({ opfDir: '' }))
        expect(book.spine.map((item) => item.path)).toEqual([
            'text/chapter-1.xhtml',
            'text/chapter-2.xhtml',
            'text/chapter-3.xhtml',
        ])
        expect(book.toc.map((item) => item.path)).toEqual(book.spine.map((item) => item.path))
    })

    it('reads a package document in a deep directory', async () => {
        const book = await openEpub(await buildEpub({ opfDir: 'a/b c/' }))
        expect(book.spine[0].path).toBe('a/b c/text/chapter-1.xhtml')
        expect(await book.readText(book.spine[0].path)).toContain('Chapter 1')
    })

    it('gives each item its index, idref, media type and size', async () => {
        const book = await openEpub(await buildEpub({}))
        expect(book.spine).toHaveLength(3)
        const text = await book.readText('OEBPS/text/chapter-2.xhtml')
        expect(book.spine[1]).toEqual({
            index: 1,
            idref: 'chapter-2',
            path: 'OEBPS/text/chapter-2.xhtml',
            mediaType: 'application/xhtml+xml',
            linear: true,
            size: text.length,
            properties: [],
        })
    })

    it('keeps linear="no" items and marks them', async () => {
        const book = await openEpub(
            await buildEpub({ chapters: [{}, { path: 'text/notes.xhtml', linear: false }, {}] }),
        )
        expect(book.spine.map((item) => item.linear)).toEqual([true, false, true])
        expect(book.spine.map((item) => item.index)).toEqual([0, 1, 2])
    })

    it('leaves out items that are missing from the container', async () => {
        const book = await openEpub(
            await buildEpub({ chapters: [{ missing: true }, {}, { missing: true }, {}] }),
        )
        expect(book.spine.map((item) => [item.index, item.path])).toEqual([
            [0, 'OEBPS/text/chapter-2.xhtml'],
            [1, 'OEBPS/text/chapter-4.xhtml'],
        ])
        expect(book.manifest.find((item) => item.id === 'chapter-1')?.size).toBe(0)
    })

    it('leaves out items that are not content documents, unknown idrefs and duplicates', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="img" href="front.png" media-type="image/png"/>
<item id="svg" href="page.svg" media-type="image/svg+xml"/>
<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="c2.html" media-type="TEXT/HTML"/>
<item id="c3" href="c3.xhtml" media-type="application/xml"/>`,
                    spine: `<spine>
<itemref idref="img"/><itemref idref="svg"/><itemref idref="c1"/><itemref idref="nothing"/>
<itemref idref="c2" properties="page-spread-left"/><itemref idref="c1"/><itemref idref="c3"/>
</spine>`,
                }),
                files: {
                    'OEBPS/front.png': TINY_PNG,
                    'OEBPS/page.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
                    'OEBPS/c1.xhtml': chapter(),
                    'OEBPS/c2.html': chapter(),
                    'OEBPS/c3.xhtml': chapter(),
                },
            }),
        )

        expect(book.spine.map((item) => [item.index, item.idref, item.mediaType])).toEqual([
            [0, 'c1', 'application/xhtml+xml'],
            [1, 'c2', 'text/html'],
            // The media type was wrong, so it comes from the file extension.
            [2, 'c3', 'application/xhtml+xml'],
        ])
        expect(book.spine[1].properties).toEqual(['page-spread-left'])
        expect(book.pageProgression).toBe('ltr')
    })

    it('reads the page progression direction', async () => {
        expect((await openEpub(await buildEpub({ pageProgression: 'rtl' }))).pageProgression).toBe(
            'rtl',
        )
        expect((await openEpub(await buildEpub({ pageProgression: 'ltr' }))).pageProgression).toBe(
            'ltr',
        )
        expect((await openEpub(await buildEpub({}))).pageProgression).toBe('ltr')
    })
})

describe('cover', () => {
    it('rule a: the manifest item with the cover-image property', async () => {
        const book = await openEpub(await buildEpub({ cover: 'cover-image' }))
        expect(book.coverPath).toBe('OEBPS/images/front.png')
        const blob = await book.readBlob(book.coverPath!)
        expect(blob.type).toBe('image/png')
        expect(blob.size).toBe(TINY_PNG.length)
    })

    it('rule b: the cover meta with a manifest id', async () => {
        const book = await openEpub(await buildEpub({ version: 2, cover: 'meta' }))
        expect(book.coverPath).toBe('OEBPS/images/front.png')
    })

    it('rule b: the cover meta with an href', async () => {
        const book = await openEpub(
            await buildEpub({
                version: 2,
                cover: { variant: 'meta-href', path: 'images/my front.png' },
            }),
        )
        expect(book.coverPath).toBe('OEBPS/images/my front.png')
    })

    it('rule c: the first img of the guide cover page', async () => {
        const book = await openEpub(await buildEpub({ version: 2, cover: 'guide' }))
        expect(book.coverPath).toBe('OEBPS/images/front.png')
    })

    it('rule c: the SVG image of the guide cover page', async () => {
        const book = await openEpub(await buildEpub({ version: 2, cover: 'guide-svg' }))
        expect(book.coverPath).toBe('OEBPS/images/front.png')
    })

    it('rule c: the page with the cover property', async () => {
        const book = await openEpub(await buildEpub({ cover: 'page-property' }))
        expect(book.coverPath).toBe('OEBPS/images/front.png')
    })

    it('rule c: a guide reference that points at the image', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="i1" href="art/front.png" media-type="image/png"/>`,
                    rest: '<guide><reference type="Cover" href="art/front.png"/></guide>',
                }),
                files: { 'OEBPS/c1.xhtml': chapter(), 'OEBPS/art/front.png': TINY_PNG },
            }),
        )
        expect(book.coverPath).toBe('OEBPS/art/front.png')
    })

    it('rule c: a guide reference with a cover image type from another tool', async () => {
        // From a real book: the cover meta names an id that is not in the manifest, the guide
        // type is not "cover", and the href has a different letter case than the file.
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    metadata: '<dc:title>Book</dc:title><meta content="cover-image" name="cover"/>',
                    manifest: `<item id="cvi" href="OEBPS/cvi.htm" media-type="application/xhtml+xml"/>
<item id="c1" href="OEBPS/c1.htm" media-type="application/xhtml+xml"/>
<item id="fcvt" href="OEBPS/images/cvt_r1.jpg" media-type="image/jpeg"/>
<item id="fcvi" href="OEBPS/images/cvi_r1.jpg" media-type="image/jpeg"/>`,
                    spine: '<spine><itemref idref="cvi" linear="no"/><itemref idref="c1" linear="yes"/></spine>',
                    rest: `<guide>
<reference href="OEBPS/c1.htm" title="Table of Contents" type="toc"/>
<reference href="OEBPS/Images/cvt_r1.jpg" title="thumb" type="thumbimagestandard"/>
<reference href="OEBPS/Images/back_r1.jpg" title="back" type="other.backcover"/>
<reference href="OEBPS/Images/cvi_r1.jpg" title="cover" type="coverimagestandard"/>
</guide>`,
                }),
                opfPath: 'book.opf',
                files: {
                    'OEBPS/cvi.htm': chapterXhtml({
                        title: 'Front',
                        body: '<img src="images/cvi_r1.jpg"/>',
                    }),
                    'OEBPS/c1.htm': chapter(),
                    'OEBPS/images/cvt_r1.jpg': TINY_PNG,
                    'OEBPS/images/cvi_r1.jpg': TINY_PNG,
                    'OEBPS/images/back_r1.jpg': TINY_PNG,
                },
            }),
        )
        expect(book.coverPath).toBe('OEBPS/images/cvi_r1.jpg')
        expect(book.spine.map((item) => item.linear)).toEqual([false, true])
    })

    it('rule c: the guide type "cover" has priority over other cover types', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="a" href="a.png" media-type="image/png"/>
<item id="b" href="b.png" media-type="image/png"/>`,
                    rest: `<guide>
<reference href="a.png" type="other.ms-coverimage-standard"/>
<reference href="b.png" type="cover"/>
</guide>`,
                }),
                files: {
                    'OEBPS/c1.xhtml': chapter(),
                    'OEBPS/a.png': TINY_PNG,
                    'OEBPS/b.png': TINY_PNG,
                },
            }),
        )
        expect(book.coverPath).toBe('OEBPS/b.png')
    })

    it('rule d: the first image with the word cover in its id or path', async () => {
        const byPath = await openEpub(await buildEpub({ cover: 'name' }))
        expect(byPath.coverPath).toBe('OEBPS/images/cover.png')

        const byId = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="i1" href="a.png" media-type="image/png"/>
<item id="BookCover" href="b.png" media-type="image/png"/>
<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
                }),
                files: {
                    'OEBPS/c1.xhtml': chapter(),
                    'OEBPS/a.png': TINY_PNG,
                    'OEBPS/b.png': TINY_PNG,
                    'OEBPS/cover.xhtml': chapter(),
                },
            }),
        )
        expect(byId.coverPath).toBe('OEBPS/b.png')
    })

    it('gives null when no rule matches', async () => {
        const book = await openEpub(await buildEpub({ files: { 'images/a.png': TINY_PNG } }))
        expect(book.coverPath).toBeNull()
    })

    it('uses the rules in order', async () => {
        const files = {
            'OEBPS/c1.xhtml': chapter(),
            'OEBPS/a.png': TINY_PNG,
            'OEBPS/b.png': TINY_PNG,
            'OEBPS/c.png': TINY_PNG,
            'OEBPS/cover.png': TINY_PNG,
            'OEBPS/page.xhtml': chapterXhtml({ title: 'Front', body: '<img src="c.png"/>' }),
        }
        const manifest = (
            properties: string,
        ) => `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="named" href="cover.png" media-type="image/png"/>
<item id="a" href="a.png" media-type="image/png" ${properties}/>
<item id="b" href="b.png" media-type="image/png"/>
<item id="c" href="c.png" media-type="image/png"/>
<item id="page" href="page.xhtml" media-type="application/xhtml+xml"/>`
        const guide = '<guide><reference type="cover" href="page.xhtml"/></guide>'
        const meta = '<dc:title>Book</dc:title><meta name="cover" content="b"/>'

        const all = await openEpub(
            await packEpub({
                opf: opf({
                    metadata: meta,
                    manifest: manifest('properties="cover-image"'),
                    rest: guide,
                }),
                files,
            }),
        )
        expect(all.coverPath).toBe('OEBPS/a.png')

        const noProperty = await openEpub(
            await packEpub({
                opf: opf({ metadata: meta, manifest: manifest(''), rest: guide }),
                files,
            }),
        )
        expect(noProperty.coverPath).toBe('OEBPS/b.png')

        const guideAndName = await openEpub(
            await packEpub({ opf: opf({ manifest: manifest(''), rest: guide }), files }),
        )
        expect(guideAndName.coverPath).toBe('OEBPS/c.png')

        const nameOnly = await openEpub(
            await packEpub({ opf: opf({ manifest: manifest('') }), files }),
        )
        expect(nameOnly.coverPath).toBe('OEBPS/cover.png')
    })

    it('goes to the next rule when the cover file is missing or is not an image', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    metadata: '<dc:title>Book</dc:title><meta name="cover" content="c1"/>',
                    manifest: `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="gone" href="gone.png" media-type="image/png" properties="cover-image"/>
<item id="pic" href="pic.png" media-type="image/png"/>`,
                }),
                files: {
                    // The cover meta points at a page. The first image of that page is the cover.
                    'OEBPS/c1.xhtml': chapterXhtml({
                        title: 'Front',
                        body: '<img src="https://example.com/x.png"/><img src="nothing.png"/><img src="pic.png"/>',
                    }),
                    'OEBPS/pic.png': TINY_PNG,
                },
            }),
        )
        expect(book.coverPath).toBe('OEBPS/pic.png')
    })

    it('does not read a large document to find the cover', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="pic" href="pic.png" media-type="image/png"/>`,
                    rest: '<guide><reference type="cover" href="c1.xhtml#start"/></guide>',
                }),
                files: {
                    'OEBPS/c1.xhtml': chapterXhtml({
                        title: 'All of the book',
                        body: `<img src="pic.png"/><p>${'Many words. '.repeat(30_000)}</p>`,
                    }),
                    'OEBPS/pic.png': TINY_PNG,
                },
            }),
        )
        expect(book.spine[0].size).toBeGreaterThan(256 * 1024)
        expect(book.coverPath).toBeNull()
    })

    it('reads a cover page that has an HTML entity and a self-closed title', async () => {
        // The HTML parser reads `<title/>` as a start tag and loses all the text after it.
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="page" href="page.xhtml" media-type="application/xhtml+xml"/>
<item id="pic" href="pic.png" media-type="image/png"/>`,
                    rest: '<guide><reference type="cover" href="page.xhtml"/></guide>',
                }),
                files: {
                    'OEBPS/c1.xhtml': chapter(),
                    'OEBPS/page.xhtml': `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title/></head>
<body><p>&nbsp;<img src="pic.png" alt=""/></p></body></html>`,
                    'OEBPS/pic.png': TINY_PNG,
                },
            }),
        )
        expect(book.coverPath).toBe('OEBPS/pic.png')
    })

    it('reads a cover page that is not well-formed XHTML', async () => {
        const book = await openEpub(
            await packEpub({
                opf: opf({
                    manifest: `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="page" href="page.html" media-type="text/html"/>
<item id="pic" href="pic.png" media-type="image/png"/>`,
                    rest: '<guide><reference type="cover" href="page.html"/></guide>',
                }),
                files: {
                    'OEBPS/c1.xhtml': chapter(),
                    'OEBPS/page.html': '<html><body><p>&nbsp;<img src=pic.png><br></body></html>',
                    'OEBPS/pic.png': TINY_PNG,
                },
            }),
        )
        expect(book.coverPath).toBe('OEBPS/pic.png')
    })
})
