import { afterEach, describe, expect, it, vi } from 'vitest'
import { splitAtPivot } from '$lib/rsvp'
import {
    LONG_WORD_LENGTH,
    PIVOT_POSITION,
    WORD_FONT_FAMILY,
    WORD_FONT_WEIGHT,
    createCanvasMeasure,
    createWordFitter,
} from './word-fit'

/** Each character is 0.5 em wide. */
const measure = vi.fn((text: string) => text.length * 0.5)

function fit(text: string, options: { width?: number; fontSize?: number; pivot?: boolean } = {}) {
    const { width = 1000, fontSize = 50, pivot = true } = options
    return { text, parts: splitAtPivot(text), width, fontSize, pivot }
}

afterEach(() => {
    measure.mockClear()
    vi.restoreAllMocks()
})

describe('createWordFitter', () => {
    it('gives 1 with no measurement for a short word in a wide line', () => {
        const fitter = createWordFitter(measure)
        expect(fitter.scaleFor(fit('reader'))).toBe(1)
        expect(measure).not.toHaveBeenCalled()
    })

    it('measures a word that has more characters than the limit', () => {
        const fitter = createWordFitter(measure)
        const word = 'a'.repeat(LONG_WORD_LENGTH + 1)
        expect(fitter.scaleFor(fit(word, { width: 5000 }))).toBe(1)
        expect(measure).toHaveBeenCalled()
    })

    it('makes a long word fit on the right of the pivot place', () => {
        const fitter = createWordFitter(measure)
        // The pivot is the fifth letter. The 36 characters from it are 36 * 0.5 * 50 = 900 px.
        // The room is 1000 * 0.62 * 0.96 = 595.2 px.
        const scale = fitter.scaleFor(fit('a'.repeat(40)))
        expect(scale).toBeCloseTo(0.661, 2)
        expect(36 * 0.5 * 50 * scale).toBeLessThanOrEqual(1000 * (1 - PIVOT_POSITION))
    })

    it('makes the part before the pivot letter fit on the left', () => {
        const text = '((((((((word'
        expect(splitAtPivot(text).before).toBe('((((((((w')
        // That part is 12 em here, which is 600 px. The room is 1000 * 0.38 * 0.96 = 364.8 px.
        const fitter = createWordFitter((part) => (part === '((((((((w' ? 12 : 1))
        const scale = fitter.scaleFor(fit(text))
        expect(scale).toBeCloseTo(0.608, 2)
        expect(600 * scale).toBeLessThanOrEqual(1000 * PIVOT_POSITION)
    })

    it('uses the full width for a centred word', () => {
        const fitter = createWordFitter(measure)
        // 40 characters are 1000 px. The room is 1000 * 0.96 = 960 px.
        expect(fitter.scaleFor(fit('a'.repeat(40), { pivot: false }))).toBeCloseTo(0.96, 2)
        expect(fitter.scaleFor(fit('a'.repeat(30), { pivot: false }))).toBe(1)
    })

    it('measures a short word when the line is narrow', () => {
        const fitter = createWordFitter(measure)
        // 'something' has 7 characters from the pivot: 7 * 0.5 * 96 = 336 px in 198.4 px.
        expect(fitter.scaleFor(fit('something', { width: 333.33, fontSize: 96 }))).toBeCloseTo(
            0.59,
            2,
        )
        expect(measure).toHaveBeenCalled()
    })

    it('measures each word one time and keeps the width for each font size', () => {
        const fitter = createWordFitter(measure)
        const word = 'a'.repeat(40)
        const large = fitter.scaleFor(fit(word, { fontSize: 50 }))
        const calls = measure.mock.calls.length
        const small = fitter.scaleFor(fit(word, { fontSize: 25 }))
        expect(measure).toHaveBeenCalledTimes(calls)
        expect(small).toBe(1)
        expect(large).toBeLessThan(1)
    })

    it('has a minimum scale for a token with no end', () => {
        const fitter = createWordFitter(measure)
        expect(fitter.scaleFor(fit('a'.repeat(5000)))).toBe(0.1)
    })

    it('gives 1 before the width is known', () => {
        const fitter = createWordFitter(measure)
        expect(fitter.scaleFor(fit('a'.repeat(40), { width: 0 }))).toBe(1)
        expect(measure).not.toHaveBeenCalled()
    })
})

describe('createCanvasMeasure', () => {
    it('makes one canvas context and gives the width in em', () => {
        const context = { font: '', measureText: vi.fn(() => ({ width: 250 })) }
        const getContext = vi
            .spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockReturnValue(context as unknown as CanvasRenderingContext2D)

        const canvasMeasure = createCanvasMeasure()
        expect(getContext).not.toHaveBeenCalled()
        expect(canvasMeasure('word')).toBe(2.5)
        expect(canvasMeasure('next')).toBe(2.5)
        expect(getContext).toHaveBeenCalledTimes(1)
        expect(context.font).toBe(`${WORD_FONT_WEIGHT} 100px ${WORD_FONT_FAMILY}`)
        expect(context.measureText).toHaveBeenCalledWith('word')
    })

    it('estimates the width when the browser gives no context', () => {
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
        const canvasMeasure = createCanvasMeasure()
        expect(canvasMeasure('four')).toBeCloseTo(4 * 0.62)
        canvasMeasure('more')
        expect(getContext).toHaveBeenCalledTimes(1)
    })
})
