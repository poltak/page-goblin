import { describe, expect, it } from 'vitest'
import { bookFraction, locateFraction, wordsRemaining } from './progress'
import type { SpineStats } from './types'

function stats(...chars: number[]): SpineStats[] {
    // One word for each five characters keeps the two numbers easy to tell apart.
    return chars.map((count) => ({ chars: count, words: count / 5 }))
}

describe('bookFraction', () => {
    const spineStats = stats(100, 300, 600)

    it('weights each spine item by its characters', () => {
        expect(bookFraction({ spineStats, spineIndex: 0, chapterFraction: 0 })).toBe(0)
        expect(bookFraction({ spineStats, spineIndex: 0, chapterFraction: 0.5 })).toBeCloseTo(0.05)
        expect(bookFraction({ spineStats, spineIndex: 1, chapterFraction: 0 })).toBeCloseTo(0.1)
        expect(bookFraction({ spineStats, spineIndex: 1, chapterFraction: 0.5 })).toBeCloseTo(0.25)
        expect(bookFraction({ spineStats, spineIndex: 2, chapterFraction: 0 })).toBeCloseTo(0.4)
        expect(bookFraction({ spineStats, spineIndex: 2, chapterFraction: 0.5 })).toBeCloseTo(0.7)
        expect(bookFraction({ spineStats, spineIndex: 2, chapterFraction: 1 })).toBe(1)
    })

    it('gives the same value for the end of an item and the start of the next item', () => {
        expect(bookFraction({ spineStats, spineIndex: 0, chapterFraction: 1 })).toBe(
            bookFraction({ spineStats, spineIndex: 1, chapterFraction: 0 }),
        )
    })

    it('clamps a chapter fraction that is out of range', () => {
        expect(bookFraction({ spineStats, spineIndex: 1, chapterFraction: -2 })).toBeCloseTo(0.1)
        expect(bookFraction({ spineStats, spineIndex: 1, chapterFraction: 7 })).toBeCloseTo(0.4)
        expect(
            bookFraction({ spineStats, spineIndex: 1, chapterFraction: Number.NaN }),
        ).toBeCloseTo(0.1)
    })

    it('clamps a spine index that is out of range', () => {
        expect(bookFraction({ spineStats, spineIndex: -1, chapterFraction: 0.5 })).toBe(0)
        expect(bookFraction({ spineStats, spineIndex: 3, chapterFraction: 0.5 })).toBe(1)
    })

    it('gives 0 for a book with no spine items', () => {
        expect(bookFraction({ spineStats: [], spineIndex: 0, chapterFraction: 0.5 })).toBe(0)
    })

    it('does not throw for a spine index that is not a whole number', () => {
        expect(bookFraction({ spineStats, spineIndex: Number.NaN, chapterFraction: 0.5 })).toBe(0)
        expect(bookFraction({ spineStats, spineIndex: -Infinity, chapterFraction: 0.5 })).toBe(0)
        expect(bookFraction({ spineStats, spineIndex: Infinity, chapterFraction: 0.5 })).toBe(1)
        // 1.5 is in item 1.
        expect(bookFraction({ spineStats, spineIndex: 1.5, chapterFraction: 0.5 })).toBeCloseTo(
            0.25,
        )
        expect(bookFraction({ spineStats: [], spineIndex: Number.NaN, chapterFraction: 0.5 })).toBe(
            0,
        )
    })

    it('gives each item the same weight when no item has text', () => {
        const empty = stats(0, 0, 0, 0)

        expect(bookFraction({ spineStats: empty, spineIndex: 0, chapterFraction: 0 })).toBe(0)
        expect(bookFraction({ spineStats: empty, spineIndex: 1, chapterFraction: 0 })).toBe(0.25)
        expect(bookFraction({ spineStats: empty, spineIndex: 2, chapterFraction: 0.5 })).toBe(0.625)
        expect(bookFraction({ spineStats: empty, spineIndex: 3, chapterFraction: 1 })).toBe(1)
    })

    it('does not move in an item that has no text', () => {
        const withGap = stats(100, 0, 300)

        expect(bookFraction({ spineStats: withGap, spineIndex: 1, chapterFraction: 0 })).toBe(0.25)
        expect(bookFraction({ spineStats: withGap, spineIndex: 1, chapterFraction: 1 })).toBe(0.25)
    })

    it('works for a book with one item', () => {
        const single = stats(500)

        expect(bookFraction({ spineStats: single, spineIndex: 0, chapterFraction: 0 })).toBe(0)
        expect(bookFraction({ spineStats: single, spineIndex: 0, chapterFraction: 0.3 })).toBe(0.3)
        expect(bookFraction({ spineStats: single, spineIndex: 0, chapterFraction: 1 })).toBe(1)
    })
})

