/**
 * The stylesheet of the note popover. The shadow root of the note adopts
 * [this sheet, ...book sheets].
 *
 * As in the reader view, this sheet declares the layer `rd-override` before a book sheet can
 * declare a layer. For `!important` declarations the first layer wins over later layers and
 * over rules with no layer, so the book cannot beat the rules below. The defaults are in a
 * second layer, where each book rule wins over them.
 *
 * The popover sets these on the host element of the shadow root:
 *   --note-size      the font size of the reader settings
 *   --rd-scale       that size divided by 16, for the absolute sizes of the book styles
 *   --note-font      and the attribute data-font, when the user chose a font
 *   --note-leading   and the attribute data-leading, when the user chose a line height
 *   data-dark        on a dark theme. A book colour for a white page is not readable there.
 */

const BODY_FONT_ELEMENTS =
    'p, div, span, li, dd, dt, blockquote, td, th, a, em, i, b, strong, section, article'
const OWN_FONT_ELEMENTS = 'h1, h2, h3, h4, h5, h6, code, pre, kbd, samp, tt'
const LINE_HEIGHT_ELEMENTS = 'p, li, dd, dt, blockquote, div'

export function noteBaseCss(): string {
    return `@layer rd-override;
@layer rd-base;
@layer rd-base {
    rd-html {
        color: var(--rd-fg);
        font-family: ui-serif, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
        line-height: 1.5;
        overflow-wrap: break-word;
        -webkit-text-size-adjust: 100%;
        text-size-adjust: 100%;
        text-align: start;
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
@layer rd-override {
    rd-html,
    rd-body {
        display: block !important;
        position: static !important;
        float: none !important;
        width: auto !important;
        height: auto !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        columns: auto !important;
        background: transparent !important;
        writing-mode: horizontal-tb !important;
    }
    rd-html {
        font-size: var(--note-size, 1rem) !important;
    }
    rd-body {
        font-size: 1em !important;
    }
    /* The note. A book can hide a note, float it or give it a fixed place and size. */
    rd-body > * {
        display: block !important;
        position: static !important;
        float: none !important;
        visibility: visible !important;
        width: auto !important;
        height: auto !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
    }
    img,
    svg,
    video {
        max-width: 100% !important;
    }
    img {
        object-fit: contain !important;
    }
    ::selection {
        background-color: var(--rd-selection-bg) !important;
    }
    :host([data-font]) rd-body,
    :host([data-font]) rd-body :is(${BODY_FONT_ELEMENTS}):not(:is(${OWN_FONT_ELEMENTS}) *) {
        font-family: var(--note-font) !important;
    }
    :host([data-leading]) rd-body,
    :host([data-leading]) rd-body :is(${LINE_HEIGHT_ELEMENTS}) {
        line-height: var(--note-leading) !important;
    }
    :host([data-dark]) rd-html {
        color: var(--rd-fg) !important;
    }
    :host([data-dark]) rd-body,
    :host([data-dark]) rd-body * {
        color: inherit !important;
        background-color: transparent !important;
        border-color: currentColor !important;
    }
    :host([data-dark]) rd-body a[data-rd-path],
    :host([data-dark]) rd-body a[href] {
        color: var(--rd-link) !important;
    }
}
`
}

let baseSheet: CSSStyleSheet | null = null

/** The sheet of `noteBaseCss`. All note popovers of the page share one object. */
export function getNoteBaseSheet(): CSSStyleSheet {
    if (!baseSheet) {
        baseSheet = new CSSStyleSheet()
        baseSheet.replaceSync(noteBaseCss())
    }
    return baseSheet
}
