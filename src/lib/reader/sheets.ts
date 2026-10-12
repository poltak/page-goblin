/**
 * The two reader stylesheets of a chapter frame.
 *
 * A frame adopts [base sheet, ...book sheets, override sheet]. The base sheet declares the
 * cascade layer `rd-override` before a book sheet can declare a layer. For `!important`
 * declarations the first layer wins over later layers and over rules with no layer, so a
 * book stylesheet cannot beat the reader overrides. The low priority defaults are in a
 * second layer: a normal declaration in a layer loses to each book rule with no layer.
 */

import type { Appearance } from './types'
import type { PagedGeometry, ScrollGeometry } from './geometry'

export const OVERRIDE_LAYER = 'rd-override'
export const BASE_LAYER = 'rd-base'

const BODY_FONT_ELEMENTS =
    'p, div, span, li, dd, dt, blockquote, td, th, a, em, i, b, strong, section, article'
const OWN_FONT_ELEMENTS = 'h1, h2, h3, h4, h5, h6, code, pre, kbd, samp, tt'
const LINE_HEIGHT_ELEMENTS = 'p, li, dd, dt, blockquote, div'
const ALIGN_ELEMENTS = 'p, li, dd, blockquote'
const READER_MARKS = 'mark.rd-hl, mark.rd-active'

/** A text column below this width in pixels has no room for a deep indent. */
export const NARROW_COLUMN = 520

/**
 * Some books indent a line with many blockquotes, one inside the other. In a narrow column
 * the text then has no width: it leaves its column and shows on the next page. From the
 * fourth level on, a blockquote adds no more indent there.
 */
const DEEP_QUOTE_RULE = `
    rd-body blockquote blockquote blockquote blockquote {
        margin-left: 0 !important;
        margin-right: 0 !important;
    }`

export type OverrideLayout =
    { mode: 'paged'; geometry: PagedGeometry } | { mode: 'scroll'; geometry: ScrollGeometry }

export interface OverrideOptions {
    appearance: Appearance
    layout: OverrideLayout
}

export function baseCss(): string {
    return `@layer ${OVERRIDE_LAYER};
@layer ${BASE_LAYER};
@layer ${BASE_LAYER} {
    rd-html {
        display: block;
        color: var(--rd-fg);
        font-family: ui-serif, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
        line-height: 1.5;
        overflow-wrap: break-word;
        -webkit-text-size-adjust: 100%;
        text-size-adjust: 100%;
        text-align: start;
        orphans: 2;
        widows: 2;
    }
    rd-body {
        display: block;
        margin: 0;
    }
    img,
    svg,
    video {
        max-width: 100%;
    }
    img,
    video,
    svg[viewBox] {
        height: auto;
    }
    a[data-rd-path],
    a[href] {
        color: var(--rd-link);
        cursor: pointer;
    }
    a[data-rd-path] {
        text-decoration: underline;
    }
    pre {
        white-space: pre-wrap;
    }
    table {
        max-width: 100%;
    }
}
@layer ${OVERRIDE_LAYER} {
    :host {
        display: block !important;
        contain: layout paint !important;
    }
    ::selection {
        background-color: var(--rd-selection-bg) !important;
    }
    mark.rd-hl {
        color: inherit !important;
        background-color: var(--rd-hl-yellow) !important;
        cursor: pointer !important;
    }
    mark.rd-hl[data-color='green'] {
        background-color: var(--rd-hl-green) !important;
    }
    mark.rd-hl[data-color='blue'] {
        background-color: var(--rd-hl-blue) !important;
    }
    mark.rd-hl[data-color='pink'] {
        background-color: var(--rd-hl-pink) !important;
    }
    mark.rd-hl[data-color='purple'] {
        background-color: var(--rd-hl-purple) !important;
    }
    mark.rd-hl[data-note] {
        text-decoration: underline dotted !important;
        text-underline-offset: 0.2em !important;
    }
    mark.rd-active {
        color: inherit !important;
        background-color: var(--rd-active-bg) !important;
    }
    ::highlight(rd-search) {
        background-color: var(--rd-hl-yellow);
        text-decoration: underline;
    }
    ::highlight(rd-active) {
        background-color: var(--rd-active-bg);
    }
    img,
    a {
        -webkit-user-drag: none !important;
    }
}
`
}

