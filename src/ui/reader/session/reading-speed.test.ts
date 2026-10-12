import { describe, expect, it } from 'vitest'
import { AVERAGE_ALPHA, nextAverage, readingSample } from './reading-speed'
import type { ReadingSampleOptions, SpeedPoint } from './reading-speed'

// 1500 characters at 1 word for each 5 characters are 300 words.
const previous: SpeedPoint = {
    locator: { spineIndex: 2, offset: 1000 },
    visible: { spineIndex: 2, start: 1000, end: 2500 },
    time: 100_000,
}
const stats = { chars: 50_000, words: 10_000 }

function sample(changes: Partial<ReadingSampleOptions> = {}): number | null {
    return readingSample({
        previous,
        next: { locator: { spineIndex: 2, offset: 2500 }, time: 160_000 },
        mode: 'read',
        visible: true,
        stats,
        ...changes,
    })
}

function after(seconds: number, offset = 2500): ReadingSampleOptions['next'] {
    return { locator: { spineIndex: 2, offset }, time: previous.time + seconds * 1000 }
}

describe('readingSample', () => {
    it('gives the words for each minute of one page turn', () => {
        // 300 words in 60 seconds.
        expect(sample()).toBeCloseTo(300, 9)
        // 300 words in 30 seconds.
        expect(sample({ next: after(30) })).toBeCloseTo(600, 9)
    })

    it('uses the word density of the chapter', () => {
        expect(sample({ stats: { chars: 60_000, words: 10_000 } })).toBeCloseTo(250, 9)
    })

    it.each([
        ['no statistics', undefined],
        ['a chapter with no characters', { chars: 0, words: 0 }],
        ['a chapter with no words', { chars: 500, words: 0 }],
    ])('uses 1 word for each 6 characters with %s', (_name, value) => {
        expect(sample({ stats: value })).toBeCloseTo(250, 9)
    })

    it('gives null when there is no relocate before', () => {
        expect(sample({ previous: null })).toBeNull()
    })

    it.each(['speed', 'listen'] as const)('gives null in the mode %s', (mode) => {
        expect(sample({ mode })).toBeNull()
    })

    it('gives null when the page was hidden in between', () => {
        expect(sample({ visible: false })).toBeNull()
    })

    it('gives null for a move to a different chapter', () => {
        expect(
            sample({ next: { locator: { spineIndex: 3, offset: 2500 }, time: 160_000 } }),
        ).toBeNull()
    })

    it.each([
        ['a move back', 0],
        ['no move', 1000],
        ['a scroll of some lines', 1400],
        ['one character before the page end', 2499],
        ['a jump forward', 9000],
    ])('gives null for %s', (_name, offset) => {
        expect(sample({ next: after(60, offset) })).toBeNull()
    })

    it('gives null when the visible range before was empty', () => {
        const empty: SpeedPoint = {
            ...previous,
            visible: { spineIndex: 2, start: 1000, end: 1000 },
        }
        expect(sample({ previous: empty, next: after(60, 1000) })).toBeNull()
    })

    it('accepts only 3 to 300 seconds between the two relocates', () => {
        // 40 words. The speed is inside its limits from 2.7 to 40 seconds.
        const short: SpeedPoint = {
            ...previous,
            visible: { spineIndex: 2, start: 1000, end: 1200 },
        }
        const quick = (seconds: number) =>
            sample({ previous: short, next: after(seconds, 1200) }) !== null
        expect(quick(2.999)).toBe(false)
        expect(quick(3)).toBe(true)
        expect(quick(40)).toBe(true)

        // 600 words. The speed is inside its limits from 40 to 600 seconds.
        const long: SpeedPoint = {
            ...previous,
            visible: { spineIndex: 2, start: 1000, end: 4000 },
        }
        const slow = (seconds: number) =>
            sample({ previous: long, next: after(seconds, 4000) }) !== null
        expect(slow(300)).toBe(true)
        expect(slow(300.001)).toBe(false)
    })

    it('drops a sample outside 60 to 900 words for each minute', () => {
        // 300 words.
        expect(sample({ next: after(20) })).toBeCloseTo(900, 9)
        expect(sample({ next: after(19.9) })).toBeNull()
        expect(sample({ next: after(300) })).toBeCloseTo(60, 9)

        const short: SpeedPoint = {
            ...previous,
            visible: { spineIndex: 2, start: 1000, end: 1500 },
        }
        // 100 words in 101 seconds are below 60.
        expect(sample({ previous: short, next: after(101, 1500) })).toBeNull()
        expect(sample({ previous: short, next: after(100, 1500) })).toBeCloseTo(60, 9)
    })

    it('gives null for a time that is not a number', () => {
        expect(sample({ next: { locator: { spineIndex: 2, offset: 2500 }, time: NaN } })).toBeNull()
    })
})

describe('nextAverage', () => {
    it('moves the average by one fifth of the difference', () => {
        expect(AVERAGE_ALPHA).toBe(0.2)
        expect(nextAverage(230, 330)).toBeCloseTo(250, 9)
        expect(nextAverage(250, 150)).toBeCloseTo(230, 9)
        expect(nextAverage(300, 300)).toBe(300)
    })

    it('comes near a constant speed after many samples', () => {
        let average = 230
        for (let count = 0; count < 40; count++) average = nextAverage(average, 400)
        expect(average).toBeGreaterThan(399)
        expect(average).toBeLessThanOrEqual(400)
    })
})
