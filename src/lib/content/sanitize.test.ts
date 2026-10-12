import { describe, expect, it } from 'vitest'
import { createFakeBook } from '$lib/epub/testing/fake-book'
import { sanitizeDocument } from './sanitize'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
const PATH = 'OEBPS/text/ch1.xhtml'

const book = createFakeBook({
    files: {
        'OEBPS/text/ch1.xhtml': '',
        'OEBPS/text/ch2.xhtml': '',
        'OEBPS/images/a.png': 'png',
        'OEBPS/images/b b.jpg': 'jpg',
        'OEBPS/css/main.css': '',
        'OEBPS/css/second.css': '',
        'OEBPS/css/night.css': '',
        'OEBPS/page-template.xpgt': '',
    },
    spine: ['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml'],
})

interface PageOptions {
    body: string
    head?: string
    htmlAttributes?: string
    bodyAttributes?: string
}

function page({ body, head = '', htmlAttributes = '', bodyAttributes = '' }: PageOptions): string {
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" ' +
        `xmlns:xlink="http://www.w3.org/1999/xlink" ${htmlAttributes}>` +
        `<head><title>Chapter</title>${head}</head><body ${bodyAttributes}>${body}</body></html>`
    )
}

function sanitize(options: PageOptions | string) {
    const xhtml = typeof options === 'string' ? options : page(options)
    return sanitizeDocument({ xhtml, path: PATH, book })
}

function bodyHtml(body: string): string {
    return sanitize({ body }).body.innerHTML
}

const FORBIDDEN_ELEMENTS = new Set(
    (
        'script style iframe frame frameset object embed applet form input button select ' +
        'textarea option link meta base template audio video source track canvas map area ' +
        'dialog noscript foreignobject animate animatetransform animatemotion set ' +
        'annotation-xml handler listener'
    ).split(' '),
)
const FORBIDDEN_ATTRIBUTES = new Set(
    (
        'srcset srcdoc action formaction poster background ping data style xlink:href ' +
        'lowsrc codebase manifest usemap target-x'
    ).split(' '),
)
const RASTER_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i
const PAINT_SERVERS = new Set(['linearGradient', 'radialGradient', 'pattern'])

