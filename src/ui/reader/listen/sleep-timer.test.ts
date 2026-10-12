import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSleepTimer } from './sleep-timer'

const MINUTE = 60_000

function make() {
    const onChange = vi.fn<() => void>()
    const onElapsed = vi.fn<() => void>()
    return { timer: createSleepTimer({ onChange, onElapsed }), onChange, onElapsed }
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('createSleepTimer', () => {
    it('is off at the start', () => {
        const { timer } = make()
        expect(timer.choice).toBe('off')
        expect(timer.minutesLeft).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('counts the minutes down and ends', () => {
        const { timer, onChange, onElapsed } = make()
        timer.set(3)
        expect(timer.choice).toBe(3)
        expect(timer.minutesLeft).toBe(3)
        expect(onChange).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(MINUTE - 1)
        expect(timer.minutesLeft).toBe(3)
        vi.advanceTimersByTime(1)
        expect(timer.minutesLeft).toBe(2)
        expect(onChange).toHaveBeenCalledTimes(2)

        vi.advanceTimersByTime(2 * MINUTE - 1)
        expect(timer.minutesLeft).toBe(1)
        expect(onElapsed).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        expect(onElapsed).toHaveBeenCalledTimes(1)
        expect(timer.choice).toBe('off')
        expect(timer.minutesLeft).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('tells the change before the end', () => {
        const calls: string[] = []
        const timer = createSleepTimer({
            onChange: () => calls.push(`change:${timer.choice}`),
            onElapsed: () => calls.push('elapsed'),
        })
        timer.set(1)
        vi.advanceTimersByTime(MINUTE)
        expect(calls).toEqual(['change:1', 'change:off', 'elapsed'])
    })

    it('uses the clock, so a late timer of a hidden page does not add time', () => {
        const { timer, onElapsed } = make()
        timer.set(5)
        // The browser runs no timer for 10 minutes.
        vi.setSystemTime(Date.now() + 10 * MINUTE)
        vi.advanceTimersByTime(MINUTE)
        expect(onElapsed).toHaveBeenCalledTimes(1)
        expect(timer.choice).toBe('off')
    })

    it('starts the time again for the same number of minutes', () => {
        const { timer, onElapsed } = make()
        timer.set(5)
        vi.advanceTimersByTime(4 * MINUTE)
        timer.set(5)
        expect(timer.minutesLeft).toBe(5)
        vi.advanceTimersByTime(4 * MINUTE)
        expect(onElapsed).not.toHaveBeenCalled()
        vi.advanceTimersByTime(MINUTE)
        expect(onElapsed).toHaveBeenCalledTimes(1)
    })

    it('clears a timer', () => {
        const { timer, onChange, onElapsed } = make()
        timer.set(5)
        timer.clear()
        expect(timer.choice).toBe('off')
        expect(timer.minutesLeft).toBeNull()
        expect(onChange).toHaveBeenCalledTimes(2)
        expect(vi.getTimerCount()).toBe(0)
        vi.advanceTimersByTime(10 * MINUTE)
        expect(onElapsed).not.toHaveBeenCalled()

        // No change, no call.
        timer.clear()
        expect(onChange).toHaveBeenCalledTimes(2)
    })

    it('stops one time at the end of a chapter', () => {
        const { timer, onChange, onElapsed } = make()
        expect(timer.takeChapterEnd()).toBe(false)

        timer.set('chapter')
        expect(timer.choice).toBe('chapter')
        expect(timer.minutesLeft).toBeNull()
        expect(vi.getTimerCount()).toBe(0)

        expect(timer.takeChapterEnd()).toBe(true)
        expect(timer.choice).toBe('off')
        expect(timer.takeChapterEnd()).toBe(false)
        expect(onChange).toHaveBeenCalledTimes(2)
        expect(onElapsed).not.toHaveBeenCalled()
    })

    it('does not stop at the end of a chapter for a timer in minutes', () => {
        const { timer } = make()
        timer.set(5)
        expect(timer.takeChapterEnd()).toBe(false)
        expect(timer.choice).toBe(5)
    })

    it('replaces a timer in minutes with the end of the chapter', () => {
        const { timer, onElapsed } = make()
        timer.set(5)
        timer.set('chapter')
        expect(timer.minutesLeft).toBeNull()
        vi.advanceTimersByTime(10 * MINUTE)
        expect(onElapsed).not.toHaveBeenCalled()
        expect(timer.choice).toBe('chapter')
    })

    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('takes %s minutes as off', (value) => {
        const { timer } = make()
        timer.set(5)
        timer.set(value)
        expect(timer.choice).toBe('off')
        expect(vi.getTimerCount()).toBe(0)
    })
})
