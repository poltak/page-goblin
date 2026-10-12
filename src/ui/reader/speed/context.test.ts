import { describe, expect, it } from 'vitest'
import { makeChapter } from '$lib/rsvp/testing/chapter'
import { CONTEXT_UNLIMITED_MAX, contextAfter, contextBefore, contextCharBudget } from './context'

const { words } = makeChapter(['one two three four five six seven'])

/** The options for the test chapter. The default limit is above the length of the chapter. */
function at(index: number, { count, maxChars = 1000 }: { count: number; maxChars?: number }) {
    return { words, index, count, maxChars }
}

describe('contextBefore and contextAfter', () => {
    it('give the words on each side in reading order', () => {
        expect(contextBefore(at(3, { count: 2 }))).toBe('two three')
        expect(contextAfter(at(3, { count: 2 }))).toBe('five six')
    })

    it('give nothing for a count of 0', () => {
        expect(contextBefore(at(3, { count: 0 }))).toBe('')
        expect(contextAfter(at(3, { count: 0 }))).toBe('')
    })

    it('stop at the chapter edges', () => {
        expect(contextBefore(at(0, { count: 2 }))).toBe('')
        expect(contextBefore(at(1, { count: 5 }))).toBe('one')
        expect(contextAfter(at(6, { count: 2 }))).toBe('')
        expect(contextAfter(at(5, { count: 5 }))).toBe('seven')
    })

    it('do not limit the characters for a small count', () => {
        expect(contextBefore(at(6, { count: CONTEXT_UNLIMITED_MAX, maxChars: 5 }))).toBe(
            'one two three four five six',
        )
        expect(contextAfter(at(0, { count: CONTEXT_UNLIMITED_MAX, maxChars: 5 }))).toBe(
            'two three four five six seven',
        )
    })

    it('keep the nearest words that fit for a large count', () => {
        // 'five six' has 8 characters and one more for each word.
        expect(contextBefore(at(6, { count: 100, maxChars: 10 }))).toBe('five six')
        expect(contextAfter(at(0, { count: 100, maxChars: 10 }))).toBe('two three')
    })

    it('show one word that is longer than the limit', () => {
        expect(contextBefore(at(3, { count: 100, maxChars: 2 }))).toBe('three')
        expect(contextAfter(at(3, { count: 100, maxChars: 2 }))).toBe('five')
    })

    it('give nothing for an empty chapter', () => {
        const empty = { words: [], index: 0, count: 5, maxChars: 100 }
        expect(contextBefore(empty)).toBe('')
        expect(contextAfter(empty)).toBe('')
    })
})

describe('contextCharBudget', () => {
    it('grows with the width', () => {
        expect(contextCharBudget(360)).toBe(96)
        expect(contextCharBudget(720)).toBe(192)
    })

    it('is 0 for a width that is not known', () => {
        expect(contextCharBudget(0)).toBe(0)
        expect(contextCharBudget(Number.NaN)).toBe(0)
    })
})
