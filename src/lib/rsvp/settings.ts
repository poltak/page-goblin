import type { RsvpSettings } from './types'

export const RSVP_WPM_MIN = 50
export const RSVP_WPM_MAX = 1000
export const RSVP_MULTIPLIER_MIN = 1
export const RSVP_MULTIPLIER_MAX = 10

export const DEFAULT_RSVP_SETTINGS: Readonly<RsvpSettings> = Object.freeze({
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

interface NumberRule {
    fallback: number
    min: number
    max: number
}

function readNumber(value: unknown, { fallback, min, max }: NumberRule): number {
    // A number input gives its value as a string.
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback
    return Math.min(Math.max(parsed, min), max)
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

/**
 * Make valid settings from stored data or from user input. A number out of range goes to the
 * nearest limit. A value of the wrong type, NaN or an infinite number gets the `fallback` value.
 */
export function normalizeRsvpSettings(
    raw: unknown,
    fallback: Readonly<RsvpSettings> = DEFAULT_RSVP_SETTINGS,
): RsvpSettings {
    const source: Partial<Record<keyof RsvpSettings, unknown>> =
        typeof raw === 'object' && raw !== null ? raw : {}
    const multiplier = (key: keyof RsvpSettings & `${string}Multiplier`) =>
        readNumber(source[key], {
            fallback: fallback[key],
            min: RSVP_MULTIPLIER_MIN,
            max: RSVP_MULTIPLIER_MAX,
        })

    return {
        wpm: readNumber(source.wpm, {
            fallback: fallback.wpm,
            min: RSVP_WPM_MIN,
            max: RSVP_WPM_MAX,
        }),
        periodMultiplier: multiplier('periodMultiplier'),
        commaMultiplier: multiplier('commaMultiplier'),
        semicolonMultiplier: multiplier('semicolonMultiplier'),
        exclamationMultiplier: multiplier('exclamationMultiplier'),
        paragraphMultiplier: multiplier('paragraphMultiplier'),
        headingMultiplier: multiplier('headingMultiplier'),
        longWordDelay: readBoolean(source.longWordDelay, fallback.longWordDelay),
        rampUp: readBoolean(source.rampUp, fallback.rampUp),
    }
}
