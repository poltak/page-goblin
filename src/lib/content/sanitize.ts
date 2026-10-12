/**
 * Turns one EPUB content document into a new DOM tree that is safe to show.
 *
 * The book is untrusted input. This file only reads the parsed document. It makes each node
 * of the result from an allow list, so an element or attribute that this file does not name
 * cannot be in the result.
 */

import type { EpubBook } from '$lib/epub/types'
import { decodeCssEscapes, isSafeMediaQuery } from './css'
import { normalizeLanguage } from './language'
import { INTERNAL_LINK_FRAGMENT_ATTR, INTERNAL_LINK_PATH_ATTR } from './types'
import { resolveFile, resolveHref, wordSet } from './util'

/** On `<a>` elements that open a web or mail address. */
export const EXTERNAL_LINK_ATTR = 'data-rd-external'
/** Container path of the image file, on `<img>` and SVG `<image>` elements. */
export const IMAGE_PATH_ATTR = 'data-rd-src'
/** The `style` attribute of the book. The loader rewrites its URLs and then applies it. */
export const PENDING_STYLE_ATTR = 'data-rd-style'
/** The value of `epub:type`. */
export const EPUB_TYPE_ATTR = 'data-epub-type'

export type StyleSource =
    { kind: 'link'; path: string; media?: string } | { kind: 'inline'; css: string }

export interface SanitizeOptions {
    xhtml: string
    /** Container path of the content document. Relative URLs resolve against it. */
    path: string
    book: EpubBook
}

export interface SanitizedDocument {
    /** An `<rd-html>` element. */
    root: HTMLElement
    /** An `<rd-body>` element, the only child of `root`. */
    body: HTMLElement
    /** The language of the document from `normalizeLanguage`, or null when it has none. */
    lang: string | null
    dir: 'ltr' | 'rtl' | null
    /** Stylesheets of the document in cascade order. */
    styleSources: StyleSource[]
    /**
     * `<img>` and SVG `<image>` elements that show an image: a file of the book in
     * `data-rd-src`, or a data URL in `src` (`href` for SVG).
     */
    images: Element[]
}

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS = 'http://www.w3.org/2000/svg'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const OPS_NS = 'http://www.idpf.org/2007/ops'

const KEPT_HTML = wordSet(
    'a abbr address article aside b bdi bdo big blockquote br caption center cite code col ' +
        'colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 ' +
        'h6 header hgroup hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp ' +
        'section small span strike strong sub summary sup table tbody td tfoot th thead time ' +
        'tr tt u ul var wbr',
)
const REMOVED_HTML = wordSet(
    'script style template iframe frame frameset object embed applet form input button select ' +
        'textarea option link meta base title head noscript audio video source track canvas ' +
        'map area dialog',
)
const VOID_HTML = wordSet('area base br col embed hr img input link meta param source track wbr')
const KEPT_SVG = wordSet(
    'svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient ' +
        'radialGradient stop clipPath mask pattern marker image use symbol title desc',
)

const GLOBAL_ATTRS = wordSet('id class lang dir title hidden role')
const HTML_ATTRS = wordSet(
    'colspan rowspan scope headers span start reversed datetime alt width height align valign ' +
        'border cellpadding cellspacing',
)
const SVG_ATTRS = wordSet(
    'viewBox preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry d points transform fill ' +
        'fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin ' +
        'stroke-dasharray stroke-opacity opacity offset stop-color stop-opacity gradientUnits ' +
        'gradientTransform clip-path clip-rule mask font-size font-family font-weight ' +
        'text-anchor dx dy width height patternUnits patternContentUnits patternTransform ' +
        'spreadMethod stroke-miterlimit stroke-dashoffset fx fy text-decoration ' +
        'letter-spacing dominant-baseline alignment-baseline vector-effect marker-start ' +
        'marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient',
)
// These elements can take their content from a different element of the same document.
const SVG_PAINT_SERVERS = wordSet('linearGradient radialGradient pattern')
const SVG_VALUE_FUNCTIONS = wordSet(
    'url rgb rgba hsl hsla translate scale rotate skewx skewy matrix',
)
const NAME_CHARACTER = /[\w-]/
// Presentation attributes of MathML. None of them can hold a URL.
const MATHML_ATTRS = wordSet(
    'display displaystyle mathvariant mathsize mathcolor mathbackground scriptlevel stretchy ' +
        'fence separator lspace rspace largeop movablelimits symmetric maxsize minsize accent ' +
        'accentunder form linethickness columnalign rowalign columnspacing rowspacing ' +
        'columnlines rowlines frame framespacing columnspan rowspan open close separators ' +
        'notation depth voffset width height numalign denomalign bevelled subscriptshift ' +
        'superscriptshift',
)
const ROOT_ATTRS = wordSet(`lang dir class ${EPUB_TYPE_ATTR}`)
const BODY_ATTRS = wordSet(`id class lang dir ${PENDING_STYLE_ATTR} ${EPUB_TYPE_ATTR}`)

