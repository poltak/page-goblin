import { describe, expect, it } from 'vitest'
import { pagedGeometry, scrollGeometry } from './geometry'
import { baseCss, createSheet, getBaseSheet, overrideCss } from './sheets'
import type { Appearance } from './types'

const APPEARANCE: Appearance = {
    theme: 'light',
    fontFamily: null,
    fontSize: 18,
    lineHeight: null,
    margin: 'normal',
    textAlign: 'publisher',
    hyphenate: false,
    publisherStyles: true,
    columns: 'auto',
    pageTurn: 'slide',
}

const PAGED = {
    mode: 'paged' as const,
    geometry: pagedGeometry({ width: 375, height: 812, margin: 'normal', columns: 1 }),
}
const SCROLL = { mode: 'scroll' as const, geometry: scrollGeometry('normal') }

function paged(patch: Partial<Appearance> = {}): string {
    return overrideCss({ appearance: { ...APPEARANCE, ...patch }, layout: PAGED })
}

function balanced(css: string): boolean {
    let depth = 0
    for (const letter of css) {
        if (letter === '{') depth++
        if (letter === '}') depth--
        if (depth < 0) return false
    }
    return depth === 0
}

/** The declarations of a CSS text, without comments. */
function declarations(css: string): string[] {
    return css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith(';') && line.includes(':'))
}

describe('baseCss', () => {
    it('declares the override layer in its first statement', () => {
        expect(baseCss().startsWith('@layer rd-override;')).toBe(true)
    })

    it('has balanced blocks', () => {
        expect(balanced(baseCss())).toBe(true)
    })

    it('has the defaults for the book text', () => {
        const css = baseCss()
        expect(css).toContain('color: var(--rd-fg)')
        expect(css).toContain(
            "font-family: ui-serif, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
        )
        expect(css).toContain('line-height: 1.5')
        expect(css).toContain('overflow-wrap: break-word')
        expect(css).toContain('orphans: 2')
        expect(css).toContain('widows: 2')
        expect(css).toContain('white-space: pre-wrap')
    })

    it('has the highlight colours and the two custom highlights', () => {
        const css = baseCss()
        for (const color of ['yellow', 'green', 'blue', 'pink', 'purple']) {
            expect(css).toContain(`var(--rd-hl-${color})`)
        }
        expect(css).toContain('::highlight(rd-active)')
        expect(css).toContain('::highlight(rd-search)')
        expect(css).toContain('var(--rd-active-bg)')
        expect(css).toContain('var(--rd-selection-bg)')
        expect(css).toContain('mark.rd-hl[data-note]')
    })
})

