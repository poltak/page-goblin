const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const WORKER_FILE = './sw.js'

export interface RegisterOptions {
    /**
     * A new version is installed and waits. Show a prompt and call `applyUpdate` when the user
     * accepts. The call can come more than one time.
     */
    onUpdateReady: () => void
}

let registration: ServiceWorkerRegistration | null = null
let updateAccepted = false
let reloading = false

function reloadOnce(): void {
    if (reloading) return
    reloading = true
    location.reload()
}

async function register(onUpdateReady: () => void): Promise<void> {
    const container = navigator.serviceWorker
    // A different site of the same origin can have a worker with a wider scope. That worker
    // controls this page until the first worker of the app takes control. It is not an old
    // version of the app, so it gives no update prompt and no reload.
    const workerUrl = new URL(WORKER_FILE, document.baseURI).href
    const isOurs = (worker: ServiceWorker | null): boolean => worker?.scriptURL === workerUrl

    let controlled = isOurs(container.controller)
    container.addEventListener('controllerchange', () => {
        // The first worker of a new install takes control with no reload. Each later change
        // means that the cache of this page is gone, also when a different tab accepted it.
        if (controlled || updateAccepted) reloadOnce()
        controlled = isOurs(container.controller)
    })

    let current: ServiceWorkerRegistration
    try {
        current = await container.register(WORKER_FILE, { updateViaCache: 'none' })
    } catch (error) {
        console.warn('The service worker did not register.', error)
        return
    }
    registration = current

    const watchInstall = (worker: ServiceWorker | null): void => {
        worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && isOurs(container.controller)) onUpdateReady()
        })
    }
    if (current.waiting && isOurs(container.controller)) onUpdateReady()
    // The browser checks for an update at each page load. Registration starts after the load
    // event, so the new worker can be in its install already, with no updatefound event to come.
    watchInstall(current.installing)
    current.addEventListener('updatefound', () => watchInstall(current.installing))

    let lastCheck = Date.now()
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return
        lastCheck = Date.now()
        current.update().catch(() => undefined)
    })
}

/**
 * Registers the service worker of a production build. It does nothing in the dev server, where
 * a worker would hide code changes behind its cache.
 */
export function registerServiceWorker({ onUpdateReady }: RegisterOptions): void {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    // The worker downloads the full app at install. That must not slow down the first load.
    if (document.readyState === 'complete') void register(onUpdateReady)
    else window.addEventListener('load', () => void register(onUpdateReady), { once: true })
}

/** Starts the waiting version. The page reloads one time when the new worker has control. */
export function applyUpdate(): void {
    const waiting = registration?.waiting
    if (!waiting) {
        // A different tab started the new version already.
        reloadOnce()
        return
    }
    updateAccepted = true
    // A second trigger for the same reload, in case this page gets no controllerchange event.
    waiting.addEventListener('statechange', () => {
        if (waiting.state === 'activated') reloadOnce()
    })
    waiting.postMessage({ type: 'SKIP_WAITING' })
}
