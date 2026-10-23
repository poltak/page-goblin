import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Rgb = [number, number, number]
type Tokens = Record<string, string>

const file = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8')
const css = file.replace(/\/\*[\s\S]*?\*\//g, '')

/** The custom properties of the innermost rule whose selector has `selectorPart`. */
function block(selectorPart: string): Tokens {
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selector.includes(selectorPart)) continue
        const tokens: Tokens = {}
        for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
            tokens[name] = value.trim()
        }
        return tokens
    }
    throw new Error(`No rule for ${selectorPart}`)
}

const themes: Record<string, Tokens> = {
    light: block("[data-theme='light']"),
    sepia: block("[data-theme='sepia']"),
    dark: block("[data-theme='dark']"),
    black: block("[data-theme='black']"),
}

/** Parses `#rrggbb` or `rgb(r g b / a)`. The alpha is 1 for a hex colour. */
function parse(value: string): { rgb: Rgb; alpha: number } {
    const hex = /^#([0-9a-f]{6})$/i.exec(value)
    if (hex) {
        const n = parseInt(hex[1], 16)
        return { rgb: [n >> 16, (n >> 8) & 255, n & 255], alpha: 1 }
    }
    const rgb = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value)
    if (!rgb) throw new Error(`Cannot parse the colour ${value}`)
    return { rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], alpha: Number(rgb[4]) }
}

/** The solid colour that `value` gives on top of `below`. */
function over(value: string, below: Rgb): Rgb {
    const { rgb, alpha } = parse(value)
    return rgb.map((c, i) => Math.round(c * alpha + below[i] * (1 - alpha))) as Rgb
}

function luminance(rgb: Rgb): number {
    const [r, g, b] = rgb.map((c) => {
        const s = c / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: Rgb, b: Rgb): number {
    const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y)
    return (high + 0.05) / (low + 0.05)
}

const HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink', 'purple']

describe('theme tokens', () => {
    it('has the page colours of the specification', () => {
        const page = Object.entries(themes).map(([name, t]) => [name, t['--bg'], t['--fg']])
        expect(page).toEqual([
            ['light', '#fbfaf8', '#1f1d1a'],
            ['sepia', '#f4ecd8', '#433422'],
            ['dark', '#1d1d1b', '#d6d2c9'],
            ['black', '#000000', '#a9a69f'],
        ])
    })

    it('defines the same tokens in each theme', () => {
        const names = Object.keys(themes.light).sort()
        expect(names.length).toBeGreaterThan(30)
        for (const tokens of Object.values(themes)) {
            expect(Object.keys(tokens).sort()).toEqual(names)
        }
    })

    it('keeps the system dark block equal to the dark theme', () => {
        expect(block(':root:not([data-theme])')).toEqual(themes.dark)
    })

    it('uses the terracotta accent on the light themes', () => {
        expect(themes.light['--accent']).toBe('#b4552d')
        expect(themes.sepia['--accent']).toBe('#b4552d')
    })
})

describe.each(Object.entries(themes))('contrast in the %s theme', (_name, t) => {
    const solid = (name: string) => parse(t[name]).rgb
    const surfaces = ['--bg', '--surface', '--surface-raised'].map(solid)

    it('has readable text on each surface', () => {
        for (const surface of surfaces) {
            expect(contrast(solid('--fg'), surface)).toBeGreaterThanOrEqual(7)
            for (const name of ['--fg-muted', '--fg-faint', '--accent-text', '--danger']) {
                expect(contrast(solid(name), surface), name).toBeGreaterThanOrEqual(4.5)
            }
        }
    })

    it('has readable text on the fills', () => {
        for (const surface of surfaces) {
            const fill = over(t['--fill'], surface)
            const soft = over(t['--accent-soft'], surface)
            expect(contrast(solid('--fg-muted'), fill)).toBeGreaterThanOrEqual(4.5)
            expect(contrast(solid('--danger'), fill)).toBeGreaterThanOrEqual(4.5)
            expect(contrast(solid('--accent-text'), soft)).toBeGreaterThanOrEqual(4.5)
            expect(contrast(solid('--fg'), over(t['--fill-strong'], surface))).toBeGreaterThan(4.5)
        }
        expect(contrast(solid('--accent-fg'), solid('--accent'))).toBeGreaterThanOrEqual(4.5)
        expect(contrast(solid('--danger-fg'), solid('--danger'))).toBeGreaterThanOrEqual(4.5)
    })

    it('has control borders and accent fills with a ratio of 3 or more', () => {
        for (const surface of surfaces) {
            expect(contrast(solid('--accent'), surface)).toBeGreaterThanOrEqual(3)
            expect(contrast(solid('--border-strong'), surface)).toBeGreaterThanOrEqual(3)
            const fill = over(t['--fill'], surface)
            expect(contrast(solid('--border-strong'), fill)).toBeGreaterThanOrEqual(3)
        }
    })

    it('keeps book text and links readable on each mark', () => {
        const page = solid('--bg')
        const text = solid('--fg')
        const link = solid('--rd-link')
        expect(contrast(link, page)).toBeGreaterThanOrEqual(4.5)
        const marks = [
            '--rd-selection-bg',
            '--rd-active-bg',
            ...HIGHLIGHTS.map((colour) => `--rd-hl-${colour}`),
        ]
        for (const name of marks) {
            const mark = over(t[name], page)
            expect(contrast(text, mark), name).toBeGreaterThanOrEqual(4.5)
            expect(contrast(link, mark), name).toBeGreaterThanOrEqual(4.5)
        }
    })

    // The speech marker or the selection can be on top of a highlight. The two colours then
    // mix, and the dark themes do not keep 4.5. The comment in tokens.css has the ratios.
    it('keeps book text at 3 to 1 or more on two marks at the same time', () => {
        const page = solid('--bg')
        for (const top of ['--rd-active-bg', '--rd-selection-bg']) {
            for (const colour of HIGHLIGHTS) {
                const mark = over(t[top], over(t[`--rd-hl-${colour}`], page))
                const ratio = contrast(solid('--fg'), mark)
                expect(ratio, `${top} on ${colour}`).toBeGreaterThanOrEqual(3)
            }
        }
    })
})

describe.each(['amber', 'red'])('the %s text of the black theme', (tint) => {
    const own = block(`[data-black-tint='${tint}']`)
    const t: Tokens = { ...themes.black, ...own }
    const solid = (name: string) => parse(t[name]).rgb
    const surfaces = ['--bg', '--surface', '--surface-raised'].map(solid)
    const text = ['--fg', '--fg-muted', '--fg-faint']

    it('changes only the text colours', () => {
        expect(Object.keys(own).sort()).toEqual([...text].sort())
    })

    it('has readable text on each surface and fill', () => {
        for (const surface of surfaces) {
            for (const name of text) {
                expect(contrast(solid(name), surface), name).toBeGreaterThanOrEqual(4.5)
            }
            expect(contrast(solid('--fg-muted'), over(t['--fill'], surface))).toBeGreaterThan(4.5)
            expect(contrast(solid('--fg'), over(t['--fill-strong'], surface))).toBeGreaterThan(4.5)
        }
    })

    it('keeps book text readable on each mark', () => {
        const page = solid('--bg')
        const marks = [
            '--rd-selection-bg',
            '--rd-active-bg',
            ...HIGHLIGHTS.map((colour) => `--rd-hl-${colour}`),
        ]
        for (const name of marks) {
            expect(contrast(solid('--fg'), over(t[name], page)), name).toBeGreaterThanOrEqual(4.5)
        }
    })
})
