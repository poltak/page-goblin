/**
 * Functions for the stylesheets of a book. They rewrite CSS text, inline `@import` rules, and
 * change a CSS text into a constructable stylesheet that is safe to adopt in the shadow root
 * of a reader view.
 */

import type { EpubBook } from '$lib/epub/types'
import type { ResourceStore } from './resources'
import { resolveFile } from './util'

export interface CssImport {
    /** The URL as written, with CSS escapes decoded. */
    url: string
    /** The text after the URL (a media query, `layer()`, `supports()`), or null. */
    media: string | null
    /** False when the rule comes after a block or has no end. A browser ignores such a rule. */
    leading: boolean
    /** Start of the full rule in the CSS text. */
    start: number
    /** Exclusive. */
    end: number
}

export interface FontFaceSpec {
    /** Family name with no quotes. */
    family: string
    /** The `src` descriptor. All its URLs are object URLs or data URLs. */
    src: string
    weight: string | null
    style: string | null
    stretch: string | null
    unicodeRange: string | null
    display: string | null
}

export interface BuiltSheet {
    /** Null when the environment has no constructable stylesheets. */
    sheet: CSSStyleSheet | null
    fontFaces: FontFaceSpec[]
}

export interface CssSource {
    book: EpubBook
    resources: ResourceStore
    /** Container path of the file that has the CSS. Relative URLs resolve against it. */
    path: string
    /** Wrap the result in this media query. */
    media?: string
}

const MAX_IMPORT_DEPTH = 5
// For one stylesheet with all its imports. A book can import each file many times at each
// depth, and the number of reads then grows very fast.
const MAX_IMPORTED_FILES = 64

const COMMENT = String.raw`\/\*[\s\S]*?(?:\*\/|$)`
// A CSS string ends at a line end, also when it has no closing quote.
const DOUBLE_STRING = String.raw`"(?:[^"\\\n\r\f]|\\[\s\S])*"?`
const SINGLE_STRING = String.raw`'(?:[^'\\\n\r\f]|\\[\s\S])*'?`
const ESCAPE = String.raw`\\[\s\S]`
// The name `url`, also with CSS escapes (`\75rl`). The CSS tokenizer reads them as `url`.
const URL_NAME = String.raw`(?:\\0{0,4}[57]5\s?|\\?u)(?:\\0{0,4}[57]2\s?|\\?r)(?:\\0{0,4}[46]c\s?|\\?l)`
// `url(` is a URL token only at the start of a name. `my-url(` and `#url(` are not URLs. An
// unquoted URL goes to the first `)`, as in the CSS tokenizer, also when it is not valid.
const URL_TOKEN = String.raw`(?<![\w\u0080-\uffff#@\\-])(${URL_NAME})\(\s*(?:"((?:[^"\\\n\r\f]|\\[\s\S])*)"?|'((?:[^'\\\n\r\f]|\\[\s\S])*)'?|((?:[^)\\]|\\[\s\S])*))\s*\)?`
// The `)` of `url()` is optional in the two rules below, as in `URL_TOKEN`. If the patterns
// needed it, each rule start with no `)` after it would scan the rest of the text, and a
// text with many such starts would stop the page for minutes.
const IMPORT_RULE = String.raw`@import\s*(?:url\(\s*(?:"([^"\n\r\f]*)"|'([^'\n\r\f]*)'|([^)\s"']*))\s*\)?|"([^"\n\r\f]*)"|'([^'\n\r\f]*)')([^;{}]*)(;|$)?`
const NAMESPACE_RULE = String.raw`@namespace\s*(?:([\w-]+)\s+)?(?:url\(\s*(?:"[^"\n\r\f]*"|'[^'\n\r\f]*'|[^)\s"']*)\s*\)?|"[^"\n\r\f]*"|'[^'\n\r\f]*')\s*;?`