/** The security rules of the module, for any tree that the sanitiser returns. */
function expectSafe(root: Element): void {
    for (const element of [root, ...root.querySelectorAll('*')]) {
        const name = element.localName
        expect(FORBIDDEN_ELEMENTS.has(name.toLowerCase()), `element ${name}`).toBe(false)
        expect(element.ownerDocument).toBe(document)
        if (element.namespaceURI === SVG_NS) expect(name).not.toBe('a')

        for (const attribute of element.attributes) {
            const attributeName = attribute.name.toLowerCase()
            const value = attribute.value
            const label = `${name} ${attribute.name}="${value}"`
            expect(attributeName.startsWith('on'), label).toBe(false)
            expect(FORBIDDEN_ATTRIBUTES.has(attributeName), label).toBe(false)
            expect(/(?:java|vb)script:/i.test(value.replace(/\s/g, '')), label).toBe(false)

            if (attributeName === 'src') {
                expect(name, label).toBe('img')
                expect(value, label).toMatch(RASTER_DATA_URL)
            } else if (attributeName === 'href') {
                if (name === 'a') expect(value, label).toMatch(/^(?:https?:\/\/|mailto:)/)
                else if (name === 'use' || PAINT_SERVERS.has(name))
                    expect(value, label).toMatch(/^#/)
                else if (name === 'image') expect(value, label).toMatch(RASTER_DATA_URL)
                else expect.fail(`href on ${label}`)
            } else if (attributeName !== 'data-rd-style') {
                expect(/(?:https?:)?\/\//i.test(value), label).toBe(false)
            }
        }
    }
}

describe('sanitizeDocument: structure', () => {
    it('makes rd-html and rd-body in the main document', () => {
        const { root, body } = sanitize({ body: '<p>Hello</p>' })

        expect(root.localName).toBe('rd-html')
        expect(body.localName).toBe('rd-body')
        expect(root.children).toHaveLength(1)
        expect(root.firstElementChild).toBe(body)
        expect(root.ownerDocument).toBe(document)
        expect(root.isConnected).toBe(false)
        expect(body.innerHTML).toBe('<p>Hello</p>')
    })

    it('copies lang, dir and class of the html element to rd-html', () => {
        const { root, lang, dir } = sanitize({
            body: '<p>x</p>',
            htmlAttributes: 'xml:lang="ar" dir="RTL" class="book" id="top" onclick="x()"',
        })

        expect(root.getAttribute('lang')).toBe('ar')
        expect(root.getAttribute('dir')).toBe('RTL')
        expect(root.getAttribute('class')).toBe('book')
        expect(root.getAttributeNames().sort()).toEqual(['class', 'dir', 'lang'])
        expect(lang).toBe('ar')
        expect(dir).toBe('rtl')
    })

    it('copies id, class, lang, dir and the style of the body element to rd-body', () => {
        const { body, lang, dir } = sanitize({
            body: '<p>x</p>',
            htmlAttributes: 'lang="en"',
            bodyAttributes:
                'id="b" class="chapter" lang="fr" dir="ltr" style="margin: 0" title="t" onload="x()"',
        })

        expect(body.id).toBe('b')
        expect(body.className).toBe('chapter')
        expect(body.getAttribute('data-rd-style')).toBe('margin: 0')
        expect(body.getAttributeNames().sort()).toEqual([
            'class',
            'data-rd-style',
            'dir',
            'id',
            'lang',
        ])
        expect(lang).toBe('fr')
        expect(dir).toBe('ltr')
    })

    it('gives null for a missing language and direction', () => {
        const { lang, dir } = sanitize({ body: '<p>x</p>', htmlAttributes: 'dir="sideways"' })

        expect(lang).toBeNull()
        expect(dir).toBeNull()
    })

    it('normalises the language of the document', () => {
        const cases: [string, string, string | null][] = [
            ['xml:lang="en_US"', '', 'en-US'],
            ['lang="ENG"', '', 'en'],
            ['lang="fr"', 'lang="DEU"', 'de'],
            ['lang="pt-BR"', 'xml:lang="und"', 'pt-BR'],
            ['lang="und"', 'lang="it"', 'it'],
            ['lang="und"', 'lang=""', null],
            ['lang="english"', '', null],
        ]

        for (const [htmlAttributes, bodyAttributes, expected] of cases) {
            const { root, body, lang } = sanitize({
                body: '<p>x</p>',
                htmlAttributes,
                bodyAttributes,
            })
            const label = `${htmlAttributes} ${bodyAttributes}`
            expect(lang, label).toBe(expected)
            // The element with the language has the normal form. A value that names no
            // language is not in the result.
            expect(body.getAttribute('lang') ?? root.getAttribute('lang'), label).toBe(expected)
            for (const element of [root, body]) {
                expect(['und', ''], label).not.toContain(element.getAttribute('lang'))
            }
        }
    })

    it('normalises the language of an element and keeps a value that names no language', () => {
        expect(
            bodyHtml(
                '<p lang="en_GB">a</p><p xml:lang="FRA">b</p><p lang="zxx">c</p><p lang="">d</p>' +
                    '<p lang="x-klingon">e</p>',
            ),
        ).toBe(
            '<p lang="en-GB">a</p><p lang="fr">b</p><p lang="zxx">c</p><p lang="">d</p>' +
                '<p lang="x-klingon">e</p>',
        )
    })

    it('keeps text of CDATA sections and drops comments', () => {
        expect(bodyHtml('<p>a<![CDATA[ <b> ]]><!-- note -->c</p>')).toBe('<p>a &lt;b&gt; c</p>')
    })
})

describe('sanitizeDocument: elements', () => {
    it('keeps the elements of the allow list', () => {
        const markup =
            '<section><h1>T</h1><p>a <em>b</em> <strong>c</strong> <i>d</i> <sub>e</sub></p>' +
            '<blockquote><cite>f</cite></blockquote><ul><li>g</li></ul>' +
            '<table><caption>h</caption><colgroup><col></colgroup><thead><tr><th>i</th></tr></thead>' +
            '<tbody><tr><td>j</td></tr></tbody></table>' +
            '<figure><figcaption>k</figcaption></figure><ruby>l<rp>(</rp><rt>m</rt><rp>)</rp></ruby>' +
            '<details><summary>n</summary>o</details><hr><pre><code>p</code></pre></section>'

        expect(bodyHtml(markup.replace('<col>', '<col/>').replace('<hr>', '<hr/>'))).toBe(markup)
    })

    it('removes the elements of the remove list with their content', () => {
        const removed = [
            '<script>alert(1)</script>',
            '<style>p { color: red }</style>',
            '<template><p>t</p></template>',
            '<iframe src="https://example.com/">x</iframe>',
            '<object data="a.swf"><p>fallback</p></object>',
            '<embed src="a.swf"/>',
            '<applet code="A">x</applet>',
            '<form action="https://example.com/"><p>form text</p><input name="q"/></form>',
            '<button>press</button>',
            '<select><option>one</option></select>',
            '<textarea>typed</textarea>',
            '<link rel="stylesheet" href="https://example.com/a.css"/>',
            '<meta http-equiv="refresh" content="0;url=https://example.com/"/>',
            '<base href="https://example.com/"/>',
            '<noscript><p>no script</p></noscript>',
            '<audio src="a.mp3">audio text</audio>',
            '<video poster="p.png"><source src="a.mp4"/><track src="a.vtt"/>video text</video>',
            '<canvas>canvas text</canvas>',
            '<map name="m"><area href="https://example.com/"/></map>',
            '<dialog open="open">dialog text</dialog>',
        ]

        for (const markup of removed) {
            const { root, body } = sanitize({ body: `<p>before</p>${markup}<p>after</p>` })
            expect(body.innerHTML, markup).toBe('<p>before</p><p>after</p>')
            expectSafe(root)
        }
    })

    it('keeps only the children of an element that is not in a list', () => {
        expect(bodyHtml('<p>a <blink>b <em>c</em></blink> <unknown-tag>d</unknown-tag></p>')).toBe(
            '<p>a b <em>c</em> d</p>',
        )
        expect(
            bodyHtml('<picture><source srcset="a.webp"/><img alt="A" src="x.png"/></picture>'),
        ).toBe('<img alt="A" decoding="async">')
    })

    it('uses the lower-case rules for upper-case names in an XML document', () => {
        const { root, body } = sanitize({
            body:
                '<P CLASS="x" ONCLICK="x()">upper</P><SCRIPT>alert(1)</SCRIPT>' +
                '<IMG SRC="https://example.com/a.png" ONERROR="alert(1)" ALT="A"/>' +
                '<A HREF="JAVASCRIPT:alert(1)">link</A>',
        })

        expect(body.innerHTML).toBe(
            '<p class="x">upper</p><img alt="A" decoding="async"><a>link</a>',
        )
        expectSafe(root)
    })

    it('shows only the default branch of epub:switch', () => {
        const markup =
            '<p>a</p><epub:switch id="s"><epub:case required-namespace="http://www.w3.org/1998/Math/MathML">' +
            '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></epub:case>' +
            '<epub:default><p>x as text</p></epub:default></epub:switch><p>b</p>'

        expect(bodyHtml(markup)).toBe('<p>a</p><p>x as text</p><p>b</p>')
        // The same markup in HTML mode. The `<br>` makes the XML parse fail.
        expect(sanitize(`<html><body><br>${markup}</body></html>`).body.innerHTML).toBe(
            '<br><p>a</p><p>x as text</p><p>b</p>',
        )
    })

    it('never adopts a node of the parsed document', () => {
        const { root } = sanitize({
            body: '<div><p>a</p><svg xmlns="http://www.w3.org/2000/svg"><g/></svg></div>',
        })

        for (const element of root.querySelectorAll('*')) {
            expect(element.ownerDocument).toBe(document)
        }
        expect(root.querySelector('p')).toBeInstanceOf(HTMLParagraphElement)
    })
})

describe('sanitizeDocument: attributes', () => {
    it('keeps the attributes of the allow list', () => {
        expect(
            bodyHtml(
                '<p id="a" class="b c" lang="de" dir="rtl" title="t" hidden="hidden" role="note" ' +
                    'aria-label="l" aria-hidden="true">x</p>',
            ),
        ).toBe(
            '<p id="a" class="b c" lang="de" dir="rtl" title="t" hidden="hidden" role="note" ' +
                'aria-label="l" aria-hidden="true">x</p>',
        )
        expect(
            bodyHtml(
                '<table border="1" cellpadding="2" cellspacing="3" width="100" align="center">' +
                    '<colgroup span="2"></colgroup><tbody><tr valign="top">' +
                    '<td colspan="2" rowspan="3" headers="h" scope="col" height="5">x</td>' +
                    '</tr></tbody></table>',
            ),
        ).toBe(
            '<table border="1" cellpadding="2" cellspacing="3" width="100" align="center">' +
                '<colgroup span="2"></colgroup><tbody><tr valign="top">' +
                '<td colspan="2" rowspan="3" headers="h" scope="col" height="5">x</td>' +
                '</tr></tbody></table>',
        )
        expect(bodyHtml('<p><time datetime="2020-01-01">day</time></p>')).toBe(
            '<p><time datetime="2020-01-01">day</time></p>',
        )
    })

    it('removes all other attributes', () => {
        expect(
            bodyHtml(
                '<p data-rd-path="x" data-rd-src="y" data-rd-skip="" data-x="1" tabindex="0" ' +
                    'contenteditable="true" draggable="true" accesskey="k" slot="s" is="x-y" ' +
                    'autofocus="autofocus" onclick="x()" onmouseover="x()" name="n">x</p>',
            ),
        ).toBe('<p>x</p>')
    })

    it('keeps type on ol only, value on li only, and font attributes on font only', () => {
        expect(
            bodyHtml(
                '<ol type="a" start="3" reversed="reversed"><li value="5" type="i">x</li></ol>',
            ),
        ).toBe('<ol type="a" start="3" reversed="reversed"><li value="5">x</li></ol>')
        expect(bodyHtml('<ul type="disc"><li>x</li></ul>')).toBe('<ul><li>x</li></ul>')
        expect(bodyHtml('<p value="1" size="2" color="red" face="Arial">x</p>')).toBe('<p>x</p>')
        expect(bodyHtml('<font size="2" color="red" face="Arial">x</font>')).toBe(
            '<font size="2" color="red" face="Arial">x</font>',
        )
    })

    it('copies xml:lang to lang and epub:type to data-epub-type', () => {
        expect(bodyHtml('<p xml:lang="ja">x</p>')).toBe('<p lang="ja">x</p>')
        expect(bodyHtml('<p xml:lang="ja" lang="en">x</p>')).toBe('<p lang="en">x</p>')
        expect(bodyHtml('<aside epub:type="footnote" id="n1">x</aside>')).toBe(
            '<aside data-epub-type="footnote" id="n1">x</aside>',
        )
    })

    it('keeps a style attribute with a property that only ends in behavior', () => {
        const safe = [
            'scroll-behavior: smooth',
            'overscroll-behavior: contain; color: red',
            'OVERSCROLL-BEHAVIOR-Y: none',
            'scroll-behavior/**/: smooth',
            'transition: scroll-behavior 1s',
            'will-change: behavior',
            '-ms-behavior: none',
            'margin: 0 /* behavior */',
        ]

        for (const style of safe) {
            const { body } = sanitize({ body: `<p style="${style}">x</p>` })
            expect(body.querySelector('p')!.getAttribute('data-rd-style'), style).toBe(style)
        }
    })

    it('finds a behavior declaration in the same way as a slow reference', () => {
        // The reference reads each comment again for each name, so it is only for short text.
        const reference = /(?:^|[^\w-])behavior(?:[ \t\n\r\f]|\/\*(?:(?!\*\/)[\s\S])*\*\/)*:/i
        const parts = ['behavior', 'BEHAVIOR', '/*', '*/', ' ', ':', ';', 'x', '-', '/', '*']
        let seed = 12345
        const random = (limit: number) => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff
            return seed % limit
        }

        for (let round = 0; round < 2000; round++) {
            let style = ''
            for (let count = 1 + random(24); count > 0; count--) {
                style += parts[random(parts.length)]
            }
            const { body } = sanitize({ body: `<p style="${style}">x</p>` })
            const kept = body.querySelector('p')!.hasAttribute('data-rd-style')
            expect(kept, style).toBe(!reference.test(style))
        }
    })

    it('reads a long style attribute with many comment starts in linear time', () => {
        const style = 'behavior/*'.repeat(50_000)
        const before = performance.now()
        const { body } = sanitize({ body: `<p style="${style}">x</p>` })

        expect(body.querySelector('p')!.getAttribute('data-rd-style')).toBe(style)
        expect(performance.now() - before).toBeLessThan(2000)
    })

    it('reads the text after a comment one time for all names before the comment', () => {
        // Each name has a comment start after it, and all comments end at the same mark.
        const style = ' behavior/*'.repeat(10_000) + '*/' + ' '.repeat(200_000) + 'x'
        const before = performance.now()
        const { body } = sanitize({ body: `<p style="${style}">x</p>` })

        expect(body.querySelector('p')!.getAttribute('data-rd-style')).toBe(style)
        expect(performance.now() - before).toBeLessThan(2000)
    })

    it('finds a behavior declaration after names that share one comment end', () => {
        const shared = ' behavior/*'.repeat(50) + '*/'
        const unsafe = [
            `${shared} x; behavior/* y */ : url(a.htc)`,
            `${shared} /* y */ : url(a.htc)`,
            `${shared}:url(a.htc)`,
        ]

        for (const style of unsafe) {
            const { body } = sanitize({ body: `<p style="${style}">x</p>` })
            expect(body.innerHTML, style).toBe('<p>x</p>')
        }
        const { body } = sanitize({ body: `<p style="${shared} x: 1">x</p>` })
        expect(body.querySelector('p')!.hasAttribute('data-rd-style')).toBe(true)
    })

    it('keeps a safe style attribute as data-rd-style and sets no real style', () => {
        const { body } = sanitize({ body: '<p style="color: red; margin-left: 2em">x</p>' })
        const p = body.querySelector('p')!

        expect(p.getAttribute('data-rd-style')).toBe('color: red; margin-left: 2em')
        expect(p.hasAttribute('style')).toBe(false)
    })

    it('removes an unsafe style attribute', () => {
        const unsafe = [
            'width: expression(alert(1))',
            'width: EXPRESSION(alert(1))',
            'background: url(javascript:alert(1))',
            'background: url(JaVaScRiPt:alert(1))',
            'behavior: url(a.htc)',
            'BEHAVIOR : url(a.htc)',
            'color: red;behavior:url(a.htc)',
            'color: red;&#10;&#9;behavior&#10;: url(a.htc)',
            'scroll-behavior: smooth; behavior: url(a.htc)',
            'be\\68 avior: url(a.htc)',
            '\\62 ehavior: url(a.htc)',
            'behavior/* x */: url(a.htc)',
            '/* x */behavior /* y */ /* z */: url(a.htc)',
            "content: '/*'; be\\68 avior/**/: url(a.htc); quotes: '*/'",
            "content: 'behavior/*'; behavior: url(a.htc)",
            '-moz-binding: url(a.xml#x)',
            '@import url(https://example.com/a.css)',
            '@IMPORT "a.css"',
            'width: e\\78pression(alert(1))',
            'width: exp/**/ression(alert(1))',
            'background: url(java\\73 cript:alert(1))',
            "content: '/*'; width: e\\78pression(alert(1)); quotes: '*/'",
        ]

        for (const style of unsafe) {
            const { body } = sanitize({ body: `<p style="${style}">x</p>` })
            expect(body.innerHTML, style).toBe('<p>x</p>')
        }
    })
})

describe('sanitizeDocument: links', () => {
    it('gives an internal link the path and fragment attributes and no href', () => {
        const { body } = sanitize({ body: '<p><a href="ch2.xhtml#note-1" id="l">note</a></p>' })
        const a = body.querySelector('a')!

        expect(a.outerHTML).toBe(
            '<a id="l" data-rd-path="OEBPS/text/ch2.xhtml" data-rd-fragment="note-1" role="link" ' +
                'tabindex="0">note</a>',
        )
    })

    it('leaves the fragment attribute out when the link has no fragment', () => {
        const a = sanitize({ body: '<a href="ch2.xhtml">next</a>' }).body.querySelector('a')!

        expect(a.getAttribute('data-rd-path')).toBe('OEBPS/text/ch2.xhtml')
        expect(a.hasAttribute('data-rd-fragment')).toBe(false)
        expect(a.hasAttribute('href')).toBe(false)
    })

    it('resolves a link that is only a fragment to the document itself', () => {
        const a = sanitize({ body: '<a href="#top">top</a>' }).body.querySelector('a')!

        expect(a.getAttribute('data-rd-path')).toBe(PATH)
        expect(a.getAttribute('data-rd-fragment')).toBe('top')
    })

    it('keeps web and mail links and opens them in a new context', () => {
        const { body } = sanitize({
            body:
                '<a href="https://example.com/a?b=1#c">web</a>' +
                '<a href="HTTP://Example.com">old</a>' +
                '<a href="mailto:reader@example.com">mail</a>',
        })
        const links = [...body.querySelectorAll('a')]

        expect(links.map((a) => a.getAttribute('href'))).toEqual([
            'https://example.com/a?b=1#c',
            'http://example.com/',
            'mailto:reader@example.com',
        ])
        for (const a of links) {
            expect(a.getAttribute('target')).toBe('_blank')
            expect(a.getAttribute('rel')).toBe('noopener noreferrer')
            expect(a.hasAttribute('data-rd-external')).toBe(true)
            expect(a.hasAttribute('data-rd-path')).toBe(false)
            expect(a.hasAttribute('role')).toBe(false)
        }
    })

    it('gives no href to a link with a different scheme', () => {
        const hrefs = [
            'javascript:alert(1)',
            '  javascript:alert(1)',
            'JaVaScRiPt:alert(1)',
            'java&#9;script:alert(1)',
            'java&#10;script:alert(1)',
            '&#1;javascript:alert(1)',
            'data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;',
            'vbscript:msgbox(1)',
            'file:///etc/passwd',
            'ftp://example.com/a',
            'blob:https://example.com/1234',
            'tel:+123',
        ]

        for (const href of hrefs) {
            const { root, body } = sanitize({ body: `<a href="${href}" class="x">link</a>` })
            const a = body.querySelector('a')!
            expect(a.getAttributeNames(), href).toEqual(['class'])
            expect(a.textContent).toBe('link')
            expectSafe(root)
        }
    })

    it('does not throw for a bad percent escape', () => {
        const a = sanitize({ body: '<a href="ch%ZZ.xhtml">x</a>' }).body.querySelector('a')!

        expect(a.outerHTML).toBe('<a>x</a>')
    })

    it('keeps a link target that has no href', () => {
        expect(bodyHtml('<p><a id="p12" name="page12"></a>text</p>')).toBe(
            '<p><a id="p12" name="page12"></a>text</p>',
        )
    })
})

describe('sanitizeDocument: images', () => {
    it('puts the path of a book image in data-rd-src and sets no src', () => {
        const { body, images } = sanitize({
            body: '<img src="../images/a.png" alt="A" width="10" height="20" class="pic"/>',
        })
        const img = body.querySelector('img')!

        expect(img.outerHTML).toBe(
            '<img alt="A" width="10" height="20" class="pic" decoding="async" ' +
                'data-rd-src="OEBPS/images/a.png">',
        )
        expect(images).toEqual([img])
    })

    it('decodes a percent escape in the path', () => {
        const { images } = sanitize({ body: '<img src="../images/b%20b.jpg" alt=""/>' })

        expect(images[0].getAttribute('data-rd-src')).toBe('OEBPS/images/b b.jpg')
    })

    it('sets no source for a remote image, an unsafe data URL or a missing file', () => {
        const sources = [
            'https://example.com/a.png',
            '//example.com/a.png',
            'data:image/svg+xml,&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot;/&gt;',
            'data:image/svg+xml;base64,PHN2Zy8+',
            'DATA:IMAGE/SVG+XML,x',
            'data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;',
            'data:image/pngx;base64,AAAA',
            'data:image/png',
            'data:,AAAA',
            'data:;base64,AAAA',
            'x data:image/png;base64,AAAA',
            '../images/missing.png',
            'javascript:alert(1)',
            '',
        ]

        for (const src of sources) {
            const { root, body, images } = sanitize({ body: `<img src="${src}" alt="Alt text"/>` })
            expect(body.innerHTML, src).toBe('<img alt="Alt text" decoding="async">')
            expect(images).toEqual([])
            expectSafe(root)
        }
    })

    it('keeps a data URL of a raster image and adds the element to the images', () => {
        const urls = [
            'data:image/png;base64,iVBORw0KGgo=',
            'data:image/jpeg;base64,/9j/4AAQ//Z',
            'data:image/jpg;base64,/9j/4AAQ',
            'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
            'data:image/webp;base64,UklGRg==',
            'DATA:IMAGE/PNG;BASE64,AAAA',
            'data:image/gif,GIF89a',
            'data:image/png;charset=utf-8;base64,AAAA',
        ]

        for (const url of urls) {
            const { root, body, images } = sanitize({ body: `<img src="${url}" alt="A"/>` })
            const img = body.querySelector('img')!
            expect(img.getAttribute('src'), url).toBe(url)
            expect(img.hasAttribute('data-rd-src')).toBe(false)
            expect(images).toEqual([img])
            expectSafe(root)
        }
    })

    it('removes white space before a data URL', () => {
        const { body } = sanitize({
            body: '<img src=" &#10;&#9;data:image/png;base64,AAAA" alt=""/>',
        })

        expect(body.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    })

    it('sets no source for a data URL above 2 MB', () => {
        const start = 'data:image/png;base64,'
        const limit = 2 * 1024 * 1024
        const atLimit = start + 'A'.repeat(limit - start.length)

        const kept = sanitize({ body: `<img src="${atLimit}" alt=""/>` })
        const removed = sanitize({ body: `<img src="${atLimit}A" alt=""/>` })

        expect(kept.body.querySelector('img')!.getAttribute('src')).toHaveLength(limit)
        expect(kept.images).toHaveLength(1)
        expect(removed.body.innerHTML).toBe('<img alt="" decoding="async">')
        expect(removed.images).toEqual([])
    })

    it('removes srcset and other loading attributes', () => {
        const { root, body } = sanitize({
            body:
                '<img src="../images/a.png" srcset="https://example.com/a.png 2x" ' +
                'lowsrc="https://example.com/l.png" usemap="#m" loading="lazy" alt=""/>',
        })

        expect(body.innerHTML).toBe(
            '<img alt="" decoding="async" data-rd-src="OEBPS/images/a.png">',
        )
        expectSafe(root)
    })
})

describe('sanitizeDocument: SVG and MathML', () => {
    it('keeps the SVG elements and attributes of the allow list', () => {
        const { root, body } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="100" ' +
                'height="100" preserveAspectRatio="xMidYMid meet" id="s" class="c">' +
                '<title>Title</title><desc>Desc</desc>' +
                '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="1">' +
                '<stop offset="0" stop-color="red" stop-opacity="0.5"/></linearGradient>' +
                '<clipPath id="c"><rect x="0" y="0" width="5" height="5"/></clipPath></defs>' +
                '<g transform="translate(1 2)" fill="url(#g)" clip-path="url(#c)" opacity="0.5">' +
                '<path d="M0 0L1 1" stroke="black" stroke-width="2"/>' +
                '<circle cx="1" cy="2" r="3"/><ellipse rx="1" ry="2"/>' +
                '<line x1="0" y1="0" x2="1" y2="1"/><polyline points="0,0 1,1"/>' +
                '<polygon points="0,0 1,1 1,0"/>' +
                '<text x="1" y="2" font-size="3" text-anchor="middle"><tspan dx="1">T</tspan></text>' +
                '</g></svg>',
        })
        const svg = body.querySelector('svg')!

        expect(svg.namespaceURI).toBe(SVG_NS)
        expect(svg.getAttribute('viewBox')).toBe('0 0 10 10')
        expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
        expect(svg.hasAttribute('xmlns')).toBe(false)
        expect([...svg.querySelectorAll('*')].map((element) => element.localName)).toEqual([
            'title',
            'desc',
            'defs',
            'linearGradient',
            'stop',
            'clipPath',
            'rect',
            'g',
            'path',
            'circle',
            'ellipse',
            'line',
            'polyline',
            'polygon',
            'text',
            'tspan',
        ])
        expect(svg.querySelector('linearGradient')!.getAttribute('gradientUnits')).toBe(
            'userSpaceOnUse',
        )
        expect(svg.querySelector('g')!.getAttribute('fill')).toBe('url(#g)')
        expect(svg.querySelector('g')!.getAttribute('clip-path')).toBe('url(#c)')
        expect(svg.querySelector('path')!.getAttribute('d')).toBe('M0 0L1 1')
        expect(svg.querySelector('title')!.textContent).toBe('Title')
        expectSafe(root)
    })

    it('removes all other SVG elements with their content', () => {
        const dangerous = [
            '<script>alert(1)</script>',
            '<script xlink:href="https://example.com/a.js"/>',
            '<foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://example.com/"/></foreignObject>',
            '<foreignObject><p xmlns="http://www.w3.org/1999/xhtml">inner</p></foreignObject>',
            '<animate attributeName="href" values="javascript:alert(1)"/>',
            '<set attributeName="onmouseover" to="alert(1)"/>',
            '<animateTransform attributeName="transform" type="rotate"/>',
            '<a xlink:href="javascript:alert(1)"><text>click</text></a>',
            '<a href="https://example.com/"><rect width="1" height="1"/></a>',
            '<style>@import url(https://example.com/a.css);</style>',
            '<handler>alert(1)</handler>',
            '<feImage xlink:href="https://example.com/a.png"/>',
            '<SCRIPT>alert(1)</SCRIPT>',
        ]

        for (const markup of dangerous) {
            const { root, body } = sanitize({
                body: `<svg xmlns="http://www.w3.org/2000/svg"><g>${markup}<rect width="1" height="1"/></g></svg>`,
            })
            expect(body.innerHTML, markup).toBe(
                '<svg><g><rect width="1" height="1"></rect></g></svg>',
            )
            expectSafe(root)
        }
    })

    it('removes a script in nested SVG elements', () => {
        const { root, body } = sanitize({
            body:
                '<div><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><g><svg><defs>' +
                '<script>alert(1)</script></defs><g onclick="alert(2)"><script>alert(3)</script>' +
                '</g></svg></g></svg></div>',
        })

        expect(body.innerHTML).toBe('<div><svg><g><svg><defs></defs><g></g></svg></g></svg></div>')
        expectSafe(root)
    })

    it('keeps use only when its href points into the document', () => {
        const { root, body } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg">' +
                '<use xlink:href="#shape" x="1"/>' +
                '<use href=" #other"/>' +
                '<use xlink:href="https://example.com/a.svg#shape"/>' +
                '<use href="other.svg#shape"/>' +
                '<use href="data:image/svg+xml,&lt;svg id=\'x\'/&gt;#x"/>' +
                '<use href="https://example.com/a.svg#x" xlink:href="#shape"/>' +
                '<use/></svg>',
        })
        const uses = [...body.querySelectorAll('use')]

        expect(uses).toHaveLength(2)
        expect(uses[0].getAttribute('href')).toBe('#shape')
        expect(uses[0].getAttribute('x')).toBe('1')
        expect(uses[1].getAttribute('href')).toBe('#other')
        expectSafe(root)
    })

    it('resolves the href of an SVG image and sets no href', () => {
        const { root, body, images } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">' +
                '<image xlink:href="../images/a.png" width="600" height="800"/>' +
                '<image href="../images/b%20b.jpg"/>' +
                '<image xlink:href="https://example.com/a.png"/>' +
                '<image href="../images/missing.png"/></svg>',
        })
        const found = [...body.querySelectorAll('image')]

        expect(found.map((image) => image.getAttribute('data-rd-src'))).toEqual([
            'OEBPS/images/a.png',
            'OEBPS/images/b b.jpg',
            null,
            null,
        ])
        expect(images).toEqual(found.slice(0, 2))
        expect(found[0].getAttribute('width')).toBe('600')
        for (const image of found) expect(image.hasAttribute('href')).toBe(false)
        expectSafe(root)
    })

    it('keeps a data URL of a raster image in an SVG image', () => {
        const { root, body, images } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg">' +
                '<image xlink:href="data:image/png;base64,AAAA" width="6" height="8"/>' +
                '<image href="data:image/jpeg;base64,/9j/"/>' +
                '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>' +
                '<image xlink:href="data:text/html,x"/></svg>',
        })
        const found = [...body.querySelectorAll('image')]

        expect(found.map((image) => image.getAttribute('href'))).toEqual([
            'data:image/png;base64,AAAA',
            'data:image/jpeg;base64,/9j/',
            null,
            null,
        ])
        expect(images).toEqual(found.slice(0, 2))
        for (const image of found) expect(image.hasAttribute('data-rd-src')).toBe(false)
        expectSafe(root)
    })

    it('keeps more presentation attributes of SVG', () => {
        const { root, body } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg">' +
                '<pattern id="p" patternUnits="userSpaceOnUse" patternContentUnits="objectBoundingBox" ' +
                'patternTransform="rotate(45)" width="4" height="4"/>' +
                '<radialGradient id="r" fx="0.2" fy="0.3" spreadMethod="reflect"/>' +
                '<path d="M0 0L1 1" stroke-miterlimit="4" stroke-dashoffset="2" ' +
                'vector-effect="non-scaling-stroke" marker-start="url(#m)" marker-mid="url(#m)" ' +
                'marker-end="url(#m)"/>' +
                '<text text-decoration="underline" letter-spacing="2" dominant-baseline="middle" ' +
                'alignment-baseline="central">T</text></svg>',
        })
        const names = (selector: string) => body.querySelector(selector)!.getAttributeNames().sort()

        expect(names('pattern')).toEqual([
            'height',
            'id',
            'patternContentUnits',
            'patternTransform',
            'patternUnits',
            'width',
        ])
        expect(names('radialGradient')).toEqual(['fx', 'fy', 'id', 'spreadMethod'])
        expect(names('path')).toEqual([
            'd',
            'marker-end',
            'marker-mid',
            'marker-start',
            'stroke-dashoffset',
            'stroke-miterlimit',
            'vector-effect',
        ])
        expect(names('text')).toEqual([
            'alignment-baseline',
            'dominant-baseline',
            'letter-spacing',
            'text-decoration',
        ])
        expectSafe(root)
    })

    it('keeps a marker attribute only when it points into the document', () => {
        const { root, body } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg">' +
                '<path marker-start="url(#m)" marker-mid="url(https://example.com/a.svg#m)" ' +
                'marker-end="url(other.svg#m)"/><line marker-end="none"/></svg>',
        })

        expect(body.querySelector('path')!.getAttributeNames()).toEqual(['marker-start'])
        expect(body.querySelector('line')!.getAttribute('marker-end')).toBe('none')
        expectSafe(root)
    })

    it('keeps the marker element that a marker attribute points to', () => {
        const { root, body } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
                '<marker id="m" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" ' +
                'markerHeight="6" markerUnits="strokeWidth" orient="auto-start-reverse" ' +
                'onload="alert(1)" xlink:href="https://example.com/a.svg#m">' +
                '<path d="M0 0L10 5L0 10z"/><script>alert(1)</script></marker></defs>' +
                '<line x1="0" y1="0" x2="9" y2="9" marker-end="url(#m)"/></svg>',
        })
        const marker = body.querySelector('marker')!

        expect(marker.namespaceURI).toBe(SVG_NS)
        expect(marker.getAttributeNames().sort()).toEqual([
            'id',
            'markerHeight',
            'markerUnits',
            'markerWidth',
            'orient',
            'refX',
            'refY',
            'viewBox',
        ])
        expect(marker.innerHTML).toBe('<path d="M0 0L10 5L0 10z"></path>')
        expect(body.querySelector('line')!.getAttribute('marker-end')).toBe('url(#m)')
        expectSafe(root)
    })

    it('keeps the href of a gradient or pattern only when it points into the document', () => {
        const { root, body } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg">' +
                '<linearGradient id="a" xlink:href="#base"/>' +
                '<radialGradient id="b" href=" #base"/>' +
                '<pattern id="c" xlink:href="#tile"/>' +
                '<linearGradient id="d" xlink:href="https://example.com/a.svg#base" x1="0"/>' +
                '<radialGradient id="e" href="other.svg#base"/>' +
                '<pattern id="f" href="data:image/svg+xml,x#tile"/>' +
                '<linearGradient id="g" href="javascript:alert(1)"/>' +
                '<stop href="#base"/><rect xlink:href="#base"/></svg>',
        })
        const href = (id: string) => body.querySelector(`#${id}`)!.getAttribute('href')

        expect([href('a'), href('b'), href('c')]).toEqual(['#base', '#base', '#tile'])
        // The element stays and uses its own content.
        expect([href('d'), href('e'), href('f'), href('g')]).toEqual([null, null, null, null])
        expect(body.querySelector('#d')!.getAttribute('x1')).toBe('0')
        expect(body.querySelector('stop')!.hasAttribute('href')).toBe(false)
        expect(body.querySelector('rect')!.hasAttribute('href')).toBe(false)
        expectSafe(root)
    })

    it('removes an SVG attribute that has a URL outside the document', () => {
        const { root, body } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg">' +
                '<rect fill="url(https://example.com/a.svg#g)" stroke="url( \'other.svg#g\' )" ' +
                'mask="url(#m)" clip-path="\\75rl(https://example.com/a.svg#c)" width="1"/></svg>',
        })
        const rect = body.querySelector('rect')!

        expect(rect.getAttributeNames().sort()).toEqual(['mask', 'width'])
        expectSafe(root)
    })

    it('removes an SVG attribute that has a function that is not in the allow list', () => {
        const { root, body } = sanitize({
            body:
                '<svg xmlns="http://www.w3.org/2000/svg">' +
                '<rect mask="image-set(\'https://example.com/t.png\' 1x)" ' +
                'fill="RGB(1, 2, 3)" transform="rotate(10)translate(1, 2) skewX(3)" ' +
                'clip-path="url(#c)" stroke="image(\'https://example.com/t.png\')" ' +
                'stop-color="hsla(1, 2%, 3%, 0.5)" opacity="(https://example.com/a.png)" ' +
                'stroke-opacity="\u00e9url(https://example.com/a.svg#b)" ' +
                'fill-opacity="url(#a) cross-fade(url(#b), url(#c))"/></svg>',
        })
        const rect = body.querySelector('rect')!

        expect(rect.getAttributeNames().sort()).toEqual([
            'clip-path',
            'fill',
            'stop-color',
            'transform',
        ])
        expectSafe(root)
    })

    it('keeps MathML and removes annotation-xml and link attributes', () => {
        const { root, body } = sanitize({
            body:
                '<p><math xmlns="http://www.w3.org/1998/Math/MathML" display="block" ' +
                'xlink:href="https://example.com/" href="javascript:alert(1)" onclick="x()">' +
                '<semantics><mrow><mi mathvariant="bold" href="https://example.com/">x</mi>' +
                '<mo>=</mo><mfrac linethickness="2"><mn>1</mn><mn>2</mn></mfrac></mrow>' +
                '<annotation encoding="application/x-tex">x = 1/2</annotation>' +
                '<annotation-xml encoding="text/html"><script xmlns="http://www.w3.org/1999/xhtml">' +
                'alert(1)</script></annotation-xml></semantics>' +
                '<maction actiontype="statusline#https://example.com/"><mi>a</mi></maction>' +
                '<mglyph src="https://example.com/a.png" alt="g"/></math></p>',
        })
        const math = body.querySelector('math')!

        expect(math.namespaceURI).toBe(MATHML_NS)
        expect(math.getAttributeNames()).toEqual(['display'])
        expect(math.querySelector('mi')!.getAttributeNames()).toEqual(['mathvariant'])
        expect(math.querySelector('mfrac')!.getAttribute('linethickness')).toBe('2')
        expect(math.querySelector('annotation-xml')).toBeNull()
        expect(math.querySelector('annotation')!.textContent).toBe('x = 1/2')
        expect(math.querySelector('maction')!.getAttributeNames()).toEqual([])
        expect(math.querySelector('mglyph')!.getAttributeNames()).toEqual([])
        expectSafe(root)
    })
})

