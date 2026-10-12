import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EpubBook } from '$lib/epub/types'
import { createFakeBook } from '$lib/epub/testing/fake-book'
import { createContentLoader } from './loader'
import { buildTextModel, createTextIndex } from './text-model'
import type { ContentLoader } from './types'

function chapter(body: string, head = ''): string {
    return (
        '<?xml version="1.0" encoding="utf-8"?>' +
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title>${head}</head>` +
        `<body>${body}</body></html>`
    )
}

const MAIN_LINK = '<link rel="stylesheet" href="../css/main.css"/>'

const CHAPTER_1 =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" dir="ltr" class="doc"><head><title>One</title>' +
    MAIN_LINK +
    '<style>h1 { background: url(../images/a.png) } body { margin: 0 }</style></head>' +
    '<body id="ch1" class="chapter">' +
    '<h1 id="title">Chapter one</h1>' +
    '<p id="p1" style="color: red; background-image: url(../images/b.png)">Text with ' +
    '<a href="ch2.xhtml#note">a link</a> and <img src="../images/a.png" alt="A"/>.</p>' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="art">' +
    '<image xlink:href="../images/b.png" width="1" height="1"/></svg>' +
    '<p><a name="legacy"></a>End <span id="last" style="position: fixed; page-break-before: always">' +
    'here</span>.</p></body></html>'

const FILES: Record<string, string> = {
    'OEBPS/text/ch1.xhtml': CHAPTER_1,
    'OEBPS/text/ch2.xhtml': chapter(
        '<p id="note">Note text <img src="../images/d.png" alt=""/></p>',
        MAIN_LINK,
    ),
    'OEBPS/text/ch3.xhtml': chapter(
        '<p>Three <img src="../images/c.png" alt=""/></p>' +
            '<p id="remote" style="background-image: url(https://example.com/t.gif); color: blue">x</p>',
    ),
    'OEBPS/text/ch4.xhtml': chapter(
        '<p>Four <img src="../images/d.png" alt=""/></p>',
        '<link rel="stylesheet" href="../css/bad.css"/>' + MAIN_LINK,
    ),
    'OEBPS/text/ch5.xhtml': chapter('<p>Five has no images.</p>'),
    'OEBPS/css/main.css':
        '@import "fonts.css";\nhtml, body { color: black }\n.x { background: url(../images/a.png) }',
    'OEBPS/css/fonts.css':
        '@font-face { font-family: "Zeta Serif"; src: url(../fonts/z.woff2) }\n' +
        "@font-face { font-family: 'Alpha Sans'; src: url(../fonts/a.woff2); font-weight: bold }\n" +
        '@font-face { font-family: "Alpha Sans"; src: url(../fonts/a.woff2); font-weight: normal }',
    'OEBPS/css/bad.css': 'p { color: red }',
    'OEBPS/fonts/z.woff2': 'z',
    'OEBPS/fonts/a.woff2': 'a',
    'OEBPS/images/a.png': 'a',
    'OEBPS/images/b.png': 'b',
    'OEBPS/images/c.png': 'c',
    'OEBPS/images/d.png': 'd',
}

function makeBook(): EpubBook {
    const book = createFakeBook({
        files: FILES,
        spine: [
            'OEBPS/text/ch1.xhtml',
            'OEBPS/text/ch2.xhtml',
            'OEBPS/text/ch3.xhtml',
            'OEBPS/text/ch4.xhtml',
            'OEBPS/text/ch5.xhtml',
        ],
    })
    const readText = book.readText
    book.readText = async (path) => {
        if (path === 'OEBPS/css/bad.css') throw new Error('Bad file')
        return readText(path)
    }
    return book
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 'ready' when the promise resolves in the time limit. */
function settlesIn(promise: Promise<void>, ms: number): Promise<string> {
    return Promise.race([promise.then(() => 'ready'), sleep(ms).then(() => 'pending')])
}

function readCount(spy: { mock: { calls: unknown[][] } }, path: string): number {
    return spy.mock.calls.filter((call) => call[0] === path).length
}

let created: Map<string, Blob>
let revoked: string[]
let loader: ContentLoader | null

function makeLoader(
    options: Partial<Parameters<typeof createContentLoader>[0]> = {},
): ContentLoader {
    loader = createContentLoader({ book: makeBook(), imageTimeoutMs: 20, ...options })
    return loader
}

beforeEach(() => {
    created = new Map()
    revoked = []
    loader = null
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        const url = `blob:test/${created.size + 1}`
        created.set(url, blob as Blob)
        return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
        revoked.push(url)
    })
})

afterEach(() => {
    loader?.dispose()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(document, 'fonts')
})

describe('createContentLoader: load', () => {
    it('prepares a chapter as detached DOM', async () => {
        const content = await makeLoader().load(0)

        expect(content.spineIndex).toBe(0)
        expect(content.path).toBe('OEBPS/text/ch1.xhtml')
        expect(content.root.localName).toBe('rd-html')
        expect(content.root.className).toBe('doc')
        expect(content.body.localName).toBe('rd-body')
        expect(content.body.parentElement).toBe(content.root)
        expect(content.body.id).toBe('ch1')
        expect(content.root.isConnected).toBe(false)
        expect(content.lang).toBe('en')
        expect(content.dir).toBe('ltr')
        expect(content.body.querySelector('h1')!.textContent).toBe('Chapter one')
    })

    it('keeps the link data of an internal link', async () => {
        const content = await makeLoader().load(0)
        const link = content.body.querySelector('a[data-rd-path]')!

        expect(link.getAttribute('data-rd-path')).toBe('OEBPS/text/ch2.xhtml')
        expect(link.getAttribute('data-rd-fragment')).toBe('note')
        expect(link.hasAttribute('href')).toBe(false)
    })

    it('sets an object URL on each image of the book', async () => {
        const content = await makeLoader().load(0)
        const img = content.body.querySelector('img')!
        const svgImage = content.body.querySelector('image')!

        expect(img.getAttribute('src')).toMatch(/^blob:test\/\d+$/)
        expect(await created.get(img.getAttribute('src')!)!.text()).toBe('a')
        expect(svgImage.getAttribute('href')).toMatch(/^blob:test\/\d+$/)
        expect(await created.get(svgImage.getAttribute('href')!)!.text()).toBe('b')
    })

    it('applies the style attributes with rewritten URLs', async () => {
        const content = await makeLoader().load(0)
        const paragraph = content.body.querySelector<HTMLElement>('#p1')!
        const last = content.body.querySelector<HTMLElement>('#last')!

        expect(content.root.querySelector('[data-rd-style]')).toBeNull()
        expect(paragraph.style.color).toBe('red')
        expect(paragraph.style.backgroundImage).toBe(
            `url("${content.body.querySelector('image')!.getAttribute('href')}")`,
        )
        expect(last.style.position).toBe('absolute')
        expect(last.style.getPropertyValue('break-before')).toBe('column')
    })

    it('leaves no remote URL in a style attribute', async () => {
        const content = await makeLoader().load(2)
        const paragraph = content.body.querySelector<HTMLElement>('#remote')!

        expect(paragraph.style.color).toBe('blue')
        expect(paragraph.getAttribute('style')).not.toContain('example.com')
        expect(content.root.outerHTML).not.toContain('example.com')
    })

    it('gives the stylesheets in cascade order with rewritten selectors', async () => {
        const content = await makeLoader().load(0)
        const [linked, inline] = content.styles

        expect(content.styles).toHaveLength(2)
        expect((linked.cssRules[0] as CSSStyleRule).selectorText).toBe('rd-html, rd-body')
        expect((inline.cssRules[0] as CSSStyleRule).selectorText).toBe('h1')
        expect((inline.cssRules[1] as CSSStyleRule).selectorText).toBe('rd-body')
        for (const sheet of content.styles) {
            for (const rule of sheet.cssRules) {
                expect(rule).not.toBeInstanceOf(CSSFontFaceRule)
                expect(rule.cssText).not.toMatch(/url\((?!"blob:test\/)/)
            }
        }
    })

    it('shares the sheet of a linked file between chapters', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const contentLoader = makeLoader({ book })

        const [first, second] = await Promise.all([contentLoader.load(0), contentLoader.load(1)])

        expect(second.styles).toHaveLength(1)
        expect(second.styles[0]).toBe(first.styles[0])
        expect(readCount(readText, 'OEBPS/css/main.css')).toBe(1)
    })

    it('skips a stylesheet that cannot be read', async () => {
        const content = await makeLoader().load(3)

        expect(content.styles).toHaveLength(1)
        expect((content.styles[0].cssRules[0] as CSSStyleRule).selectorText).toBe(
            'rd-html, rd-body',
        )
    })

    it('gives the chapter length of the text model', async () => {
        const content = await makeLoader().load(0)

        expect(content.length).toBe(42)
        expect(content.length).toBe(buildTextModel(content.body).text.length)
        expect(content.length).toBe(createTextIndex(content.body).length)
    })

    it('gives the offset of each id and each a name', async () => {
        const content = await makeLoader().load(0)
        const index = createTextIndex(content.body)

        expect([...content.anchors]).toEqual([
            ['ch1', 0],
            ['title', 0],
            ['p1', 11],
            ['art', 33],
            ['legacy', 33],
            ['last', 37],
        ])
        for (const id of ['title', 'p1', 'art', 'last']) {
            const element = content.body.querySelector(`#${id}`)!
            expect(content.anchors.get(id)).toBe(index.offsetOfElement(element))
        }
        expect(content.anchors.get('legacy')).toBe(
            index.offsetOfElement(content.body.querySelector('a[name="legacy"]')!),
        )
    })

    it('rejects for a spine index that the book does not have', async () => {
        const contentLoader = makeLoader()

        await expect(contentLoader.load(99)).rejects.toThrow(RangeError)
        await expect(contentLoader.load(-1)).rejects.toThrow(RangeError)
    })
})

