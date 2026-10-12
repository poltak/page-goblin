/**
 * A button that does one step for a tap and repeats the step while the user holds it.
 */

import type { RsvpTimer } from '$lib/rsvp'
import { on } from '../../dom'

/** Time from the press to the first repeat. */
export const HOLD_DELAY_MS = 400
/** Time between two repeats. */
export const HOLD_INTERVAL_MS = 80

export interface HoldRepeatOptions {
    button: HTMLElement
    timer: Pick<RsvpTimer, 'setTimeout' | 'clearTimeout'>
    /** Does one step. Returns false when a limit stops it, which also ends the repeat. */
    onStep(): boolean
}

/** Returns the function that removes the listeners and stops the repeat. */
export function holdRepeat({ button, timer, onStep }: HoldRepeatOptions): () => void {
    let pressed = false
    /** The hold did a step already, so the click of its release must not do one more. */
    let repeated = false
    let handle: unknown

    function repeat(): void {
        if (!pressed) return
        repeated = true
        if (onStep()) handle = timer.setTimeout(repeat, HOLD_INTERVAL_MS)
        else pressed = false
    }

    function release(): void {
        if (!pressed) return
        pressed = false
        timer.clearTimeout(handle)
    }

    const removers = [
        on(button, 'pointerdown', (event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return
            release()
            pressed = true
            repeated = false
            handle = timer.setTimeout(repeat, HOLD_DELAY_MS)
        }),
        // The first step waits for the click. A press that starts a scroll of the sheet on a
        // touch screen then does no step.
        on(button, 'click', (event) => {
            // A click from the keyboard has no press before it, and its detail is 0.
            const afterHold = repeated && event.detail > 0
            repeated = false
            if (!afterHold) onStep()
        }),
        ...(['pointerup', 'pointercancel', 'pointerleave', 'blur'] as const).map((type) =>
            on(button, type, release),
        ),
    ]

    return () => {
        release()
        for (const remove of removers) remove()
    }
}