describe('sanitizeDocument: stylesheets', () => {
    it('lists linked and inline stylesheets in document order', () => {
        const { styleSources } = sanitize({
            head:
                '<link rel="stylesheet" type="text/css" href="../css/main.css"/>' +
                '<style type="text/css">p { margin: 0 }</style>' +
                '<link href="../css/second.css" rel="STYLESHEET"/>',
            body: '<style>h1 { color: red }</style><p>x</p>',
        })

        expect(styleSources).toEqual([
            { kind: 'link', path: 'OEBPS/css/main.css' },
            { kind: 'inline', css: 'p { margin: 0 }' },
            { kind: 'link', path: 'OEBPS/css/second.css' },
            { kind: 'inline', css: 'h1 { color: red }' },
        ])
    })

    it('skips alternate, remote, missing and not-CSS stylesheet links', () => {
        const { styleSources } = sanitize({
            head:
                '<link rel="alternate stylesheet" href="../css/night.css"/>' +
                '<link rel="stylesheet" href="https://example.com/a.css"/>' +
                '<link rel="stylesheet" href="../css/missing.css"/>' +
                '<link rel="icon" href="../images/a.png"/>' +
                '<link rel="stylesheet" type="application/vnd.adobe-page-template+xml" ' +
                'href="../page-template.xpgt"/>',
            body: '<p>x</p>',
        })

        expect(styleSources).toEqual([])
    })

    it('reads CSS that is in a comment or a CDATA section', () => {
        const { styleSources } = sanitize({
            head:
                '<style><!-- p { color: red } --></style>' +
                '<style>/*<![CDATA[*/ b { color: blue } /*]]>*/</style>',
            body: '<p>x</p>',
        })

        expect(styleSources).toHaveLength(2)
        expect((styleSources[0] as { css: string }).css).toContain('p { color: red }')
        expect((styleSources[1] as { css: string }).css).toContain('b { color: blue }')
    })

    it('keeps the media query of a stylesheet', () => {
        const { styleSources } = sanitize({
            head:
                '<link rel="stylesheet" href="../css/main.css" media="all"/>' +
                '<link rel="stylesheet" href="../css/second.css" media="amzn-mobi"/>' +
                '<link rel="stylesheet" href="../css/night.css" media="screen { } * { color: red"/>' +
                '<style media="print">p { margin: 0 }</style>',
            body: '<p>x</p>',
        })

        expect(styleSources).toEqual([
            { kind: 'link', path: 'OEBPS/css/main.css' },
            { kind: 'link', path: 'OEBPS/css/second.css', media: 'amzn-mobi' },
            { kind: 'inline', css: '@media print {\np { margin: 0 }\n}' },
        ])
    })
})

