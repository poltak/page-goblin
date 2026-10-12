import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTEXT_FONT_PX } from './context'
import { STAGE_MAX_WIDTH, STAGE_PADDING } from './controller'
import { PIVOT_POSITION, WORD_FONT_FAMILY, WORD_FONT_WEIGHT } from './word-fit'

// jsdom has no layout and does not apply nested CSS, so these tests read the source text.
// The script has copies of some CSS values, because it must not read the layout. A change on
// one side only makes a long word too wide or puts it at the wrong place, with no error.

function read(path: string): string {
    return readFileSync(join(import.meta.dirname, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

const css = read('speed.css')
const tokens = read('../../../styles/tokens.css')

/** The value of a custom property in `source`. */
function property(source: string, name: string): string {
    const match = new RegExp(`${name}:\\s*([^;]+);`).exec(source)
    if (!match) throw new Error(`No value for ${name}`)
    return match[1].trim()
}

/** The text between the braces of the first rule whose selector line is `selector`. */
function rule(selector: string): string {
    const start = css.indexOf(`${selector} {`)
    if (start < 0) throw new Error(`No rule for ${selector}`)
    const open = css.indexOf('{', start)
    let depth = 0
    let end = open
    do {
        if (css[end] === '{') depth++
        else if (css[end] === '}') depth--
    } while (depth > 0 && ++end < css.length)
    return css.slice(open + 1, end)
}

function pixels(length: string): number {
    const value = Number.parseFloat(length)
    return length.endsWith('rem') ? value * 16 : value
}

describe('the values that the script copies from the CSS', () => {
    it('has the pivot place of the word line', () => {
        expect(property(css, '--speed-pivot')).toBe(`${PIVOT_POSITION * 100}%`)
        expect(rule('.speed-word')).toContain('padding-left: var(--speed-pivot)')
        expect(rule('.speed-word')).toContain('transform-origin: var(--speed-pivot) 50%')
        expect(rule('.speed-word-before')).toContain('right: calc(100% - var(--speed-pivot))')
    })

    it('measures a word in the font of the word line', () => {
        expect(rule('.speed-word')).toContain('font-family: var(--font-ui)')
        expect(rule('.speed-word')).toContain('font-weight: var(--weight-medium)')
        expect(property(tokens, '--font-ui')).toBe(WORD_FONT_FAMILY)
        expect(Number(property(tokens, '--weight-medium'))).toBe(WORD_FONT_WEIGHT)
        // Letter spacing and tabular digits change the width of a word.
        expect(rule('.speed-word')).toContain('letter-spacing: 0')
        expect(rule('.speed-word')).toContain('font-variant-numeric: normal')
    })

    it('has the size of the context text', () => {
        expect(rule('.speed-context')).toContain('font-size: var(--text-md)')
        expect(pixels(property(tokens, '--text-md'))).toBe(CONTEXT_FONT_PX)
    })

    it('has the width of the stage before the first measurement', () => {
        expect(pixels(property(css, '--speed-max'))).toBe(STAGE_MAX_WIDTH)
        expect(rule('.speed-stage')).toContain('max-width: var(--speed-max)')
        expect(rule('.speed-stage')).toContain('max(var(--space-4), var(--safe-left))')
        expect(pixels(property(tokens, '--space-4')) * 2).toBe(STAGE_PADDING)
    })
})

describe('the word line', () => {
    it('keeps a long word in the centre when the pivot highlight is off', () => {
        const off = rule(".speed[data-pivot='off']")
        // A centred text line starts a word that is too wide at the left edge. The scale
        // around the centre then puts the word off centre, and its end is cut.
        expect(off).toContain('display: flex')
        expect(off).toContain('justify-content: center')
        expect(off).not.toContain('text-align: center')
        expect(off).toContain('transform-origin: 50% 50%')
    })

    it('does not start a layout outside the line for a new word', () => {
        expect(rule('.speed-word')).toContain('contain: size layout style')
        expect(rule('.speed-context')).toContain('contain: strict')
    })

    it('has no transition when the user asked for reduced motion', () => {
        const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
        expect(reduced).toContain('.speed *')
        expect(reduced).toContain('transition: none')
    })
})