describe('createContentLoader: language', () => {
    function languageLoader(htmlAttributes: string, language: string | null): ContentLoader {
        const book = createFakeBook({
            files: {
                'ch.xhtml':
                    `<html xmlns="http://www.w3.org/1999/xhtml" ${htmlAttributes}><head><title>T</title></head>` +
                    '<body><p>Text</p></body></html>',
            },
            spine: ['ch.xhtml'],
            metadata: { language },
        })
        return makeLoader({ book })
    }

    it('takes the language of the book when the document has none', async () => {
        const content = await languageLoader('', 'EN_us').load(0)

        expect(content.lang).toBe('en-us')
        expect(content.root.getAttribute('lang')).toBe('en-us')
    })

    it('takes the language of the document before the language of the book', async () => {
        const content = await languageLoader('xml:lang="fr_CA"', 'en').load(0)

        expect(content.lang).toBe('fr-CA')
        expect(content.root.getAttribute('lang')).toBe('fr-CA')
    })

    it('takes the language of the book when the document names no language', async () => {
        const content = await languageLoader('lang="und"', 'eng').load(0)

        expect(content.lang).toBe('en')
        expect(content.root.getAttribute('lang')).toBe('en')
    })

    it('gives null and sets no lang attribute when there is no language', async () => {
        for (const language of [null, 'UND', 'English']) {
            const content = await languageLoader('lang="zxx"', language).load(0)

            expect(content.lang, String(language)).toBeNull()
            expect(content.root.hasAttribute('lang')).toBe(false)
            loader?.dispose()
        }
    })
})