describe('sanitizeDocument: HTML fallback', () => {
    it('parses malformed XML as HTML', () => {
        const { body } = sanitize(
            '<html><head><title>T</title></head><body><p>one<br>two&nbsp;three</p>' +
                '<p>unclosed<p>next</body></html>',
        )

        expect(body.querySelectorAll('p')).toHaveLength(3)
        expect(body.querySelector('br')).not.toBeNull()
        expect(body.textContent).toBe('onetwo\u00a0threeunclosednext')
    })

    it('parses a document with no XHTML namespace as HTML', () => {
        const { body } = sanitize('<html><body><p class="a">text</p></body></html>')

        expect(body.innerHTML).toBe('<p class="a">text</p>')
    })

    it('keeps the chapter text when the title element is self-closed', () => {
        // The undefined entity makes the XML parse fail, so the HTML parser reads the file.
        const { body } = sanitize(
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title/>' +
                '<link rel="stylesheet" href="../css/main.css"/></head>' +
                '<body><h1>Heading</h1><p>First&nbsp;paragraph.</p></body></html>',
        )

        expect(body.innerHTML).toBe('<h1>Heading</h1><p>First&nbsp;paragraph.</p>')
    })

    it('keeps the chapter text when the title element is self-closed in valid XHTML', () => {
        const { body, styleSources } = sanitize(
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title/>' +
                '<link rel="stylesheet" href="../css/main.css"/></head>' +
                '<body><h1>Heading</h1><p>First paragraph.</p></body></html>',
        )

        expect(body.innerHTML).toBe('<h1>Heading</h1><p>First paragraph.</p>')
        expect(styleSources).toEqual([{ kind: 'link', path: 'OEBPS/css/main.css' }])
    })

    it('keeps the text after other self-closed elements in HTML mode', () => {
        const { root, body } = sanitize(
            '<html><body><p>a&nbsp;b</p><script src="a.js"/><p><a id="n1"/>after anchor</p>' +
                '<div class="pagebreak"/><p>last <span class="x" title="a > b"/>text</p>' +
                '<textarea/><p>end</p><iframe src="https://example.com/"/><p>tail</p></body></html>',
        )

        expect(body.innerHTML).toBe(
            '<p>a&nbsp;b</p><p><a id="n1"></a>after anchor</p><div class="pagebreak"></div>' +
                '<p>last <span class="x" title="a > b"></span>text</p><p>end</p><p>tail</p>',
        )
        expectSafe(root)
    })

    it('keeps an unquoted attribute value that ends with a slash in HTML mode', () => {
        const { body } = sanitize(
            '<html><body><p>See <a href=https://example.com/>the site</a> and ' +
                '<a class=note href=ch2.xhtml#n1 />the note.<br>end</p></body></html>',
        )
        const [external, internal] = body.querySelectorAll('a')

        expect(external.getAttribute('href')).toBe('https://example.com/')
        expect(external.textContent).toBe('the site')
        // White space before the slash makes the tag self-closed.
        expect(internal.getAttribute('data-rd-path')).toBe('OEBPS/text/ch2.xhtml')
        expect(internal.textContent).toBe('')
        expect(body.textContent).toBe('See the site and the note.end')
    })

    it('reads the stylesheets and the body attributes in HTML mode', () => {
        const { body, lang, styleSources } = sanitize(
            '<html xml:lang="pt"><head><link rel=stylesheet href="../css/main.css"><style>p{}</style>' +
                '</head><body class=main epub:type="bodymatter"><p epub:type="pagebreak">x</body></html>',
        )

        expect(lang).toBe('pt')
        expect(body.className).toBe('main')
        expect(body.getAttribute('data-epub-type')).toBe('bodymatter')
        expect(body.innerHTML).toBe('<p data-epub-type="pagebreak">x</p>')
        expect(styleSources).toEqual([
            { kind: 'link', path: 'OEBPS/css/main.css' },
            { kind: 'inline', css: 'p{}' },
        ])
    })

    it('reads a file with a byte order mark', () => {
        expect(sanitize(`\ufeff${page({ body: '<p>x</p>' })}`).body.innerHTML).toBe('<p>x</p>')
    })

    it('returns an empty body for an empty file', () => {
        const { body, images, styleSources } = sanitize('')

        expect(body.childNodes).toHaveLength(0)
        expect(images).toEqual([])
        expect(styleSources).toEqual([])
    })
})

