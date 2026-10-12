import { describe, expect, test } from 'vitest'
import { DEFAULT_RSVP_SETTINGS } from './settings'
import { makeWord } from './testing/chapter'
import { rampFactorAt, rewindIntervalMs, wordDelayMs } from './timing'
import type { RsvpSettings } from './types'

/** 600 words for each minute gives a base time of 100 ms. */
const settings: RsvpSettings = { ...DEFAULT_RSVP_SETTINGS, wpm: 600 }

function delayOf(text: string, patch: Partial<RsvpSettings> = {}): number {
    return wordDelayMs({ word: makeWord(text), settings: { ...settings, ...patch } })
}

describe('wordDelayMs', () => {
    test('uses 60000 / wpm as the base time', () => {
        expect(delayOf('word')).toBe(100)
        expect(delayOf('word', { wpm: 250 })).toBe(240)
        expect(delayOf('word', { wpm: 50 })).toBe(1200)
        expect(delayOf('word', { wpm: 1000 })).toBe(60)
    })

    test('does not go below a base time of 50 ms', () => {
        expect(delayOf('word', { wpm: 1200 })).toBe(50)
        expect(delayOf('word', { wpm: 60000 })).toBe(50)
        expect(delayOf('word.', { wpm: 60000 })).toBe(150)
    })

    test('applies the punctuation multipliers', () => {
        expect(delayOf('word.')).toBe(300)
        expect(delayOf('word,')).toBe(200)
        expect(delayOf('word;')).toBe(250)
        expect(delayOf('word:')).toBe(250)
        expect(delayOf('word!')).toBe(300)
        expect(delayOf('word?')).toBe(300)
        expect(delayOf('word.\u201D')).toBe(300)
        expect(delayOf('word,[12]')).toBe(200)
    })

    test('uses the multipliers from the settings', () => {
        const custom = {
            periodMultiplier: 5,
            commaMultiplier: 1.5,
            semicolonMultiplier: 4,
            exclamationMultiplier: 6,
        }
        expect(delayOf('word.', custom)).toBe(500)
        expect(delayOf('word,', custom)).toBe(150)
        expect(delayOf('word:', custom)).toBe(400)
        expect(delayOf('word?', custom)).toBe(600)
    })

    test('gives the last word of a block the paragraph multiplier as a minimum', () => {
        const delay = (text: string, patch: Partial<RsvpSettings> = {}) =>
            wordDelayMs({ word: makeWord(text, true), settings: { ...settings, ...patch } })

        expect(delay('word')).toBe(350)
        expect(delay('word,')).toBe(350)
        expect(delay('word.')).toBe(350)
        expect(delay('word.', { periodMultiplier: 5 })).toBe(500)
        expect(delay('word', { paragraphMultiplier: 1 })).toBe(100)
        expect(delay('word,', { paragraphMultiplier: 1 })).toBe(200)
    })

    test('gives the last word of a heading the heading multiplier as a minimum', () => {
        const delay = (text: string, patch: Partial<RsvpSettings> = {}) =>
            wordDelayMs({
                word: makeWord(text, true),
                settings: { ...settings, ...patch },
                isHeadingEnd: true,
            })

        expect(delay('Title')).toBe(400)
        expect(delay('Title:')).toBe(400)
        expect(delay('Title?', { exclamationMultiplier: 6 })).toBe(600)
        // The heading value replaces the paragraph value.
        expect(delay('Title', { headingMultiplier: 2 })).toBe(200)
    })

    test('ignores the heading flag for a word that does not end a block', () => {
        const delay = wordDelayMs({ word: makeWord('Title'), settings, isHeadingEnd: true })
        expect(delay).toBe(100)
    })

    test('gives 4 percent more time for each letter above 8', () => {
        expect(delayOf('abcdefgh')).toBe(100)
        expect(delayOf('abcdefghi')).toBeCloseTo(104, 6)
        expect(delayOf('abcdefghij')).toBeCloseTo(108, 6)
        expect(delayOf('abcdefghijklmnop')).toBeCloseTo(132, 6)
    })

    test('limits the long word time to 60 percent', () => {
        expect(delayOf('a'.repeat(22))).toBeCloseTo(156, 6)
        expect(delayOf('a'.repeat(23))).toBeCloseTo(160, 6)
        expect(delayOf('a'.repeat(24))).toBeCloseTo(160, 6)
        expect(delayOf('a'.repeat(100000))).toBeCloseTo(160, 6)
    })

    test('counts only letters and digits for the long word rule', () => {
        // 8 letters with 4 punctuation characters.
        expect(delayOf('"(abcdefgh)"')).toBe(100)
        expect(delayOf('abcd-efgh')).toBe(100)
        expect(delayOf('abcde-fghi')).toBeCloseTo(104, 6)
        expect(delayOf('1234567890')).toBeCloseTo(108, 6)
        // 9 letters, where each accent is a separate combining character.
        expect(delayOf('e\u0301'.repeat(9))).toBeCloseTo(104, 6)
        // 8 letters that use two UTF-16 code units each.
        expect(delayOf('\u{1D41A}'.repeat(8))).toBe(100)
    })

    test('gives the same result when the same word is measured again', () => {
        expect(delayOf('abcdefghij')).toBeCloseTo(108, 6)
        expect(delayOf('abcdefghij')).toBeCloseTo(108, 6)
    })

    test('has no long word time when the setting is off', () => {
        expect(delayOf('abcdefghijklmnop', { longWordDelay: false })).toBe(100)
    })

    test('multiplies the punctuation, long word and ramp factors', () => {
        const delay = wordDelayMs({
            word: makeWord('abcdefghij.', true),
            settings,
            rampFactor: 1.6,
        })
        expect(delay).toBeCloseTo(100 * 3.5 * 1.08 * 1.6, 6)
    })
})

describe('rampFactorAt', () => {
    test('goes from 1.6 to 1 in five equal steps', () => {
        const factors = [0, 1, 2, 3, 4, 5, 6, 100].map(rampFactorAt)
        const expected = [1.6, 1.48, 1.36, 1.24, 1.12, 1, 1, 1]
        factors.forEach((factor, i) => expect(factor).toBeCloseTo(expected[i], 10))
    })

    test('gives the start factor for a negative count', () => {
        expect(rampFactorAt(-3)).toBeCloseTo(1.6, 10)
    })
})

describe('rewindIntervalMs', () => {
    test('uses two times the reading speed', () => {
        expect(rewindIntervalMs(250)).toBe(120)
        expect(rewindIntervalMs(50)).toBe(600)
    })

    test('does not go faster than 800 words for each minute', () => {
        expect(rewindIntervalMs(400)).toBe(75)
        expect(rewindIntervalMs(600)).toBe(75)
        expect(rewindIntervalMs(1000)).toBe(75)
    })
})