describe('createContentLoader: sizes that follow the reader setting', () => {
    const book = () =>
        createFakeBook({
            files: {
                'ch.xhtml': chapter(
                    '<p id="a" style="font-size: 10px; line-height: 12px !important">a</p>' +
                        '<p id="b" style="font-size: large; line-height: 1.5">b</p>' +
                        '<p id="c" style="font-size: 0.9em; color: red">c</p>',
                    '<link rel="stylesheet" href="main.css"/>' +
                        '<style>h1 { font-size: 24pt } h2 { font-size: x-small }</style>',
                ),
                'main.css': 'p { font-size: 12pt; line-height: 14pt } li { font-size: 80% }',
            },
            spine: ['ch.xhtml'],
        })

    it('scales the absolute sizes of the stylesheets', async () => {
        const content = await makeLoader({ book: book() }).load(0)
        const [linked, inline] = content.styles
        const value = (sheet: CSSStyleSheet, index: number, name: string) =>
            (sheet.cssRules[index] as CSSStyleRule).style.getPropertyValue(name)

        expect(value(linked, 0, 'font-size')).toBe('calc(12pt * var(--rd-scale, 1))')
        expect(value(linked, 0, 'line-height')).toBe('calc(14pt * var(--rd-scale, 1))')
        expect(value(linked, 1, 'font-size')).toBe('80%')
        expect(value(inline, 0, 'font-size')).toBe('calc(24pt * var(--rd-scale, 1))')
        expect(value(inline, 1, 'font-size')).toBe('0.625em')
    })

    it('scales the absolute sizes of the style attributes', async () => {
        const content = await makeLoader({ book: book() }).load(0)
        const style = (id: string) => content.body.querySelector<HTMLElement>(`#${id}`)!.style

        expect(style('a').getPropertyValue('font-size')).toBe('calc(10px * var(--rd-scale, 1))')
        expect(style('a').getPropertyValue('line-height')).toBe('calc(12px * var(--rd-scale, 1))')
        expect(style('a').getPropertyPriority('line-height')).toBe('important')
        expect(style('b').getPropertyValue('font-size')).toBe('1.125em')
        expect(style('b').getPropertyValue('line-height')).toBe('1.5')
        expect(style('c').getPropertyValue('font-size')).toBe('0.9em')
        expect(style('c').color).toBe('red')
    })

    it('gives each SVG drawing a scale of 1, so that its text keeps its size', async () => {
        const drawing = createFakeBook({
            files: {
                'ch.xhtml': chapter(
                    '<svg xmlns="http://www.w3.org/2000/svg" id="plain" viewBox="0 0 100 50">' +
                        '<text id="label" x="1" y="9" style="font-size: 10px">Label</text>' +
                        '<svg id="inner"><text>Inner</text></svg></svg>' +
                        '<svg xmlns="http://www.w3.org/2000/svg" id="styled" ' +
                        'style="background-image: url(a.png); font-size: 12pt"><text>T</text></svg>' +
                        '<p id="p" style="font-size: 10px">Text</p>',
                ),
                'a.png': 'a',
            },
            spine: ['ch.xhtml'],
        })
        const content = await makeLoader({ book: drawing }).load(0)
        const style = (id: string) =>
            content.body.querySelector<HTMLElement | SVGElement>(`#${id}`)!.style

        // The declaration stays a product. The scale of the drawing makes it the book value.
        expect(style('label').getPropertyValue('font-size')).toBe('calc(10px * var(--rd-scale, 1))')
        expect(style('plain').getPropertyValue('--rd-scale')).toBe('1')
        expect(style('inner').getPropertyValue('--rd-scale')).toBe('1')
        // The book style of the element stays, also when it is applied after a file read.
        expect(style('styled').getPropertyValue('--rd-scale')).toBe('1')
        expect(style('styled').getPropertyValue('font-size')).toBe(
            'calc(12pt * var(--rd-scale, 1))',
        )
        expect(style('styled').backgroundImage).toContain('blob:test/')
        expect(style('p').getPropertyValue('--rd-scale')).toBe('')
        expect(content.root.style.getPropertyValue('--rd-scale')).toBe('')
    })
})

