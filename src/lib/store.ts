export type StoreListener<T> = (state: T, previous: T) => void

export interface Store<T extends object> {
    get(): T
    /**
     * Merges `patch` into the state. Does nothing when each value in `patch` is already set.
     * Calls the listeners before it returns. Throws the first error of a listener after all
     * listeners have the change.
     */
    set(patch: Partial<T>): void
    /** Returns the function that removes the listener. */
    subscribe(listener: StoreListener<T>): () => void
}

/** A small state holder. State objects are never changed, so `state !== previous` after a change. */
export function createStore<T extends object>(initial: T): Store<T> {
    let state = initial
    const listeners = new Set<StoreListener<T>>()
    // A listener can call set(). Such a change waits here until the listeners have the current
    // one, so each listener gets each change, in order.
    const queue: [state: T, previous: T][] = []

    return {
        get: () => state,
        set(patch) {
            const keys = Object.keys(patch) as (keyof T)[]
            if (keys.every((key) => Object.is(patch[key], state[key]))) return
            const previous = state
            state = { ...state, ...patch }
            queue.push([state, previous])
            if (queue.length > 1) return
            const errors: unknown[] = []
            for (let i = 0; i < queue.length; i++) {
                // The loop uses a copy. A loop through the Set also calls a listener that is
                // added during the loop, so a listener that subscribes again gets the change again.
                for (const listener of [...listeners]) {
                    if (!listeners.has(listener)) continue
                    try {
                        listener(...queue[i])
                    } catch (error) {
                        errors.push(error)
                    }
                }
            }
            queue.length = 0
            if (errors.length > 0) throw errors[0]
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    }
}
