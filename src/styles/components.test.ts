import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// jsdom has no layout and does not apply nested CSS, so these tests read the source text.
// They do not show how a browser draws a component. They keep a rule in the file when the
// reason for the rule is not visible in jsdom.

function read(name: string): string {
    return readFileSync(join(import.meta.dirname, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

const tokens = read('tokens.css')
const base = read('base.css')
const components = read('components.css')

/**
 * The text between the braces of each rule in `css` whose last selector line is `selector`,
 * as one string. A selector can have more than one rule.
 */
function rule(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const bodies: string[] = []
    for (const match of css.matchAll(new RegExp(`^\\s*${escaped} \\{$`, 'gm'))) {
        const open = css.indexOf('{', match.index)
        let depth = 0
        let end = open
        do {
            if (css[end] === '{') depth++
            else if (css[end] === '}') depth--
        } while (depth > 0 && ++end < css.length)
        bodies.push(css.slice(open + 1, end))
    }
    if (bodies.length === 0) throw new Error(`No rule for ${selector}`)
    return bodies.join('\n')
}

function names(css: string, pattern: RegExp): Set<string> {
    return new Set([...css.matchAll(pattern)].map((match) => match[1]))
}

describe('design system CSS', () => {
    // A custom property with a wrong name fails with no error in the browser.
    it('uses only custom properties that have a definition', () => {
        const fromTokens = names(tokens, /(--[\w-]+)\s*:/g)
        // The page sets these on an element. Each use has a fallback value.
        const inputs = new Map([
            [base, ['--black-brightness']],
            [components, ['--value', '--level', '--toast-offset']],
        ])
        for (const [css, own] of inputs) {
            const known = new Set([...fromTokens, ...names(css, /(--[\w-]+)\s*:/g), ...own])
            const unknown = [...names(css, /var\(\s*(--[\w-]+)/g)].filter((n) => !known.has(n))
            expect(unknown).toEqual([])
            for (const input of own) {
                expect(css).toMatch(new RegExp(`var\\(${input}, [^)]+\\)`))
                expect(css).not.toMatch(new RegExp(`var\\(${input}\\)`))
            }
        }
    })

    it('takes each colour from a token', () => {
        for (const css of [base, components]) {
            expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi)).toBeNull()
        }
    })

    it('has no backdrop-filter', () => {
        expect(tokens + base + components).not.toContain('backdrop-filter')
    })

    // A browser drops the full rule when it does not know one selector of a list.
    it('keeps each selector with a vendor pseudo-element alone in its rule', () => {
        const preludes = [...(base + components).matchAll(/([^{};]+)\{/g)].map((match) => match[1])
        const vendor = preludes.filter((prelude) => /::-(?:webkit|moz)-/.test(prelude))
        expect(vendor.length).toBeGreaterThan(8)
        for (const prelude of vendor) expect(prelude.trim()).not.toContain(',')
    })
})

describe('components', () => {
    // Safari and Firefox have no overlay property. They take a closing dialog or popover out of
    // the top layer at once, and it stays on screen until the close transition ends.
    it('keeps a closing dialog and menu in place outside the top layer', () => {
        for (const selector of ['dialog.sheet', 'dialog.modal']) {
            const dialog = rule(components, selector)
            expect(dialog, selector).toMatch(/^\s*position: fixed;$/m)
            expect(dialog, selector).toMatch(/^\s*inset: [^;]+;$/m)
            expect(dialog, selector).toMatch(/^\s*z-index: var\(--z-sheet\);$/m)
        }
        expect(rule(components, 'dialog.modal')).toMatch(/^\s*margin: auto;$/m)
        const menu = rule(rule(components, '.menu'), '&[popover]')
        expect(menu).toMatch(/^\s*position: fixed;$/m)
        expect(menu).toMatch(/^\s*z-index: var\(--z-menu\);$/m)
    })

    // A second tap on a dialog or a menu that closes must not do the action again.
    it('takes no pointer events while a dialog or a menu closes', () => {
        const closing = rule(rule(components, 'dialog.modal'), '&:not([open])')
        expect(closing).toContain('pointer-events: none;')
        const menu = rule(components, '.menu')
        expect(rule(menu, '&[popover]')).toContain('pointer-events: none;')
        expect(rule(menu, '&:popover-open')).toContain('pointer-events: auto;')
    })

    // A control that spans two rows shares its height between them. With no help text the
    // label is then above the middle of a control that is higher than the label.
    it('lets the control of an inline field span two rows only with a help text', () => {
        const field = rule(components, '.field-inline')
        const control = '& > :not(.field-label, .field-help, .field-error)'
        expect(rule(field, control)).not.toContain('span')
        const withHelp = rule(field, `&:has(> .field-help, > .field-error) > ${control.slice(4)}`)
        expect(withHelp).toMatch(/grid-row: 1 \/ span 2;/)
    })

    it('makes the touch area of a segmented control 44px high', () => {
        const input = rule(rule(components, '.segmented'), '& input')
        // The label is 36px high in a group with 4px of padding.
        expect(rule(rule(components, '.segmented'), '& > label')).toContain(
            'min-height: var(--control-h-compact);',
        )
        expect(input).toContain('top: calc(var(--space-1) * -1);')
        expect(input).toContain('height: calc(100% + var(--space-2));')
    })

    it('stops the hover and active states of a disabled form control', () => {
        for (const selector of ['.slider', '.switch', '.input']) {
            expect(rule(rule(components, selector), '&:disabled'), selector).toContain(
                'pointer-events: none;',
            )
        }
    })

    // A selector cannot see a text node. An icon next to plain text is the first and the last
    // child at the same time, so it must not get the two edge margins.
    it('moves the icon of a button out only at one edge', () => {
        const button = rule(components, '.btn')
        expect(button).toContain('& > .icon:first-child:not(:only-child) {')
        expect(button).toContain('& > .icon:last-child:not(:only-child) {')
    })
})