describe('createContentLoader: cache', () => {
    it('gives the same chapter for a second call', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const contentLoader = makeLoader({ book })

        const first = await contentLoader.load(0)
        const second = await contentLoader.load(0)

        expect(second).toBe(first)
        expect(readCount(readText, 'OEBPS/text/ch1.xhtml')).toBe(1)
    })

    it('shares one promise between concurrent calls', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const contentLoader = makeLoader({ book })

        const first = contentLoader.load(1)
        const second = contentLoader.load(1)

        expect(second).toBe(first)
        expect(await first).toBe(await second)
        expect(readCount(readText, 'OEBPS/text/ch2.xhtml')).toBe(1)
    })

    it('removes the least recently used chapter and releases its image URLs', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const contentLoader = makeLoader({ book, cacheSize: 2 })

        const third = await contentLoader.load(2)
        const imageUrl = third.body.querySelector('img')!.getAttribute('src')!
        await contentLoader.load(4)
        expect(revoked).toEqual([])

        await contentLoader.load(1)

        expect(revoked).toEqual([imageUrl])
        expect(await contentLoader.load(2)).not.toBe(third)
        expect(readCount(readText, 'OEBPS/text/ch3.xhtml')).toBe(2)
    })

    it('marks a chapter as recently used on a cache hit', async () => {
        const contentLoader = makeLoader({ cacheSize: 2 })

        const first = await contentLoader.load(0)
        const second = await contentLoader.load(1)
        await contentLoader.load(0)
        await contentLoader.load(4)

        expect(await contentLoader.load(0)).toBe(first)
        expect(await contentLoader.load(1)).not.toBe(second)
    })

    it('keeps an image URL that a different cached chapter uses', async () => {
        const contentLoader = makeLoader({ cacheSize: 2 })

        const second = await contentLoader.load(1)
        const fourth = await contentLoader.load(3)
        const url = fourth.body.querySelector('img')!.getAttribute('src')!
        expect(second.body.querySelector('img')!.getAttribute('src')).toBe(url)

        await contentLoader.load(4)
        expect(revoked).not.toContain(url)

        await contentLoader.load(2)
        expect(revoked).toContain(url)
    })

    it('keeps the cached chapters when a call has a spine index that the book does not have', async () => {
        const contentLoader = makeLoader({ cacheSize: 2 })
        const second = await contentLoader.load(1)
        const third = await contentLoader.load(2)

        await expect(contentLoader.load(99)).rejects.toThrow(RangeError)
        await expect(contentLoader.load(-1)).rejects.toThrow(RangeError)
        await expect(contentLoader.load(0.5)).rejects.toThrow(RangeError)

        expect(revoked).toEqual([])
        expect(await contentLoader.load(1)).toBe(second)
        expect(await contentLoader.load(2)).toBe(third)
    })

    it('does not cache a failed load', async () => {
        const book = makeBook()
        const readText = book.readText
        let fail = true
        book.readText = async (path) => {
            if (fail && path === 'OEBPS/text/ch5.xhtml') throw new Error('Read error')
            return readText(path)
        }
        const contentLoader = makeLoader({ book })

        await expect(contentLoader.load(4)).rejects.toThrow('Read error')
        fail = false
        const content = await contentLoader.load(4)

        expect(content.body.textContent).toBe('Five has no images.')
    })
})

