import { describe, expect, it } from 'vitest'
import type { RelocateInfo } from '$lib/reader/types'
import { BARS_HIDDEN, isPageTurn, reduceBars } from './bars'
import type { BarsContext, BarsEvent, BarsState } from './bars'

const READ: BarsContext = { mode: 'read', held: false }
const SHOWN: BarsState = { visible: true, timed: false }
const PEEK: BarsState = { visible: true, timed: true }

function run(events: BarsEvent[], context: BarsContext = READ): BarsState {
    return events.reduce((state, event) => reduceBars(state, event, context), BARS_HIDDEN)
}

describe('reduceBars', () => {
    it('starts with hidden bars', () => {
        expect(BARS_HIDDEN).toEqual({ visible: false, timed: false })
    })

    it('shows the bars for a moment when the book opens', () => {
        expect(run(['open'])).toEqual(PEEK)
        expect(run(['open', 'timeout'])).toEqual(BARS_HIDDEN)
    })

    it('shows the bars for a moment when a mode ends', () => {
        expect(run(['mode-exit'])).toEqual(PEEK)
        expect(run(['mode-exit', 'timeout'])).toEqual(BARS_HIDDEN)
    })

    it('toggles the bars on a centre tap', () => {
        expect(run(['center-tap'])).toEqual(SHOWN)
        expect(run(['center-tap', 'center-tap'])).toEqual(BARS_HIDDEN)
        expect(run(['open', 'center-tap'])).toEqual(BARS_HIDDEN)
    })

    it('keeps bars from a centre tap after the time of a moment', () => {
        expect(run(['center-tap', 'timeout'])).toEqual(SHOWN)
    })

    it('shows the bars when the focus moves into them', () => {
        expect(run(['focus'])).toEqual(SHOWN)
    })

    it('keeps the bars when the focus moves into them during the moment', () => {
        expect(run(['open', 'focus'])).toEqual(SHOWN)
        expect(run(['open', 'focus', 'timeout'])).toEqual(SHOWN)
    })

    it('shows the bars when the pointer goes to the top edge', () => {
        expect(run(['pointer-top'])).toEqual(SHOWN)
        expect(run(['open', 'pointer-top', 'timeout'])).toEqual(SHOWN)
    })

    it.each<BarsEvent>(['page-turn', 'page-tap', 'escape'])('hides the bars on %s', (event) => {
        expect(run(['center-tap', event])).toEqual(BARS_HIDDEN)
        expect(run(['open', event])).toEqual(BARS_HIDDEN)
        expect(run([event])).toEqual(BARS_HIDDEN)
    })

    it('keeps the bars at the timeout while the user works with them', () => {
        const state = reduceBars(PEEK, 'timeout', { mode: 'read', held: true })
        expect(state).toEqual(SHOWN)
    })

    it('ignores a timeout for hidden bars', () => {
        expect(reduceBars(BARS_HIDDEN, 'timeout', READ)).toEqual(BARS_HIDDEN)
    })

    it('does not make bars that the user opened leave after a moment', () => {
        expect(run(['center-tap', 'open'])).toEqual(SHOWN)
        expect(run(['center-tap', 'mode-exit', 'timeout'])).toEqual(SHOWN)
    })

    it.each(['speed', 'listen'] as const)('hides the bars in the %s mode', (mode) => {
        expect(reduceBars(SHOWN, 'mode', { mode, held: true })).toEqual(BARS_HIDDEN)
    })

    it('keeps the bars hidden for each event while the speed reader runs', () => {
        const events: BarsEvent[] = [
            'open',
            'mode-exit',
            'center-tap',
            'focus',
            'pointer-top',
            'page-turn',
            'page-tap',
            'escape',
            'timeout',
            'mode',
        ]
        for (const event of events) {
            expect(reduceBars(BARS_HIDDEN, event, { mode: 'speed', held: false })).toEqual(
                BARS_HIDDEN,
            )
            expect(reduceBars(SHOWN, event, { mode: 'speed', held: false })).toEqual(BARS_HIDDEN)
        }
    })

    it('shows and hides the bars in the listen mode as in the read mode', () => {
        const listen = { mode: 'listen', held: false } as const
        expect(reduceBars(BARS_HIDDEN, 'center-tap', listen)).toEqual(SHOWN)
        expect(reduceBars(BARS_HIDDEN, 'focus', listen)).toEqual(SHOWN)
        expect(reduceBars(BARS_HIDDEN, 'pointer-top', listen)).toEqual(SHOWN)
        expect(reduceBars(SHOWN, 'center-tap', listen)).toEqual(BARS_HIDDEN)
        // The voice turns the page.
        expect(reduceBars(SHOWN, 'page-turn', listen)).toEqual(BARS_HIDDEN)
    })

    it('does not change the bars when the mode goes back to read', () => {
        expect(reduceBars(BARS_HIDDEN, 'mode', READ)).toEqual(BARS_HIDDEN)
        expect(reduceBars(SHOWN, 'mode', READ)).toEqual(SHOWN)
    })
})

describe('isPageTurn', () => {
    /** A page of the paged view that shows the characters from `start` to `end`. */
    function page(start: number, end: number, changes: Partial<RelocateInfo> = {}): RelocateInfo {
        return {
            locator: { spineIndex: 1, offset: start },
            visible: { spineIndex: 1, start, end },
            chapterLength: 5000,
            page: 3,
            pageCount: 12,
            atBookStart: false,
            atBookEnd: false,
            ...changes,
        }
    }

    it('is false for the first position and for the same position', () => {
        expect(isPageTurn(null, page(100, 400))).toBe(false)
        expect(isPageTurn(page(100, 400), page(100, 400))).toBe(false)
        // The page count changed, for example after a late image.
        expect(isPageTurn(page(100, 400), page(100, 380, { pageCount: 13 }))).toBe(false)
    })

    it('is true for the next and the previous page', () => {
        expect(isPageTurn(page(100, 400), page(400, 700))).toBe(true)
        expect(isPageTurn(page(400, 700), page(100, 400))).toBe(true)
    })

    it('is true for a jump to a different chapter', () => {
        const other = page(100, 400, {
            locator: { spineIndex: 2, offset: 100 },
            visible: { spineIndex: 2, start: 100, end: 400 },
        })
        expect(isPageTurn(page(100, 400), other)).toBe(true)
    })

    it('is false when a new layout of the paged view moves the start of the page', () => {
        // Larger text: the page that has the old text starts later and ends sooner.
        expect(isPageTurn(page(100, 400), page(160, 330))).toBe(false)
        // Smaller text, or a higher page after the listen bar closed.
        expect(isPageTurn(page(100, 400), page(40, 520))).toBe(false)
        // A second new layout in a row.
        expect(isPageTurn(page(160, 330), page(180, 300))).toBe(false)
    })

    it('is true for a page with no text that follows a page with text', () => {
        expect(isPageTurn(page(100, 400), page(400, 400))).toBe(true)
        expect(isPageTurn(page(400, 400), page(400, 400, { pageCount: 13 }))).toBe(false)
    })

    it('is true for each new position of the scroll view', () => {
        const scroll = (start: number, end: number): RelocateInfo =>
            page(start, end, { page: null, pageCount: null })
        expect(isPageTurn(scroll(100, 400), scroll(130, 430))).toBe(true)
        expect(isPageTurn(scroll(100, 400), scroll(100, 400))).toBe(false)
    })

    it('is false when the paged view replaces the scroll view at the same text', () => {
        const scroll = page(100, 400, { page: null, pageCount: null })
        expect(isPageTurn(scroll, page(60, 350))).toBe(false)
    })
})
