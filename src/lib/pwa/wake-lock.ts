export interface ScreenWakeLock {
    /** Keeps the screen on until `release`. Resolves also when the browser refuses the lock. */
    request(): Promise<void>
    release(): Promise<void>
}

export function createWakeLock(): ScreenWakeLock {
    let wanted = false
    let sentinel: WakeLockSentinel | null = null
    let acquiring: Promise<void> | null = null

    async function acquire(): Promise<void> {
        if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return
        try {
            const lock = await navigator.wakeLock.request('screen')
            if (!wanted) {
                await lock.release()
                return
            }
            sentinel = lock
            lock.addEventListener('release', () => {
                if (sentinel === lock) sentinel = null
            })
        } catch {
            // The browser can refuse the lock, for example in battery saver mode.
        }
    }

    function ensure(): Promise<void> {
        if (!wanted || sentinel) return Promise.resolve()
        acquiring ??= acquire().finally(() => {
            acquiring = null
        })
        return acquiring
    }

    // The browser releases the lock when the page is hidden.
    function onVisibilityChange(): void {
        if (document.visibilityState === 'visible') void ensure()
    }

    return {
        request() {
            if (!wanted) {
                wanted = true
                document.addEventListener('visibilitychange', onVisibilityChange)
            }
            return ensure()
        },
        async release() {
            wanted = false
            document.removeEventListener('visibilitychange', onVisibilityChange)
            const lock = sentinel
            sentinel = null
            try {
                await lock?.release()
            } catch {
                // The lock is already gone.
            }
        },
    }
}