describe('createContentLoader: imagesReady', () => {
    it('resolves at once for a chapter with no images', async () => {
        const content = await makeLoader({ imageTimeoutMs: 10_000 }).load(4)

        expect(await settlesIn(content.imagesReady, 50)).toBe('ready')
    })

    it('resolves through the time limit when the images do not load', async () => {
        const content = await makeLoader({ imageTimeoutMs: 40 }).load(0)

        expect(content.body.querySelector('img')!.complete).toBe(false)
        expect(await settlesIn(content.imagesReady, 5)).toBe('pending')
        await expect(content.imagesReady).resolves.toBeUndefined()
    })

    it('resolves when each image fired load or error', async () => {
        const contentLoader = makeLoader({ imageTimeoutMs: 10_000 })
        const first = await contentLoader.load(0)
        const second = await contentLoader.load(1)

        first.body.querySelector('img')!.dispatchEvent(new Event('load'))
        second.body.querySelector('img')!.dispatchEvent(new Event('error'))

        expect(await settlesIn(first.imagesReady, 50)).toBe('ready')
        expect(await settlesIn(second.imagesReady, 50)).toBe('ready')
    })
})

describe('createContentLoader: data URL images', () => {
    const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='
    const book = () =>
        createFakeBook({
            files: {
                'ch.xhtml': chapter(
                    `<p>One <img id="data" src="${DATA_URL}" alt=""/></p>` +
                        `<svg xmlns="http://www.w3.org/2000/svg"><image href="${DATA_URL}"/></svg>`,
                ),
            },
            spine: ['ch.xhtml'],
        })

    it('keeps the data URL and makes no object URL', async () => {
        const content = await makeLoader({ book: book() }).load(0)

        expect(content.body.querySelector('img')!.getAttribute('src')).toBe(DATA_URL)
        expect(content.body.querySelector('image')!.getAttribute('href')).toBe(DATA_URL)
        expect(created.size).toBe(0)
    })

    it('waits for an image with a data URL', async () => {
        const content = await makeLoader({ book: book(), imageTimeoutMs: 10_000 }).load(0)

        expect(await settlesIn(content.imagesReady, 5)).toBe('pending')
        content.body.querySelector('img')!.dispatchEvent(new Event('load'))
        expect(await settlesIn(content.imagesReady, 50)).toBe('ready')
    })

    it('revokes nothing for a data URL when the loader is disposed', async () => {
        const contentLoader = makeLoader({ book: book() })
        await contentLoader.load(0)
        contentLoader.dispose()

        expect(revoked).toEqual([])
    })
})

