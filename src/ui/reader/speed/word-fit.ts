/**
 * Makes a long word fit on the word line. The width of a word comes from a canvas text
 * measurement, which needs no layout. The result is a scale factor for a CSS transform.
 */

import type { PivotParts } from '$lib/rsvp'

/** The part of the line width that is on the left of the pivot letter. Equal to --speed-pivot. */
export const PIVOT_POSITION = 0.38

/** A word with more characters than this always gets a measurement. */
export const LONG_WORD_LENGTH = 12

/** The font of the word line. It has the weight 500 and the stack of --font-ui. */
export const WORD_FONT_WEIGHT = 500
export const WORD_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

/** The canvas font can differ a little from the font of the page, so the word gets less room. */
const SAFETY = 0.96
/** No character of the UI font is wider than this, in em. */
const WIDEST_CHARACTER_EM = 1.05
/** Estimate for a browser that gives no canvas context. */
const FALLBACK_CHARACTER_EM = 0.62
const REFERENCE_PX = 100
const CACHE_LIMIT = 4000
const MIN_SCALE = 0.1

/** Width of a text in em, at the font of the word line. */
export type MeasureText = (text: string) => number

export interface FitOptions {
    /** The full word. It is the cache key. */
    text: string
    parts: PivotParts
    /** Width of the word line in CSS pixels. */
    width: number
    /** Font size of the word in CSS pixels. */
    fontSize: number
    /** False when the word is centred and has no fixed pivot place. */
    pivot: boolean
}

export interface WordFitter {
    /** The scale that makes the word fit, from above 0 to 1. */
    scaleFor(options: FitOptions): number
}

interface WordSize {
    /** Width of the part before the pivot letter, in em. */
    before: number
    /** Width of the pivot letter and the part after it, in em. */
    rest: number
}

/** A measure function that uses one shared canvas context. */
export function createCanvasMeasure(): MeasureText {
    let context: CanvasRenderingContext2D | null | undefined

    return (text) => {
        if (context === undefined) {
            context = document.createElement('canvas').getContext('2d')
            if (context) {
                context.font = `${WORD_FONT_WEIGHT} ${REFERENCE_PX}px ${WORD_FONT_FAMILY}`
            }
        }
        if (!context) return text.length * FALLBACK_CHARACTER_EM
        return context.measureText(text).width / REFERENCE_PX
    }
}

export function createWordFitter(measure: MeasureText): WordFitter {
    // The widths are in em, so a change of the font size keeps them.
    const sizes = new Map<string, WordSize>()

    function sizeOf(text: string, parts: PivotParts): WordSize {
        let size = sizes.get(text)
        if (!size) {
            size = {
                before: parts.before ? measure(parts.before) : 0,
                rest: measure(parts.pivot + parts.after),
            }
            if (sizes.size >= CACHE_LIMIT) sizes.clear()
            sizes.set(text, size)
        }
        return size
    }

    return {
        scaleFor({ text, parts, width, fontSize, pivot }) {
            if (!(width > 0 && fontSize > 0)) return 1
            const leftRoom = (pivot ? width * PIVOT_POSITION : width / 2) * SAFETY
            const rightRoom = (pivot ? width * (1 - PIVOT_POSITION) : width / 2) * SAFETY

            // A short word in a wide line fits for each possible character, so it needs no
            // measurement. On a phone most words get one, and the cache keeps it.
            const widest = text.length * fontSize * WIDEST_CHARACTER_EM
            if (text.length <= LONG_WORD_LENGTH && widest <= Math.min(leftRoom, rightRoom)) {
                return 1
            }

            const size = sizeOf(text, parts)
            const before = size.before * fontSize
            const rest = size.rest * fontSize
            let scale = 1
            if (pivot) {
                if (before > leftRoom) scale = leftRoom / before
                if (rest > rightRoom) scale = Math.min(scale, rightRoom / rest)
            } else if (before + rest > leftRoom + rightRoom) {
                scale = (leftRoom + rightRoom) / (before + rest)
            }
            if (scale >= 1) return 1
            // Three decimals keep the style text short. Below the minimum no letter is readable,
            // so a token of that length (text with no spaces) is cut at the edges.
            return Math.max(MIN_SCALE, Math.floor(scale * 1000) / 1000)
        },
    }
}
