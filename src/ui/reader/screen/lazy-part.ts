/**
 * A part of the reader screen that loads at its first use. The screen keeps one instance.
 */

import { showToast } from '../../app/toast'
import type { Part } from '../parts'

export const PART_LOAD_MESSAGE = 'This part did not load. Check the connection and try again.'

export interface LazyPart<T extends Part> {
    /** The part when it is loaded, else null. */
    readonly current: T | null
    /**
     * Gives the part to `run`. When the part is loaded, `run` is called before this function
     * returns, so a click handler keeps its user gesture. Else the part loads first. A load
     * that fails shows a message, and the next call tries again.
     */
    use(run: (part: T) => void): void
    /** Starts the load. A failure shows no message. */
    warm(): void
    /** Destroys the part. A load that ends later gives a part that is destroyed at once. */
    destroy(): void
}

export function lazyPart<T extends Part>(create: () => Promise<T>): LazyPart<T> {
    let current: T | null = null
    let pending: Promise<T | null> | null = null
    let destroyed = false

    function load(): Promise<T | null> {
        // An error that `create` throws before its first await is also a failed load.
        pending ??= Promise.resolve()
            .then(create)
            .then(
                (part) => {
                    if (destroyed) {
                        part.destroy()
                        return null
                    }
                    current = part
                    return part
                },
                (error: unknown) => {
                    pending = null
                    throw error
                },
            )
        return pending
    }

    return {
        get current() {
            return current
        },
        use(run) {
            if (destroyed) return
            if (current) {
                run(current)
                return
            }
            load().then(
                (part) => {
                    if (part && !destroyed) run(part)
                },
                (error: unknown) => {
                    console.error(error)
                    if (!destroyed) showToast({ message: PART_LOAD_MESSAGE, tone: 'error' })
                },
            )
        },
        warm() {
            if (destroyed || current) return
            load().catch((error: unknown) => console.error(error))
        },
        destroy() {
            if (destroyed) return
            destroyed = true
            current?.destroy()
            current = null
        },
    }
}