describe('createContentLoader: prepare', () => {
    function installFontApi(): Set<{ family: string }> {
        class FakeFontFace {
            loaded = Promise.resolve(this)
            constructor(
                readonly family: string,
                readonly source: string,
                readonly descriptors: FontFaceDescriptors,
            ) {}
        }
        const fonts = new Set<FakeFontFace>()
        vi.stubGlobal('FontFace', FakeFontFace)
        Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
        return fonts
    }

    it('has no book fonts before prepare', () => {
        expect(makeLoader().bookFonts).toEqual([])
    })

    it('lists the font families sorted, with no quotes and no duplicates', async () => {
        const contentLoader = makeLoader()

        await contentLoader.prepare()

        expect(contentLoader.bookFonts).toEqual(['Alpha Sans', 'Zeta Serif'])
    })

    it('does not reject for a bad stylesheet and still loads the others', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const contentLoader = makeLoader({ book })

        await expect(contentLoader.prepare()).resolves.toBeUndefined()

        expect(readCount(readText, 'OEBPS/css/bad.css')).toBe(1)
        expect(contentLoader.bookFonts).toHaveLength(2)
    })

    it('registers each font face one time with document.fonts', async () => {
        const fonts = installFontApi()
        const contentLoader = makeLoader()

        await contentLoader.prepare()
        await contentLoader.prepare()

        // main.css imports fonts.css, and fonts.css is also a manifest item.
        expect([...fonts].map((face) => face.family).sort()).toEqual([
            'Alpha Sans',
            'Alpha Sans',
            'Zeta Serif',
        ])
    })

    it('uses the prepared sheets for the chapters', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const contentLoader = makeLoader({ book })

        await contentLoader.prepare()
        const content = await contentLoader.load(0)

        expect(content.styles).toHaveLength(2)
        expect(readCount(readText, 'OEBPS/css/main.css')).toBe(1)
    })

    it('registers the fonts of a stylesheet that load reads before prepare', async () => {
        const contentLoader = makeLoader()

        await contentLoader.load(0)

        expect(contentLoader.bookFonts).toEqual(['Alpha Sans', 'Zeta Serif'])
    })

    it('removes the fonts on dispose', async () => {
        const fonts = installFontApi()
        const contentLoader = makeLoader()
        await contentLoader.prepare()
        expect(fonts.size).toBe(3)

        contentLoader.dispose()

        expect(fonts.size).toBe(0)
        expect(contentLoader.bookFonts).toEqual([])
    })
})

