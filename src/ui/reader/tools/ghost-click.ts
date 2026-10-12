/**
 * A tap on the book text can open a box below the finger: a toolbar, a note or the image
 * viewer. The tap opens the box in its pointerup event. On a touch screen the browser finds
 * the target of the click after that, so the click of the same tap goes to a button of the
 * new box. Such a click has no press inside the box before it, and it comes a moment after
 * the box opened.
 */

/** A click with no press before it is not from the opening tap after this time. */
export const GHOST_CLICK_MS = 400

export interface OpenedBox {
    /** `Date.now()` at the time the box opened. */
    openedAt: number
    /** True when the last press on the page started inside the box. */
    pressedInside: boolean
}

export function isGhostClick(event: MouseEvent, { openedAt, pressedInside }: OpenedBox): boolean {
    // A click from the keyboard has a detail of 0. It is never from a tap.
    return event.detail !== 0 && !pressedInside && Date.now() - openedAt < GHOST_CLICK_MS
}
