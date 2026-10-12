import type { TextBlock, TextModel } from '$lib/content/types'

/** Characters of context before a search match. */
export const EXCERPT_BEFORE = 40
/** Characters of context after a search match. */
export const EXCERPT_AFTER = 60
export const BOOKMARK_EXCERPT_LENGTH = 120

type ExcerptModel = Pick<TextModel, 'text' | 'blocks'>

interface SliceOptions {
    model: ExcerptModel
    start: number
    /** Exclusive. */
    end: number
}

export interface MatchExcerpt {
    excerpt: string
    /** Start of the match inside `excerpt`. */
    matchStart: number
    /** Exclusive. */
    matchEnd: number
}

export interface LeadingExcerptOptions {
    model: ExcerptModel
    /** Chapter offset of the first character. */
    offset: number
    maxLength?: number
}

export function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ')
}

function isWhitespace(char: string | undefined): boolean {
    return char !== undefined && /\s/.test(char)
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff
}

/** Index of the first block that ends at or after `offset`. Blocks are sorted. */
function firstBlockEndingFrom(blocks: readonly TextBlock[], offset: number): number {
    let low = 0
    let high = blocks.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (blocks[middle].end >= offset) high = middle
        else low = middle + 1
    }
    return low
}

/**
 * The text of [start, end) with a space at each block end. Some books have no white space
 * between two paragraphs in the markup, and then the last word of a paragraph would join the
 * first word of the next one.
 *
 * A block end at `start` or at `end` also gives a space, because the text on the other side of
 * that position (a search match, or the text outside the window) is in a different block.
 */
function readableSlice({ model, start, end }: SliceOptions): string {
    const { text, blocks } = model
    let result = ''
    let from = start
    for (let index = firstBlockEndingFrom(blocks, start); index < blocks.length; index++) {
        const boundary = blocks[index].end
        if (boundary > end) break
        result += text.slice(from, boundary) + ' '
        from = boundary
    }
    return result + text.slice(from, end)
}

/**
 * The text around a search match: about 40 characters before it and 60 after it, with white
 * space collapsed. A word that the window cuts is left out. Text with no white space (Chinese,
 * Japanese) is cut at the window.
 */
export function matchExcerpt({ model, start, end }: SliceOptions): MatchExcerpt {
    const { text } = model
    let from = Math.max(0, start - EXCERPT_BEFORE)
    let to = Math.min(text.length, end + EXCERPT_AFTER)
    // The window must not cut a character that has two code units.
    if (from > 0 && from < start && isLowSurrogate(text.charCodeAt(from))) from++
    if (to < text.length && to > end && isHighSurrogate(text.charCodeAt(to - 1))) to--

    let before = collapseWhitespace(readableSlice({ model, start: from, end: start }))
    if (from > 0 && !isWhitespace(text[from - 1])) {
        const space = before.indexOf(' ')
        if (space >= 0) before = before.slice(space + 1)
    }
    before = before.trimStart()

    let after = collapseWhitespace(readableSlice({ model, start: end, end: to }))
    if (to < text.length && !isWhitespace(text[to])) {
        const space = after.lastIndexOf(' ')
        if (space >= 0) after = after.slice(0, space)
    }
    after = after.trimEnd()

    const match = collapseWhitespace(text.slice(start, end))
    return {
        excerpt: before + match + after,
        matchStart: before.length,
        matchEnd: before.length + match.length,
    }
}

/**
 * The first words at a position, for a bookmark: 120 characters at most, with white space
 * collapsed, cut at a word end.
 */
export function leadingExcerpt({
    model,
    offset,
    maxLength = BOOKMARK_EXCERPT_LENGTH,
}: LeadingExcerptOptions): string {
    const { text } = model
    const start = Math.min(text.length, Math.max(0, Math.floor(offset) || 0))
    // White space collapses, so the window is longer than the result.
    const end = Math.min(text.length, start + maxLength * 4)
    const collapsed = collapseWhitespace(readableSlice({ model, start, end })).trim()
    if (collapsed.length <= maxLength) return collapsed

    let cut = collapsed.slice(0, maxLength)
    if (collapsed[maxLength] !== ' ') {
        const space = cut.lastIndexOf(' ')
        if (space > 0) cut = cut.slice(0, space)
        else if (isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1)
    }
    return cut.trimEnd()
}