describe('createContentLoader: loadText', () => {
    it('gives the text model of a cached chapter', async () => {
        const contentLoader = makeLoader()
        const content = await contentLoader.load(0)

        const model = await contentLoader.loadText(0)

        expect(model).toEqual(buildTextModel(content.body))
        expect(model.text).toBe('Chapter oneText with a link and .End here.')
        expect(model.blocks[0]).toEqual({ start: 0, end: 11, heading: true })
    })

    it('reads a chapter that is not cached and does not load its styles and images', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const readBlob = vi.spyOn(book, 'readBlob')
        const contentLoader = makeLoader({ book, cacheSize: 1 })
        const shown = await contentLoader.load(4)

        const model = await contentLoader.loadText(0)

        expect(model.text).toBe('Chapter oneText with a link and .End here.')
        expect(readBlob).not.toHaveBeenCalled()
        expect(readCount(readText, 'OEBPS/css/main.css')).toBe(0)
        expect(await contentLoader.load(4)).toBe(shown)
    })

    it('gives the same text as the loaded chapter', async () => {
        const contentLoader = makeLoader()

        const model = await contentLoader.loadText(1)
        const content = await contentLoader.load(1)

        expect(model).toEqual(buildTextModel(content.body))
        expect(model.text.length).toBe(content.length)
    })

    it('keeps a cache of three models', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const contentLoader = makeLoader({ book })

        const first = contentLoader.loadText(0)
        expect(contentLoader.loadText(0)).toBe(first)
        await contentLoader.loadText(1)
        await contentLoader.loadText(2)
        await contentLoader.loadText(0)
        await contentLoader.loadText(3)
        await contentLoader.loadText(0)
        expect(readCount(readText, 'OEBPS/text/ch1.xhtml')).toBe(1)

        await contentLoader.loadText(1)
        expect(readCount(readText, 'OEBPS/text/ch2.xhtml')).toBe(2)
    })

    it('rejects for a spine index that the book does not have', async () => {
        await expect(makeLoader().loadText(99)).rejects.toThrow(RangeError)
    })

    it('keeps the cached models when a call has a spine index that the book does not have', async () => {
        const book = makeBook()
        const readText = vi.spyOn(book, 'readText')
        const contentLoader = makeLoader({ book })
        await contentLoader.loadText(0)
        await contentLoader.loadText(1)
        await contentLoader.loadText(2)

        await expect(contentLoader.loadText(99)).rejects.toThrow(RangeError)
        await contentLoader.loadText(0)

        expect(readCount(readText, 'OEBPS/text/ch1.xhtml')).toBe(1)
    })

    it('gives an SVG image of the book as a data URL', async () => {
        const book = createFakeBook({
            files: {
                'ch.xhtml': chapter(
                    '<p><img src="art.svg" alt=""/></p><svg xmlns="http://www.w3.org/2000/svg">' +
                        '<image href="art.svg" width="1" height="1"/></svg>',
                ),
                'art.svg':
                    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            },
            spine: ['ch.xhtml'],
        })
        const contentLoader = makeLoader({ book })

        const content = await contentLoader.load(0)

        const urls = [
            content.body.querySelector('img')!.getAttribute('src'),
            content.body.querySelector('image')!.getAttribute('href'),
        ]
        for (const url of urls) expect(url).toMatch(/^data:image\/svg\+xml;base64,/)
        expect(created.size).toBe(0)
    })
})

describe('createContentLoader: dispose', () => {
    it('revokes all object URLs and rejects later calls', async () => {
        const contentLoader = makeLoader()
        await contentLoader.prepare()
        await contentLoader.load(0)
        await contentLoader.load(2)
        expect(created.size).toBeGreaterThan(0)
        expect(revoked).toEqual([])

        contentLoader.dispose()

        expect(revoked.sort()).toEqual([...created.keys()].sort())
        await expect(contentLoader.load(0)).rejects.toThrow('disposed')
        await expect(contentLoader.loadText(0)).rejects.toThrow('disposed')
        await expect(contentLoader.prepare()).resolves.toBeUndefined()
        expect(() => contentLoader.dispose()).not.toThrow()
    })

    it('revokes the URLs of a load that ends after dispose', async () => {
        const contentLoader = makeLoader()

        const pending = contentLoader.load(0)
        contentLoader.dispose()
        await pending.catch(() => {})
        await sleep(10)

        expect(revoked.sort()).toEqual([...created.keys()].sort())
    })
})
