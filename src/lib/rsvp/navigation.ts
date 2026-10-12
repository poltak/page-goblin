import type { WordToken } from '$lib/content/types'
import { endsSentence } from './punctuation'

/**
 * "Previous sentence" goes to the start of the current sentence when the current word is more
 * than this number of words after that start. A second push soon after the first one then goes
 * to the sentence before it.
 */
export const SENTENCE_RESTART_WORDS = 2

/** A valid word index. 0 for an empty chapter and for a value that is not finite. */
export function clampWordIndex(index: number, wordCount: number): number {
    if (wordCount <= 0 || !Number.isFinite(index)) return 0
    return Math.min(Math.max(0, Math.trunc(index)), wordCount - 1)
}

/**
 * Index of the first word whose end is above the chapter offset. The last word when the offset
 * is after all words. 0 for an empty chapter.
 */
export function wordIndexAtOffset(words: readonly WordToken[], offset: number): number {
    if (Number.isNaN(offset)) return 0
    let low = 0
    let high = words.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (words[middle].end > offset) high = middle
        else low = middle + 1
    }
    return Math.min(low, Math.max(words.length - 1, 0))
}

/**
 * A sentence starts at each block start and after a word that ends a sentence. False for an
 * index above 0 that has no word.
 */
export function isSentenceStart(words: readonly WordToken[], index: number): boolean {
    if (index <= 0) return true
    const word: WordToken | undefined = words[index]
    const previous: WordToken | undefined = words[index - 1]
    if (!word || !previous) return false
    return previous.endsBlock || previous.block !== word.block || endsSentence(previous.text)
}

/**
 * Index of the first word of the sentence that has the word at `index`. This function and the
 * two functions below limit `index` to the words of the chapter, as `clampWordIndex` does.
 */
export function sentenceStartIndex(words: readonly WordToken[], index: number): number {
    let start = clampWordIndex(index, words.length)
    while (start > 0 && !isSentenceStart(words, start)) start--
    return start
}

/** Index of the first word of the next sentence, or -1 when `index` is in the last sentence. */
export function nextSentenceIndex(words: readonly WordToken[], index: number): number {
    for (let next = clampWordIndex(index, words.length) + 1; next < words.length; next++) {
        if (isSentenceStart(words, next)) return next
    }
    return -1
}

/** The target of a "previous sentence" step from the word at `index`. */
export function previousSentenceIndex(words: readonly WordToken[], index: number): number {
    const current = clampWordIndex(index, words.length)
    const start = sentenceStartIndex(words, current)
    if (start === 0 || current - start > SENTENCE_RESTART_WORDS) return start
    return sentenceStartIndex(words, start - 1)
}
