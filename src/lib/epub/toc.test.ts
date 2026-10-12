import { describe, expect, it } from 'vitest'
import { openEpub } from './index'
import { buildEpub, chapterXhtml, packEpub, type BuildEpubTocEntry } from './testing/build-epub'
import type { TocItem } from './types'

const NESTED_TOC: BuildEpubTocEntry[] = [
    {
        title: 'Part One',
        children: [
            {
                title: 'Chapter 1',
                href: 'text/chapter-1.xhtml',
                children: [
                    { title: 'Section 1.1', href: 'text/chapter-1.xhtml#s1' },
                    { title: 'Section 1.2', href: 'text/chapter-1.xhtml#s2' },
                ],
            },
            { title: 'Chapter 2', href: 'text/chapter-2.xhtml#title' },
        ],
    },
    { title: 'Chapter 3', href: 'text/chapter-3.xhtml' },
    { title: 'Notes', href: 'text/notes.xhtml#n1' },
]

const leaf = (item: Omit<TocItem, 'children'>): TocItem => ({ ...item, children: [] })

const EXPECTED_NESTED: TocItem[] = [
    {
        title: 'Part One',
        path: null,
        fragment: null,
        spineIndex: -1,
        children: [
            {
                title: 'Chapter 1',
                path: 'OEBPS/text/chapter-1.xhtml',
                fragment: null,
                spineIndex: 0,
                children: [
                    leaf({
                        title: 'Section 1.1',
                        path: 'OEBPS/text/chapter-1.xhtml',
                        fragment: 's1',
                        spineIndex: 0,
                    }),
                    leaf({
                        title: 'Section 1.2',
                        path: 'OEBPS/text/chapter-1.xhtml',
                        fragment: 's2',
                        spineIndex: 0,
                    }),
                ],
            },
            leaf({
                title: 'Chapter 2',
                path: 'OEBPS/text/chapter-2.xhtml',
                fragment: 'title',
                spineIndex: 1,
            }),
        ],
    },
    leaf({ title: 'Chapter 3', path: 'OEBPS/text/chapter-3.xhtml', fragment: null, spineIndex: 2 }),
    // The target is in the manifest but not in the spine.
    leaf({ title: 'Notes', path: 'OEBPS/text/notes.xhtml', fragment: 'n1', spineIndex: -1 }),
]

const NOTES_FILE = {
    'text/notes.xhtml': chapterXhtml({ title: 'Notes', body: '<p id="n1">Note</p>' }),
}

