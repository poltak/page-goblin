import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTimer } from '$lib/rsvp/testing/fake-timer'
import type { FakeTimer } from '$lib/rsvp/testing/fake-timer'
import { HOLD_DELAY_MS, HOLD_INTERVAL_MS, holdRepeat } from './hold-repeat'
import { pointer } from './testing/fixtures'

let button: HTMLButtonElement
let timer: FakeTimer
let remove: () => void
let limit: number
const onStep = vi.fn(() => onStep.mock.calls.length < limit)

/** A click that follows a press has a detail of 1. A click from the keyboard has 0. */
function click(detail: number): void {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
}

beforeEach(() => {
    button = document.createElement('button')
    document.body.append(button)
    timer = createFakeTimer()
    limit = Infinity
    onStep.mockClear()
    remove = holdRepeat({ button, timer, onStep })
})

afterEach(() => {
    remove()
    button.remove()
})

describe('holdRepeat', () => {
    it('does one step for a tap', () => {
        button.dispatchEvent(pointer('pointerdown'))
        expect(onStep).not.toHaveBeenCalled()
        button.dispatchEvent(pointer('pointerup'))
        click(1)
        expect(onStep).toHaveBeenCalledTimes(1)
        expect(timer.pending()).toEqual([])
    })

    it('does one step for a click from the keyboard', () => {
        click(0)
        expect(onStep).toHaveBeenCalledTimes(1)
    })

    it('repeats the step during a hold and not for the click of the release', () => {
        button.dispatchEvent(pointer('pointerdown'))
        timer.advance(HOLD_DELAY_MS - 1)
        expect(onStep).not.toHaveBeenCalled()
        timer.advance(1)
        expect(onStep).toHaveBeenCalledTimes(1)
        timer.advance(HOLD_INTERVAL_MS * 3)
        expect(onStep).toHaveBeenCalledTimes(4)

        button.dispatchEvent(pointer('pointerup'))
        click(1)
        timer.advance(1000)
        expect(onStep).toHaveBeenCalledTimes(4)
    })

    it('steps again for a tap after a hold', () => {
        button.dispatchEvent(pointer('pointerdown'))
        timer.advance(HOLD_DELAY_MS)
        button.dispatchEvent(pointer('pointerup'))
        click(1)
        onStep.mockClear()

        button.dispatchEvent(pointer('pointerdown'))
        button.dispatchEvent(pointer('pointerup'))
        click(1)
        expect(onStep).toHaveBeenCalledTimes(1)
    })

    it('steps for a keyboard click after a hold that had no click', () => {
        button.dispatchEvent(pointer('pointerdown'))
        timer.advance(HOLD_DELAY_MS)
        button.dispatchEvent(pointer('pointerleave'))
        onStep.mockClear()
        click(0)
        expect(onStep).toHaveBeenCalledTimes(1)
    })

    it('stops the repeat when a step reports a limit', () => {
        limit = 3
        button.dispatchEvent(pointer('pointerdown'))
        timer.advance(HOLD_DELAY_MS + HOLD_INTERVAL_MS * 10)
        expect(onStep).toHaveBeenCalledTimes(3)
        expect(timer.pending()).toEqual([])
    })

    it.each(['pointerup', 'pointercancel', 'pointerleave', 'blur'])(
        'stops the hold on %s',
        (type) => {
            button.dispatchEvent(pointer('pointerdown'))
            button.dispatchEvent(type === 'blur' ? new FocusEvent('blur') : pointer(type))
            timer.advance(5000)
            expect(onStep).not.toHaveBeenCalled()
        },
    )

    it('ignores a press with a secondary mouse button', () => {
        button.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse', button: 2 }))
        timer.advance(5000)
        expect(onStep).not.toHaveBeenCalled()
    })

    it('stops the repeat when the listeners are removed', () => {
        button.dispatchEvent(pointer('pointerdown'))
        remove()
        timer.advance(5000)
        click(0)
        expect(onStep).not.toHaveBeenCalled()
    })
})
