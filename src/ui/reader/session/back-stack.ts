import type { Locator } from '$lib/types'

export const BACK_STACK_LIMIT = 20

export interface BackStack {
    readonly size: number
    /** Add a position. When the stack is full, the oldest position goes away. */
    push(locator: Locator): void
    /** Remove and return the newest position. */
    pop(): Locator | undefined
    clear(): void
}

/** The positions that `back()` returns to, newest last. */
export function createBackStack(limit: number = BACK_STACK_LIMIT): BackStack {
    const entries: Locator[] = []

    return {
        get size() {
            return entries.length
        },
        push(locator) {
            const top = entries[entries.length - 1]
            // Two jumps from the same place need only one step back.
            if (top && top.spineIndex === locator.spineIndex && top.offset === locator.offset) {
                return
            }
            entries.push({ spineIndex: locator.spineIndex, offset: locator.offset })
            if (entries.length > limit) entries.splice(0, entries.length - limit)
        },
        pop: () => entries.pop(),
        clear() {
            entries.length = 0
        },
    }
}