/** A book with a hand-written nav document and an optional NCX file. */
function bookWithNav(nav: string, ncx?: string): Promise<Blob> {
    return packEpub({
        opf: `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title></metadata>
<manifest>
<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav/toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${ncx === undefined ? '' : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'}
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
        files: {
            'OEBPS/text/c1.xhtml': chapterXhtml({ title: 'One', body: '<p>One</p>' }),
            'OEBPS/text/c2.xhtml': chapterXhtml({ title: 'Two', body: '<p>Two</p>' }),
            'OEBPS/nav/toc.xhtml': nav,
            ...(ncx === undefined ? {} : { 'OEBPS/toc.ncx': ncx }),
        },
    })
}

const navDocument = (body: string) =>
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>${body}</body></html>`

const ncxDocument = (navMap: string) =>
    `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${navMap}</navMap></ncx>`

const titles = (items: readonly TocItem[]): unknown[] =>
    items.map((item) => (item.children.length ? [item.title, titles(item.children)] : item.title))

describe('nav document', () => {
    it('reads nested entries with fragments and span headings', async () => {
        const book = await openEpub(
            await buildEpub({ version: 3, toc: NESTED_TOC, files: NOTES_FILE }),
        )
        expect(book.toc).toEqual(EXPECTED_NESTED)
    })

    it('has priority over the NCX file', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument(
                    '<nav epub:type="toc"><ol><li><a href="../text/c1.xhtml">From nav</a></li></ol></nav>',
                ),
                ncxDocument(
                    '<navPoint><navLabel><text>From NCX</text></navLabel><content src="text/c1.xhtml"/></navPoint>',
                ),
            ),
        )
        expect(titles(book.toc)).toEqual(['From nav'])
    })

    it('resolves targets against the directory of the nav document', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument(`<nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="../text/c2.xhtml">Start</a></li></ol></nav>
<nav epub:type="toc"><h2>Contents</h2><ol>
<li><a href="../text/c1.xhtml">One</a></li>
<li><a href="../text/c2.xhtml#top">  Two
   <em>words</em> </a></li>
<li><a href="https://example.com/">A website</a></li>
<li><a href="../text/c9.xhtml">Not in the book</a></li>
</ol></nav>`),
            ),
        )

        expect(book.toc).toEqual([
            leaf({ title: 'One', path: 'OEBPS/text/c1.xhtml', fragment: null, spineIndex: 0 }),
            leaf({
                title: 'Two words',
                path: 'OEBPS/text/c2.xhtml',
                fragment: 'top',
                spineIndex: 1,
            }),
            leaf({ title: 'A website', path: null, fragment: null, spineIndex: -1 }),
            leaf({
                title: 'Not in the book',
                path: 'OEBPS/text/c9.xhtml',
                fragment: null,
                spineIndex: -1,
            }),
        ])
    })

    it('finds the toc nav by role and with another prefix', async () => {
        const byRole = await openEpub(
            await bookWithNav(
                navDocument(
                    '<nav role="doc-toc"><ol><li><a href="../text/c1.xhtml">One</a></li></ol></nav>',
                ),
            ),
        )
        expect(titles(byRole.toc)).toEqual(['One'])

        const otherPrefix = await openEpub(
            await bookWithNav(
                `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ops="http://www.idpf.org/2007/ops"><body>
<nav ops:type="page-list toc"><ol><li><a href="../text/c1.xhtml">One</a></li></ol></nav></body></html>`,
            ),
        )
        expect(titles(otherPrefix.toc)).toEqual(['One'])
    })

    it('reads a nav document that is not well-formed XHTML', async () => {
        const book = await openEpub(
            await bookWithNav(`<!DOCTYPE html><html><body>
<nav epub:type="toc"><ol>
<li><a href="../text/c1.xhtml">One&nbsp;&amp; only<br></a>
  <ol><li><a href="../text/c1.xhtml#a">Inner</a></ol>
<li><a href="../text/c2.xhtml">Two</a>
</ol></nav></body></html>`),
        )
        expect(titles(book.toc)).toEqual([['One & only', ['Inner']], 'Two'])
        expect(book.toc[0].children[0]).toMatchObject({ fragment: 'a', spineIndex: 0 })
    })

    it('reads a nav document that has an HTML entity and a self-closed title', async () => {
        // The HTML parser reads `<title/>` as a start tag and loses all the text after it.
        const book = await openEpub(
            await bookWithNav(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title/></head>
<body><nav epub:type="toc"><ol>
<li><a href="../text/c1.xhtml">One&nbsp;&amp; only</a>
<ol><li><a href="../text/c1.xhtml#a">Inner</a></li></ol></li>
<li><a href="../text/c2.xhtml">Two</a></li>
</ol></nav></body></html>`),
        )
        expect(titles(book.toc)).toEqual([['One & only', ['Inner']], 'Two'])
        expect(book.toc[1]).toMatchObject({ path: 'OEBPS/text/c2.xhtml', spineIndex: 1 })
    })

    it('finds the link of an entry that has another element before it', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument(`<nav epub:type="toc"><ol>
<li><span class="number">1.</span> <a href="../text/c1.xhtml">One</a></li>
<li><span>Part</span><ol><li><a href="../text/c2.xhtml#a">Two</a></li></ol></li>
</ol></nav>`),
            ),
        )
        expect(book.toc).toMatchObject([
            { title: 'One', path: 'OEBPS/text/c1.xhtml', spineIndex: 0, children: [] },
            {
                title: 'Part',
                path: null,
                children: [{ title: 'Two', path: 'OEBPS/text/c2.xhtml', fragment: 'a' }],
            },
        ])
    })

    it('leaves out entries with an empty title and keeps their children', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument(`<nav epub:type="toc"><ol>
<li><a href="../text/c1.xhtml"> </a><ol><li><a href="../text/c1.xhtml#a">Kept</a></li></ol></li>
<li><span></span></li>
<li><a href="../text/c2.xhtml">Two</a></li>
</ol></nav>`),
            ),
        )
        expect(titles(book.toc)).toEqual(['Kept', 'Two'])
    })

    it('reads entries that have no link', async () => {
        // From a real book: most entries are plain text or bold text, and the list has a type.
        const book = await openEpub(
            await bookWithNav(
                navDocument(`<nav epub:type="toc" role="doc-toc"><h1>Contents</h1><ol epub:type="list">
<li><a href="../text/c1.xhtml"><b>Introduction</b></a></li>
<li><b>5. Local Variables</b>
<ol>
<li>Variables, Declarations, and Assignment</li>
<li>The Parser
<ol><li>The Updated AST</li></ol></li>
</ol></li>
</ol></nav>
<nav epub:type="lot"><ol><li><a href="../text/c2.xhtml">A table</a></li></ol></nav>`),
            ),
        )
        expect(titles(book.toc)).toEqual([
            'Introduction',
            [
                '5. Local Variables',
                ['Variables, Declarations, and Assignment', ['The Parser', ['The Updated AST']]],
            ],
        ])
        expect(book.toc[1]).toMatchObject({ path: null, fragment: null, spineIndex: -1 })
        expect(book.toc[1].children[1]).toMatchObject({ path: null, spineIndex: -1 })
    })

    it('reads a link in a wrapper element and text with no element', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument(`<nav epub:type="toc"><div><ul>
<li><p><a href="../text/c1.xhtml">Wrapped</a></p></li>
<li>Plain text<ul><li><a href="../text/c2.xhtml" title="From title"><img src="x.png" alt=""/></a></li></ul></li>
</ul></div></nav>`),
            ),
        )
        expect(book.toc).toMatchObject([
            { title: 'Wrapped', path: 'OEBPS/text/c1.xhtml', spineIndex: 0 },
            { title: 'Plain text', path: null, children: [{ title: 'From title', spineIndex: 1 }] },
        ])
    })
})

describe('NCX file', () => {
    it('reads nested entries', async () => {
        const book = await openEpub(
            await buildEpub({ version: 2, toc: NESTED_TOC, files: NOTES_FILE }),
        )
        expect(book.toc).toEqual(EXPECTED_NESTED)
    })

    it('is the fallback when the nav document has no toc nav', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument(
                    '<nav epub:type="landmarks"><ol><li><a href="../text/c1.xhtml">Start</a></li></ol></nav>',
                ),
                ncxDocument(
                    `<navPoint id="a" playOrder="1"><navLabel><text>From NCX</text></navLabel><content src="text/c2.xhtml#x"/></navPoint>`,
                ),
            ),
        )
        expect(book.toc).toEqual([
            leaf({ title: 'From NCX', path: 'OEBPS/text/c2.xhtml', fragment: 'x', spineIndex: 1 }),
        ])
    })

    it('is the fallback when the toc nav has no entries', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument('<nav epub:type="toc"><ol></ol></nav>'),
                ncxDocument(
                    '<navPoint><navLabel><text>From NCX</text></navLabel><content src="text/c1.xhtml"/></navPoint>',
                ),
            ),
        )
        expect(titles(book.toc)).toEqual(['From NCX'])
    })

    it('is found through the spine toc attribute when the media type is wrong', async () => {
        const book = await openEpub(
            await packEpub({
                opf: `<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
<manifest>
<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="contents" href="contents.xml" media-type="text/xml"/>
</manifest>
<spine toc="contents"><itemref idref="c1"/></spine>
</package>`,
                files: {
                    'OEBPS/c1.xhtml': chapterXhtml({ title: 'One', body: '<p>One</p>' }),
                    'OEBPS/contents.xml': ncxDocument(
                        '<navPoint><navLabel><text>One</text></navLabel><content src="c1.xhtml"/></navPoint>',
                    ),
                },
            }),
        )
        expect(book.toc).toEqual([
            leaf({ title: 'One', path: 'OEBPS/c1.xhtml', fragment: null, spineIndex: 0 }),
        ])
    })

    it('reads an NCX file with HTML entities and prefixes', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument(''),
                `<?xml version="1.0"?><ncx:ncx xmlns:ncx="http://www.daisy.org/z3986/2005/ncx/"><ncx:navMap>
<ncx:navPoint><ncx:navLabel><ncx:text>Caf&eacute;&nbsp;&mdash; R&D</ncx:text></ncx:navLabel><ncx:content src="text/c1.xhtml"/>
<ncx:navPoint><ncx:navLabel><ncx:text>Inner</ncx:text></ncx:navLabel><ncx:content src="text/c2.xhtml"/></ncx:navPoint>
</ncx:navPoint>
<ncx:navPoint><ncx:navLabel><ncx:text>  </ncx:text></ncx:navLabel><ncx:content src="text/c2.xhtml"/></ncx:navPoint>
</ncx:navMap></ncx:ncx>`,
            ),
        )
        expect(titles(book.toc)).toEqual([['Café — R&D', ['Inner']]])
    })

    it('keeps an entry whose target is an absolute path of another computer', async () => {
        // From a real book. The target is not in the container, so the entry has no spine index.
        const book = await openEpub(
            await bookWithNav(
                navDocument(''),
                ncxDocument(`<navPoint id="a" playOrder="0"><navLabel><text>1</text></navLabel>
<content src="/C%3a%5cUsers%5csomeone%5cDownloads%5cBook%5c011.html"/></navPoint>
<navPoint id="b" playOrder="1"><navLabel><text>2</text></navLabel><content src="text/c2.xhtml"/></navPoint>`),
            ),
        )
        expect(book.toc).toEqual([
            leaf({
                title: '1',
                path: 'C:/Users/someone/Downloads/Book/011.html',
                fragment: null,
                spineIndex: -1,
            }),
            leaf({ title: '2', path: 'OEBPS/text/c2.xhtml', fragment: null, spineIndex: 1 }),
        ])
        expect(book.has(book.toc[0].path!)).toBe(false)
    })

    it('reads an NCX file that is not well-formed XML', async () => {
        const book = await openEpub(
            await bookWithNav(
                navDocument(''),
                `<ncx><navMap>
<navPoint><navLabel><text>One</text></navLabel><content src="text/c1.xhtml"/>
<navPoint><navLabel><text>Inner</text></navLabel><content src="text/c1.xhtml#a"/></navPoint>
</navPoint>
<navPoint><navLabel><text>Two</text></navLabel><content src="text/c2.xhtml"></navPoint>
</navMap>`,
            ),
        )
        expect(titles(book.toc)).toEqual([['One', ['Inner']], 'Two'])
        expect(book.toc[1]).toMatchObject({ path: 'OEBPS/text/c2.xhtml', spineIndex: 1 })
    })
})

describe('no table of contents', () => {
    it('gives an empty list when the book has no nav document and no NCX file', async () => {
        const book = await openEpub(await buildEpub({ nav: false, ncx: false }))
        expect(book.toc).toEqual([])
        expect(book.spine).toHaveLength(3)
    })

    it('gives an empty list when the files are in the manifest but not in the container', async () => {
        const book = await openEpub(
            await packEpub({
                opf: `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<manifest>
<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="c1"/></spine>
</package>`,
                files: { 'OEBPS/c1.xhtml': chapterXhtml({ title: 'One', body: '<p>One</p>' }) },
            }),
        )
        expect(book.toc).toEqual([])
    })
})