describe('overrideCss', () => {
    it('puts all rules in the override layer', () => {
        const css = paged()
        expect(css.startsWith('@layer rd-override {')).toBe(true)
        expect(css.trimEnd().endsWith('}')).toBe(true)
        expect(balanced(css)).toBe(true)
        // One layer block and nothing after it.
        expect(css.match(/@layer/g)).toHaveLength(1)
    })

    it('marks each declaration as important', () => {
        for (const css of [
            paged(),
            paged({
                theme: 'dark',
                fontFamily: 'Literata, serif',
                lineHeight: 1.6,
                textAlign: 'justify',
                hyphenate: true,
            }),
            overrideCss({ appearance: APPEARANCE, layout: SCROLL }),
        ]) {
            for (const declaration of declarations(css)) {
                // A custom property cannot lose to a book rule, because no book sets it.
                if (declaration.startsWith('--rd-scale')) continue
                expect(declaration, declaration).toMatch(/!important;$/)
            }
        }
    })

    it('sets the font size and the scale for absolute book sizes', () => {
        const css = paged({ fontSize: 20 })
        expect(css).toContain('font-size: 20px !important')
        expect(css).toContain('--rd-scale: 1.25;')
        expect(css).toContain('font-size: 1em !important')
    })

    it('uses 16 pixels for a font size that is not a number', () => {
        expect(paged({ fontSize: Number.NaN })).toContain('font-size: 16px !important')
    })

    it('has no font family rule for the publisher font', () => {
        expect(paged()).not.toContain('font-family')
    })

    it('sets the font family on body text and not on headings and code', () => {
        const css = paged({ fontFamily: '"Literata Variable", serif' })
        expect(css).toContain('font-family: "Literata Variable", serif !important')
        const rule = css.slice(
            css.lastIndexOf('rd-body,', css.indexOf('font-family')),
            css.indexOf('font-family'),
        )
        expect(rule).toContain(
            ':is(p, div, span, li, dd, dt, blockquote, td, th, a, em, i, b, strong, section, article)',
        )
        expect(rule).toContain(':not(:is(h1, h2, h3, h4, h5, h6, code, pre, kbd, samp, tt) *)')
    })

    it('ignores a font family that can end the rule', () => {
        for (const value of [
            'serif; } * { display: none',
            'x } body { color: red',
            'a<b',
            "bad'quote",
            'back\\slash',
        ]) {
            expect(paged({ fontFamily: value }), value).not.toContain('font-family')
        }
        // The same characters are safe inside a quoted name.
        expect(paged({ fontFamily: '"Semi;colon {font}", serif' })).toContain(
            'font-family: "Semi;colon {font}", serif',
        )
    })

    it('sets the line height only when it is not null', () => {
        expect(paged()).not.toContain('line-height')
        const css = paged({ lineHeight: 1.75 })
        expect(css).toContain('line-height: 1.75 !important')
        expect(css).toContain('rd-body :is(p, li, dd, dt, blockquote, div)')
    })

    it('keeps the alignment of the publisher', () => {
        expect(paged({ textAlign: 'publisher' })).not.toContain('text-align')
    })

    it('sets start or justify on paragraphs and list items', () => {
        expect(paged({ textAlign: 'start' })).toContain('text-align: start !important')
        const css = paged({ textAlign: 'justify' })
        expect(css).toContain('text-align: justify !important')
        expect(css).toContain('rd-body :is(p, li, dd, blockquote)')
    })

    it('turns hyphenation on and off', () => {
        const on = paged({ hyphenate: true })
        expect(on).toContain('hyphens: auto !important')
        expect(on).toContain('-webkit-hyphens: auto !important')
        const off = paged({ hyphenate: false })
        expect(off).toContain('hyphens: manual !important')
        expect(off).not.toContain('hyphens: auto')
    })

    it('replaces the book colours only in the dark themes', () => {
        for (const theme of ['dark', 'black'] as const) {
            const css = paged({ theme })
            expect(css).toContain('color: inherit !important')
            expect(css).toContain('background-color: transparent !important')
            expect(css).toContain('border-color: currentColor !important')
            expect(css).toContain('color: var(--rd-link) !important')
            // The marks of the reader keep their colours.
            expect(css).toContain('rd-body *:not(mark.rd-hl, mark.rd-active)')
        }
        for (const theme of ['light', 'sepia'] as const) {
            const css = paged({ theme })
            expect(css).not.toContain('color: inherit')
            expect(css).not.toContain('var(--rd-link)')
            expect(css).toContain('background: transparent !important')
        }
    })

    it('removes the page box of the book', () => {
        const css = paged()
        const body = css.slice(css.indexOf('rd-body {'), css.indexOf('}', css.indexOf('rd-body {')))
        for (const declaration of [
            'margin: 0 !important',
            'padding: 0 !important',
            'max-width: none !important',
            'width: auto !important',
            'height: auto !important',
            'position: static !important',
            'float: none !important',
            'overflow: visible !important',
        ]) {
            expect(body, declaration).toContain(declaration)
        }
    })

    it('keeps the column strip left to right for a right-to-left book', () => {
        const css = paged()
        expect(css).toContain('direction: ltr !important')
        expect(css).toContain("rd-html[dir='rtl' i] > rd-body")
        expect(css).toContain('direction: rtl !important')
    })

    it('writes the paged geometry', () => {
        const g = PAGED.geometry
        const css = paged()
        expect(css).toContain(`width: ${g.contentWidth}px !important`)
        expect(css).toContain(`height: ${g.contentHeight}px !important`)
        expect(css).toContain(`margin: ${g.marginY}px ${g.marginX}px !important`)
        expect(css).toContain(`column-width: ${g.columnWidth}px !important`)
        expect(css).toContain(`column-gap: ${g.columnGap}px !important`)
        expect(css).toContain('column-fill: auto !important')
        expect(css).toContain(`max-height: ${g.contentHeight}px !important`)
        expect(css).toContain('break-inside: avoid !important')
        expect(css).toContain('object-fit: contain !important')
    })

    it('stops the indent of deep blockquote nests in a narrow column only', () => {
        const rule =
            /rd-body blockquote blockquote blockquote blockquote \{\s*margin-left: 0 !important;\s*margin-right: 0 !important;/
        expect(paged()).toMatch(rule)

        const wide = overrideCss({
            appearance: APPEARANCE,
            layout: {
                mode: 'paged',
                geometry: pagedGeometry({ width: 900, height: 1100, margin: 'normal', columns: 1 }),
            },
        })
        expect(wide).not.toContain('blockquote blockquote')

        const scroll = overrideCss({ appearance: APPEARANCE, layout: SCROLL })
        expect(scroll).toMatch(/@media \(max-width: 560px\) \{\s*rd-body blockquote blockquote/)
        expect(balanced(scroll)).toBe(true)
    })

    it('removes the first-line indent of a block that has only an image', () => {
        for (const css of [paged(), overrideCss({ appearance: APPEARANCE, layout: SCROLL })]) {
            expect(css).toMatch(/rd-body \[data-rd-media\] \{\s*text-indent: 0 !important;/)
        }
    })

    it('writes the scroll geometry for each margin', () => {
        const widths = { narrow: [46, 16], normal: [38, 20], wide: [30, 28] } as const
        for (const margin of ['narrow', 'normal', 'wide'] as const) {
            const css = overrideCss({
                appearance: { ...APPEARANCE, margin },
                layout: { mode: 'scroll', geometry: scrollGeometry(margin) },
            })
            expect(css).toContain(`max-width: ${widths[margin][0]}em !important`)
            expect(css).toContain(`padding: 24px ${widths[margin][1]}px !important`)
            expect(css).toContain('margin: 0 auto !important')
            expect(css).not.toContain('column-width')
            expect(css).not.toContain('break-inside')
        }
    })

    it('has a rule between two chapters in the scroll view', () => {
        const css = overrideCss({ appearance: APPEARANCE, layout: SCROLL })
        expect(css).toContain(':host(:not(:last-child))')
        expect(css).toContain('var(--rd-rule)')
    })

    it('gives the same text for the same input', () => {
        expect(paged({ theme: 'sepia' })).toBe(paged({ theme: 'sepia' }))
        // The page turn animation changes no style.
        expect(paged({ pageTurn: 'none' })).toBe(paged({ pageTurn: 'slide' }))
        expect(paged({ fontSize: 19 })).not.toBe(paged({ fontSize: 18 }))
    })
})

describe('sheets', () => {
    it('makes one base sheet for all frames', () => {
        expect(getBaseSheet()).toBe(getBaseSheet())
    })

    it('makes a sheet from the override text', () => {
        const sheet = createSheet(paged())
        expect(sheet).toBeInstanceOf(CSSStyleSheet)
    })
})
