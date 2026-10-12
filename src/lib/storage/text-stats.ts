import type { SpineStats } from './types'

// A tag pattern uses `[^<>]*` and not `[^>]*`. A `<` in the text with no `>` after it then
// costs a short scan and not a scan to the end of the document.

const BODY_OPEN = /<body\b[^<>]*>/i

// Tags that do not separate words, for example a drop cap in a span. They are removed with no
// space in their place. `\b` stops `b` from matching `br` or `body`.
const INLINE_TAG =
    /<\/?(?:a|abbr|b|bdi|bdo|big|cite|code|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strike|strong|sub|sup|tt|u|var|wbr)\b[^<>]*>/gi

// In this sequence: comments, script and style elements with their content, all other tags.
// The lookbehind keeps a self-closing `<script/>` out of the second alternative.
// `|$` gives the remainder of the document to a comment, script or style that has no end, as a
// browser does. Without it, each such start scans to the end of the document and then fails.
// A book with many of them would stop the page for minutes.
const NOT_TEXT =
    /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^<>]*(?<!\/)>[\s\S]*?(?:<\/\1\s*>|$)|<[^<>]*>/gi

const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    // Not one of the five XML entities, but EPUB 2 books use it often and it separates words.
    nbsp: '\u00a0',
}

function decodeEntity(match: string, decimal?: string, hex?: string, name?: string): string {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match
    const codePoint = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16)
    // A number that is not a code point stays as written.
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match
}

/** The same set of characters as `\s` in a regular expression. */
function isWhiteSpace(code: number): boolean {
    if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d)
    if (code < 0xa0) return false
    return (
        code === 0xa0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff
    )
}

/**
 * Estimate the text size of one content document. It uses no DOM, so the import of a book
 * stays fast. `chars` is the length of the text with each run of white space as one space.
 * The result is near the length of the rendered text, but it is not exact.
 */
export function estimateTextStats(xhtml: string): SpineStats {
    const body = BODY_OPEN.exec(xhtml)
    const markup = body ? xhtml.slice(body.index + body[0].length) : xhtml

    const text = markup
        .replace(INLINE_TAG, '')
        .replace(NOT_TEXT, ' ')
        // Entities are decoded after the tags are gone, so `&lt;p&gt;` stays text.
        .replace(ENTITY, decodeEntity)

    // A loop counts the words. In a test, a replace of `\s+` with one space and a count of the
    // spaces took five times as long.
    let words = 0
    let wordChars = 0
    let inWord = false
    for (let index = 0; index < text.length; index++) {
        if (isWhiteSpace(text.charCodeAt(index))) {
            inWord = false
            continue
        }
        if (!inWord) {
            inWord = true
            words++
        }
        wordChars++
    }

    // One space goes between each two words.
    return { chars: wordChars + Math.max(0, words - 1), words }
}
