/**
 * The rules that show and hide the two bars of the reader screen, as a pure state machine.
 * The screen sends each input here as an event and applies the state that comes back.
 */

import type { RelocateInfo } from '$lib/reader/types'
import { compareLocators } from '$lib/types'
import type { ReaderMode } from '../types'

/** The time that the bars stay after the book opens and after a mode ends. */
export const BARS_PEEK_MS = 3000

/** A mouse pointer at this distance from the top edge, or nearer, shows the bars. */
export const BARS_POINTER_ZONE_PX = 56

export interface BarsState {
    visible: boolean
    /** The bars hide by themselves after `BARS_PEEK_MS`. */
    timed: boolean
}

export type BarsEvent =
    /** The book is on screen. The bars show for a moment. */
    | 'open'
    /** The speed reader or the listen bar ended. The bars show for a moment. */
    | 'mode-exit'
    /** A tap in the centre of the page. */
    | 'center-tap'
    /** The keyboard focus moved into a bar, or the user used a control of a bar. */
    | 'focus'
    /** The mouse pointer went to the top edge of the screen. */
    | 'pointer-top'
    /** The position in the book changed, and the bars did not cause the change. */
    | 'page-turn'
    /** A tap in the page that is not a centre tap. */
    | 'page-tap'
    | 'escape'
    /** `BARS_PEEK_MS` went by since the bars showed for a moment. */
    | 'timeout'
    /** The mode of the session changed. */
    | 'mode'

export interface BarsContext {
    mode: ReaderMode
    /** The user works with a bar now: the focus or the pointer is in it, or its menu is open. */
    held: boolean
}

export const BARS_HIDDEN: BarsState = Object.freeze({ visible: false, timed: false })
const SHOWN: BarsState = Object.freeze({ visible: true, timed: false })
const SHOWN_FOR_A_MOMENT: BarsState = Object.freeze({ visible: true, timed: true })

export function reduceBars(state: BarsState, event: BarsEvent, context: BarsContext): BarsState {
    // The speed reader covers the page and has its own controls.
    if (context.mode === 'speed') return BARS_HIDDEN

    switch (event) {
        case 'open':
        case 'mode-exit':
            // Bars that the user opened stay until the user hides them.
            return state.visible ? state : SHOWN_FOR_A_MOMENT
        case 'center-tap':
            return state.visible ? BARS_HIDDEN : SHOWN
        case 'focus':
        case 'pointer-top':
            return SHOWN
        case 'page-turn':
        case 'page-tap':
        case 'escape':
            return BARS_HIDDEN
        case 'timeout':
            if (!state.visible || !state.timed) return state
            return context.held ? SHOWN : BARS_HIDDEN
        case 'mode':
            // The listen bar is new on screen. The page and the bar must be in sight.
            return context.mode === 'listen' ? BARS_HIDDEN : state
    }
}

/**
 * True when a new position is a page turn or a jump. False when it is the same place in a new
 * layout.
 *
 * After a resize or a change of the text, the paged view makes its pages again and shows the
 * page that has the old text. That page can start at a different character, but the two pages
 * have text in common. The pages before and after a page turn have no text in common.
 */
export function isPageTurn(previous: RelocateInfo | null, next: RelocateInfo): boolean {
    if (!previous || compareLocators(previous.locator, next.locator) === 0) return false
    // The scroll view keeps its first line in a new layout, so each new position is a move.
    if (next.page === null) return true
    const before = previous.visible
    const after = next.visible
    return (
        before.spineIndex !== after.spineIndex ||
        after.start >= before.end ||
        after.end <= before.start
    )
}
