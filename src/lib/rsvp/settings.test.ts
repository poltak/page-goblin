import { describe, expect, test } from 'vitest'
import { DEFAULT_RSVP_SETTINGS, normalizeRsvpSettings } from './settings'

describe('DEFAULT_RSVP_SETTINGS', () => {
    test('has the values that the owner tuned', () => {
        expect(DEFAULT_RSVP_SETTINGS).toEqual({
            wpm: 250,
            periodMultiplier: 3,
            commaMultiplier: 2,
            semicolonMultiplier: 2.5,
            exclamationMultiplier: 3,
            paragraphMultiplier: 3.5,
            headingMultiplier: 4,
            longWordDelay: true,
            rampUp: true,
        })
    })

    test('cannot be changed', () => {
        expect(Object.isFrozen(DEFAULT_RSVP_SETTINGS)).toBe(true)
    })
})

describe('normalizeRsvpSettings', () => {
    test.each([undefined, null, 42, 'fast', true, []])('gives the defaults for %j', (raw) => {
        expect(normalizeRsvpSettings(raw)).toEqual(DEFAULT_RSVP_SETTINGS)
    })

    test('gives a new object each time', () => {
        const settings = normalizeRsvpSettings({})
        expect(settings).not.toBe(DEFAULT_RSVP_SETTINGS)
        expect(Object.isFrozen(settings)).toBe(false)
    })

    test('keeps valid values', () => {
        const valid = {
            wpm: 420,
            periodMultiplier: 1,
            commaMultiplier: 1.5,
            semicolonMultiplier: 10,
            exclamationMultiplier: 4,
            paragraphMultiplier: 2,
            headingMultiplier: 6,
            longWordDelay: false,
            rampUp: false,
        }
        expect(normalizeRsvpSettings(valid)).toEqual(valid)
    })

    test('fills in the fields that are missing', () => {
        expect(normalizeRsvpSettings({ wpm: 300 })).toEqual({ ...DEFAULT_RSVP_SETTINGS, wpm: 300 })
    })

    test('drops fields that it does not know', () => {
        expect(normalizeRsvpSettings({ wpm: 300, theme: 'dark' })).toEqual({
            ...DEFAULT_RSVP_SETTINGS,
            wpm: 300,
        })
    })

    test('limits the speed to the range 50 to 1000', () => {
        expect(normalizeRsvpSettings({ wpm: 5 }).wpm).toBe(50)
        expect(normalizeRsvpSettings({ wpm: 0 }).wpm).toBe(50)
        expect(normalizeRsvpSettings({ wpm: -200 }).wpm).toBe(50)
        expect(normalizeRsvpSettings({ wpm: 50 }).wpm).toBe(50)
        expect(normalizeRsvpSettings({ wpm: 1000 }).wpm).toBe(1000)
        expect(normalizeRsvpSettings({ wpm: 60000 }).wpm).toBe(1000)
    })

    test('limits each multiplier to the range 1 to 10', () => {
        const settings = normalizeRsvpSettings({
            periodMultiplier: 0,
            commaMultiplier: -1,
            semicolonMultiplier: 0.5,
            exclamationMultiplier: 11,
            paragraphMultiplier: 1000,
            headingMultiplier: 10,
        })
        expect(settings).toMatchObject({
            periodMultiplier: 1,
            commaMultiplier: 1,
            semicolonMultiplier: 1,
            exclamationMultiplier: 10,
            paragraphMultiplier: 10,
            headingMultiplier: 10,
        })
    })

    test('replaces numbers that are not finite with the defaults', () => {
        const settings = normalizeRsvpSettings({
            wpm: Number.NaN,
            periodMultiplier: Number.POSITIVE_INFINITY,
            commaMultiplier: Number.NEGATIVE_INFINITY,
            semicolonMultiplier: Number.NaN,
        })
        expect(settings).toEqual(DEFAULT_RSVP_SETTINGS)
    })

    test('replaces values of the wrong type with the defaults', () => {
        const settings = normalizeRsvpSettings({
            wpm: null,
            periodMultiplier: {},
            commaMultiplier: [4],
            semicolonMultiplier: true,
            exclamationMultiplier: 'many',
            paragraphMultiplier: '',
            headingMultiplier: '  ',
            longWordDelay: 'false',
            rampUp: 0,
        })
        expect(settings).toEqual(DEFAULT_RSVP_SETTINGS)
    })

    test('reads numbers from strings, as a number input gives them', () => {
        const settings = normalizeRsvpSettings({
            wpm: '300',
            commaMultiplier: ' 1.5 ',
            periodMultiplier: '99',
        })
        expect(settings.wpm).toBe(300)
        expect(settings.commaMultiplier).toBe(1.5)
        expect(settings.periodMultiplier).toBe(10)
    })

    test('uses the second argument for values that are not valid', () => {
        const current = { ...DEFAULT_RSVP_SETTINGS, wpm: 400, commaMultiplier: 4, rampUp: false }
        const settings = normalizeRsvpSettings(
            { wpm: Number.NaN, commaMultiplier: 'x', rampUp: 'yes', periodMultiplier: 5 },
            current,
        )
        expect(settings).toEqual({ ...current, periodMultiplier: 5 })
    })
})