/** A font family value from the settings. A value that can end the rule is not used. */
function safeFontFamily(value: string | null): string | null {
    if (!value) return null
    const outsideStrings = value.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '')
    if (/[{};<>"'\\\n]/.test(outsideStrings)) return null
    return value
}

function finite(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback
}

function pagedRules(geometry: PagedGeometry): string {
    const { contentWidth, contentHeight, marginX, marginY, columnWidth, columnGap } = geometry
    return `
    rd-html {
        width: ${contentWidth}px !important;
        height: ${contentHeight}px !important;
        max-width: none !important;
        margin: ${marginY}px ${marginX}px !important;
        padding: 0 !important;
        column-width: ${columnWidth}px !important;
        column-count: auto !important;
        column-gap: ${columnGap}px !important;
        column-fill: auto !important;
        column-rule: none !important;
    }
    img,
    svg,
    video,
    table {
        max-height: ${contentHeight}px !important;
        break-inside: avoid !important;
    }
    img,
    svg,
    video {
        max-width: 100% !important;
    }${columnWidth < NARROW_COLUMN ? DEEP_QUOTE_RULE : ''}`
}

function scrollRules(geometry: ScrollGeometry): string {
    return `
    :host(:not(:last-child)) {
        border-bottom: 1px solid var(--rd-rule) !important;
    }
    rd-html {
        width: auto !important;
        height: auto !important;
        max-width: ${geometry.maxWidthEm}em !important;
        margin: 0 auto !important;
        padding: 24px ${geometry.sidePadding}px !important;
        columns: auto !important;
    }
    img,
    svg,
    video {
        max-width: 100% !important;
    }
    @media (max-width: ${NARROW_COLUMN + 2 * geometry.sidePadding}px) {${DEEP_QUOTE_RULE.replace(/\n/g, '\n    ')}
    }`
}

export function overrideCss({ appearance, layout }: OverrideOptions): string {
    const fontSize = finite(appearance.fontSize, 16)
    const fontFamily = safeFontFamily(appearance.fontFamily)
    const lineHeight =
        appearance.lineHeight !== null && Number.isFinite(appearance.lineHeight)
            ? appearance.lineHeight
            : null
    const dark = appearance.theme === 'dark' || appearance.theme === 'black'
    const hyphens = appearance.hyphenate ? 'auto' : 'manual'

    let css = `@layer ${OVERRIDE_LAYER} {
    rd-html {
        display: block !important;
        box-sizing: content-box !important;
        position: static !important;
        float: none !important;
        overflow: visible !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-height: none !important;
        border: 0 !important;
        background: transparent !important;
        font-size: ${fontSize}px !important;
        --rd-scale: ${fontSize / 16};
        /* The column strip always grows to the right. */
        direction: ltr !important;
        writing-mode: horizontal-tb !important;
    }
    rd-body {
        display: block !important;
        position: static !important;
        float: none !important;
        overflow: visible !important;
        width: auto !important;
        height: auto !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        columns: auto !important;
        background: transparent !important;
        font-size: 1em !important;
        writing-mode: horizontal-tb !important;
    }
    rd-html[dir='rtl' i] > rd-body {
        direction: rtl !important;
    }
    rd-body :is(${ALIGN_ELEMENTS}) {
        -webkit-hyphens: ${hyphens} !important;
        hyphens: ${hyphens} !important;
    }
    img {
        object-fit: contain !important;
    }
    /* An image with the first-line indent of its block sticks out of the column. The
       frame marks the blocks that have an image and no text. */
    rd-body [data-rd-media] {
        text-indent: 0 !important;
    }`

    css += layout.mode === 'paged' ? pagedRules(layout.geometry) : scrollRules(layout.geometry)

    if (fontFamily) {
        css += `
    rd-body,
    rd-body :is(${BODY_FONT_ELEMENTS}):not(:is(${OWN_FONT_ELEMENTS}) *) {
        font-family: ${fontFamily} !important;
    }`
    }

    if (lineHeight !== null) {
        css += `
    rd-body,
    rd-body :is(${LINE_HEIGHT_ELEMENTS}) {
        line-height: ${lineHeight} !important;
    }`
    }

    if (appearance.textAlign === 'start' || appearance.textAlign === 'justify') {
        css += `
    rd-body :is(${ALIGN_ELEMENTS}) {
        text-align: ${appearance.textAlign} !important;
    }`
    }

    if (dark) {
        // A book colour that is made for a white page is not readable on a dark page.
        css += `
    rd-html {
        color: var(--rd-fg) !important;
    }
    rd-body,
    rd-body *:not(${READER_MARKS}) {
        color: inherit !important;
        background-color: transparent !important;
        border-color: currentColor !important;
    }
    rd-body a[data-rd-path],
    rd-body a[href] {
        color: var(--rd-link) !important;
    }`
    }

    return css + '\n}\n'
}

let baseSheet: CSSStyleSheet | null = null

export function createSheet(css: string): CSSStyleSheet {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    return sheet
}

/** The base sheet. All frames of the page share one object. */
export function getBaseSheet(): CSSStyleSheet {
    baseSheet ??= createSheet(baseCss())
    return baseSheet
}
