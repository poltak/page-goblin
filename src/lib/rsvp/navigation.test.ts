import { describe, expect, test } from 'vitest'
import {
    clampWordIndex,
    isSentenceStart,
    nextSentenceIndex,
    previousSentenceIndex,
    sentenceStartIndex,
    wordIndexAtOffset,
} from './navigation'
import { makeChapter } from './testing/chapter'

/*
 * Word indexes:
 *   block 0 (heading): Chapter 0, one 1
 *   block 1: "Stop!" 2, she 3, said. 4, He 5, ran 6, away 7, fast\u2026 8, Then 9, nothing 10,
 *            (at 11, all).[3] 12, The 13, end 14
 *   block 2: New 15, block 16, starts 17, here. 18, Done. 19
 */
const chapter = makeChapter([
    '# Chapter one',
    '"Stop!" she said. He ran away fast\u2026 Then nothing (at all).[3] The end',
    'New block starts here. Done.',
])
const { words } = chapter
const SENTENCE_STARTS = [0, 2, 3, 5, 9, 13, 15, 19]

describe('clampWordIndex', () => {
    test('limits the index to the words of the chapter', () => {
        expect(clampWordIndex(-5, 10)).toBe(0)
        expect(clampWordIndex(0, 10)).toBe(0)
        expect(clampWordIndex(9, 10)).toBe(9)
        expect(clampWordIndex(10, 10)).toBe(9)
        expect(clampWordIndex(1e9, 10)).toBe(9)
    })

    test('removes the fraction', () => {
        expect(clampWordIndex(3.9, 10)).toBe(3)
        expect(clampWordIndex(-0.5, 10)).toBe(0)
    })

    test('gives 0 for an empty chapter and for a value that is not finite', () => {
        expect(clampWordIndex(4, 0)).toBe(0)
        expect(clampWordIndex(Number.NaN, 10)).toBe(0)
        expect(clampWordIndex(Number.POSITIVE_INFINITY, 10)).toBe(0)
    })
})

describe('wordIndexAtOffset', () => {
    test('finds the word that has the offset', () => {
        expect(wordIndexAtOffset(words, 0)).toBe(0)
        expect(wordIndexAtOffset(words, 3)).toBe(0)
        expect(wordIndexAtOffset(words, words[5].start)).toBe(5)
        expect(wordIndexAtOffset(words, words[5].end - 1)).toBe(5)
    })

    test('goes to the next word when the offset is between two words', () => {
        // `end` is exclusive, so the end of a word is the space after it.
        expect(wordIndexAtOffset(words, words[5].end)).toBe(6)
        expect(wordIndexAtOffset(words, words[1].end)).toBe(2)
    })

    test('agrees with a linear search at each offset', () => {
        for (let offset = -2; offset <= chapter.text.length + 2; offset++) {
            const found = words.findIndex((word) => word.end > offset)
            expect(wordIndexAtOffset(words, offset)).toBe(found < 0 ? words.length - 1 : found)
        }
    })

    test('limits the result to the words of the chapter', () => {
        expect(wordIndexAtOffset(words, -100)).toBe(0)
        expect(wordIndexAtOffset(words, Number.NEGATIVE_INFINITY)).toBe(0)
        expect(wordIndexAtOffset(words, 1e9)).toBe(19)
        expect(wordIndexAtOffset(words, Number.POSITIVE_INFINITY)).toBe(19)
        expect(wordIndexAtOffset(words, Number.NaN)).toBe(0)
    })

    test('gives 0 for an empty chapter', () => {
        expect(wordIndexAtOffset([], 10)).toBe(0)
    })
})

describe('sentence starts', () => {
    test('are at block starts and after words that end a sentence', () => {
        const starts = words.map((_, i) => i).filter((i) => isSentenceStart(words, i))
        expect(starts).toEqual(SENTENCE_STARTS)
    })

    test('sentenceStartIndex gives the first word of the sentence of each word', () => {
        const expected = [0, 0, 2, 3, 3, 5, 5, 5, 5, 9, 9, 9, 9, 13, 13, 15, 15, 15, 15, 19]
        expect(words.map((_, i) => sentenceStartIndex(words, i))).toEqual(expected)
    })

    test('nextSentenceIndex gives the start of the sentence after each word', () => {
        const expected = [2, 2, 3, 5, 5, 9, 9, 9, 9, 13, 13, 13, 13, 15, 15, 19, 19, 19, 19, -1]
        expect(words.map((_, i) => nextSentenceIndex(words, i))).toEqual(expected)
    })

    test('previousSentenceIndex goes to the sentence before when the word is near the start', () => {
        // From the first three words of a sentence, the target is the sentence before it.
        expect(previousSentenceIndex(words, 5)).toBe(3)
        expect(previousSentenceIndex(words, 6)).toBe(3)
        expect(previousSentenceIndex(words, 7)).toBe(3)
        expect(previousSentenceIndex(words, 3)).toBe(2)
        expect(previousSentenceIndex(words, 2)).toBe(0)
        expect(previousSentenceIndex(words, 15)).toBe(13)
        expect(previousSentenceIndex(words, 19)).toBe(15)
    })

    test('previousSentenceIndex goes to the start of the current sentence from the fourth word', () => {
        expect(previousSentenceIndex(words, 8)).toBe(5)
        expect(previousSentenceIndex(words, 12)).toBe(9)
        expect(previousSentenceIndex(words, 18)).toBe(15)
    })

    test('previousSentenceIndex stays in the first sentence of the chapter', () => {
        expect(previousSentenceIndex(words, 0)).toBe(0)
        expect(previousSentenceIndex(words, 1)).toBe(0)
    })

    test('work on an empty chapter', () => {
        expect(sentenceStartIndex([], 0)).toBe(0)
        expect(nextSentenceIndex([], 0)).toBe(-1)
        expect(previousSentenceIndex([], 0)).toBe(0)
    })

    test('isSentenceStart gives false for an index that has no word', () => {
        for (const index of [words.length, words.length + 3, 2.5, Number.NaN]) {
            expect(isSentenceStart(words, index)).toBe(false)
        }
        expect(isSentenceStart(words, -5)).toBe(true)
    })

    test('limit an index that is not valid to the words of the chapter', () => {
        expect(sentenceStartIndex(words, 99)).toBe(19)
        expect(sentenceStartIndex(words, -3)).toBe(0)
        expect(sentenceStartIndex(words, 7.5)).toBe(5)
        expect(sentenceStartIndex(words, Number.NaN)).toBe(0)

        expect(nextSentenceIndex(words, 99)).toBe(-1)
        expect(nextSentenceIndex(words, -5)).toBe(2)
        expect(nextSentenceIndex(words, 1.5)).toBe(2)
        expect(nextSentenceIndex(words, Number.NaN)).toBe(2)

        expect(previousSentenceIndex(words, 99)).toBe(15)
        expect(previousSentenceIndex(words, -2)).toBe(0)
        expect(previousSentenceIndex(words, 8.9)).toBe(5)
        expect(previousSentenceIndex(words, Number.NaN)).toBe(0)
    })

    test('use the block index when a block has no end flag', () => {
        const noFlags = makeChapter(['one two', 'three four']).words.map((word) => ({
            ...word,
            endsBlock: false,
        }))
        expect(isSentenceStart(noFlags, 1)).toBe(false)
        expect(isSentenceStart(noFlags, 2)).toBe(true)
    })
})
