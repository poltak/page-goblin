import { describe, expect, it } from 'vitest'
import {
    DEFAULT_SETTINGS,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    FONT_SIZE_STEP,
    LINE_HEIGHT_MAX,
    LINE_HEIGHT_MIN,
    LINE_HEIGHT_STEP,
    normalizeSettings,
    RSVP_CONTEXT_WORDS_MAX,
    RSVP_CONTEXT_WORDS_MIN,
    RSVP_CONTEXT_WORDS_STEP,
    RSVP_FONT_SIZE_MAX,
    RSVP_FONT_SIZE_MIN,
    RSVP_FONT_SIZE_STEP,
    RSVP_MULTIPLIER_MAX,
    RSVP_MULTIPLIER_MIN,
    RSVP_MULTIPLIER_STEP,
    RSVP_WPM_MAX,
    RSVP_WPM_MIN,
    RSVP_WPM_STEP,
    SPEECH_PITCH_MAX,
    SPEECH_PITCH_MIN,
    SPEECH_PITCH_STEP,
    SPEECH_RATE_MAX,
    SPEECH_RATE_MIN,
    SPEECH_RATE_STEP,
} from './schema'
import type { Settings } from './schema'

const CUSTOM: Settings = {
    theme: 'sepia',
    darkTheme: 'black',
    layout: 'scroll',
    fontId: 'literata',
    fontSize: 24,
    lineHeight: 1.8,
    margin: 'wide',
    textAlign: 'justify',
    hyphenate: true,
    publisherStyles: false,
    columns: 2,
    pageTurn: 'fade',
    keepAwake: false,
    rsvp: {
        wpm: 420,
        contextWords: 12,
        periodMultiplier: 2.5,
        commaMultiplier: 1.5,
        semicolonMultiplier: 2,
        exclamationMultiplier: 4,
        paragraphMultiplier: 5,
        headingMultiplier: 6.5,
        longWordDelay: false,
        rampUp: false,
        showPivot: false,
        pauseAtChapterStart: false,
        fontSize: 64,
    },
    speech: { voiceId: 'com.apple.voice.Samantha', rate: 1.4, pitch: 0.8, highlightWords: false },
    librarySort: 'author',
}

describe('DEFAULT_SETTINGS', () => {
    it('has the specified values', () => {
        expect(DEFAULT_SETTINGS).toEqual({
            theme: 'auto',
            darkTheme: 'dark',
            layout: 'paged',
            fontId: 'publisher',
            fontSize: 19,
            lineHeight: 1.55,
            margin: 'normal',
            textAlign: 'publisher',
            hyphenate: false,
            publisherStyles: true,
            columns: 'auto',
            pageTurn: 'slide',
            keepAwake: true,
            rsvp: {
                wpm: 250,
                contextWords: 5,
                periodMultiplier: 3,
                commaMultiplier: 2,
                semicolonMultiplier: 2.5,
                exclamationMultiplier: 3,
                paragraphMultiplier: 3.5,
                headingMultiplier: 4,
                longWordDelay: true,
                rampUp: true,
                showPivot: true,
                pauseAtChapterStart: true,
                fontSize: 48,
            },
            speech: { voiceId: null, rate: 1, pitch: 1, highlightWords: true },
            librarySort: 'recent',
        })
    })

    it('is a fixed point of normalizeSettings', () => {
        expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
    })

    it('cannot be changed', () => {
        expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
        expect(Object.isFrozen(DEFAULT_SETTINGS.rsvp)).toBe(true)
        expect(Object.isFrozen(DEFAULT_SETTINGS.speech)).toBe(true)
    })
})

