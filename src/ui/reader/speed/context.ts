/**
 * The context lines of the speed reader. They show the words before and after the word on
 * screen.
 */

import type { WordToken } from '$lib/content/types'

/** Above this number of context words, the lines show only what fits. */
export const CONTEXT_UNLIMITED_MAX = 30

/** Each context block has this number of lines. */
const CONTEXT_LINES = 2
/** Font size of the context lines in CSS pixels (--text-md). */
export const CONTEXT_FONT_PX = 15
/** Mean width of a character of running text in the UI font, in em. */
const MEAN_CHARACTER_EM = 0.5

export interface ContextOptions {
    /** The words of the chapter. */
    words: readonly WordToken[]
    /** Index of the word on screen. */
    index: number
    /** The context words setting. */
    count: number
    /** Number of characters that fit in one context block. See `contextCharBudget`. */
    maxChars: number
}

/** Number of characters that fit in the lines of one context block of this width. */
export function contextCharBudget(widthPx: number): number {
    if (!(widthPx > 0)) return 0
    return Math.floor((CONTEXT_LINES * widthPx) / (CONTEXT_FONT_PX * MEAN_CHARACTER_EM))
}

/** The limit applies only to a large setting. A small setting shows each of its words. */
function charLimit({ count, maxChars }: ContextOptions): number {
    return count > CONTEXT_UNLIMITED_MAX ? maxChars : Infinity
}

/** The words before the word on screen, in reading order. Empty at the chapter start. */
export function contextBefore(options: ContextOptions): string {
    const { words, index, count } = options
    if (count <= 0) return ''
    const limit = charLimit(options)
    const first = Math.max(0, index - count)
    let start = Math.min(index, words.length)
    let length = 0
    // The words that are nearest to the word on screen have priority.
    while (start > first) {
        const next = length + words[start - 1].text.length + 1
        if (next > limit && length > 0) break
        length = next
        start--
    }
    return join(words, start, Math.min(index, words.length))
}

/** The words after the word on screen. Empty at the chapter end. */
export function contextAfter(options: ContextOptions): string {
    const { words, index, count } = options
    if (count <= 0) return ''
    const limit = charLimit(options)
    const start = Math.max(0, index + 1)
    const last = Math.min(words.length, start + count)
    let end = start
    let length = 0
    while (end < last) {
        const next = length + words[end].text.length + 1
        if (next > limit && length > 0) break
        length = next
        end++
    }
    return join(words, start, end)
}

function join(words: readonly WordToken[], start: number, end: number): string {
    let text = ''
    for (let index = start; index < end; index++) {
        text += index === start ? words[index].text : ` ${words[index].text}`
    }
    return text
}
