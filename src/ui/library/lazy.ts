import { showToast } from '../app/toast'

/**
 * Wraps the load of a part of the app that is not in the first chunk. The first call starts
 * the load and each later call gets the same result. After a failed load the next call tries
 * again.
 */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | null = null
    return () =>
        (pending ??= load().catch((error: unknown) => {
            pending = null
            throw error
        }))
}

/** For the catch of a lazy part. The usual cause is no network before the app is cached. */
export function reportLoadError(error: unknown): void {
    console.error(error)
    showToast({
        message: 'This part of the app did not load. Check the connection and try again.',
        tone: 'error',
    })
}
