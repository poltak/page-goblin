export interface Emitter<Events> {
    /** Returns a function that removes the listener. */
    on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void
    emit<K extends keyof Events>(event: K, payload: Events[K]): void
    /** Remove all listeners. */
    clear(): void
}

/** Sends an error to the error handling of the page and does not stop the caller. */
export function reportAsync(error: unknown): void {
    if (typeof reportError === 'function') reportError(error)
    else
        setTimeout(() => {
            throw error
        }, 0)
}

/**
 * A small typed event emitter.
 *
 * A listener that throws does not stop the other listeners, and the error does not go to the
 * code that emits. The session emits from callbacks of the reader view, and an error there
 * would stop the view in the middle of a page turn.
 */
export function createEmitter<Events>(
    onListenerError: (error: unknown) => void = reportAsync,
): Emitter<Events> {
    type Listener = (payload: never) => void
    const listeners = new Map<keyof Events, Set<Listener>>()

    return {
        on(event, listener) {
            // A wrapper lets the same function listen two times and be removed one at a time.
            const entry: Listener = (payload) => listener(payload)
            let set = listeners.get(event)
            if (!set) listeners.set(event, (set = new Set()))
            set.add(entry)
            return () => {
                listeners.get(event)?.delete(entry)
            }
        },
        emit(event, payload) {
            const set = listeners.get(event)
            if (!set || set.size === 0) return
            // The loop uses a copy, because a listener can add or remove listeners.
            for (const listener of [...set]) {
                if (!set.has(listener)) continue
                try {
                    listener(payload as never)
                } catch (error) {
                    onListenerError(error)
                }
            }
        },
        clear() {
            // An emit that runs now reads its set, so each set must be empty also.
            for (const set of listeners.values()) set.clear()
            listeners.clear()
        },
    }
}
