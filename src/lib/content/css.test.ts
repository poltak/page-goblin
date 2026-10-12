import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeBook } from '$lib/epub/testing/fake-book'
import {
    buildSheet,
    findImports,
    fixDeclarations,
    isLocalCssValue,
    isSafeMediaQuery,
    loadStylesheetText,
    registerFontFaces,
    resolveCssText,
    resolveCssUrls,
    rewriteCssUrls,
    rewriteSelector,
    scaleFontSize,
    scaleLineHeight,
    unregisterFontFaces,
    type FontFaceSpec,
} from './css'
import type { ResourceStore } from './resources'

/** A store with URLs that a test can predict. */
function fakeResources(): ResourceStore & { acquired: string[] } {
    const acquired: string[] = []
    return {
        acquired,
        acquire: async (path) => {
            acquired.push(path)
            return `blob:test/${path}`
        },
        release() {},
        dispose() {},
    }
}

function ruleTexts(sheet: CSSStyleSheet): string[] {
    return [...sheet.cssRules].map((rule) => rule.cssText.replace(/\s+/g, ' '))
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('rewriteCssUrls', () => {
    const upper = (url: string) => `X:${url}`

    it('finds url() tokens with double quotes, single quotes and no quotes', () => {
        expect(rewriteCssUrls('a { background: url("a.png") }', upper)).toBe(
            'a { background: url("X:a.png") }',
        )
        expect(rewriteCssUrls("a { background: url('a.png') }", upper)).toBe(
            'a { background: url("X:a.png") }',
        )
        expect(rewriteCssUrls('a { background: url(a.png) }', upper)).toBe(
            'a { background: url("X:a.png") }',
        )
    })

    it('accepts white space and upper case', () => {
        expect(rewriteCssUrls('a { background: URL(  "a b.png"  ) }', upper)).toBe(
            'a { background: url("X:a b.png") }',
        )
        expect(rewriteCssUrls('a { background: Url( a.png ) no-repeat }', upper)).toBe(
            'a { background: url("X:a.png") no-repeat }',
        )
    })

    it('rewrites each token of a declaration', () => {
        const css =
            '@font-face { font-family: F; src: url(f.woff2) format("woff2"), url("f.ttf") format("truetype") }'

        expect(rewriteCssUrls(css, upper)).toBe(
            '@font-face { font-family: F; src: url("X:f.woff2") format("woff2"), url("X:f.ttf") format("truetype") }',
        )
    })

    it('keeps data URLs and local fragments', () => {
        const css =
            'a { background: url(data:image/png;base64,AAAA) } b { background: url("DATA:image/gif;base64,R0") } c { clip-path: url(#clip); filter: url("#f") }'
        const seen: string[] = []

        expect(
            rewriteCssUrls(css, (url) => {
                seen.push(url)
                return null
            }),
        ).toBe(css)
        expect(seen).toEqual([])
    })

    it('replaces a URL with an empty URL when the resolver gives null', () => {
        const css =
            'a { background: url(https://example.com/a.png) } b { background: url("//example.com/b.png") } c { background: url(missing.png) } d { background: url() }'

        expect(rewriteCssUrls(css, () => null)).toBe(
            'a { background: url("") } b { background: url("") } c { background: url("") } d { background: url("") }',
        )
    })

    it('does not change text in comments and strings', () => {
        const css =
            '/* url(a.png) */ a::before { content: "url(b.png)"; quotes: \'url(c.png)\' } b { background: url(d.png) }'

        expect(rewriteCssUrls(css, upper)).toBe(
            '/* url(a.png) */ a::before { content: "url(b.png)"; quotes: \'url(c.png)\' } b { background: url("X:d.png") }',
        )
    })

    it('decodes CSS escapes in the URL and in the function name', () => {
        expect(rewriteCssUrls('a { background: url(a\\ b.png) }', upper)).toBe(
            'a { background: url("X:a b.png") }',
        )
        expect(rewriteCssUrls('a { background: url("a\\62 c.png") }', upper)).toBe(
            'a { background: url("X:abc.png") }',
        )
        expect(
            rewriteCssUrls('a { background: \\75rl(https://example.com/a.png) }', () => null),
        ).toBe('a { background: url("") }')
        expect(rewriteCssUrls('a { background: u\\72 l(a.png) }', upper)).toBe(
            'a { background: url("X:a.png") }',
        )
    })

    it('escapes the characters that can end the URL string', () => {
        expect(rewriteCssUrls('a { background: url(a.png) }', () => 'x")y\\z')).toBe(
            'a { background: url("x%22)y%5Cz") }',
        )
    })

    it('finds a URL after text that only looks like a string or a URL', () => {
        // In each case a scanner that does not read the text as the CSS tokenizer does would
        // see a string from the first quote to the last quote, and miss the URL in it.
        const tricks = [
            'p { x: foo-url(a "x) y" ); background: url(https://example.com/a.png) } q { content: "" }',
            'p { x: #url(a "x) y" ); background: url(https://example.com/a.png) } q { content: "" }',
            'p { background: url(a"b) } q { background: url(https://example.com/a.png) } r { content: "" }',
            'p { content: "abc\r; background: url(https://example.com/a.png); quotes: "" }',
            'p { content: "abc\f; background: url(https://example.com/a.png); quotes: "" }',
            'p { x: \\" ; background: url(https://example.com/a.png); quotes: "" }',
            "p { x: \\' ; background: url(https://example.com/a.png); quotes: '' }",
        ]

        for (const css of tricks) {
            expect(
                rewriteCssUrls(css, () => null),
                css,
            ).not.toContain('example.com')
        }
    })

    it('does not make a URL from a name that starts with an escaped backslash', () => {
        // The browser reads `\\url(` as a function with the name `\url`. It loads nothing.
        const css = 'p { background: \\\\url(https://example.com/a.png) }'

        expect(rewriteCssUrls(css, upper)).toBe(css)
    })

    it('does not read a longer function name as a URL', () => {
        const css = 'p { x: my-url(a.png) no_url(b.png) #url(c.png) }'

        expect(rewriteCssUrls(css, upper)).toBe(css)
    })

    it('reads an unquoted URL to the closing parenthesis', () => {
        expect(rewriteCssUrls('p { background: url(a b.png) }', upper)).toBe(
            'p { background: url("X:a b.png") }',
        )
        expect(rewriteCssUrls('p { background: url(a.png', upper)).toBe(
            'p { background: url("X:a.png")',
        )
    })

    it('returns text with no URL as it is', () => {
        const css = 'p { margin: 0 } /* no links */'

        expect(rewriteCssUrls(css, upper)).toBe(css)
    })
})

describe('findImports', () => {
    it('finds the url() form and the string form', () => {
        const css =
            '@import url("a.css");\n@import url(\'b.css\');\n@import url(c.css);\n@import "d.css";\n@import \'e.css\';\np { margin: 0 }'

        expect(findImports(css).map((rule) => rule.url)).toEqual([
            'a.css',
            'b.css',
            'c.css',
            'd.css',
            'e.css',
        ])
    })

    it('gives the media query', () => {
        const imports = findImports(
            '@import url(a.css) screen and (min-width: 600px);@import "b.css" print;@import "c.css";',
        )

        expect(imports.map((rule) => rule.media)).toEqual([
            'screen and (min-width: 600px)',
            'print',
            null,
        ])
    })

    it('gives the range of the full rule', () => {
        const css = '@charset "utf-8";\n@import "a.css" print;\np { margin: 0 }'
        const [rule] = findImports(css)

        expect(css.slice(rule.start, rule.end)).toBe('@import "a.css" print;')
    })

    it('ignores an import in a comment or a string', () => {
        const css = '/* @import "a.css"; */ p::before { content: "@import \'b.css\';" }'

        expect(findImports(css)).toEqual([])
    })

    it('marks an import after a block as not leading', () => {
        const imports = findImports('@import "a.css";\np { margin: 0 }\n@import "b.css";')

        expect(imports.map((rule) => [rule.url, rule.leading])).toEqual([
            ['a.css', true],
            ['b.css', false],
        ])
    })

    it('marks an import with no end as not leading', () => {
        const [rule] = findImports('@import "a.css" screen { p { margin: 0 } }')

        expect(rule.leading).toBe(false)
    })

    it('reads an unquoted URL with no closing parenthesis to the end of the URL', () => {
        expect(findImports('@import url(a.css')).toMatchObject([{ url: 'a.css', end: 17 }])
        expect(findImports('@import url(a.css screen; p { }')).toMatchObject([
            { url: 'a.css', media: 'screen', end: 25 },
        ])
    })

    it('reads many rules with no end in linear time', async () => {
        // Each rule start must not scan the rest of the text again.
        const book = createFakeBook({ files: { 'a.css': '' }, spine: [] })
        const start = performance.now()

        const imports = findImports('@importurl('.repeat(50_000))
        const css = await resolveCssText({
            book,
            resources: fakeResources(),
            path: 'a.css',
            css: '@namespaceurl('.repeat(50_000),
        })

        expect(performance.now() - start).toBeLessThan(2000)
        expect(imports).toHaveLength(1)
        expect(css).toBe('')
    })

    it('accepts upper case and no space before the URL', () => {
        expect(findImports('@IMPORT"a.css";@Import URL(b.css);').map((rule) => rule.url)).toEqual([
            'a.css',
            'b.css',
        ])
    })
})

describe('rewriteSelector', () => {
    const cases: [string, string][] = [
        ['html', 'rd-html'],
        ['body', 'rd-body'],
        ['HTML', 'rd-html'],
        ['Body', 'rd-body'],
        ['html, body', 'rd-html, rd-body'],
        ['html body', 'rd-html rd-body'],
        ['html>body', 'rd-html>rd-body'],
        ['html > body > p', 'rd-html > rd-body > p'],
        ['body.chapter p', 'rd-body.chapter p'],
        ['body#main', 'rd-body#main'],
        ['body[lang="en"]', 'rd-body[lang="en"]'],
        ['html[dir=rtl] body', 'rd-html[dir=rtl] rd-body'],
        ['body::before', 'rd-body::before'],
        ['body:first-child', 'rd-body:first-child'],
        ['body *', 'rd-body *'],
        ['h1 + p ~ body', 'h1 + p ~ rd-body'],
        [':not(body)', ':not(rd-body)'],
        ['p:not(html.x body)', 'p:not(rd-html.x rd-body)'],
        [':is(html, body) p', ':is(rd-html, rd-body) p'],
        ['& body', '& rd-body'],
        [':root', 'rd-html'],
        [':ROOT', 'rd-html'],
        [':root > body', 'rd-html > rd-body'],
        [':root.dark p', 'rd-html.dark p'],
        [':root, body', 'rd-html, rd-body'],
        [':not(:root)', ':not(rd-html)'],
        ['html:root', 'rd-html:is(rd-html)'],
        ['.theme:root p', '.theme:is(rd-html) p'],
        ['*:root', '*:is(rd-html)'],
        ['[epub|type~="noteref"]', '[data-epub-type~="noteref"]'],
        ['a[epub|type="noteref"]', 'a[data-epub-type="noteref"]'],
        ['[EPUB|TYPE~=footnote]', '[data-epub-type~=footnote]'],
        ['[epub\\:type~="footnote"]', '[data-epub-type~="footnote"]'],
        ['[epub|type]', '[data-epub-type]'],
        ['body[epub|type~="frontmatter"] h1', 'rd-body[data-epub-type~="frontmatter"] h1'],
        ['section[epub|type~="chapter"] > body', 'section[data-epub-type~="chapter"] > rd-body'],
    ]

    for (const [input, expected] of cases) {
        it(`changes ${input}`, () => {
            expect(rewriteSelector(input)).toBe(expected)
        })
    }

    const unchanged = [
        'tbody',
        'tbody tr td',
        'table > tbody > tr',
        '.body',
        '.html',
        '#html',
        '#body',
        'p.body.html',
        '.body-text',
        'body-text',
        'my-body',
        'html-element',
        '.html-body p',
        '[class*=body]',
        '[class*="body"]',
        "[title='html body']",
        '[data-body]',
        '[body]',
        'a[href$=".html"]',
        'p:nth-child(2n+1)',
        'p::selection',
        ':root-like',
        '.a\\:body',
        '.root',
        '[type="epub"]',
        '[epub|types]',
        '[data-epub-type~="noteref"]',
        'p[title=":root body html"]',
        'h1, h2 > span.x',
        '*',
    ]

    for (const selector of unchanged) {
        it(`does not change ${selector}`, () => {
            expect(rewriteSelector(selector)).toBe(selector)
        })
    }
})

describe('rewriteSelector: large input', () => {
    it('reads many open brackets in linear time', () => {
        const start = performance.now()

        const selector = rewriteSelector(`body ${'[x '.repeat(100_000)}`)

        expect(performance.now() - start).toBeLessThan(2000)
        expect(selector.startsWith('rd-body [x ')).toBe(true)
    })
})

describe('isLocalCssValue', () => {
    it('accepts object URLs, data URLs, fragments and values with no URL', () => {
        for (const value of [
            'red',
            'rgb(1, 2, 3)',
            'url("blob:http://localhost/1234")',
            'url(data:image/png;base64,AAAA) no-repeat',
            'url("#clip")',
            'url("")',
            'image-set(url("blob:x") 1x, url("data:image/png;base64,AA") type("image/png") 2x)',
        ]) {
            expect(isLocalCssValue(value), value).toBe(true)
        }
    })

    it('rejects values that can load a different URL', () => {
        for (const value of [
            'url("https://example.com/a.png")',
            'url(//example.com/a.png)',
            'url("a.png")',
            'image-set("https://example.com/a.png" 1x)',
            'image-set("a.png" 1x, url("blob:x") 2x)',
            '-webkit-image-set(var(--image) 1x)',
            'src("https://example.com/a.woff")',
        ]) {
            expect(isLocalCssValue(value), value).toBe(false)
        }
    })
})

describe('isSafeMediaQuery', () => {
    it('accepts media queries and rejects text that can start a rule', () => {
        expect(isSafeMediaQuery('screen and (min-width: 600px)')).toBe(true)
        expect(isSafeMediaQuery('amzn-kf8')).toBe(true)
        expect(isSafeMediaQuery('screen { } p { color: red')).toBe(false)
        expect(isSafeMediaQuery('screen; @import "a.css"')).toBe(false)
        expect(isSafeMediaQuery('screen /* x')).toBe(false)
        expect(isSafeMediaQuery('s\\63reen')).toBe(false)
    })
})

describe('resolveCssText and loadStylesheetText', () => {
    it('rewrites each URL to an object URL of the file, relative to the CSS file', async () => {
        const book = createFakeBook({
            files: {
                'OEBPS/css/main.css':
                    '@font-face { font-family: "Book"; src: url(../fonts/book.woff2) }\n' +
                    '.cover { background: url("../images/a.png") }\n' +
                    '.icon { background: url(../images/sprite.svg#star) }\n' +
                    '.gone { background: url(../images/missing.png) }\n' +
                    '.web { background: url(https://example.com/a.png) }\n' +
                    '.inline { background: url(data:image/gif;base64,R0) }',
                'OEBPS/fonts/book.woff2': 'font',
                'OEBPS/images/a.png': 'png',
                'OEBPS/images/sprite.svg': '<svg/>',
            },
            spine: [],
        })
        const resources = fakeResources()

        const css = await loadStylesheetText({ book, path: 'OEBPS/css/main.css', resources })

        expect(css).toBe(
            '@font-face { font-family: "Book"; src: url("blob:test/OEBPS/fonts/book.woff2") }\n' +
                '.cover { background: url("blob:test/OEBPS/images/a.png") }\n' +
                '.icon { background: url("blob:test/OEBPS/images/sprite.svg#star") }\n' +
                '.gone { background: url("") }\n' +
                '.web { background: url("") }\n' +
                '.inline { background: url(data:image/gif;base64,R0) }',
        )
        expect(resources.acquired.sort()).toEqual([
            'OEBPS/fonts/book.woff2',
            'OEBPS/images/a.png',
            'OEBPS/images/sprite.svg',
        ])
    })

    it('inlines imports and resolves their URLs relative to the imported file', async () => {
        const book = createFakeBook({
            files: {
                'css/main.css':
                    '@import "parts/base.css";\n@import url(print.css) print;\np { margin: 0 }',
                'css/parts/base.css': 'body { background: url(bg.png) }',
                'css/parts/bg.png': 'png',
                'css/print.css': 'p { color: black }',
            },
            spine: [],
        })

        const css = await loadStylesheetText({
            book,
            path: 'css/main.css',
            resources: fakeResources(),
        })

        expect(css).toBe(
            'body { background: url("blob:test/css/parts/bg.png") }\n' +
                '@media print {\np { color: black }\n}\n' +
                '\n\np { margin: 0 }',
        )
        expect(findImports(css)).toEqual([])
    })

    it('wraps an import with layer() and supports() conditions', async () => {
        const book = createFakeBook({
            files: {
                'main.css':
                    '@import "a.css" layer(base) supports(display: grid) screen;@import "b.css" layer;',
                'a.css': 'a { color: red }',
                'b.css': 'b { color: blue }',
            },
            spine: [],
        })

        const css = await loadStylesheetText({ book, path: 'main.css', resources: fakeResources() })

        expect(css).toContain(
            '@layer base {@supports (display: grid) {@media screen {\na { color: red }\n}}}',
        )
        expect(css).toContain('@layer  {\nb { color: blue }\n}')
    })

    it('removes imports that are remote, missing, late or unsafe', async () => {
        const book = createFakeBook({
            files: {
                'main.css':
                    '@import url(https://example.com/a.css);@import "missing.css";' +
                    '@import "ok.css" screen { } p { background: url(https://example.com/x.png) } @media all;' +
                    'p { margin: 0 }\n@import "ok.css";',
                'ok.css': 'i { color: red }',
            },
            spine: [],
        })

        const css = await loadStylesheetText({ book, path: 'main.css', resources: fakeResources() })

        expect(css).not.toMatch(/@import/i)
        expect(css).not.toContain('example.com')
        expect(css).not.toContain('color: red')
        expect(css).toContain('p { margin: 0 }')
    })

    it('stops at an import cycle', async () => {
        const book = createFakeBook({
            files: {
                'a.css': '@import "b.css";\na { color: red }',
                'b.css': '@import "a.css";\n@import "b.css";\nb { color: blue }',
            },
            spine: [],
        })

        const css = await loadStylesheetText({ book, path: 'a.css', resources: fakeResources() })

        expect(css.match(/color: red/g)).toHaveLength(1)
        expect(css.match(/color: blue/g)).toHaveLength(1)
        expect(css.indexOf('color: blue')).toBeLessThan(css.indexOf('color: red'))
    })

    it('follows imports to depth 5 and not deeper', async () => {
        const files: Record<string, string> = {}
        for (let level = 0; level <= 7; level++) {
            files[`level${level}.css`] =
                `@import "level${level + 1}.css";\n.level${level} { margin: 0 }`
        }
        const book = createFakeBook({ files, spine: [] })

        const css = await loadStylesheetText({
            book,
            path: 'level0.css',
            resources: fakeResources(),
        })

        expect(css).toContain('.level5 {')
        expect(css).not.toContain('.level6 {')
        expect(css).not.toMatch(/@import/i)
    })

    it('stops when one stylesheet imports too many files', async () => {
        // Each file imports the next one 10 times: 10 + 100 + 1000 + 10 000 reads with no limit.
        const repeat = (name: string) => `@import "${name}";\n`.repeat(10)
        const book = createFakeBook({
            files: {
                'a.css': `${repeat('b.css')}.a { margin: 0 }`,
                'b.css': `${repeat('c.css')}.b { margin: 0 }`,
                'c.css': `${repeat('d.css')}.c { margin: 0 }`,
                'd.css': `${repeat('e.css')}.d { margin: 0 }`,
                'e.css': '.e { margin: 0 }',
            },
            spine: [],
        })
        const readText = vi.spyOn(book, 'readText')

        const css = await loadStylesheetText({ book, path: 'a.css', resources: fakeResources() })

        expect(readText.mock.calls.length).toBeLessThanOrEqual(70)
        expect(css).toContain('.a { margin: 0 }')
        expect(css).toContain('.b { margin: 0 }')
        expect(css).not.toMatch(/@import/i)
    })

    it('moves namespace rules with a prefix to the start and drops a default namespace', async () => {
        const book = createFakeBook({
            files: {
                'main.css':
                    '@import "notes.css";\n@namespace url(http://www.w3.org/1999/xhtml);\n' +
                    '@namespace epub "http://www.idpf.org/2007/ops";\np { margin: 0 }',
                'notes.css':
                    '@namespace epub url("http://www.idpf.org/2007/ops");\n[epub|type~="noteref"] { color: red }',
            },
            spine: [],
        })

        const css = await loadStylesheetText({ book, path: 'main.css', resources: fakeResources() })

        expect(
            css.startsWith(
                '@namespace epub url("http://www.idpf.org/2007/ops");\n' +
                    '@namespace epub "http://www.idpf.org/2007/ops";\n',
            ),
        ).toBe(true)
        expect(css.match(/@namespace/g)).toHaveLength(2)
        expect(css).not.toContain('1999/xhtml')
        expect(css).toContain('[epub|type~="noteref"] { color: red }')
    })

    it('wraps the result in a media query', async () => {
        const book = createFakeBook({ files: { 'a.css': 'p { margin: 0 }' }, spine: [] })
        const resources = fakeResources()

        expect(await loadStylesheetText({ book, path: 'a.css', resources, media: 'print' })).toBe(
            '@media print {\np { margin: 0 }\n}',
        )
        expect(
            await loadStylesheetText({ book, path: 'a.css', resources, media: 'all { } p { x: y' }),
        ).toBe('')
    })

    it('resolves the CSS of a style element relative to the chapter', async () => {
        const book = createFakeBook({
            files: {
                'text/ch1.xhtml': '',
                'text/local.css': 'em { color: red }',
                'images/a.png': 'png',
            },
            spine: ['text/ch1.xhtml'],
        })

        const css = await resolveCssText({
            book,
            css: '@import "local.css";\np { background: url(../images/a.png) }',
            path: 'text/ch1.xhtml',
            resources: fakeResources(),
        })

        expect(css).toBe('em { color: red }\n\np { background: url("blob:test/images/a.png") }')
    })

    it('rejects when the file is not in the book', async () => {
        const book = createFakeBook({ files: {}, spine: [] })

        await expect(
            loadStylesheetText({ book, path: 'missing.css', resources: fakeResources() }),
        ).rejects.toThrow()
    })
})

describe('resolveCssUrls', () => {
    it('gives one path for each acquired URL', async () => {
        const book = createFakeBook({
            files: { 'text/ch1.xhtml': '', 'images/a.png': 'png', 'images/b.png': 'png' },
            spine: [],
        })

        const result = await resolveCssUrls({
            book,
            css: 'background: url(../images/a.png), url(../images/b.png), url(../images/a.png), url(x.png)',
            path: 'text/ch1.xhtml',
            resources: fakeResources(),
        })

        expect(result.css).toBe(
            'background: url("blob:test/images/a.png"), url("blob:test/images/b.png"), url("blob:test/images/a.png"), url("")',
        )
        expect(result.paths.sort()).toEqual(['images/a.png', 'images/b.png'])
    })

    it('leaves a URL empty when the store cannot read the file', async () => {
        const book = createFakeBook({ files: { 'a.png': 'png' }, spine: [] })
        const resources: ResourceStore = {
            acquire: () => Promise.reject(new Error('read error')),
            release() {},
            dispose() {},
        }

        const result = await resolveCssUrls({
            book,
            css: 'background: url(a.png)',
            path: 'x.css',
            resources,
        })

        expect(result).toEqual({ css: 'background: url("")', paths: [] })
    })
})

describe('buildSheet', () => {
    it('rewrites the selectors of style rules, also in grouping rules', () => {
        const { sheet } = buildSheet(
            'html, body { margin: 0 }\n' +
                ':root { color: black }\n' +
                'tbody .body { color: red }\n' +
                '@media screen { body p { color: blue } }\n' +
                '@supports (display: grid) { html { color: green } }\n' +
                '@layer base { body > h1 { color: gray } }',
        )

        expect(sheet).not.toBeNull()
        expect(ruleTexts(sheet!)).toEqual([
            'rd-html, rd-body { margin: 0px; }',
            'rd-html { color: black; }',
            'tbody .body { color: red; }',
            '@media screen { rd-body p { color: blue; } }',
            '@supports (display: grid) { rd-html { color: green; } }',
            '@layer base { rd-body > h1 { color: gray; } }',
        ])
    })

    it('rewrites an epub:type attribute selector', () => {
        const { sheet } = buildSheet(
            '@namespace epub "http://www.idpf.org/2007/ops";\n[epub|type~="noteref"] { color: red }',
        )
        const rule = [...sheet!.cssRules].find(
            (item) => item instanceof CSSStyleRule,
        ) as CSSStyleRule

        expect(rule.selectorText).toBe('[data-epub-type~="noteref"]')
    })

    it('rewrites the selectors of nested rules', () => {
        const { sheet } = buildSheet('.a { color: red; & body { color: blue } }')
        const outer = sheet!.cssRules[0] as CSSStyleRule

        expect((outer.cssRules[0] as CSSStyleRule).selectorText).toBe('& rd-body')
    })

    it('changes forced page breaks to column breaks', () => {
        const { sheet } = buildSheet(
            '.a { break-before: page }\n' +
                '.b { break-after: left }\n' +
                '.c { break-before: right; break-after: recto }\n' +
                '.d { break-after: verso }\n' +
                '.e { break-before: always }\n' +
                '.f { page-break-before: always }\n' +
                '.g { page-break-after: always !important }\n' +
                '.h { break-before: avoid; break-after: auto; page-break-before: avoid }\n' +
                '@media screen { .i { page-break-after: always } }',
        )
        const rules = [...sheet!.cssRules] as CSSStyleRule[]
        const value = (index: number, name: string) => rules[index].style.getPropertyValue(name)

        expect(value(0, 'break-before')).toBe('column')
        expect(value(1, 'break-after')).toBe('column')
        expect(value(2, 'break-before')).toBe('column')
        expect(value(2, 'break-after')).toBe('column')
        expect(value(3, 'break-after')).toBe('column')
        expect(value(4, 'break-before')).toBe('column')
        expect(value(5, 'break-before')).toBe('column')
        expect(value(5, 'page-break-before')).not.toBe('always')
        expect(value(6, 'break-after')).toBe('column')
        expect(rules[6].style.getPropertyPriority('break-after')).toBe('important')
        expect(value(7, 'break-before')).toBe('avoid')
        expect(value(7, 'break-after')).toBe('auto')
        expect(value(7, 'page-break-before')).toBe('avoid')
        const inner = (sheet!.cssRules[8] as CSSMediaRule).cssRules[0] as CSSStyleRule
        expect(inner.style.getPropertyValue('break-after')).toBe('column')
    })

    it('changes position fixed to absolute', () => {
        const { sheet } = buildSheet(
            '.a { position: fixed }\n.b { position: FIXED !important }\n.c { position: sticky }',
        )
        const rules = [...sheet!.cssRules] as CSSStyleRule[]

        expect(rules[0].style.getPropertyValue('position')).toBe('absolute')
        expect(rules[1].style.getPropertyValue('position')).toBe('absolute')
        expect(rules[1].style.getPropertyPriority('position')).toBe('important')
        expect(rules[2].style.getPropertyValue('position')).toBe('sticky')
    })

    it('makes the absolute font sizes and line heights follow the reader setting', () => {
        const { sheet } = buildSheet(
            'p { font-size: 12pt; line-height: 14pt }\n' +
                '.a { font-size: 16PX !important; line-height: 1.2 }\n' +
                '.b { font-size: small; line-height: 18px !important }\n' +
                '.c { font-size: 0.9em; line-height: 120% }\n' +
                '.d { font-size: larger; line-height: normal; margin-top: 12pt }\n' +
                '.e { font-size: calc(1em + 10px); line-height: var(--leading) }\n' +
                '@media screen { .f { font-size: 10pt } @supports (display: grid) { .g { font-size: xx-large } } }\n' +
                '.h { font-size: 0; line-height: 0 }\n' +
                '@keyframes grow { from { font-size: 10px } to { font-size: 2em } }',
        )
        const rules = [...sheet!.cssRules] as CSSStyleRule[]
        const value = (index: number, name: string) => rules[index].style.getPropertyValue(name)
        const priority = (index: number, name: string) =>
            rules[index].style.getPropertyPriority(name)

        expect(value(0, 'font-size')).toBe('calc(12pt * var(--rd-scale, 1))')
        expect(value(0, 'line-height')).toBe('calc(14pt * var(--rd-scale, 1))')
        expect(priority(0, 'font-size')).toBe('')
        expect(value(1, 'font-size')).toBe('calc(16px * var(--rd-scale, 1))')
        expect(priority(1, 'font-size')).toBe('important')
        expect(value(1, 'line-height')).toBe('1.2')
        expect(value(2, 'font-size')).toBe('0.8125em')
        expect(value(2, 'line-height')).toBe('calc(18px * var(--rd-scale, 1))')
        expect(priority(2, 'line-height')).toBe('important')
        expect(value(3, 'font-size')).toBe('0.9em')
        expect(value(3, 'line-height')).toBe('120%')
        expect(value(4, 'font-size')).toBe('larger')
        expect(value(4, 'line-height')).toBe('normal')
        expect(value(4, 'margin-top')).toBe('12pt')
        expect(value(5, 'font-size')).toBe('calc(1em + 10px)')
        expect(value(5, 'line-height')).toBe('var(--leading)')

        const media = sheet!.cssRules[6] as CSSMediaRule
        expect((media.cssRules[0] as CSSStyleRule).style.getPropertyValue('font-size')).toBe(
            'calc(10pt * var(--rd-scale, 1))',
        )
        const supports = media.cssRules[1] as CSSSupportsRule
        expect((supports.cssRules[0] as CSSStyleRule).style.getPropertyValue('font-size')).toBe(
            '2em',
        )
        expect(value(7, 'font-size')).not.toContain('calc')
        expect(value(7, 'line-height')).toBe('0')

        const frames = (sheet!.cssRules[8] as CSSKeyframesRule).cssRules
        expect((frames[0] as CSSKeyframeRule).style.getPropertyValue('font-size')).toBe(
            'calc(10px * var(--rd-scale, 1))',
        )
        expect((frames[1] as CSSKeyframeRule).style.getPropertyValue('font-size')).toBe('2em')
    })

    it('scales the sizes of a font shorthand through its parts', () => {
        const { sheet } = buildSheet(
            'h1 { font: bold 12pt/14pt serif }\n' +
                'h2 { font: 100% serif }\n' +
                'h3 { font: var(--heading-font) }',
        )
        const rules = [...sheet!.cssRules] as CSSStyleRule[]

        expect(rules[0].style.getPropertyValue('font-size')).toBe('calc(12pt * var(--rd-scale, 1))')
        expect(rules[0].style.getPropertyValue('line-height')).toBe(
            'calc(14pt * var(--rd-scale, 1))',
        )
        expect(rules[0].style.getPropertyValue('font-weight')).toBe('bold')
        expect(rules[0].style.getPropertyValue('font-family')).toBe('serif')
        expect(rules[1].style.getPropertyValue('font-size')).toBe('100%')
        // A shorthand with var() has no parts. It stays as written.
        expect(rules[2].style.getPropertyValue('font')).toBe('var(--heading-font)')
    })

    it('takes the font faces out of the sheet and returns them', () => {
        const { sheet, fontFaces } = buildSheet(
            '@font-face { font-family: "Book Serif"; src: url("blob:test/a.woff2") format("woff2"), url("blob:test/a.ttf"); font-weight: 700; font-style: italic; font-stretch: condensed; unicode-range: U+0-7F; font-display: swap }\n' +
                'p { margin: 0 }\n' +
                '@media screen { @font-face { font-family: Plain; src: url(data:font/woff2;base64,AAAA;x) } }',
        )

        expect(fontFaces).toEqual<FontFaceSpec[]>([
            {
                family: 'Book Serif',
                src: 'url("blob:test/a.woff2") format("woff2"), url("blob:test/a.ttf")',
                weight: '700',
                style: 'italic',
                stretch: 'condensed',
                unicodeRange: 'U+0-7F',
                display: 'swap',
            },
            {
                family: 'Plain',
                src: 'url(data:font/woff2;base64,AAAA;x)',
                weight: null,
                style: null,
                stretch: null,
                unicodeRange: null,
                display: null,
            },
        ])
        expect(ruleTexts(sheet!)).toEqual(['p { margin: 0px; }', '@media screen { }'])
    })

    it('reads the font faces from the object model when it has the src descriptor', () => {
        // jsdom does not keep `src`. Give it back, as a browser does.
        const original = CSSStyleDeclaration.prototype.getPropertyValue
        vi.spyOn(CSSStyleDeclaration.prototype, 'getPropertyValue').mockImplementation(function (
            this: CSSStyleDeclaration,
            name: string,
        ) {
            if (name === 'src' && this.parentRule instanceof CSSFontFaceRule) {
                const family = original.call(this, 'font-family')
                return `url("blob:test/${family.replace(/"/g, '')}.woff2")`
            }
            return original.call(this, name)
        })

        const { sheet, fontFaces } = buildSheet(
            '@font-face { font-family: First; src: url(first-in-text) }\n' +
                '@media screen { @font-face { font-family: "Second"; src: url(second-in-text); font-weight: 300 } }\n' +
                '@font-face { font-family: Third; src: url(third-in-text) }',
        )
        vi.restoreAllMocks()

        expect(fontFaces.map((face) => [face.family, face.src, face.weight])).toEqual([
            ['First', 'url("blob:test/First.woff2")', null],
            ['Second', 'url("blob:test/Second.woff2")', '300'],
            ['Third', 'url("blob:test/Third.woff2")', null],
        ])
        expect(ruleTexts(sheet!)).toEqual(['@media screen { }'])
    })

    it('removes a declaration with a remote URL that the text scanner cannot see', () => {
        // The backslash makes the scanner read the rest of the line as a string.
        const { sheet } = buildSheet(
            '.x\\" { color: red } .a { background-image: url(https://example.com/a.png); color: blue } .b::after { content: "" }',
        )
        const rule = [...sheet!.cssRules].find(
            (item) => (item as CSSStyleRule).selectorText === '.a',
        ) as CSSStyleRule

        expect(rule.style.color).toBe('blue')
        expect(rule.style.backgroundImage).toBe('')
        for (const item of sheet!.cssRules) expect(item.cssText).not.toContain('example.com')
    })

    it('also checks keyframes for a remote URL in strict mode', () => {
        const { sheet } = buildSheet(
            '/* \\ */ @keyframes k { from { background-image: url(https://example.com/a.png); opacity: 0 } to { opacity: 1 } }',
        )
        const text = sheet!.cssRules[0].cssText

        expect(text).not.toContain('example.com')
        expect(text).toMatch(/opacity: 0/)
    })

    it('removes a custom property with an escape and a URL in strict mode', () => {
        const { sheet } = buildSheet(
            '.a { --marker: \\"q url(https://example.com/a.png); --plain: 2px; list-style: var(--marker); color: red }',
        )
        const rule = sheet!.cssRules[0] as CSSStyleRule

        expect(rule.style.getPropertyValue('--marker')).toBe('')
        expect(rule.style.getPropertyValue('--plain')).toBe('2px')
        expect(rule.style.color).toBe('red')
        expect(rule.cssText).not.toContain('example.com')
    })

    it('removes a declaration with a remote URL in a var() fallback in strict mode', () => {
        const { sheet } = buildSheet(
            '/* \\ */ .a { background: var(--none, url(https://example.com/a.png)); color: red }',
        )
        const rule = sheet!.cssRules[0] as CSSStyleRule

        expect(rule.cssText).not.toContain('example.com')
        expect(rule.style.color).toBe('red')
    })

    it('drops a font source that is not in the book', () => {
        const { fontFaces } = buildSheet(
            '@font-face { font-family: A; src: url(""), url("blob:test/a.woff") }\n' +
                '@font-face { font-family: B; src: url("") }\n' +
                '@font-face { font-family: C; src: url("https://example.com/c.woff") }\n' +
                '@font-face { src: url("blob:test/d.woff") }',
        )

        expect(fontFaces.map((face) => [face.family, face.src])).toEqual([
            ['A', 'url("blob:test/a.woff")'],
        ])
    })

    it('deletes the rules that select the shadow host', () => {
        // The sheet is adopted in the shadow root of the view. Only these selectors can
        // style an element of the app.
        const { sheet } = buildSheet(
            ':host { display: none !important }\n' +
                ':HOST(.reader) p, body { color: red }\n' +
                ':host-context(.dark) p { color: white }\n' +
                '@media screen { :host { inset: 0; z-index: 99 } p { margin: 0 } }\n' +
                '.ghost { color: gray }',
        )

        expect(ruleTexts(sheet!)).toEqual([
            '@media screen { p { margin: 0px; } }',
            '.ghost { color: gray; }',
        ])
    })

    it('deletes a scope rule that has the shadow host as its root', () => {
        const { sheet } = buildSheet(
            '@scope { :scope { display: none } }\n' +
                '@scope (:host) { :scope { display: none } }\n' +
                '@scope (.card) to (.content) { body p { color: blue } }\n' +
                '@media screen { @scope { p { color: red } } }',
        )

        expect(ruleTexts(sheet!)).toEqual([
            '@scope (.card) to (.content) { rd-body p { color: blue; } }',
            '@media screen { }',
        ])
    })

    it('deletes page rules and import rules', () => {
        const { sheet } = buildSheet(
            '@import url("https://example.com/a.css");\n@page { margin: 1in }\n@page :first { margin: 0 }\np { margin: 0 }',
        )

        expect(ruleTexts(sheet!)).toEqual(['p { margin: 0px; }'])
    })

    it('keeps keyframes rules', () => {
        const { sheet } = buildSheet('@keyframes fade { from { opacity: 0 } to { opacity: 1 } }')

        expect(sheet!.cssRules).toHaveLength(1)
    })

    it('returns a null sheet and the font faces when there are no constructable sheets', () => {
        vi.stubGlobal('CSSStyleSheet', undefined)

        const { sheet, fontFaces } = buildSheet(
            '/* @font-face { font-family: Hidden; src: url(x) } */\n' +
                '@FONT-FACE {\n  font-family: \'Book Sans\';\n  src: url("blob:test/a.woff2") format("woff2");\n  font-weight: bold\n}\n' +
                'body { margin: 0 }',
        )

        expect(sheet).toBeNull()
        expect(fontFaces).toEqual<FontFaceSpec[]>([
            {
                family: 'Book Sans',
                src: 'url("blob:test/a.woff2") format("woff2")',
                weight: 'bold',
                style: null,
                stretch: null,
                unicodeRange: null,
                display: null,
            },
        ])
    })

    it('returns a null sheet when replaceSync is not there', () => {
        vi.stubGlobal('CSSStyleSheet', class {})

        expect(buildSheet('p { margin: 0 }')).toEqual({ sheet: null, fontFaces: [] })
    })

    it('returns an empty sheet for empty text', () => {
        const { sheet, fontFaces } = buildSheet('')

        expect(sheet!.cssRules).toHaveLength(0)
        expect(fontFaces).toEqual([])
    })
})

describe('buildSheet: font faces from the text', () => {
    /** The family and the source of each font face that the text scanner finds. */
    function facesOf(css: string): string[][] {
        vi.stubGlobal('CSSStyleSheet', undefined)
        return buildSheet(css).fontFaces.map((face) => [face.family, face.src])
    }

    it('reads each rule in source order, also in a grouping rule', () => {
        const faces = facesOf(
            '@font-face{font-family:A;src:url("blob:test/a")}\n' +
                '@media print { @font-face { font-family: B; src: url("blob:test/b") } }\n' +
                'p { color: red }\n' +
                '@FONT-FACE\n{\n  font-family: C;\n  src: url("blob:test/c")\n}',
        )

        expect(faces).toEqual([
            ['A', 'url("blob:test/a")'],
            ['B', 'url("blob:test/b")'],
            ['C', 'url("blob:test/c")'],
        ])
    })

    it('does not end a rule at a brace in a string or after a backslash', () => {
        expect(facesOf('@font-face { font-family: "}{"; src: url("blob:test/a}") }')).toEqual([
            ['}{', 'url("blob:test/a}")'],
        ])
        expect(facesOf("@font-face { font-family: '{}'; src: url('blob:test/b{') }")).toEqual([
            ['{}', "url('blob:test/b{')"],
        ])
        expect(facesOf('@font-face { font-family: a\\}b; src: url("blob:test/c") }')).toEqual([
            ['a}b', 'url("blob:test/c")'],
        ])
    })

    it('gives nothing for a rule that has a block in it or that has no end', () => {
        expect(facesOf('@font-face { font-family: A; p { } src: url("blob:test/a") }')).toEqual([])
        expect(facesOf('@font-face { font-family: B; src: url("blob:test/b")')).toEqual([])
        expect(facesOf('@font-face { font-family: C; src: url("blob:test/c) }')).toEqual([])
    })

    it('reads the rule after a rule that has a block in it', () => {
        const faces = facesOf(
            '@font-face { font-family: A; p { } }\n' +
                '@font-face { @font-face { font-family: B; src: url("blob:test/b") } }\n' +
                '@font-face { font-family: C; src: url("blob:test/c") }',
        )

        expect(faces).toEqual([
            ['B', 'url("blob:test/b")'],
            ['C', 'url("blob:test/c")'],
        ])
    })

    it('does not read a rule that is in a string', () => {
        const faces = facesOf(
            'p::after { content: "@font-face { font-family: S; src: url(blob:test/s) }" }\n' +
                '@font-face { font-family: A; src: url("blob:test/a") }',
        )

        expect(faces).toEqual([['A', 'url("blob:test/a")']])
    })

    it('drops each form of an empty font source', () => {
        const forms = [
            'url()',
            'url( )',
            'url("")',
            "url('')",
            'url( "" )',
            "url(\t''\n)",
            'URL("")',
        ]

        for (const form of forms) {
            const faces = facesOf(
                `@font-face { font-family: A; src: ${form}, url("blob:test/a.woff") }`,
            )
            expect(faces, form).toEqual([['A', 'url("blob:test/a.woff")']])
        }
    })

    it('keeps a font source that is not empty', () => {
        const forms = ['url("#a")', 'url(#a)', 'url("data:font/woff2;base64,AAAA")', 'local("A")']

        for (const form of forms) {
            expect(facesOf(`@font-face { font-family: A; src: ${form} }`), form).toEqual([
                ['A', form],
            ])
        }
    })
})

describe('buildSheet: large input', () => {
    const LENGTH = 200_000
    // In this text each `\"` after the first one is an escape in a string, so the string of
    // each `@font-face{` has no end.
    const openStrings = '"@font-face{\\'.repeat(Math.ceil(LENGTH / 13))

    // Before the scanner read the text one time, and before the pattern for an empty URL had
    // one reading of a row of spaces, each of these texts kept the page busy for seconds.
    it.each([
        ['font face rules with a string that has no end', openStrings],
        ['font face rules with a string that ends before a block', `${openStrings}x"{`],
        [
            'a font source with spaces after url(',
            `@font-face { font-family: A; src: url(${' '.repeat(LENGTH)}x }`,
        ],
    ])('reads %s in linear time', (_name, css) => {
        vi.stubGlobal('CSSStyleSheet', undefined)
        const start = performance.now()

        const { fontFaces } = buildSheet(css)

        expect(performance.now() - start).toBeLessThan(500)
        expect(fontFaces).toEqual([])
    })
})

describe('scaleFontSize', () => {
    const scaled = (length: string) => `calc(${length} * var(--rd-scale, 1))`

    it('multiplies one absolute length by the scale of the reader', () => {
        const cases: [string, string][] = [
            ['12pt', '12pt'],
            ['16px', '16px'],
            ['1pc', '1pc'],
            ['0.5in', '0.5in'],
            ['.5in', '.5in'],
            ['1cm', '1cm'],
            ['4.2mm', '4.2mm'],
            ['20q', '20q'],
            ['20Q', '20Q'],
            ['12PT', '12PT'],
            ['12Px', '12Px'],
            ['10.5pt', '10.5pt'],
            ['10.pt', '10.pt'],
            ['  14px  ', '14px'],
            ['\n9pt\t', '9pt'],
            ['+12px', '12px'],
            ['1e1px', '1e1px'],
            ['1.2E+1pt', '1.2E+1pt'],
            ['0.01px', '0.01px'],
        ]

        for (const [value, length] of cases) {
            expect(scaleFontSize(value), value).toBe(scaled(length))
        }
    })

    it('changes an absolute keyword to a size in em', () => {
        const cases: [string, string][] = [
            ['xx-small', '0.5625em'],
            ['x-small', '0.625em'],
            ['small', '0.8125em'],
            ['medium', '1em'],
            ['large', '1.125em'],
            ['x-large', '1.5em'],
            ['xx-large', '2em'],
            ['xxx-large', '3em'],
            ['SMALL', '0.8125em'],
            ['X-Large', '1.5em'],
            ['  medium ', '1em'],
        ]

        for (const [value, expected] of cases) {
            expect(scaleFontSize(value), value).toBe(expected)
        }
    })

    it('gives null for a relative value', () => {
        const values = [
            '1em',
            '0.9em',
            '1.2rem',
            '120%',
            '2ex',
            '3ch',
            '1.5',
            'smaller',
            'larger',
            '2vw',
            '1vh',
            '1vmin',
            '5cqw',
            '1lh',
            '1rlh',
            '1cap',
            '1ic',
        ]

        for (const value of values) expect(scaleFontSize(value), value).toBeNull()
    })

    it('gives null for a value that already has a function', () => {
        const values = [
            'calc(12pt * var(--rd-scale, 1))',
            'calc(12px + 1em)',
            'var(--size)',
            'var(--size, 12px)',
            'min(12px, 1em)',
            'max(10pt, 2vw)',
            'clamp(12px, 2vw, 20px)',
            'env(safe-area-inset-top, 12px)',
        ]

        for (const value of values) expect(scaleFontSize(value), value).toBeNull()
    })

    it('gives null for a keyword that is not a size, and for a bad value', () => {
        const values = [
            '',
            '   ',
            'inherit',
            'initial',
            'unset',
            'revert',
            'revert-layer',
            'normal',
            'math',
            'none',
            'constructor',
            'toString',
            '__proto__',
            'px',
            '12',
            '12 px',
            '12px 14px',
            '12px/14px',
            '12px !important',
            '-12px',
            '12pxx',
            '12pts',
            '1e',
            '1.2.3px',
            '12px;',
            'x12px',
            '#12px',
        ]

        for (const value of values) expect(scaleFontSize(value), value).toBeNull()
    })

    it('gives null for a length of zero', () => {
        for (const value of ['0', '0px', '0.0pt', '.0in', '0e3px']) {
            expect(scaleFontSize(value), value).toBeNull()
        }
    })

    it('reads a long row of digits in linear time', () => {
        // A browser gives a value with var() as the book wrote it, so this text gets to the
        // pattern. Before the pattern had one reading of a row of digits, the first value
        // kept the page busy for many seconds.
        const digits = '1'.repeat(200_000)
        const start = performance.now()

        expect(scaleFontSize(`${digits} var(--x)`)).toBeNull()
        expect(scaleFontSize(`${digits}.${digits} var(--x)`)).toBeNull()
        expect(scaleFontSize(`.${digits} var(--x)`)).toBeNull()
        expect(scaleFontSize(`1e${digits} var(--x)`)).toBeNull()
        expect(scaleLineHeight(`+${digits}pxx`)).toBeNull()
        expect(performance.now() - start).toBeLessThan(500)
    })
})

describe('scaleLineHeight', () => {
    it('multiplies one absolute length by the scale of the reader', () => {
        expect(scaleLineHeight('14pt')).toBe('calc(14pt * var(--rd-scale, 1))')
        expect(scaleLineHeight(' 18.5PX ')).toBe('calc(18.5PX * var(--rd-scale, 1))')
        expect(scaleLineHeight('0.25in')).toBe('calc(0.25in * var(--rd-scale, 1))')
        expect(scaleLineHeight('5mm')).toBe('calc(5mm * var(--rd-scale, 1))')
    })

    it('gives null for all other values', () => {
        const values = [
            '1.2',
            '1',
            '0',
            '0px',
            'normal',
            '120%',
            '1.4em',
            '1.4rem',
            '2ex',
            '1lh',
            'inherit',
            // A font size keyword is not a line height.
            'medium',
            'large',
            'calc(14pt * var(--rd-scale, 1))',
            'var(--leading)',
            '-14pt',
            '',
        ]

        for (const value of values) expect(scaleLineHeight(value), value).toBeNull()
    })
})

describe('fixDeclarations', () => {
    it('scales the absolute sizes of an inline style and keeps the priority', () => {
        const element = document.createElement('p')
        element.style.cssText =
            'font-size: 11pt !important; line-height: 13pt; margin: 12pt; text-indent: 2em'

        fixDeclarations(element.style)

        expect(element.style.getPropertyValue('font-size')).toBe('calc(11pt * var(--rd-scale, 1))')
        expect(element.style.getPropertyPriority('font-size')).toBe('important')
        expect(element.style.getPropertyValue('line-height')).toBe(
            'calc(13pt * var(--rd-scale, 1))',
        )
        expect(element.style.getPropertyPriority('line-height')).toBe('')
        // Only the two font properties change.
        expect(element.style.margin).toBe('12pt')
        expect(element.style.textIndent).toBe('2em')
    })

    it('gives the same result when it runs two times', () => {
        const element = document.createElement('p')
        element.style.cssText = 'font-size: 11pt; line-height: 13pt'

        fixDeclarations(element.style)
        const first = element.style.cssText
        fixDeclarations(element.style)

        expect(element.style.cssText).toBe(first)
    })

    it('changes the declarations of an inline style', () => {
        const element = document.createElement('div')
        element.style.cssText = 'page-break-before: always; position: fixed; color: red'

        fixDeclarations(element.style)

        expect(element.style.getPropertyValue('break-before')).toBe('column')
        expect(element.style.getPropertyValue('page-break-before')).not.toBe('always')
        expect(element.style.position).toBe('absolute')
        expect(element.style.color).toBe('red')
    })

    it('removes a declaration with a remote URL in strict mode', () => {
        const element = document.createElement('div')
        element.style.cssText =
            'background-image: url("https://example.com/a.png"); list-style-image: url("blob:test/a.png"); color: red'

        fixDeclarations(element.style, true)

        expect(element.style.backgroundImage).toBe('')
        expect(element.style.listStyleImage).toContain('blob:test/a.png')
        expect(element.style.color).toBe('red')
    })
})

describe('registerFontFaces', () => {
    const spec: FontFaceSpec = {
        family: 'Book Serif',
        src: 'url("blob:test/a.woff2")',
        weight: '700',
        style: 'italic',
        stretch: null,
        unicodeRange: null,
        display: 'swap',
    }

    function installFontApi() {
        const created: FakeFontFace[] = []
        const load = vi.fn()
        class FakeFontFace {
            loaded = Promise.resolve(this)
            load = load
            constructor(
                readonly family: string,
                readonly source: string,
                readonly descriptors: FontFaceDescriptors,
            ) {
                if (/^\d/.test(family)) throw new SyntaxError('Bad family')
                created.push(this)
            }
        }
        const fonts = new Set<FakeFontFace>()
        vi.stubGlobal('FontFace', FakeFontFace)
        Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
        return { created, fonts, load }
    }

    afterEach(() => {
        Reflect.deleteProperty(document, 'fonts')
    })

    it('returns no handles when the environment has no FontFace', () => {
        expect(registerFontFaces([spec])).toEqual([])
    })

    it('adds each face to document.fonts and does not load it', () => {
        const { created, fonts, load } = installFontApi()

        const handles = registerFontFaces([spec, { ...spec, family: 'Other', weight: null }])

        expect(handles).toHaveLength(2)
        expect(fonts.size).toBe(2)
        expect(load).not.toHaveBeenCalled()
        expect(created[0].family).toBe('Book Serif')
        expect(created[0].source).toBe('url("blob:test/a.woff2")')
        expect(created[0].descriptors).toEqual({ weight: '700', style: 'italic', display: 'swap' })
        expect(created[1].descriptors).toEqual({ style: 'italic', display: 'swap' })
    })

    it('tries the quoted family name when the plain name is rejected', () => {
        const { created } = installFontApi()

        const handles = registerFontFaces([{ ...spec, family: '1942 Report' }])

        expect(handles).toHaveLength(1)
        expect(created[0].family).toBe('"1942 Report"')
    })

    it('tries the quoted family name when the face has the error status', () => {
        // By the CSS Font Loading specification the constructor does not throw for a family
        // or a descriptor that it cannot parse. It gives a face with the status "error".
        const created: { family: string; status: string }[] = []
        class StatusFontFace {
            status: string
            loaded: Promise<unknown>
            constructor(
                readonly family: string,
                readonly source: string,
                readonly descriptors: FontFaceDescriptors,
            ) {
                const bad = /^\d/.test(family) || descriptors.weight === 'heavy'
                this.status = bad ? 'error' : 'unloaded'
                this.loaded = bad ? Promise.reject(new SyntaxError('Bad value')) : Promise.resolve()
                created.push(this)
            }
        }
        const fonts = new Set<StatusFontFace>()
        vi.stubGlobal('FontFace', StatusFontFace)
        Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })

        const handles = registerFontFaces([
            { ...spec, family: '1942 Report' },
            { ...spec, family: 'Broken', weight: 'heavy' },
            spec,
        ])

        expect([...fonts].map((face) => face.family)).toEqual(['"1942 Report"', 'Book Serif'])
        expect(handles).toHaveLength(2)
        expect(created.map((face) => face.family)).toEqual([
            '1942 Report',
            '"1942 Report"',
            'Broken',
            '"Broken"',
            'Book Serif',
        ])
    })

    it('removes the faces again', () => {
        const { fonts } = installFontApi()
        const handles = registerFontFaces([spec])

        unregisterFontFaces(handles)

        expect(fonts.size).toBe(0)
    })
})
