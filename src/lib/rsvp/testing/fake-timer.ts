/**
 * A timer for tests that keeps the exact delay of each timeout and has a clock that the test
 * moves by hand.
 */

import type { RsvpTimer } from '../types'

interface PendingTimeout {
    callback: () => void
    delay: number
    dueAt: number
}

export interface FakeTimer extends RsvpTimer {
    /** Delays of the timeouts that are waiting, in the order of their start. */
    pending(): number[]
    /** Number of `setTimeout` calls from the start. */
    startedCount(): number
    /** Move the clock forward and run each timeout that becomes due, in time order. */
    advance(ms: number): void
    /**
     * Run the oldest waiting timeout. The clock goes to the due time of that timeout plus
     * `lateMs`. A negative value runs the timeout early.
     */
    fire(lateMs?: number): void
}

export function createFakeTimer(): FakeTimer {
    let now = 0
    // Handle 0 is valid, so the engine must not use the handle to know if a timeout waits.
    let nextHandle = 0
    let started = 0
    const timeouts = new Map<number, PendingTimeout>()

    return {
        setTimeout(callback, delay) {
            const handle = nextHandle++
            started++
            timeouts.set(handle, { callback, delay, dueAt: now + delay })
            return handle
        },
        clearTimeout(handle) {
            timeouts.delete(handle as number)
        },
        now: () => now,
        pending: () => Array.from(timeouts.values(), (timeout) => timeout.delay),
        startedCount: () => started,
        advance(ms) {
            const end = now + ms
            for (;;) {
                let next: [number, PendingTimeout] | null = null
                for (const entry of timeouts) {
                    if (entry[1].dueAt <= end && (!next || entry[1].dueAt < next[1].dueAt)) {
                        next = entry
                    }
                }
                if (!next) break
                timeouts.delete(next[0])
                now = Math.max(now, next[1].dueAt)
                next[1].callback()
            }
            now = end
        },
        fire(lateMs = 0) {
            const first = timeouts.entries().next()
            if (first.done) throw new Error('No timeout is waiting')
            const [handle, timeout] = first.value
            timeouts.delete(handle)
            now = timeout.dueAt + lateMs
            timeout.callback()
        },
    }
}