describe('normalizeSettings', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty object', {}],
        ['an array', []],
        ['an array of settings', [CUSTOM]],
        ['a string', 'dark'],
        ['a number', 42],
        ['NaN', Number.NaN],
        ['a boolean', true],
        ['a function', () => CUSTOM],
    ])('gives the defaults for %s', (_name, raw) => {
        expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS)
    })

    it('gives a new object each time, with new groups', () => {
        const result = normalizeSettings(null)
        expect(result).not.toBe(DEFAULT_SETTINGS)
        expect(result.rsvp).not.toBe(DEFAULT_SETTINGS.rsvp)
        expect(result.speech).not.toBe(DEFAULT_SETTINGS.speech)
        expect(Object.isFrozen(result)).toBe(false)
    })

    it('keeps all valid fields', () => {
        expect(normalizeSettings(CUSTOM)).toEqual(CUSTOM)
        expect(normalizeSettings(JSON.parse(JSON.stringify(CUSTOM)))).toEqual(CUSTOM)
    })

    it('does not change the input and does not share its groups', () => {
        const raw = JSON.parse(JSON.stringify(CUSTOM)) as Settings
        const result = normalizeSettings(raw)
        expect(raw).toEqual(CUSTOM)
        expect(result.rsvp).not.toBe(raw.rsvp)
        expect(result.speech).not.toBe(raw.speech)
    })

    it('keeps the valid fields when other fields are bad', () => {
        const result = normalizeSettings({ ...CUSTOM, theme: 'neon', fontSize: 'big', rsvp: 7 })
        expect(result).toEqual({
            ...CUSTOM,
            theme: DEFAULT_SETTINGS.theme,
            fontSize: DEFAULT_SETTINGS.fontSize,
            rsvp: DEFAULT_SETTINGS.rsvp,
        })
    })

    it('removes fields that are not settings', () => {
        const result = normalizeSettings({ version: 1, extra: 'x', rsvp: { extra: 1 } })
        expect(result).toEqual(DEFAULT_SETTINGS)
        expect(Object.keys(result)).toEqual(Object.keys(DEFAULT_SETTINGS))
        expect(Object.keys(result.rsvp)).toEqual(Object.keys(DEFAULT_SETTINGS.rsvp))
    })

    it.each([
        ['a version from before the first release', { version: 0, theme: 'oled', fontSize: 22 }],
        ['no version', { theme: 'oled', fontSize: 22 }],
        ['a later version', { version: 99, theme: 'oled', fontSize: 22, newField: [1, 2] }],
        ['a version of the wrong type', { version: 'one', theme: 'oled', fontSize: 22 }],
    ])('reads data with %s field by field', (_name, raw) => {
        expect(normalizeSettings(raw)).toEqual({ ...DEFAULT_SETTINGS, fontSize: 22 })
    })

    it('reads the settings of the old reader without an error', () => {
        const old = { textAlign: 'justify', textScale: 135, font: 'sans', theme: 'oled-dark' }
        expect(normalizeSettings(old)).toEqual({ ...DEFAULT_SETTINGS, textAlign: 'justify' })
    })

    describe('choices', () => {
        const bad = [undefined, null, '', 'nope', 0, 3, true, {}, [], ['dark'], Number.NaN]

        it.each([
            ['theme', ['auto', 'light', 'sepia', 'dark', 'black']],
            ['darkTheme', ['dark', 'black']],
            ['layout', ['paged', 'scroll']],
            ['margin', ['narrow', 'normal', 'wide']],
            ['textAlign', ['publisher', 'start', 'justify']],
            ['columns', ['auto', 1, 2]],
            ['pageTurn', ['slide', 'fade', 'none']],
            ['librarySort', ['recent', 'added', 'title', 'author']],
        ] as const)('%s accepts only its values', (key, valid) => {
            for (const value of valid) {
                expect(normalizeSettings({ [key]: value })[key]).toBe(value)
            }
            for (const value of bad) {
                expect(normalizeSettings({ [key]: value })[key]).toBe(DEFAULT_SETTINGS[key])
            }
        })

        it('does not accept a value of a different field or a different case', () => {
            expect(normalizeSettings({ darkTheme: 'light' }).darkTheme).toBe('dark')
            expect(normalizeSettings({ darkTheme: 'sepia' }).darkTheme).toBe('dark')
            expect(normalizeSettings({ theme: 'Dark' }).theme).toBe('auto')
            expect(normalizeSettings({ layout: 'continuous' }).layout).toBe('paged')
        })

        it('accepts the column numbers only as numbers', () => {
            expect(normalizeSettings({ columns: '1' }).columns).toBe('auto')
            expect(normalizeSettings({ columns: '2' }).columns).toBe('auto')
            expect(normalizeSettings({ columns: 1.5 }).columns).toBe('auto')
        })
    })

    describe('booleans', () => {
        it.each(['hyphenate', 'publisherStyles', 'keepAwake'] as const)(
            '%s accepts only true and false',
            (key) => {
                expect(normalizeSettings({ [key]: true })[key]).toBe(true)
                expect(normalizeSettings({ [key]: false })[key]).toBe(false)
                for (const value of [undefined, null, 0, 1, 'true', 'false', '', {}, []]) {
                    expect(normalizeSettings({ [key]: value })[key]).toBe(DEFAULT_SETTINGS[key])
                }
            },
        )

        it.each(['longWordDelay', 'rampUp', 'showPivot', 'pauseAtChapterStart'] as const)(
            'rsvp.%s accepts only true and false',
            (key) => {
                expect(normalizeSettings({ rsvp: { [key]: false } }).rsvp[key]).toBe(false)
                for (const value of [undefined, null, 0, 'false', '', {}]) {
                    expect(normalizeSettings({ rsvp: { [key]: value } }).rsvp[key]).toBe(true)
                }
            },
        )

        it('speech.highlightWords accepts only true and false', () => {
            expect(
                normalizeSettings({ speech: { highlightWords: false } }).speech.highlightWords,
            ).toBe(false)
            expect(normalizeSettings({ speech: { highlightWords: 0 } }).speech.highlightWords).toBe(
                true,
            )
        })
    })

    describe('numbers', () => {
        const notNumbers = [
            undefined,
            null,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            '20',
            '',
            true,
            {},
            [20],
        ]

        it('fontSize: clamps, rounds and rejects values that are not numbers', () => {
            const fontSize = (value: unknown) => normalizeSettings({ fontSize: value }).fontSize
            expect(fontSize(12)).toBe(12)
            expect(fontSize(40)).toBe(40)
            expect(fontSize(5)).toBe(FONT_SIZE_MIN)
            expect(fontSize(-3)).toBe(FONT_SIZE_MIN)
            expect(fontSize(0)).toBe(FONT_SIZE_MIN)
            expect(fontSize(1e9)).toBe(FONT_SIZE_MAX)
            expect(fontSize(19.4)).toBe(19)
            expect(fontSize(19.6)).toBe(20)
            expect(fontSize(40.4)).toBe(40)
            for (const value of notNumbers) expect(fontSize(value)).toBe(19)
        })

        it('lineHeight: keeps null, clamps and rounds to 0.05', () => {
            const lineHeight = (value: unknown) =>
                normalizeSettings({ lineHeight: value }).lineHeight
            expect(lineHeight(null)).toBeNull()
            expect(lineHeight(1)).toBe(1)
            expect(lineHeight(2.4)).toBe(2.4)
            expect(lineHeight(0.2)).toBe(LINE_HEIGHT_MIN)
            expect(lineHeight(3)).toBe(LINE_HEIGHT_MAX)
            expect(lineHeight(1.52)).toBe(1.5)
            expect(lineHeight(1.53)).toBe(1.55)
            expect(lineHeight(1.8)).toBe(1.8)
            expect(lineHeight(2.39)).toBe(2.4)
            for (const value of notNumbers) {
                if (value !== null) expect(lineHeight(value)).toBe(1.55)
            }
        })

        it('gives numbers with no binary noise for each step of the line height', () => {
            for (let step = 0; step <= 28; step++) {
                const value = normalizeSettings({ lineHeight: 1 + step * 0.05 }).lineHeight
                expect(String(value).length).toBeLessThanOrEqual(4)
            }
        })

        it('rsvp.wpm: clamps and rounds to 10', () => {
            const wpm = (value: unknown) => normalizeSettings({ rsvp: { wpm: value } }).rsvp.wpm
            expect(wpm(50)).toBe(50)
            expect(wpm(1000)).toBe(1000)
            expect(wpm(20)).toBe(RSVP_WPM_MIN)
            expect(wpm(5000)).toBe(RSVP_WPM_MAX)
            expect(wpm(254)).toBe(250)
            expect(wpm(256)).toBe(260)
            expect(wpm(333.3)).toBe(330)
            for (const value of notNumbers) expect(wpm(value)).toBe(250)
        })

        it('rsvp.contextWords: clamps to 0 through 100 and rounds', () => {
            const words = (value: unknown) =>
                normalizeSettings({ rsvp: { contextWords: value } }).rsvp.contextWords
            expect(words(0)).toBe(0)
            expect(words(100)).toBe(100)
            expect(words(-1)).toBe(0)
            expect(words(101)).toBe(100)
            expect(words(2.4)).toBe(2)
            for (const value of notNumbers) expect(words(value)).toBe(5)
        })

        it.each([
            'periodMultiplier',
            'commaMultiplier',
            'semicolonMultiplier',
            'exclamationMultiplier',
            'paragraphMultiplier',
            'headingMultiplier',
        ] as const)('rsvp.%s: clamps to 1 through 10 and rounds to 0.5', (key) => {
            const multiplier = (value: unknown) =>
                normalizeSettings({ rsvp: { [key]: value } }).rsvp[key]
            expect(multiplier(1)).toBe(1)
            expect(multiplier(10)).toBe(10)
            expect(multiplier(0)).toBe(RSVP_MULTIPLIER_MIN)
            expect(multiplier(11)).toBe(RSVP_MULTIPLIER_MAX)
            expect(multiplier(3.2)).toBe(3)
            expect(multiplier(3.3)).toBe(3.5)
            expect(multiplier(7.5)).toBe(7.5)
            for (const value of notNumbers) {
                expect(multiplier(value)).toBe(DEFAULT_SETTINGS.rsvp[key])
            }
        })

        it('rsvp.fontSize: clamps to 24 through 96 and rounds', () => {
            const fontSize = (value: unknown) =>
                normalizeSettings({ rsvp: { fontSize: value } }).rsvp.fontSize
            expect(fontSize(10)).toBe(RSVP_FONT_SIZE_MIN)
            expect(fontSize(200)).toBe(RSVP_FONT_SIZE_MAX)
            expect(fontSize(50.5)).toBe(51)
            for (const value of notNumbers) expect(fontSize(value)).toBe(48)
        })

        it.each(['rate', 'pitch'] as const)(
            'speech.%s: clamps to 0.5 through 2 and rounds to 0.1',
            (key) => {
                const number = (value: unknown) =>
                    normalizeSettings({ speech: { [key]: value } }).speech[key]
                expect(number(0.5)).toBe(0.5)
                expect(number(2)).toBe(2)
                expect(number(0.1)).toBe(SPEECH_RATE_MIN)
                expect(number(10)).toBe(SPEECH_RATE_MAX)
                expect(number(1.26)).toBe(1.3)
                expect(number(1.24)).toBe(1.2)
                expect(number(0.7)).toBe(0.7)
                expect(number(1.7)).toBe(1.7)
                for (const value of notNumbers) expect(number(value)).toBe(1)
            },
        )
    })

    describe('slider values', () => {
        // A slider that the interface builds from the limits gives min + k * step.
        const sliders: [path: string, min: number, max: number, step: number][] = [
            ['fontSize', FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP],
            ['lineHeight', LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, LINE_HEIGHT_STEP],
            ['rsvp.wpm', RSVP_WPM_MIN, RSVP_WPM_MAX, RSVP_WPM_STEP],
            [
                'rsvp.contextWords',
                RSVP_CONTEXT_WORDS_MIN,
                RSVP_CONTEXT_WORDS_MAX,
                RSVP_CONTEXT_WORDS_STEP,
            ],
            [
                'rsvp.headingMultiplier',
                RSVP_MULTIPLIER_MIN,
                RSVP_MULTIPLIER_MAX,
                RSVP_MULTIPLIER_STEP,
            ],
            ['rsvp.fontSize', RSVP_FONT_SIZE_MIN, RSVP_FONT_SIZE_MAX, RSVP_FONT_SIZE_STEP],
            ['speech.rate', SPEECH_RATE_MIN, SPEECH_RATE_MAX, SPEECH_RATE_STEP],
            ['speech.pitch', SPEECH_PITCH_MIN, SPEECH_PITCH_MAX, SPEECH_PITCH_STEP],
        ]

        function read(path: string, value: number): number {
            const [group, key] = path.includes('.') ? path.split('.') : [null, path]
            const result = normalizeSettings(
                group ? { [group]: { [key]: value } } : { [key]: value },
            )
            const owner = (group ? result[group as 'rsvp'] : result) as unknown as Record<
                string,
                number
            >
            return owner[key]
        }

        it.each(sliders)(
            '%s: each step from the minimum to the maximum stays the same',
            (path, min, max, step) => {
                const steps = Math.round((max - min) / step)
                // The maximum is on the step grid, so a slider can reach it.
                expect(min + steps * step).toBeCloseTo(max, 9)
                const seen = new Set<number>()
                for (let k = 0; k <= steps; k++) {
                    // The text of a range input has no binary noise.
                    const value = Number((min + k * step).toFixed(2))
                    const result = read(path, value)
                    expect(result).toBe(value)
                    expect(read(path, min + k * step)).toBe(value)
                    expect(read(path, result)).toBe(result)
                    seen.add(result)
                }
                expect(seen.size).toBe(steps + 1)
                expect(read(path, min - step)).toBe(min)
                expect(read(path, max + step)).toBe(max)
            },
        )

        it('has each default value on the step grid', () => {
            for (const [path] of sliders) {
                const [group, key] = path.includes('.') ? path.split('.') : [null, path]
                const owner = (group
                    ? DEFAULT_SETTINGS[group as 'rsvp']
                    : DEFAULT_SETTINGS) as unknown as Record<string, number>
                expect(read(path, owner[key]), path).toBe(owner[key])
            }
            for (const key of Object.keys(DEFAULT_SETTINGS.rsvp)) {
                if (!key.endsWith('Multiplier')) continue
                const value = DEFAULT_SETTINGS.rsvp[key as 'periodMultiplier']
                expect(read(`rsvp.${key}`, value), key).toBe(value)
            }
        })
    })

    describe('text fields', () => {
        it('keeps a fontId that is not in the catalogue', () => {
            expect(normalizeSettings({ fontId: 'book:Minion Pro' }).fontId).toBe('book:Minion Pro')
            expect(normalizeSettings({ fontId: 'removed-font' }).fontId).toBe('removed-font')
        })

        it('replaces a fontId that is not text', () => {
            for (const value of [undefined, null, '', 7, true, {}, ['literata']]) {
                expect(normalizeSettings({ fontId: value }).fontId).toBe('publisher')
            }
        })

        it('keeps a voice id and makes each other value null', () => {
            expect(normalizeSettings({ speech: { voiceId: 'Daniel' } }).speech.voiceId).toBe(
                'Daniel',
            )
            for (const value of [undefined, null, '', 7, true, {}, ['Daniel']]) {
                expect(normalizeSettings({ speech: { voiceId: value } }).speech.voiceId).toBeNull()
            }
        })
    })

    describe('groups', () => {
        it.each([
            ['null', null],
            ['a string', 'fast'],
            ['a number', 300],
            ['an array', [{ wpm: 300 }]],
            ['a boolean', true],
        ])('gives the default groups when a group is %s', (_name, group) => {
            const result = normalizeSettings({ rsvp: group, speech: group })
            expect(result.rsvp).toEqual(DEFAULT_SETTINGS.rsvp)
            expect(result.speech).toEqual(DEFAULT_SETTINGS.speech)
        })

        it('fills the fields that a group does not have', () => {
            const result = normalizeSettings({ rsvp: { wpm: 300 }, speech: { rate: 1.5 } })
            expect(result.rsvp).toEqual({ ...DEFAULT_SETTINGS.rsvp, wpm: 300 })
            expect(result.speech).toEqual({ ...DEFAULT_SETTINGS.speech, rate: 1.5 })
        })

        it('does not read group fields from the top level', () => {
            const result = normalizeSettings({ wpm: 300, rate: 1.5 })
            expect(result).toEqual(DEFAULT_SETTINGS)
        })
    })

    it('gives the same result when it runs again on its result', () => {
        const messy = {
            theme: 'black',
            fontSize: 19.6,
            lineHeight: 1.53,
            columns: '2',
            rsvp: { wpm: 256, commaMultiplier: 3.3, rampUp: 'yes' },
            speech: { rate: 1.26, voiceId: 9 },
        }
        const once = normalizeSettings(messy)
        expect(normalizeSettings(once)).toEqual(once)
    })

    it('never throws', () => {
        const values: unknown[] = [
            undefined,
            null,
            0,
            -1,
            Number.NaN,
            '',
            'x',
            true,
            [],
            [[]],
            {},
            Symbol('s'),
            10n,
            new Date(0),
            new Map(),
            Object.create(null),
            () => {},
        ]
        const keys = [...Object.keys(DEFAULT_SETTINGS), 'version']
        for (const value of values) {
            expect(() => normalizeSettings(value)).not.toThrow()
            for (const key of keys) {
                expect(() => normalizeSettings({ [key]: value })).not.toThrow()
            }
            for (const key of Object.keys(DEFAULT_SETTINGS.rsvp)) {
                expect(() => normalizeSettings({ rsvp: { [key]: value } })).not.toThrow()
            }
            for (const key of Object.keys(DEFAULT_SETTINGS.speech)) {
                expect(() => normalizeSettings({ speech: { [key]: value } })).not.toThrow()
            }
        }
    })
})