const EXTERNAL_PROTOCOLS = wordSet('http: https: mailto:')
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const UNSAFE_STYLE = /expression\(|javascript:|-moz-binding|@import/i
const BEHAVIOR = 'behavior'
const BEHAVIOR_HINT = /behavior/i
const CSS_SPACE = new Set([' ', '\t', '\n', '\r', '\f'])
// Raster images only. An SVG image can load other files.
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i
const MAX_DATA_URL_LENGTH = 2 * 1024 * 1024
// The XML and HTML parsers stop before this depth. The limit only protects the call stack.
const MAX_DEPTH = 1024

/**
 * In HTML mode `<title/>` is a start tag, and the parser then reads the rest of the file as
 * the title. `<a id="x"/>` puts the rest of the chapter in the link. Write the tags of all
 * elements that are not void in the long form before an HTML parse.
 *
 * A value with no quotes must have white space after it. In `<a href=https://example.com/>`
 * the slash is a part of the value, and the tag is not self-closed.
 */
function expandSelfClosedTags(markup: string): string {
    return markup.replace(
        /<([a-zA-Z][\w:.-]*)((?:\s+[^\s<>"'/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+(?=\s)))?)*)\s*\/>/g,
        (match, name: string, attributes: string) =>
            VOID_HTML.has(name.toLowerCase()) ? match : `<${name}${attributes}></${name}>`,
    )
}

function parseContentDocument(xhtml: string): Document {
    const source = xhtml.charCodeAt(0) === 0xfeff ? xhtml.slice(1) : xhtml
    const parser = new DOMParser()
    const xml = parser.parseFromString(source, 'application/xhtml+xml')
    const root = xml.documentElement
    // Browsers put the parser error element in different positions.
    if (
        root &&
        root.namespaceURI === HTML_NS &&
        root.localName === 'html' &&
        xml.getElementsByTagName('parsererror').length === 0
    ) {
        return xml
    }
    return parser.parseFromString(expandSelfClosedTags(source), 'text/html')
}

function isHtmlElement(element: Element, name: string): boolean {
    return element.namespaceURI === HTML_NS && element.localName.toLowerCase() === name
}

/** Attribute names are case-sensitive in an XML document. This lookup is not. */
function readAttribute(element: Element, name: string): string | null {
    const value = element.getAttribute(name)
    if (value !== null) return value
    const attributes = element.attributes
    for (let i = 0; i < attributes.length; i++) {
        const attribute = attributes[i]
        if (attribute.namespaceURI === null && attribute.name.toLowerCase() === name) {
            return attribute.value
        }
    }
    return null
}

/**
 * True when a style attribute can have a declaration with the name `behavior`, which loaded
 * a script in old browsers. `scroll-behavior` and `overscroll-behavior` are different names.
 * The text must have its CSS escapes decoded. A comment can be between the name and the
 * colon.
 */
function hasBehaviorDeclaration(css: string): boolean {
    const text = css.toLowerCase()
    // The first `*/` after the last search position. A later search starts after it, so the
    // scan reads the text only one time.
    let close = -1
    let hasClose = true
    // The end of the last comment that the scan went over. Many names can have a comment
    // that ends there. The text after it gave no colon, so it is not read again.
    let passed = -1
    names: for (let at = text.indexOf(BEHAVIOR); at >= 0; at = text.indexOf(BEHAVIOR, at + 1)) {
        if (at > 0 && NAME_CHARACTER.test(text[at - 1])) continue
        let i = at + BEHAVIOR.length
        for (;;) {
            while (CSS_SPACE.has(text[i])) i++
            if (!text.startsWith('/*', i)) break
            if (hasClose && close < i + 2) {
                close = text.indexOf('*/', i + 2)
                hasClose = close >= 0
            }
            if (!hasClose) break
            if (close + 2 === passed) continue names
            i = close + 2
            passed = i
        }
        if (text[i] === ':') return true
    }
    return false
}

function isSafeStyle(value: string): boolean {
    if (UNSAFE_STYLE.test(value)) return false
    // A CSS escape can hide one of the keywords.
    const escaped = value.includes('\\')
    const decoded = escaped ? decodeCssEscapes(value) : value
    if (escaped && UNSAFE_STYLE.test(decoded)) return false
    // Old browsers ignored a comment inside a keyword.
    if (value.includes('/*')) {
        const plain = decodeCssEscapes(value.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ''))
        if (UNSAFE_STYLE.test(plain)) return false
    }
    return !(BEHAVIOR_HINT.test(decoded) && hasBehaviorDeclaration(decoded))
}

/**
 * The `src` of an image when it is a data URL of a raster image, else null. A browser
 * removes white space and control characters at the start of a URL.
 */
function dataImageUrl(href: string): string | null {
    if (href.length > MAX_DATA_URL_LENGTH) return null
    const url = href.replace(/^[\u0000-\u0020]+/, '')
    return DATA_IMAGE.test(url) ? url : null
}

/**
 * True when an SVG presentation attribute cannot load a file. Each `url()` must point into
 * the same document. A function that is not in the list fails, because some functions take
 * a URL as a plain string (`image-set()`).
 */
function hasOnlyLocalUrls(value: string): boolean {
    if (!value.includes('(')) return true
    // An escape can hide a function name.
    if (value.includes('\\')) return false
    for (let open = value.indexOf('('); open >= 0; open = value.indexOf('(', open + 1)) {
        let start = open
        while (start > 0 && NAME_CHARACTER.test(value[start - 1])) start--
        if (!SVG_VALUE_FUNCTIONS.has(value.slice(start, open).toLowerCase())) return false
    }
    for (const match of value.matchAll(/url\(\s*(?:"([^"]*)"?|'([^']*)'?|([^)]*))/gi)) {
        const target = (match[1] ?? match[2] ?? match[3] ?? '').trim()
        if (target.charCodeAt(0) !== 35) return false
    }
    return true
}

function isAllowedHtmlAttribute(element: string, name: string): boolean {
    if (HTML_ATTRS.has(name)) return true
    switch (name) {
        case 'type':
            return element === 'ol'
        case 'value':
            return element === 'li'
        case 'size':
        case 'color':
        case 'face':
            return element === 'font'
        // An old form of a link target. The loader puts it in the anchor map.
        case 'name':
            return element === 'a'
        default:
            return false
    }
}

/** Copy the attributes of the allow list from an element of the book to its new element. */
function copyAttributes(source: Element, target: Element): void {
    const svg = target.namespaceURI === SVG_NS
    const math = target.namespaceURI === MATHML_NS
    const element = target.localName
    const attributes = source.attributes
    let xmlLang: string | null = null

    for (let i = 0; i < attributes.length; i++) {
        const attribute = attributes[i]
        const namespace = attribute.namespaceURI
        const value = attribute.value
        // SVG attribute names are case-sensitive (`viewBox`).
        const name = svg ? attribute.name : attribute.name.toLowerCase()

        if (namespace === XML_NS ? attribute.localName === 'lang' : name === 'xml:lang') {
            xmlLang = normalizeLanguage(value) ?? value
        } else if (namespace === OPS_NS ? attribute.localName === 'type' : name === 'epub:type') {
            target.setAttribute(EPUB_TYPE_ATTR, value)
        } else if (namespace !== null || name.startsWith('on')) {
            continue
        } else if (name === 'style') {
            if (isSafeStyle(value)) target.setAttribute(PENDING_STYLE_ATTR, value)
        } else if (name === 'lang') {
            // A value such as `en_US` or `eng` gives no hyphenation in a browser.
            target.setAttribute(name, normalizeLanguage(value) ?? value)
        } else if (
            GLOBAL_ATTRS.has(name) ||
            (name.startsWith('aria-') && /^aria-[a-z]+$/.test(name)) ||
            (svg
                ? SVG_ATTRS.has(name) && hasOnlyLocalUrls(value)
                : math
                  ? MATHML_ATTRS.has(name)
                  : isAllowedHtmlAttribute(element, name))
        ) {
            target.setAttribute(name, value)
        }
    }

    if (xmlLang !== null && !target.hasAttribute('lang')) target.setAttribute('lang', xmlLang)
}

interface RootAttributes {
    source: Element
    target: Element
    allowed: ReadonlySet<string>
}

function copyRootAttributes({ source, target, allowed }: RootAttributes): void {
    copyAttributes(source, target)
    for (const name of target.getAttributeNames()) {
        if (!allowed.has(name)) target.removeAttribute(name)
    }
}

/** An absolute web or mail address in its normal form, or null. */
function externalUrl(href: string): string | null {
    try {
        // The URL parser reads the scheme in the same way as the browser.
        const url = new URL(href)
        return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null
    } catch {
        return null
    }
}

/** The `media` attribute when it limits the stylesheet, or null for all media. */
function readMedia(element: Element): string | null {
    const media = (readAttribute(element, 'media') ?? '').trim()
    return media && media.toLowerCase() !== 'all' ? media : null
}

function readDirection(element: Element): 'ltr' | 'rtl' | null {
    const dir = (element.getAttribute('dir') ?? '').toLowerCase()
    return dir === 'ltr' || dir === 'rtl' ? dir : null
}

/**
 * The language of `rd-html` or `rd-body`. A value that names no language is removed, so that
 * the element gets the language of its parent.
 */
function documentLanguage(element: Element): string | null {
    const lang = normalizeLanguage(element.getAttribute('lang'))
    if (lang === null) element.removeAttribute('lang')
    return lang
}

function appendText(target: Node, data: string): void {
    if (!data) return
    const last = target.lastChild
    if (last && last.nodeType === 3) (last as Text).appendData(data)
    else target.appendChild(document.createTextNode(data))
}

/** Copies the safe part of one parsed document into new nodes of the main document. */
class TreeBuilder {
    readonly styleSources: StyleSource[] = []
    readonly images: Element[] = []
    private readonly book: EpubBook
    private readonly path: string
    private depth = 0

    constructor(book: EpubBook, path: string) {
        this.book = book
        this.path = path
    }

    copyChildren(source: Node, target: Node): void {
        if (this.depth >= MAX_DEPTH) return
        this.depth++
        for (let node = source.firstChild; node; node = node.nextSibling) {
            const type = node.nodeType
            if (type === 3 || type === 4) appendText(target, (node as CharacterData).data)
            else if (type === 1) this.copyElement(node as Element, target)
        }
        this.depth--
    }

    copyElement(source: Element, target: Node): void {
        const namespace = source.namespaceURI
        if (namespace === SVG_NS) {
            this.copySvgElement(source, target)
            return
        }
        if (namespace === MATHML_NS) {
            this.copyMathElement(source, target)
            return
        }

        // An XML document can have upper-case names. They get the rules of the lower-case names.
        const name = source.localName.toLowerCase()
        if (namespace === HTML_NS && KEPT_HTML.has(name)) {
            const element = document.createElement(name)
            copyAttributes(source, element)
            if (name === 'a') {
                this.setLinkTarget(source, element)
            } else if (name === 'img') {
                element.setAttribute('decoding', 'async')
                this.setImageSource(readAttribute(source, 'src'), element)
            }
            target.appendChild(element)
            if (!VOID_HTML.has(name)) this.copyChildren(source, element)
            return
        }

        if (REMOVED_HTML.has(name)) {
            if (namespace === HTML_NS) this.collectStyle(source)
            return
        }

        // `epub:switch` has the same content in more than one form. Show only `epub:default`,
        // as each reader does that has no support for the element. The HTML parser keeps the
        // prefix in the name.
        if (namespace === OPS_NS ? name === 'case' : name === 'epub:case') return

        // Keep only the children of an element that is in no list.
        this.copyChildren(source, target)
    }

    /** Stylesheets of a part of the document that is not shown (the head). */
    collectStylesBelow(element: Element): void {
        const descendants = element.getElementsByTagName('*')
        for (let i = 0; i < descendants.length; i++) {
            if (descendants[i].namespaceURI === HTML_NS) this.collectStyle(descendants[i])
        }
    }

    private copySvgElement(source: Element, target: Node): void {
        const name = source.localName
        if (!KEPT_SVG.has(name)) return

        const local = name === 'use' || SVG_PAINT_SERVERS.has(name)
        const href =
            local || name === 'image'
                ? (source.getAttribute('href') ??
                  source.getAttributeNS(XLINK_NS, 'href') ??
                  source.getAttribute('xlink:href'))
                : null
        // These elements can load a different document. Only a reference into this document
        // is safe.
        const reference = local && href !== null ? href.trim() : ''
        const isLocal = reference.charCodeAt(0) === 35
        if (name === 'use' && !isLocal) return

        const element = document.createElementNS(SVG_NS, name)
        copyAttributes(source, element)
        if (local) {
            if (isLocal) element.setAttribute('href', reference)
        } else if (name === 'image') {
            this.setImageSource(href, element)
        }
        target.appendChild(element)
        this.copyChildren(source, element)
    }

    private copyMathElement(source: Element, target: Node): void {
        const name = source.localName
        // `annotation-xml` can hold HTML. All real MathML names have only lower-case letters.
        if (!/^[a-z]+$/.test(name)) return

        const element = document.createElementNS(MATHML_NS, name)
        copyAttributes(source, element)
        target.appendChild(element)
        this.copyChildren(source, element)
    }

    private setLinkTarget(source: Element, target: Element): void {
        const href = readAttribute(source, 'href')
        if (href === null) return

        // The browser ignores white space and control characters in a URL. Remove them before
        // the test, so that `java\nscript:` is not read as a path in the book.
        if (URL_SCHEME.test(href.replace(/[\u0000-\u0020]+/g, ''))) {
            const external = externalUrl(href)
            if (external) {
                target.setAttribute('href', external)
                target.setAttribute('target', '_blank')
                target.setAttribute('rel', 'noopener noreferrer')
                target.setAttribute(EXTERNAL_LINK_ATTR, '')
            }
            return
        }

        const internal = resolveHref({ book: this.book, from: this.path, href })
        if (internal) {
            // A real `href` would change the URL of the app. The view handles the click.
            target.setAttribute(INTERNAL_LINK_PATH_ATTR, internal.path)
            if (internal.fragment) {
                target.setAttribute(INTERNAL_LINK_FRAGMENT_ATTR, internal.fragment)
            }
            target.setAttribute('role', 'link')
            target.setAttribute('tabindex', '0')
        }
    }

    private setImageSource(href: string | null, target: Element): void {
        if (href === null) return
        const data = dataImageUrl(href)
        if (data) {
            target.setAttribute(target.localName === 'img' ? 'src' : 'href', data)
        } else {
            const file = this.resolveFile(href)
            if (!file) return
            target.setAttribute(IMAGE_PATH_ATTR, file)
        }
        this.images.push(target)
    }

    /** Container path of a file of the book, or null. */
    private resolveFile(href: string | null): string | null {
        if (href === null) return null
        return resolveFile({ book: this.book, from: this.path, href })?.path ?? null
    }

    private collectStyle(element: Element): void {
        const name = element.localName.toLowerCase()
        if (name === 'style') this.collectStyleElement(element)
        else if (name === 'link') this.collectStylesheetLink(element)
    }

    private collectStyleElement(element: Element): void {
        let css = ''
        // An XML parser gives CDATA sections, and comments around the CSS, as separate nodes.
        for (let node = element.firstChild; node; node = node.nextSibling) {
            const type = node.nodeType
            if (type === 3 || type === 4 || type === 8) css += (node as CharacterData).data
        }
        if (!css.trim()) return

        const media = readMedia(element)
        if (media && !isSafeMediaQuery(media)) return
        this.styleSources.push({
            kind: 'inline',
            css: media ? `@media ${media} {\n${css}\n}` : css,
        })
    }

    private collectStylesheetLink(element: Element): void {
        const rel = (readAttribute(element, 'rel') ?? '').toLowerCase().split(/\s+/)
        if (!rel.includes('stylesheet') || rel.includes('alternate')) return

        // Old books link an Adobe page template (XML) as a stylesheet.
        const type = (readAttribute(element, 'type') ?? '').trim().toLowerCase()
        if (type && type !== 'text/css') return

        const path = this.resolveFile(readAttribute(element, 'href'))
        if (!path) return

        const media = readMedia(element)
        if (media && !isSafeMediaQuery(media)) return
        this.styleSources.push(media ? { kind: 'link', path, media } : { kind: 'link', path })
    }
}

export function sanitizeDocument({ xhtml, path, book }: SanitizeOptions): SanitizedDocument {
    const parsed = parseContentDocument(xhtml)
    const builder = new TreeBuilder(book, path)
    const root = document.createElement('rd-html')
    const body = document.createElement('rd-body')
    root.appendChild(body)

    const sourceRoot = parsed.documentElement
    if (sourceRoot && isHtmlElement(sourceRoot, 'html')) {
        copyRootAttributes({ source: sourceRoot, target: root, allowed: ROOT_ATTRS })
        let hasBody = false
        for (let child = sourceRoot.firstElementChild; child; child = child.nextElementSibling) {
            if (isHtmlElement(child, 'head')) {
                builder.collectStylesBelow(child)
            } else if (!hasBody && isHtmlElement(child, 'body')) {
                hasBody = true
                copyRootAttributes({ source: child, target: body, allowed: BODY_ATTRS })
                builder.copyChildren(child, body)
            } else {
                builder.copyElement(child, body)
            }
        }
    } else if (sourceRoot) {
        builder.copyElement(sourceRoot, body)
    }

    const bodyLanguage = documentLanguage(body)
    const rootLanguage = documentLanguage(root)
    return {
        root,
        body,
        lang: bodyLanguage ?? rootLanguage,
        dir: readDirection(body) ?? readDirection(root),
        styleSources: builder.styleSources,
        images: builder.images,
    }
}
