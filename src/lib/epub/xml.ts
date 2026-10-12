/**
 * XML helpers. Element names are matched by their lower-case local name, because books use
 * prefixes (opf:, dc:), no namespace at all, or names with capital letters (dc:Title).
 */

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])
const BLOCK_TAG_START =
    /<(?=\/?(?:p|div|br|li|ul|ol|h[1-6]|blockquote|table|tr|td|th|dl|dt|dd|hr|section|article)\b)/gi
/**
 * A comment, a processing instruction, a declaration, or the name of the first element.
 *
 * `|$` gives the remainder of the text to a comment, an instruction or a declaration that has
 * no end. Such a text is not well-formed, so the result of the repair does not change.
 * Without it, each such start scans to the end of the text and then fails, and a file with
 * many of them would stop the page for minutes.
 */
const BEFORE_ROOT =
    /<!--[\s\S]*?(?:-->|$)|<\?[\s\S]*?(?:\?>|$)|<![^>]*(?:>|$)|<([A-Za-z_][\w.:-]*)/g
/** The attributes of a start tag, from the end of the element name. */
const ROOT_ATTRIBUTES = /(?:[^<>"']|"[^"]*"|'[^']*')*/y
/** The prefix of an element name or of an attribute name. */
const PREFIX_USE = /<\/?([A-Za-z_][\w.-]*):[\w.-]|\s([A-Za-z_][\w.-]*):[\w.-]+\s*=\s*["']/g

let sharedParser: DOMParser | undefined

function parser(): DOMParser {
    return (sharedParser ??= new DOMParser())
}

/** DOMParser does not throw for bad XML. It returns a document with a parsererror element. */
export function isParserError(document: Document): boolean {
    return (
        !document.documentElement ||
        document.documentElement.localName.toLowerCase() === 'parsererror' ||
        document.getElementsByTagName('parsererror').length > 0
    )
}

function parseStrict(text: string, type: DOMParserSupportedType): Document | null {
    try {
        const document = parser().parseFromString(text, type)
        return isParserError(document) ? null : document
    } catch {
        return null
    }
}

/**
 * Parse XML. When the text is not well-formed, repair the common faults of real books and
 * try one more time. Returns null when the text is still not well-formed.
 */
export function parseXml(text: string): Document | null {
    return parseStrict(text, 'text/xml') ?? parseRepaired(text, 'text/xml')
}

/**
 * Parse a content document (the nav document, a cover page). XHTML is first. The repair step
 * is second, because the HTML parser reads a self-closed element such as `<title/>` as a
 * start tag and then loses all the text after it. The HTML parser is the last step.
 */
export function parseContentDocument(text: string): Document {
    return (
        parseStrict(text, 'application/xhtml+xml') ??
        parseRepaired(text, 'application/xhtml+xml') ??
        parseHtml(text)
    )
}

export function parseHtml(text: string): Document {
    return parser().parseFromString(text, 'text/html')
}

function parseRepaired(text: string, type: DOMParserSupportedType): Document | null {
    const repaired = repairXml(text)
    return repaired === text ? null : parseStrict(repaired, type)
}

function repairXml(text: string): string {
    const entities = new Map<string, string>()
    const start = text.indexOf('<')

    return declarePrefixes(
        (start > 0 ? text.slice(start) : text)
            // Control characters that XML 1.0 does not permit.
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
            // HTML entities such as &nbsp; are not defined in XML.
            .replace(/&([a-z][a-z\d]*);/gi, (match, name: string) => {
                if (XML_ENTITIES.has(name)) return match
                let replacement = entities.get(name)
                if (replacement === undefined) {
                    const decoded = parseHtml(match).body?.textContent ?? match
                    replacement =
                        decoded === match
                            ? `&amp;${name};`
                            : Array.from(decoded, (char) => `&#${char.codePointAt(0)};`).join('')
                    entities.set(name, replacement)
                }
                return replacement
            })
            // An ampersand that does not start an entity.
            .replace(/&(?!(?:[a-z][a-z\d]*|#\d+|#x[\da-f]+);)/gi, '&amp;'),
    )
}

/**
 * Give a declaration to each namespace prefix that the root element does not declare. All
 * browsers reject a prefix with no declaration, and package documents of real books have
 * this fault (opf:role with no xmlns:opf). Names are matched by local name, so the namespace
 * of the new declaration has no effect.
 */
function declarePrefixes(text: string): string {
    let rootNameEnd = -1
    for (const match of text.matchAll(BEFORE_ROOT)) {
        if (match[1] === undefined) continue
        rootNameEnd = match.index + match[0].length
        break
    }
    if (rootNameEnd < 0) return text

    const prefixes = new Set<string>()
    for (const match of text.matchAll(PREFIX_USE)) prefixes.add(match[1] ?? match[2])
    prefixes.delete('xml')
    prefixes.delete('xmlns')
    ROOT_ATTRIBUTES.lastIndex = rootNameEnd
    const attributes = ROOT_ATTRIBUTES.exec(text)?.[0] ?? ''
    for (const match of attributes.matchAll(/\sxmlns:([\w.-]+)\s*=/g)) prefixes.delete(match[1])
    if (!prefixes.size) return text

    const declarations = Array.from(
        prefixes,
        (prefix) => ` xmlns:${prefix}="urn:x-undeclared:${prefix}"`,
    ).join('')
    return text.slice(0, rootNameEnd) + declarations + text.slice(rootNameEnd)
}

export function localName(element: Element): string {
    return (element.localName || element.tagName.split(':').pop() || '').toLowerCase()
}

/** All descendants with this lower-case local name, in document order. */
export function descendants(parent: Document | Element, name: string): Element[] {
    const result: Element[] = []
    for (const element of parent.getElementsByTagName('*')) {
        if (localName(element) === name) result.push(element)
    }
    return result
}

export function firstDescendant(parent: Document | Element, name: string): Element | undefined {
    for (const element of parent.getElementsByTagName('*')) {
        if (localName(element) === name) return element
    }
    return undefined
}

/** Direct children with this lower-case local name. */
export function childrenNamed(parent: Element, name: string): Element[] {
    const result: Element[] = []
    for (const element of parent.children) {
        if (localName(element) === name) result.push(element)
    }
    return result
}

/**
 * The trimmed value of an attribute, or null when it is missing or empty. A prefix on the
 * attribute name is ignored, so 'role' also finds 'opf:role'.
 */
export function attribute(element: Element, name: string): string | null {
    let value = element.getAttribute(name)
    if (value === null) {
        const suffix = `:${name}`
        for (const candidate of element.attributes) {
            if (candidate.localName === name || candidate.name.endsWith(suffix)) {
                value = candidate.value
                break
            }
        }
    }
    return value?.trim() || null
}

export function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

export function textOf(element: Element | null | undefined): string {
    return collapseWhitespace(element?.textContent ?? '')
}

/** The plain text of an HTML fragment, with white space collapsed. */
export function htmlToText(html: string): string {
    if (!/[<&]/.test(html)) return collapseWhitespace(html)
    // A space before each block tag keeps the words of adjacent blocks apart.
    const document = parseHtml(html.replace(BLOCK_TAG_START, ' <'))
    for (const element of document.querySelectorAll('script, style')) element.remove()
    return collapseWhitespace(document.body?.textContent ?? '')
}