// The scanners must read comments, escapes and strings in the same way as the browser. If
// they do not, a quote can hide a URL from the scanner that the browser loads.
const URL_SCAN = new RegExp(
    `${COMMENT}|${URL_TOKEN}|${ESCAPE}|${DOUBLE_STRING}|${SINGLE_STRING}`,
    'gi',
)
const IMPORT_SCAN = new RegExp(
    `${COMMENT}|${IMPORT_RULE}|${ESCAPE}|${DOUBLE_STRING}|${SINGLE_STRING}|\\{`,
    'gi',
)
const NAMESPACE_SCAN = new RegExp(
    `${COMMENT}|${NAMESPACE_RULE}|${ESCAPE}|${DOUBLE_STRING}|${SINGLE_STRING}`,
    'gi',
)
const COMMENTS = new RegExp(COMMENT, 'g')

const SELECTOR_SCAN =
    /"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?|\[(?:[^\]"']|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')*\]?|:root(?![\w-])|(?:[.#]|::?)?-{0,2}(?:[a-z_\u0080-\uffff]|\\[\s\S])(?:[\w\u0080-\uffff-]|\\[\s\S])*/gi
const SELECTOR_HINT = /html|body|:root|epub/i
// `:host`, `:host()` and `:host-context()` select the element that has the shadow root.
const HOST_SELECTOR = /:host/i
const HOST_HINT = /:host|@scope|\\/i
const EPUB_TYPE_SELECTOR = /^\[\s*epub(?:\||\\:)type(?![\w-])/i

// One token for `fontFaceBlocks`: an escape, a string, the start of a `@font-face` block, or
// a brace. Each alternative takes its text or fails after a short scan, so the scan reads the
// text one time. One pattern for the full block does not have this property. From each
// `@font-face` it reads to the end of the text when a string or the block has no end, and a
// text with many such starts would stop the page for minutes.
const FONT_FACE_SCAN = new RegExp(
    `${ESCAPE}|${DOUBLE_STRING}|${SINGLE_STRING}|@font-face\\s*\\{|[{}]`,
    'gi',
)

// The text scanner can miss a URL when the CSS has one of these. Then `buildSheet` also checks
// the parsed values.
const STRICT_HINT = /\\|image-set|src\(/i
const URL_FUNCTION_HINT = /url\(|image-set\(|src\(/i
const PAGE_BREAKS = new Set(['page', 'left', 'right', 'recto', 'verso', 'always'])

// The sizes that browsers give the absolute keywords, as a part of the parent size.
const FONT_SIZE_KEYWORDS = new Map([
    ['xx-small', '0.5625em'],
    ['x-small', '0.625em'],
    ['small', '0.8125em'],
    ['medium', '1em'],
    ['large', '1.125em'],
    ['x-large', '1.5em'],
    ['xx-large', '2em'],
    ['xxx-large', '3em'],
])
// The dot and the digits after it are one optional group. With `\d+\.?\d*`, a long row of
// digits that no unit follows has a split at each digit, and the test of all the splits
// would stop the page for minutes.
const ABSOLUTE_LENGTH = /^\+?((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|pt|pc|in|cm|mm|q))$/i
// `url()` with nothing or an empty string in it. The white space before the string is in the
// optional group, so a long row of spaces with no `)` after it has only one reading.
const EMPTY_URL = /url\((?:\s*(?:""|''))?\s*\)/i

/** The reader views set this property on `rd-html` to the font size setting divided by 16. */
export const SCALE_PROPERTY = '--rd-scale'

export function decodeCssEscapes(text: string): string {
    if (!text.includes('\\')) return text
    return text.replace(
        /\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi,
        (_match, hex: string | undefined, char: string | undefined) => {
            if (hex === undefined) return char === '\n' ? '' : (char ?? '')
            const code = parseInt(hex, 16)
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd'
        },
    )
}

function isLocalUrl(url: string): boolean {
    return url === '' || url.charCodeAt(0) === 35 || /^(?:blob|data):/i.test(url)
}

/**
 * Call `resolve` for each `url()` token and put its result in the text. A null result gives
 * `url("")`. Data URLs and URLs that are only a fragment (`url(#clip)`) stay as written.
 */
export function rewriteCssUrls(css: string, resolve: (url: string) => string | null): string {
    if (!css.includes('\\') && !/url\(/i.test(css)) return css

    return css.replace(URL_SCAN, (match, ...groups: (string | undefined)[]) => {
        // With no function name, the match is a comment, an escape or a string.
        if (groups[0] === undefined) return match

        const url = decodeCssEscapes(groups[1] ?? groups[2] ?? groups[3] ?? '').trim()
        if (url.charCodeAt(0) === 35 || /^data:/i.test(url)) return match

        const next = url ? resolve(url) : null
        return next ? `url("${next.replace(/["\\\n\r]/g, encodeURIComponent)}")` : 'url("")'
    })
}

/** All `@import` rules of a CSS text, in source order. */
export function findImports(css: string): CssImport[] {
    const imports: CssImport[] = []
    if (!/@import/i.test(css)) return imports

    let leading = true
    for (const match of css.matchAll(IMPORT_SCAN)) {
        const text = match[0]
        if (text === '{') {
            leading = false
            continue
        }
        // A match that does not start with `@` is a comment, an escape or a string.
        if (text.charCodeAt(0) !== 64) continue

        const url = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? ''
        const media = match[6].replace(COMMENTS, ' ').trim()
        imports.push({
            url: decodeCssEscapes(url).trim(),
            media: media || null,
            leading: leading && match[7] !== undefined,
            start: match.index,
            end: match.index + text.length,
        })
    }
    return imports
}

/**
 * Change a selector of the book so that it matches the reader DOM. The type selectors `html`
 * and `body` become `rd-html` and `rd-body`, `:root` becomes `rd-html`, and an attribute
 * selector on `epub|type` becomes one on `data-epub-type`.
 */
export function rewriteSelector(selector: string): string {
    return selector.replace(SELECTOR_SCAN, (match, offset: number) => {
        const first = match.charCodeAt(0)
        if (first === 91) return match.replace(EPUB_TYPE_SELECTOR, '[data-epub-type')
        if (first === 34 || first === 39) return match
        if (first === 58) {
            if (match.toLowerCase() !== ':root') return match
            // A type selector is valid only at the start of a compound selector.
            return startsCompound(selector, offset) ? 'rd-html' : ':is(rd-html)'
        }
        const name = match.toLowerCase()
        return name === 'html' ? 'rd-html' : name === 'body' ? 'rd-body' : match
    })
}

function startsCompound(selector: string, offset: number): boolean {
    return offset === 0 || /[\s>+~,(]/.test(selector[offset - 1])
}

/** True when the text is safe to put after `@media` or `@import` in generated CSS. */
export function isSafeMediaQuery(media: string): boolean {
    return !/[{};\\]|\/\*|url\(/i.test(media)
}

function matchingParen(text: string, open: number): number {
    let depth = 0
    for (let i = open; i < text.length; i++) {
        const char = text.charCodeAt(i)
        if (char === 40) depth++
        else if (char === 41 && --depth === 0) return i
    }
    return -1
}

/** Wrap imported CSS in the conditions of its `@import` rule. */
function wrapImported(css: string, condition: string | null): string {
    if (!condition) return css

    let rest = condition
    let open = ''
    let close = ''
    const layer = /^layer(?:\(\s*([\w.-]+)\s*\))?(?=\s|$)/i.exec(rest)
    if (layer) {
        open += `@layer ${layer[1] ?? ''} {`
        close += '}'
        rest = rest.slice(layer[0].length).trim()
    }
    if (/^supports\(/i.test(rest)) {
        const end = matchingParen(rest, 8)
        if (end < 0) return ''
        open += `@supports (${rest.slice(9, end)}) {`
        close += '}'
        rest = rest.slice(end + 1).trim()
    }
    if (rest) {
        open += `@media ${rest} {`
        close += '}'
    }
    return `${open}\n${css}\n${close}`
}

/**
 * Take the `@namespace` rules out of the text. After `@import` inlining they are not at the
 * start of the sheet, where the parser needs them. The caller puts the rules with a prefix
 * back at the start. The function drops a default namespace, because it would apply to all
 * inlined files.
 */
function extractNamespaces(css: string): { css: string; namespaces: string[] } {
    const namespaces: string[] = []
    if (!/@namespace/i.test(css)) return { css, namespaces }

    const rest = css.replace(NAMESPACE_SCAN, (match, prefix: string | undefined) => {
        if (match.charCodeAt(0) !== 64) return match
        if (prefix) namespaces.push(match.endsWith(';') ? match : `${match};`)
        return ''
    })
    return { css: rest, namespaces }
}

/**
 * Rewrite each `url()` of a CSS text to an object URL from the resource store. `paths` has
 * one entry for each `acquire` call that the caller must `release` later.
 */
export async function resolveCssUrls({
    css,
    path,
    book,
    resources,
}: CssSource & { css: string }): Promise<{ css: string; paths: string[] }> {
    const urls = new Set<string>()
    const blank = rewriteCssUrls(css, (url) => {
        urls.add(url)
        return null
    })
    const paths: string[] = []
    if (!urls.size) return { css: blank, paths }

    const objectUrls = new Map<string, string>()
    await Promise.all(
        [...urls].map(async (url) => {
            const target = resolveFile({ book, from: path, href: url })
            if (!target) return
            try {
                const objectUrl = await resources.acquire(target.path)
                paths.push(target.path)
                objectUrls.set(url, target.fragment ? `${objectUrl}#${target.fragment}` : objectUrl)
            } catch {
                // The URL stays empty.
            }
        }),
    )
    return { css: rewriteCssUrls(css, (url) => objectUrls.get(url) ?? null), paths }
}

interface ExpandOptions extends CssSource {
    css: string
    depth: number
    /** Paths of the files that import this text, to stop on a cycle. */
    chain: readonly string[]
    /** The number of files that the top stylesheet can still import. */
    budget: { files: number }
}

interface ExpandedCss {
    css: string
    namespaces: string[]
}

async function expand(options: ExpandOptions): Promise<ExpandedCss> {
    const { book, resources, css, path, depth, chain, budget } = options
    const imports = findImports(css)
    const parts: string[] = []
    const namespaces: string[] = []
    let own = css

    if (imports.length) {
        const imported = await Promise.all(
            imports.map(async (rule): Promise<ExpandedCss | null> => {
                if (!rule.leading || depth >= MAX_IMPORT_DEPTH) return null
                if (rule.media !== null && !isSafeMediaQuery(rule.media)) return null
                const target = resolveFile({ book, from: path, href: rule.url })
                if (!target || chain.includes(target.path) || budget.files <= 0) return null
                budget.files--
                try {
                    const inner = await expand({
                        book,
                        resources,
                        css: await book.readText(target.path),
                        path: target.path,
                        depth: depth + 1,
                        chain: [...chain, target.path],
                        budget,
                    })
                    return {
                        css: wrapImported(inner.css, rule.media),
                        namespaces: inner.namespaces,
                    }
                } catch {
                    return null
                }
            }),
        )

        const kept: string[] = []
        let cursor = 0
        for (let i = 0; i < imports.length; i++) {
            kept.push(css.slice(cursor, imports[i].start))
            cursor = imports[i].end
            const result = imported[i]
            if (!result) continue
            parts.push(result.css)
            for (const rule of result.namespaces) namespaces.push(rule)
        }
        kept.push(css.slice(cursor))
        own = kept.join('')
    }

    const extracted = extractNamespaces(own)
    for (const rule of extracted.namespaces) namespaces.push(rule)
    const resolved = await resolveCssUrls({ css: extracted.css, path, book, resources })
    parts.push(resolved.css)
    return { css: parts.join('\n'), namespaces }
}

/**
 * Make a CSS text of the book ready for `buildSheet`. This inlines the `@import` rules and
 * rewrites each `url()` to an object URL. The object URLs stay valid until the store is
 * disposed.
 */
export async function resolveCssText({
    css,
    path,
    book,
    resources,
    media,
}: CssSource & { css: string }): Promise<string> {
    if (media && !isSafeMediaQuery(media)) return ''

    const result = await expand({
        book,
        resources,
        css,
        path,
        depth: 0,
        chain: [path],
        budget: { files: MAX_IMPORTED_FILES },
    })
    const body = media ? `@media ${media} {\n${result.css}\n}` : result.css
    const namespaces = [...new Set(result.namespaces)]
    return namespaces.length ? `${namespaces.join('\n')}\n${body}` : body
}

/** Read a CSS file of the book and make it ready for `buildSheet`. */
export async function loadStylesheetText(source: CssSource): Promise<string> {
    return resolveCssText({ ...source, css: await source.book.readText(source.path) })
}

/** Split at each separator that is not inside a string or inside brackets of any type. */
function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = []
    let depth = 0
    let quote = ''
    let start = 0
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (char === '\\') i++
        else if (quote) quote = char === quote ? '' : quote
        else if (char === '"' || char === "'") quote = char
        else if (char === '(' || char === '[' || char === '{') depth++
        else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
        else if (char === separator && depth === 0) {
            parts.push(text.slice(start, i))
            start = i + 1
        }
    }
    parts.push(text.slice(start))
    return parts
}

/**
 * True when a parsed CSS value can load only object URLs, data URLs and local fragments.
 * In `image-set()` and `src()` a plain string is also a URL.
 */
export function isLocalCssValue(value: string): boolean {
    if (!value.includes('(')) return true

    const stringsAreUrls = /image-set\(|src\(/i.test(value)
    if (stringsAreUrls && /(?:var|attr|env)\(/i.test(value)) return false

    for (const match of value.matchAll(URL_SCAN)) {
        const text = match[0]
        const first = text.charCodeAt(0)
        if (match[1] !== undefined) {
            const url = decodeCssEscapes(match[2] ?? match[3] ?? match[4] ?? '').trim()
            if (!isLocalUrl(url)) return false
        } else if (stringsAreUrls && (first === 34 || first === 39)) {
            const content = decodeCssEscapes(text.slice(1, text.endsWith(text[0]) ? -1 : undefined))
            // A media type is the argument of `type()`.
            if (!isLocalUrl(content.trim()) && !/^[\w.+-]+\/[\w.+-]+$/.test(content)) return false
        }
    }
    return true
}

/** True when the text has a function that can load a URL, also with CSS escapes in its name. */
function hasUrlFunction(text: string): boolean {
    return URL_FUNCTION_HINT.test(decodeCssEscapes(text))
}

/**
 * The check of `isLocalCssValue` for text that the browser did not write in its normal form:
 * the value of a custom property, a value with `var()`, or a full rule. In such text an
 * escape can hide a URL from the scanner, so text with an escape and a URL function fails.
 */
function isLocalRawCss(text: string): boolean {
    if (text.includes('\\') && hasUrlFunction(text)) return false
    return isLocalCssValue(text)
}

/** Remove each declaration that can load a URL that is not local. */
function removeRemoteValues(style: CSSStyleDeclaration): void {
    const text = style.cssText
    if (!hasUrlFunction(text)) return

    // The serialised text has each declaration one time. It also has the values with `var()`,
    // which the list of longhand properties gives as empty.
    for (const declaration of splitTopLevel(text, ';')) {
        const colon = declaration.indexOf(':')
        if (colon < 0) continue
        const name = declaration.slice(0, colon).trim()
        const value = declaration.slice(colon + 1)
        const raw = name.startsWith('--') || /var\(/i.test(value)
        if (!(raw ? isLocalRawCss(value) : isLocalCssValue(value))) style.removeProperty(name)
    }
}

function fixBreak(style: CSSStyleDeclaration, side: 'before' | 'after'): void {
    const name = side === 'before' ? 'break-before' : 'break-after'
    const legacyName = side === 'before' ? 'page-break-before' : 'page-break-after'
    if (PAGE_BREAKS.has(style.getPropertyValue(name))) {
        style.setProperty(name, 'column', style.getPropertyPriority(name))
        return
    }
    // Some engines keep the old property as written and do not map it to the new one.
    const legacy = style.getPropertyValue(legacyName)
    if (legacy === 'always' || legacy === 'left' || legacy === 'right') {
        const priority = style.getPropertyPriority(legacyName)
        style.removeProperty(legacyName)
        style.setProperty(name, 'column', priority)
    }
}

/**
 * A length in absolute units as a product with the scale of the reader, or null when the
 * value is not one absolute length. A length of zero stays as written.
 */
function scaleLength(value: string): string | null {
    const match = ABSOLUTE_LENGTH.exec(value.trim())
    if (!match || !(parseFloat(match[1]) > 0)) return null
    return `calc(${match[1]} * var(${SCALE_PROPERTY}, 1))`
}

/**
 * The value for a `font-size` declaration of the book that follows the font size setting of
 * the reader, or null when the value needs no change. An absolute keyword becomes a size in
 * `em`. A relative value, `calc()` and `var()` stay as written.
 */
export function scaleFontSize(value: string): string | null {
    return FONT_SIZE_KEYWORDS.get(value.trim().toLowerCase()) ?? scaleLength(value)
}

/** The same as `scaleFontSize` for `line-height`. A number without a unit stays as written. */
export function scaleLineHeight(value: string): string | null {
    return scaleLength(value)
}

function scaleDeclaration(style: CSSStyleDeclaration, name: 'font-size' | 'line-height'): void {
    const value = style.getPropertyValue(name)
    if (!value) return
    const next = name === 'font-size' ? scaleFontSize(value) : scaleLineHeight(value)
    if (next !== null) style.setProperty(name, next, style.getPropertyPriority(name))
}

/**
 * Many books set sizes in absolute units, and the font size setting then changes nothing.
 * The object model gives the parts of a `font` shorthand as `font-size` and `line-height`,
 * so this also changes the shorthand. A shorthand with `var()` has no parts and stays.
 */
function scaleFonts(style: CSSStyleDeclaration): void {
    scaleDeclaration(style, 'font-size')
    scaleDeclaration(style, 'line-height')
}

/**
 * A forced page break becomes a column break, because the paged view makes its pages with
 * CSS columns. `position: fixed` becomes `absolute`, so that book content cannot cover the
 * controls of the app.
 */
function fixLayout(style: CSSStyleDeclaration): void {
    fixBreak(style, 'before')
    fixBreak(style, 'after')
    if (style.getPropertyValue('position') === 'fixed') {
        style.setProperty('position', 'absolute', style.getPropertyPriority('position'))
    }
}

/**
 * Change the declarations that do not work in the reader: forced page breaks, fixed
 * positions, and font sizes and line heights in absolute units. With `strict`, the function
 * also removes a declaration that can load a remote URL.
 */
export function fixDeclarations(style: CSSStyleDeclaration, strict = false): void {
    fixLayout(style)
    scaleFonts(style)
    if (strict) removeRemoteValues(style)
}

/** True when CSS text needs the strict mode of `fixDeclarations`. */
export function needsStrictCheck(css: string): boolean {
    return STRICT_HINT.test(css)
}

function unquoteFamily(value: string): string {
    const text = value.trim()
    const quote = text[0]
    if ((quote === '"' || quote === "'") && text.endsWith(quote) && text.length > 1) {
        return decodeCssEscapes(text.slice(1, -1))
    }
    return decodeCssEscapes(text).replace(/\s+/g, ' ')
}

function toFontFaceSpec(read: (name: string) => string): FontFaceSpec | null {
    const family = unquoteFamily(read('font-family'))
    // An empty URL is a file that is not in the book.
    const src = splitTopLevel(read('src'), ',')
        .map((source) => source.trim())
        .filter((source) => source && !EMPTY_URL.test(source))
        .join(', ')
    if (!family || !src || !isLocalRawCss(src)) return null

    const optional = (name: string) => read(name).trim() || null
    return {
        family,
        src,
        weight: optional('font-weight'),
        style: optional('font-style'),
        stretch: optional('font-stretch'),
        unicodeRange: optional('unicode-range'),
        display: optional('font-display'),
    }
}

/**
 * The text between the braces of each `@font-face` rule, in source order. A rule that has a
 * block in it or that has no end gives nothing. The text must have no comments.
 */
function fontFaceBlocks(css: string): string[] {
    const blocks: string[] = []
    // The start of the text of the rule that is open, or -1.
    let start = -1
    for (const match of css.matchAll(FONT_FACE_SCAN)) {
        const first = match[0].charCodeAt(0)
        if (first === 64) {
            // `@font-face {`
            start = match.index + match[0].length
        } else if (first === 123) {
            // `{` of a different rule, or of a block in the font face rule.
            start = -1
        } else if (first === 125) {
            if (start >= 0) blocks.push(css.slice(start, match.index))
            start = -1
        }
        // An escape or a string. A brace in it is not the end of a block.
    }
    return blocks
}

/** For environments where the CSS object model does not give the `@font-face` descriptors. */
function findFontFacesInText(css: string): FontFaceSpec[] {
    const specs: FontFaceSpec[] = []
    if (!/@font-face/i.test(css)) return specs

    for (const block of fontFaceBlocks(css.replace(COMMENTS, ''))) {
        const declarations = new Map<string, string>()
        for (const declaration of splitTopLevel(block, ';')) {
            const colon = declaration.indexOf(':')
            if (colon < 0) continue
            declarations.set(
                declaration.slice(0, colon).trim().toLowerCase(),
                declaration.slice(colon + 1).trim(),
            )
        }
        const spec = toFontFaceSpec((name) => declarations.get(name) ?? '')
        if (spec) specs.push(spec)
    }
    return specs
}

type RuleType =
    | 'CSSStyleRule'
    | 'CSSFontFaceRule'
    | 'CSSPageRule'
    | 'CSSImportRule'
    | 'CSSNamespaceRule'
    | 'CSSScopeRule'

function isRule(rule: CSSRule, type: RuleType): boolean {
    const constructor = (globalThis as Record<string, unknown>)[type]
    return typeof constructor === 'function' && rule instanceof constructor
}

interface RuleOwner {
    readonly cssRules: CSSRuleList
    deleteRule(index: number): void
}

interface CleanState {
    fontFaces: FontFaceSpec[]
    rewriteSelectors: boolean
    /** True when a rule can select the shadow host. */
    hostRules: boolean
    fixLayout: boolean
    scaleFonts: boolean
    strict: boolean
    /** True when the object model did not give the `src` of a font face (jsdom). */
    missingFontSource: boolean
}

function rewriteRuleSelector(rule: CSSStyleRule): void {
    const selector = rule.selectorText
    if (!SELECTOR_HINT.test(selector)) return
    const next = rewriteSelector(selector)
    if (next === selector) return
    try {
        rule.selectorText = next
    } catch {
        // The rule keeps a selector that matches nothing in the reader DOM.
    }
}

/**
 * True when the rule can style the element that has the shadow root. The view adopts the
 * sheet in its shadow root, and this element is a part of the app. A `@scope` rule with no
 * start has the shadow host as its root, so `:scope` in the rule selects the host.
 */
function selectsHost(rule: CSSRule): boolean {
    if (isRule(rule, 'CSSStyleRule')) return HOST_SELECTOR.test((rule as CSSStyleRule).selectorText)
    if (isRule(rule, 'CSSScopeRule')) {
        const start = (rule as CSSScopeRule).start
        return !start || HOST_SELECTOR.test(start)
    }
    return false
}

function cleanRules(owner: RuleOwner, state: CleanState): void {
    const rules = owner.cssRules
    // Backward, so that a delete does not move the rules that are not visited yet.
    for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i]
        if (isRule(rule, 'CSSFontFaceRule')) {
            const descriptors = (rule as CSSFontFaceRule).style
            if (!descriptors.getPropertyValue('src')) state.missingFontSource = true
            const spec = toFontFaceSpec((name) => descriptors.getPropertyValue(name))
            if (spec) state.fontFaces.push(spec)
            owner.deleteRule(i)
            continue
        }
        if (isRule(rule, 'CSSPageRule') || isRule(rule, 'CSSImportRule')) {
            owner.deleteRule(i)
            continue
        }
        if (state.hostRules && selectsHost(rule)) {
            owner.deleteRule(i)
            continue
        }
        if (state.rewriteSelectors && isRule(rule, 'CSSStyleRule')) {
            rewriteRuleSelector(rule as CSSStyleRule)
        }

        // Style rules, keyframes and nested declarations have a `style`.
        const { style, cssRules } = rule as Partial<CSSStyleRule>
        if (style) {
            if (state.fixLayout) fixLayout(style)
            if (state.scaleFonts) scaleFonts(style)
            if (state.strict) removeRemoteValues(style)
        } else if (
            state.strict &&
            !cssRules &&
            !isRule(rule, 'CSSNamespaceRule') &&
            !isLocalRawCss(rule.cssText)
        ) {
            // For example a counter style that has a remote image as a symbol.
            owner.deleteRule(i)
            continue
        }
        if (cssRules && cssRules.length) cleanRules(rule as unknown as RuleOwner, state)
    }
}

function createSheet(cssText: string): CSSStyleSheet | null {
    if (
        typeof CSSStyleSheet !== 'function' ||
        typeof CSSStyleSheet.prototype.replaceSync !== 'function'
    ) {
        return null
    }
    try {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(cssText)
        return sheet
    } catch {
        return null
    }
}

/**
 * Make a constructable stylesheet from CSS text that came from `resolveCssText`. The sheet
 * has no `@font-face`, `@page` or `@import` rules. The function returns the font faces as
 * data, because a `@font-face` rule does nothing in a shadow root.
 */
export function buildSheet(cssText: string): BuiltSheet {
    const sheet = createSheet(cssText)
    if (!sheet) return { sheet: null, fontFaces: findFontFacesInText(cssText) }

    const strict = needsStrictCheck(cssText)
    const state: CleanState = {
        fontFaces: [],
        rewriteSelectors: SELECTOR_HINT.test(cssText),
        hostRules: HOST_HINT.test(cssText),
        fixLayout: strict || /break-|position/i.test(cssText),
        scaleFonts: strict || /font|line-height/i.test(cssText),
        strict,
        missingFontSource: false,
    }
    cleanRules(sheet, state)

    const fontFaces = state.missingFontSource
        ? findFontFacesInText(cssText)
        : state.fontFaces.reverse()
    return { sheet, fontFaces }
}

function createFontFace(spec: FontFaceSpec): FontFace | null {
    const descriptors: FontFaceDescriptors = {}
    if (spec.weight) descriptors.weight = spec.weight
    if (spec.style) descriptors.style = spec.style
    if (spec.stretch) descriptors.stretch = spec.stretch
    if (spec.unicodeRange) descriptors.unicodeRange = spec.unicodeRange
    if (spec.display) descriptors.display = spec.display as FontDisplay

    // Some engines parse the family as CSS and reject a name such as `1942 report`. For a
    // value that it cannot parse, an engine throws or gives a face with the status `error`.
    for (const family of [spec.family, JSON.stringify(spec.family)]) {
        try {
            const face = new FontFace(family, spec.src, descriptors)
            // A bad value rejects this promise. Nothing reads it, so mark it as handled.
            face.loaded.catch(() => {})
            if (face.status !== 'error') return face
        } catch {
            // Try the quoted name.
        }
    }
    return null
}

/**
 * Add the font faces to `document.fonts`. This does not load them. The browser loads a face
 * when text uses it. Returns the faces that were added, for `unregisterFontFaces`.
 */
export function registerFontFaces(specs: readonly FontFaceSpec[]): FontFace[] {
    const handles: FontFace[] = []
    if (typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) {
        return handles
    }
    for (const spec of specs) {
        const face = createFontFace(spec)
        if (!face) continue
        try {
            document.fonts.add(face)
            handles.push(face)
        } catch {
            // The other faces can still work.
        }
    }
    return handles
}

export function unregisterFontFaces(handles: readonly FontFace[]): void {
    if (typeof document === 'undefined' || !document.fonts) return
    for (const face of handles) document.fonts.delete(face)
}