describe('sanitizeDocument: attacks', () => {
    const attacks: Record<string, string> = {
        'upper-case script in HTML mode':
            '<p>a<br><SCRIPT>alert(1)</SCRIPT><ScRiPt SRC=//example.com/a.js></ScRiPt>',
        'upper-case handler in HTML mode':
            '<p>a<br><IMG SRC=x ONERROR=alert(1)><P ONCLICK=alert(1) OnMouseOver=alert(2)>b',
        'image error handler': '<img src="x" onerror="alert(1)" onload="alert(2)"/>',
        'body child handlers':
            '<details open="open" ontoggle="alert(1)"><summary onfocus="alert(1)">s</summary></details>',
        'svg onload':
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><g onfocusin="alert(1)"/></svg>',
        'svg script with CDATA':
            '<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[alert(1)]]></script></svg>',
        'svg script in HTML mode':
            '<p>a<br><svg><script>alert(1)</script><g><script href=//example.com/a.js></script></g></svg>',
        'svg foreignObject in HTML mode':
            '<p>a<br><svg><foreignObject><iframe src=//example.com></iframe><form action=//example.com><input></form></foreignObject></svg>',
        'svg use with a remote href':
            '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://example.com/a.svg#x"/><use href="//example.com/a.svg#x"/></svg>',
        'svg use in HTML mode':
            '<p>a<br><svg><use xlink:href="https://example.com/a.svg#x"></use><use href="javascript:alert(1)"></use></svg>',
        'svg animation of href':
            '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
        'svg image-set in a presentation attribute':
            '<svg xmlns="http://www.w3.org/2000/svg"><rect mask="image-set(\'https://example.com/t.png\' 1x)" fill="IMAGE-SET(&quot;//example.com/a.png&quot; 1x)" stroke="-webkit-image-set(url(#a) 1x, \'//example.com/b.png\' 2x)"/></svg>',
        'svg image with a script URL':
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="javascript:alert(1)" xlink:href="https://example.com/a.png"/></svg>',
        'math link':
            '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi xlink:href="javascript:alert(1)">x</mi><maction actiontype="statusline" href="javascript:alert(1)">y</maction></math>',
        'math annotation-xml in HTML mode':
            '<p>a<br><math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)><script>alert(1)</script></annotation-xml></math>',
        'script link with white space':
            '<a href=" &#9;java&#10;script&#13;:alert(1)">x</a><a href="&#14;javascript:alert(1)">y</a>',
        'script link with mixed case':
            '<a href="JaVaScRiPt:alert(1)">x</a><a HREF="JAVASCRIPT:alert(1)">y</a>',
        'script link with entities':
            '<a href="&#106;&#97;vascript:alert(1)">x</a><a href="javascript&#58;alert(1)">y</a>',
        'data link': '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
        'style attributes':
            '<p style="background: url(javascript:alert(1))">a</p><p style="width: expression(alert(1))">b</p><p style="-moz-binding: url(//example.com/a.xml#x)">c</p><p STYLE="behavior: url(a.htc)">d</p>',
        'form controls':
            '<form action="https://example.com/" method="post"><input type="text" name="a"/><button formaction="https://example.com/">go</button><select><option>a</option></select><textarea>t</textarea></form>',
        'frames and plugins':
            '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"/><object data="https://example.com/a.swf"/><embed src="https://example.com/a.swf"/><applet code="A"/>',
        'meta and base':
            '<meta http-equiv="refresh" content="0;url=https://example.com/"/><base href="https://example.com/"/><link rel="stylesheet" href="https://example.com/a.css"/><link rel="prefetch" href="https://example.com/"/>',
        'media elements':
            '<video src="https://example.com/a.mp4" poster="https://example.com/p.png" autoplay="autoplay"><source src="https://example.com/a.mp4"/><track src="https://example.com/a.vtt"/></video><audio src="https://example.com/a.mp3"/>',
        'remote images':
            '<img src="https://example.com/track.gif" alt=""/><img srcset="https://example.com/a.png 1x" alt=""/><picture><source srcset="https://example.com/a.webp"/><img src="//example.com/a.png" alt=""/></picture>',
        'table background':
            '<table background="https://example.com/a.png"><tbody><tr><td background="https://example.com/b.png">x</td></tr></tbody></table>',
        'forged reader attributes':
            '<a data-rd-path="x" data-rd-external="" target="_top" ping="https://example.com/">x</a><img data-rd-src="OEBPS/images/a.png" alt=""/>',
        'template and noscript':
            '<template><script>alert(1)</script></template><noscript><img src="https://example.com/a.png" alt=""/></noscript>',
        'unknown elements with handlers':
            '<marquee onstart="alert(1)" behavior="alternate">m</marquee><xss onpointerover="alert(1)" style="display: block">x</xss>',
        'custom element names':
            '<rd-html onclick="x()"><rd-body><script>alert(1)</script>x</rd-body></rd-html><my-element is="x-y" onclick="x()">c</my-element>',
        'elements in an unknown namespace':
            '<x:script xmlns:x="urn:x">alert(1)</x:script><x:a xmlns:x="urn:x" href="javascript:alert(1)">t</x:a>',
    }

    for (const [name, markup] of Object.entries(attacks)) {
        it(`makes a safe tree: ${name}`, () => {
            const { root, body, images } = sanitize({ body: `<div>${markup}</div><p>after</p>` })

            expectSafe(root)
            expect(body.lastElementChild?.outerHTML).toBe('<p>after</p>')
            for (const image of images) {
                expect(book.has(image.getAttribute('data-rd-src') ?? '')).toBe(true)
            }
        })
    }

    it('gives the forged reader attributes no effect', () => {
        const { body, images } = sanitize({
            body:
                '<a data-rd-path="x" data-rd-fragment="y" data-rd-external="" role="link">x</a>' +
                '<img data-rd-src="OEBPS/images/a.png" alt=""/><span data-rd-skip="">s</span>',
        })

        expect(body.innerHTML).toBe(
            '<a role="link">x</a><img alt="" decoding="async"><span>s</span>',
        )
        expect(images).toEqual([])
    })

    it('does not show the script text of an unknown namespace', () => {
        const { body } = sanitize({
            body: '<p>a<x:script xmlns:x="urn:x">alert(1)</x:script><x:b xmlns:x="urn:x">b</x:b></p>',
        })

        expect(body.innerHTML).toBe('<p>ab</p>')
    })
})