describe('locateFraction', () => {
    const spineStats = stats(100, 300, 600)

    it('finds the item and the position in the item', () => {
        expect(locateFraction({ spineStats, fraction: 0 })).toEqual({
            spineIndex: 0,
            chapterFraction: 0,
        })

        const first = locateFraction({ spineStats, fraction: 0.05 })
        expect(first.spineIndex).toBe(0)
        expect(first.chapterFraction).toBeCloseTo(0.5)

        const second = locateFraction({ spineStats, fraction: 0.25 })
        expect(second.spineIndex).toBe(1)
        expect(second.chapterFraction).toBeCloseTo(0.5)

        const last = locateFraction({ spineStats, fraction: 0.7 })
        expect(last.spineIndex).toBe(2)
        expect(last.chapterFraction).toBeCloseTo(0.5)
    })

    it('gives the end of the last item for the fraction 1', () => {
        expect(locateFraction({ spineStats, fraction: 1 })).toEqual({
            spineIndex: 2,
            chapterFraction: 1,
        })
    })

    it('gives the start of the second item for a fraction on the border', () => {
        const border = locateFraction({ spineStats, fraction: 0.1 })
        expect(border.spineIndex).toBe(1)
        expect(border.chapterFraction).toBeCloseTo(0)
    })

    it('clamps a fraction that is out of range', () => {
        expect(locateFraction({ spineStats, fraction: -1 })).toEqual({
            spineIndex: 0,
            chapterFraction: 0,
        })
        expect(locateFraction({ spineStats, fraction: 3 })).toEqual({
            spineIndex: 2,
            chapterFraction: 1,
        })
        expect(locateFraction({ spineStats, fraction: Number.NaN })).toEqual({
            spineIndex: 0,
            chapterFraction: 0,
        })
    })

    it('gives the first position for a book with no spine items', () => {
        expect(locateFraction({ spineStats: [], fraction: 0.5 })).toEqual({
            spineIndex: 0,
            chapterFraction: 0,
        })
    })

    it('gives each item the same weight when no item has text', () => {
        const empty = stats(0, 0, 0, 0)

        expect(locateFraction({ spineStats: empty, fraction: 0.625 })).toEqual({
            spineIndex: 2,
            chapterFraction: 0.5,
        })
        expect(locateFraction({ spineStats: empty, fraction: 1 })).toEqual({
            spineIndex: 3,
            chapterFraction: 1,
        })
    })

    it('skips items that have no text', () => {
        const withGaps = stats(0, 100, 0, 300, 0)

        expect(locateFraction({ spineStats: withGaps, fraction: 0 })).toEqual({
            spineIndex: 1,
            chapterFraction: 0,
        })
        expect(locateFraction({ spineStats: withGaps, fraction: 0.25 }).spineIndex).toBe(3)
        expect(locateFraction({ spineStats: withGaps, fraction: 1 })).toEqual({
            spineIndex: 3,
            chapterFraction: 1,
        })
    })
})

describe('bookFraction and locateFraction', () => {
    it('are the inverse of each other for each item and position', () => {
        // The sizes give fractions that binary numbers cannot hold exactly.
        const spineStats = stats(7, 1234, 3, 98765, 4321, 11)

        for (let spineIndex = 0; spineIndex < spineStats.length; spineIndex++) {
            for (const chapterFraction of [0, 0.001, 1 / 3, 0.5, 0.9, 0.999]) {
                const fraction = bookFraction({ spineStats, spineIndex, chapterFraction })
                const located = locateFraction({ spineStats, fraction })

                expect(located.spineIndex).toBe(spineIndex)
                expect(located.chapterFraction).toBeCloseTo(chapterFraction, 6)
            }
        }
    })

    it('are the inverse of each other for each fraction of the slider', () => {
        const spineStats = stats(120, 0, 4800, 37, 9000)

        for (let step = 0; step <= 1000; step++) {
            const fraction = step / 1000
            const located = locateFraction({ spineStats, fraction })

            expect(bookFraction({ spineStats, ...located })).toBeCloseTo(fraction, 9)
        }
    })

    it('keep the start of an item at the start when the division is not exact', () => {
        // (15 / 22) * 22 is 14.999999999999998, which is before the border.
        const spineStats = stats(15, 7)
        const fraction = bookFraction({ spineStats, spineIndex: 1, chapterFraction: 0 })

        const located = locateFraction({ spineStats, fraction })

        expect(located.spineIndex).toBe(1)
        expect(located.chapterFraction).toBe(0)
    })

    it('keep the start of each item at the start', () => {
        const spineStats = Array.from({ length: 300 }, (_, index) => ({
            chars: 1000 + ((index * 7919) % 5000),
            words: 200,
        }))

        for (let spineIndex = 0; spineIndex < spineStats.length; spineIndex++) {
            const fraction = bookFraction({ spineStats, spineIndex, chapterFraction: 0 })
            const located = locateFraction({ spineStats, fraction })

            expect(located.spineIndex).toBe(spineIndex)
            expect(located.chapterFraction).toBeCloseTo(0, 6)
        }
    })

    it('are the inverse of each other when no item has text', () => {
        const spineStats = stats(0, 0, 0)

        for (let spineIndex = 0; spineIndex < spineStats.length; spineIndex++) {
            for (const chapterFraction of [0, 0.25, 0.75]) {
                const fraction = bookFraction({ spineStats, spineIndex, chapterFraction })
                const located = locateFraction({ spineStats, fraction })

                expect(located.spineIndex).toBe(spineIndex)
                expect(located.chapterFraction).toBeCloseTo(chapterFraction, 6)
            }
        }
    })
})

