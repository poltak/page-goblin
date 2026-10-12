import { afterEach, describe, expect, test, vi } from 'vitest'
import { pivotIndexForLength, splitAtPivot } from './pivot'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/** Expected pivot position for each count of letters from 1 to 20. */
const EXPECTED_INDEX = [0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4]

describe('pivotIndexForLength', () => {
    test('follows the table for lengths 1 to 20', () => {
        const actual = EXPECTED_INDEX.map((_, i) => pivotIndexForLength(i + 1))
        expect(actual).toEqual(EXPECTED_INDEX)
    })

    test('gives 0 for a length of 0', () => {
        expect(pivotIndexForLength(0)).toBe(0)
    })
})

describe('splitAtPivot', () => {
    test.each(EXPECTED_INDEX.map((index, i) => [i + 1, index]))(
        'splits a word of %i letters at index %i',
        (length, index) => {
            const word = LETTERS.slice(0, length)
            expect(splitAtPivot(word)).toEqual({
                before: word.slice(0, index),
                pivot: word[index],
                after: word.slice(index + 1),
            })
        },
    )

    test.each(EXPECTED_INDEX.map((index, i) => [i + 1, index]))(
        'moves the pivot to the right by the leading punctuation (%i letters)',
        (length, index) => {
            const word = LETTERS.slice(0, length)
            const quoted = `\u201C(${word},\u201D`
            expect(splitAtPivot(quoted)).toEqual({
                before: `\u201C(${word.slice(0, index)}`,
                pivot: word[index],
                after: `${word.slice(index + 1)},\u201D`,
            })
        },
    )

    test('does not count trailing or inner punctuation as letters', () => {
        // 5 letters give index 1. With the punctuation counted, 6 characters would give index 2.
        expect(splitAtPivot('hello.')).toEqual({ before: 'h', pivot: 'e', after: 'llo.' })
        expect(splitAtPivot("don't!")).toEqual({ before: 'd', pivot: 'o', after: "n't!" })
        // 9 letters give index 2. The hyphen is at index 4 and does not change the result.
        expect(splitAtPivot('well-known')).toEqual({ before: 'we', pivot: 'l', after: 'l-known' })
    })

    test('counts digits', () => {
        expect(splitAtPivot('1984')).toEqual({ before: '1', pivot: '9', after: '84' })
        // 6 digits give index 2, and the dollar sign moves it to index 3.
        expect(splitAtPivot('$1,250.00')).toEqual({ before: '$1,', pivot: '2', after: '50.00' })
    })

    test('uses index 0 for a word with no letter or digit', () => {
        expect(splitAtPivot('\u2014')).toEqual({ before: '', pivot: '\u2014', after: '' })
        expect(splitAtPivot('...')).toEqual({ before: '', pivot: '.', after: '..' })
        expect(splitAtPivot('***')).toEqual({ before: '', pivot: '*', after: '**' })
    })

    test('gives empty parts for an empty word', () => {
        expect(splitAtPivot('')).toEqual({ before: '', pivot: '', after: '' })
    })

    test('handles a word of one letter', () => {
        expect(splitAtPivot('a')).toEqual({ before: '', pivot: 'a', after: '' })
        expect(splitAtPivot('"I"')).toEqual({ before: '"', pivot: 'I', after: '"' })
    })

    test('keeps accented letters whole', () => {
        expect(splitAtPivot('été')).toEqual({ before: 'é', pivot: 't', after: 'é' })
        expect(splitAtPivot('à')).toEqual({ before: '', pivot: 'à', after: '' })
        expect(splitAtPivot('\u00ABrésumé\u00BB')).toEqual({
            before: '\u00ABré',
            pivot: 's',
            after: 'umé\u00BB',
        })
        expect(splitAtPivot('naïveté')).toEqual({
            before: 'na',
            pivot: 'ï',
            after: 'veté',
        })
    })

    describe.each([
        ['one code point for each accented letter', 'NFC'],
        ['a combining accent after each letter', 'NFD'],
    ] as const)('with %s', (_name, form) => {
        const accented = 'éàüöñçíóúâêîôûäëïõãý'.normalize(form)
        const letterSize = form === 'NFC' ? 1 : 2

        test.each(EXPECTED_INDEX.map((index, i) => [i + 1, index]))(
            'splits a word of %i accented letters at index %i',
            (length, index) => {
                const word = accented.slice(0, length * letterSize)
                const start = index * letterSize
                expect(splitAtPivot(`«${word}!`)).toEqual({
                    before: `«${word.slice(0, start)}`,
                    pivot: word.slice(start, start + letterSize),
                    after: `${word.slice(start + letterSize)}!`,
                })
            },
        )
    })

    test('keeps a letter together with its combining accent', () => {
        // "e" followed by U+0301 is one character for the reader.
        const e = 'e\u0301'
        expect(splitAtPivot(`${e}t${e}`)).toEqual({ before: e, pivot: 't', after: e })
        expect(splitAtPivot(`r${e}sum${e}`)).toEqual({
            before: `r${e}`,
            pivot: 's',
            after: `um${e}`,
        })
        expect(splitAtPivot(`b${e}b${e}`)).toEqual({ before: 'b', pivot: e, after: `b${e}` })
    })

    test('does not split letters outside the basic plane', () => {
        // Mathematical bold letters use two UTF-16 code units each.
        const a = '\u{1D41A}'
        const b = '\u{1D41B}'
        const c = '\u{1D41C}'
        expect(splitAtPivot(a + b + c)).toEqual({ before: a, pivot: b, after: c })
    })

    test('does not split emoji', () => {
        const grin = '\u{1F600}'
        const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
        expect(splitAtPivot(grin)).toEqual({ before: '', pivot: grin, after: '' })
        expect(splitAtPivot(`${grin}ok`)).toEqual({ before: `${grin}o`, pivot: 'k', after: '' })
        expect(splitAtPivot(`ok${grin}`)).toEqual({ before: 'o', pivot: 'k', after: grin })
        expect(splitAtPivot(family)).toEqual({ before: '', pivot: family, after: '' })
    })

    test('handles other scripts', () => {
        expect(splitAtPivot('привет')).toEqual({
            before: 'пр',
            pivot: 'и',
            after: 'вет',
        })
        expect(splitAtPivot('日本語')).toEqual({
            before: '日',
            pivot: '本',
            after: '語',
        })
    })

    describe('very long tokens', () => {
        test('finds the pivot from the start of the token', () => {
            expect(splitAtPivot('a'.repeat(100000))).toEqual({
                before: 'aaaa',
                pivot: 'a',
                after: 'a'.repeat(99995),
            })
        })

        test('handles text that needs segmentation', () => {
            const word = '日本語'.repeat(20000)
            const parts = splitAtPivot(word)
            expect(parts.before).toBe(word.slice(0, 4))
            expect(parts.pivot).toBe(word[4])
            expect(parts.after).toBe(word.slice(5))
        })

        test('keeps leading punctuation and combining accents', () => {
            const e = 'e\u{301}'
            expect(splitAtPivot(`"(${e.repeat(40)}`)).toEqual({
                before: `"(${e.repeat(4)}`,
                pivot: e,
                after: e.repeat(35),
            })
        })

        test('reads the full token when its start has few letters', () => {
            const dashes = '-'.repeat(70)
            expect(splitAtPivot(`${dashes}abc`)).toEqual({
                before: `${dashes}a`,
                pivot: 'b',
                after: 'c',
            })
            expect(splitAtPivot(dashes)).toEqual({ before: '', pivot: '-', after: '-'.repeat(69) })
        })

        test('is correct when the examined start ends in the middle of a character', () => {
            // Each of these letters uses two UTF-16 code units, so 64 code units end inside one.
            const a = '\u{1D41A}'
            expect(splitAtPivot(`x${a.repeat(40)}`)).toEqual({
                before: `x${a.repeat(3)}`,
                pivot: a,
                after: a.repeat(36),
            })
        })

        test('gives the same parts as the full split for each length near the limit', () => {
            for (let length = 60; length <= 70; length++) {
                const word = `(${'ab'.repeat(length)}`.slice(0, length)
                expect(splitAtPivot(word)).toEqual({
                    before: word.slice(0, 5),
                    pivot: word[5],
                    after: word.slice(6),
                })
            }
        })
    })

    describe('without Intl.Segmenter', () => {
        afterEach(() => {
            vi.unstubAllGlobals()
            vi.resetModules()
        })

        test('splits by code point', async () => {
            vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: undefined } }))
            vi.resetModules()
            const fallback = await import('./pivot')

            const grin = '\u{1F600}'
            expect(fallback.splitAtPivot(`ok${grin}`)).toEqual({
                before: 'o',
                pivot: 'k',
                after: grin,
            })
            expect(fallback.splitAtPivot(grin)).toEqual({ before: '', pivot: grin, after: '' })
            expect(fallback.splitAtPivot('日本語')).toEqual({
                before: '日',
                pivot: '本',
                after: '語',
            })
        })
    })
})
