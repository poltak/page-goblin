import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// jsdom has no layout and does not apply nested CSS, so these tests read the source text.
// They keep a rule in the file when the reason for the rule is not visible in jsdom.

function read(path: string): string {
    return readFileSync(join(import.meta.dirname, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

const css = read('listen.css')
const tokens = read('../../../styles/tokens.css')

function names(text: string, pattern: RegExp): Set<string> {
    return new Set([...text.matchAll(pattern)].map((match) => match[1]))
}

/** The text between the braces of the first rule whose selector line is `selector`. */
function rule(text: string, selector: string): string {
    const start = text.indexOf(`${selector} {`)
    if (start < 0) throw new Error(`No rule for ${selector}`)
    const open = text.indexOf('{', start)
    let depth = 0
    let end = open
    do {
        if (text[end] === '{') depth++
        else if (text[end] === '}') depth--
    } while (depth > 0 && ++end < text.length)
    return text.slice(open + 1, end)
}

describe('listen.css', () => {
    // A custom property with a wrong name fails with no error in the browser.
    it('uses only custom properties that have a definition', () => {
        const known = new Set([
            ...names(tokens, /(--[\w-]+)\s*:/g),
            ...names(css, /(--[\w-]+)\s*:/g),
        ])
        const unknown = [...names(css, /var\(\s*(--[\w-]+)/g)].filter((name) => !known.has(name))
        expect(unknown).toEqual([])
    })

    it('takes each colour from a token', () => {
        expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi)).toBeNull()
    })

    it('animates only the transform', () => {
        const transitions = [...css.matchAll(/transition:\s*([^;]+);/g)].map((match) => match[1])
        for (const transition of transitions) expect(transition).toMatch(/^(transform|opacity)\b/)
    })

    // The bar is 56px high. In the reader screen the running foot (28px) is below it. A toast
    // that is not above the two covers the controls of the bar.
    it('lifts the toasts above the bar and above the running foot', () => {
        const bar = 'calc(var(--space-12) + var(--space-2))'
        expect(rule(css, '.listen-bar')).toContain(
            `min-height: calc(var(--space-12) + var(--space-2)`,
        )
        expect(rule(css, ':root:has(.listen-bar) #toasts')).toContain(`--toast-offset: ${bar};`)
        expect(
            rule(
                css,
                ':root:has(.reader-dock > .listen-bar):has(.reader-dock + .reader-foot:not([hidden])) #toasts',
            ),
        ).toContain('--toast-offset: calc(var(--space-12) + var(--space-2) + var(--space-7));')
    })

    it('keeps a touch area of 44px for the speed button on a narrow screen', () => {
        const narrow = rule(css, '@media (max-width: 359px)')
        expect(rule(narrow, '.listen-rate')).toContain('min-width: var(--control-h);')
    })
})