describe('wordsRemaining', () => {
    const spineStats = stats(100, 300, 600)

    it('counts the words to the end of the chapter and to the end of the book', () => {
        expect(wordsRemaining({ spineStats, spineIndex: 0, chapterFraction: 0 })).toEqual({
            chapter: 20,
            book: 200,
        })
        expect(wordsRemaining({ spineStats, spineIndex: 1, chapterFraction: 0.5 })).toEqual({
            chapter: 30,
            book: 150,
        })
        expect(wordsRemaining({ spineStats, spineIndex: 2, chapterFraction: 0.25 })).toEqual({
            chapter: 90,
            book: 90,
        })
    })

    it('gives 0 at the end of the book', () => {
        expect(wordsRemaining({ spineStats, spineIndex: 2, chapterFraction: 1 })).toEqual({
            chapter: 0,
            book: 0,
        })
    })

    it('gives whole numbers', () => {
        const remaining = wordsRemaining({ spineStats, spineIndex: 0, chapterFraction: 1 / 3 })

        expect(remaining).toEqual({ chapter: 13, book: 193 })
    })

    it('clamps a chapter fraction that is out of range', () => {
        expect(wordsRemaining({ spineStats, spineIndex: 1, chapterFraction: -1 })).toEqual({
            chapter: 60,
            book: 180,
        })
        expect(wordsRemaining({ spineStats, spineIndex: 1, chapterFraction: 9 })).toEqual({
            chapter: 0,
            book: 120,
        })
        expect(wordsRemaining({ spineStats, spineIndex: 1, chapterFraction: Number.NaN })).toEqual({
            chapter: 60,
            book: 180,
        })
    })

    it('clamps a spine index that is out of range', () => {
        expect(wordsRemaining({ spineStats, spineIndex: -1, chapterFraction: 0.5 })).toEqual({
            chapter: 20,
            book: 200,
        })
        expect(wordsRemaining({ spineStats, spineIndex: 3, chapterFraction: 0 })).toEqual({
            chapter: 0,
            book: 0,
        })
    })

    it('gives 0 for a book with no spine items', () => {
        for (const spineIndex of [0, -1, 2, Number.NaN]) {
            expect(wordsRemaining({ spineStats: [], spineIndex, chapterFraction: 0 })).toEqual({
                chapter: 0,
                book: 0,
            })
        }
    })

    it('does not throw for a spine index that is not a whole number', () => {
        expect(
            wordsRemaining({ spineStats, spineIndex: Number.NaN, chapterFraction: 0.5 }),
        ).toEqual({ chapter: 20, book: 200 })
        expect(wordsRemaining({ spineStats, spineIndex: Infinity, chapterFraction: 0.5 })).toEqual({
            chapter: 0,
            book: 0,
        })
        // 1.5 is in item 1.
        expect(wordsRemaining({ spineStats, spineIndex: 1.5, chapterFraction: 0.5 })).toEqual({
            chapter: 30,
            book: 150,
        })
    })

    it('gives 0 for the chapter when the item has no words', () => {
        const withGap = stats(100, 0, 300)

        expect(wordsRemaining({ spineStats: withGap, spineIndex: 1, chapterFraction: 0 })).toEqual({
            chapter: 0,
            book: 60,
        })
    })
})
