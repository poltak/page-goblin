import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeLanguage } from './language'

afterEach(() => {
    vi.restoreAllMocks()
})

describe('normalizeLanguage', () => {
    it('keeps a tag that is in the normal form', () => {
        for (const tag of ['en', 'en-US', 'pt-BR', 'zh-Hant-TW', 'vi', 'id', 'sr-Latn', 'grc']) {
            expect(normalizeLanguage(tag), tag).toBe(tag)
        }
    })

    it('trims the value, changes an underscore to a hyphen and lower-cases the language', () => {
        const cases: [string, string][] = [
            ['  en  ', 'en'],
            ['\nen-GB\t', 'en-GB'],
            ['en_US', 'en-US'],
            ['EN-US', 'en-US'],
            ['En', 'en'],
            ['EN', 'en'],
            ['zh_Hant_TW', 'zh-Hant-TW'],
            ['PT_br', 'pt-br'],
            // Only the language subtag changes. The browser reads the rest in each letter case.
            ['en-us', 'en-us'],
            ['en-gb', 'en-gb'],
        ]

        for (const [value, expected] of cases) {
            expect(normalizeLanguage(value), value).toBe(expected)
        }
    })

    it('maps a three-letter code of a common language to two letters', () => {
        const cases: [string, string][] = [
            ['eng', 'en'],
            ['fra', 'fr'],
            ['fre', 'fr'],
            ['deu', 'de'],
            ['ger', 'de'],
            ['spa', 'es'],
            ['ita', 'it'],
            ['por', 'pt'],
            ['nld', 'nl'],
            ['dut', 'nl'],
            ['rus', 'ru'],
            ['jpn', 'ja'],
            ['zho', 'zh'],
            ['chi', 'zh'],
            ['kor', 'ko'],
            ['ara', 'ar'],
            ['heb', 'he'],
            ['vie', 'vi'],
            ['ind', 'id'],
            ['pol', 'pl'],
            ['swe', 'sv'],
            ['tur', 'tr'],
            ['ENG', 'en'],
            ['Eng', 'en'],
            ['eng-US', 'en-US'],
            ['eng_GB', 'en-GB'],
            ['ZHO-Hans', 'zh-Hans'],
        ]

        for (const [value, expected] of cases) {
            expect(normalizeLanguage(value), value).toBe(expected)
        }
    })

    it('keeps a three-letter code that has no two-letter form in the list', () => {
        expect(normalizeLanguage('grc')).toBe('grc')
        expect(normalizeLanguage('LAT')).toBe('lat')
        expect(normalizeLanguage('haw-US')).toBe('haw-US')
    })

    it('gives null for a value that names no language', () => {
        for (const value of ['und', 'UND', 'Und', 'zxx', 'ZXX', 'mul', 'und-US', 'mul_Latn']) {
            expect(normalizeLanguage(value), value).toBeNull()
        }
    })

    it('gives null for an empty value', () => {
        expect(normalizeLanguage(null)).toBeNull()
        expect(normalizeLanguage(undefined)).toBeNull()
        expect(normalizeLanguage('')).toBeNull()
        expect(normalizeLanguage('   ')).toBeNull()
    })

    it('gives null for a value that is not a plausible tag', () => {
        const values = [
            'english',
            'English',
            'e',
            'x-klingon',
            'i-default',
            'en US',
            'en, fr',
            'en;fr',
            'en-',
            '-en',
            'en--US',
            'en-abcdefghi',
            'en-US-',
            '12',
            'e1',
            'en-a',
            'français',
            'http://purl.org/dc/terms/RFC4646',
            'constructor',
            '__proto__',
        ]

        for (const value of values) {
            expect(normalizeLanguage(value), value).toBeNull()
        }
    })

    it('gives the same result for a value that it saw before', () => {
        const spy = vi.spyOn(Intl, 'getCanonicalLocales')

        expect(normalizeLanguage('nb_NO')).toBe('nb-NO')
        expect(normalizeLanguage('nb_NO')).toBe('nb-NO')
        expect(spy).toHaveBeenCalledTimes(1)
    })

    it('stays correct for more values than the cache holds', () => {
        for (let i = 0; i < 200; i++) normalizeLanguage(`en-x-${i}`)

        expect(normalizeLanguage('EN_au')).toBe('en-au')
        expect(normalizeLanguage('und')).toBeNull()
    })

    it('gives null for a very long value and does not keep it', () => {
        const set = vi.spyOn(Map.prototype, 'set')
        const long = `en-${'abcdefgh-'.repeat(20_000)}x`

        expect(normalizeLanguage(long)).toBeNull()
        expect(normalizeLanguage(` ${'en-US '.repeat(50)}`)).toBeNull()
        expect(set.mock.calls.some(([key]) => typeof key === 'string' && key.length > 100)).toBe(
            false,
        )
        // A long tag of a real book still passes.
        expect(normalizeLanguage('  en_Latn_US_x_private_use_tag  ')).toBe(
            'en-Latn-US-x-private-use-tag',
        )
    })

    it('accepts a tag of the right shape when Intl cannot test it', () => {
        const original = Intl.getCanonicalLocales
        Reflect.set(Intl, 'getCanonicalLocales', undefined)
        try {
            expect(normalizeLanguage('ES_mx')).toBe('es-mx')
            expect(normalizeLanguage('spanish')).toBeNull()
        } finally {
            Reflect.set(Intl, 'getCanonicalLocales', original)
        }
    })
})
