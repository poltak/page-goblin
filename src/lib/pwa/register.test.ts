import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeWorker extends EventTarget {
    state = 'installing'
    postMessage = vi.fn()

    setState(state: string): void {
        this.state = state
        this.dispatchEvent(new Event('statechange'))
    }
}

class FakeRegistration extends EventTarget {
    installing: FakeWorker | null = null
    waiting: FakeWorker | null = null
    update = vi.fn(async () => undefined)
}

class FakeContainer extends EventTarget {
    controller: { scriptURL: string } | null = null
    registration = new FakeRegistration()
    register = vi.fn(async (): Promise<FakeRegistration> => this.registration)
}

const HOUR = 60 * 60 * 1000
/** A worker of the app. Its file is next to the page. */
const OURS = { scriptURL: new URL('./sw.js', document.baseURI).href }
/** A worker of a different site of the same origin, with a scope that has this page in it. */
const OTHER_SITE = { scriptURL: new URL('/service-worker.js', document.baseURI).href }

describe('service worker registration', () => {
    let container: FakeContainer
    let reload: ReturnType<typeof vi.fn>
    let onUpdateReady: ReturnType<typeof vi.fn<() => void>>
    let pwa: typeof import('./register')

    /** Lets the registration promise and the code after it run. */
    const settle = () => new Promise((resolve) => setTimeout(resolve))

    function setVisibility(state: DocumentVisibilityState): void {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
        document.dispatchEvent(new Event('visibilitychange'))
    }

    /** Puts a new worker in the registration, as the browser does when it finds an update. */
    function findUpdate(): FakeWorker {
        const worker = new FakeWorker()
        container.registration.installing = worker
        container.registration.dispatchEvent(new Event('updatefound'))
        return worker
    }

    function finishInstall(worker: FakeWorker): void {
        container.registration.installing = null
        container.registration.waiting = worker
        worker.setState('installed')
    }

    beforeEach(async () => {
        vi.resetModules()
        container = new FakeContainer()
        reload = vi.fn()
        onUpdateReady = vi.fn<() => void>()
        Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true })
        vi.stubGlobal('location', { reload })
        vi.stubEnv('PROD', true)
        vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        pwa = await import('./register')
    })

    afterEach(() => {
        Reflect.deleteProperty(navigator, 'serviceWorker')
        vi.useRealTimers()
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('registers the worker file next to the page in a production build', async () => {
        pwa.registerServiceWorker({ onUpdateReady })
        await settle()

        expect(container.register).toHaveBeenCalledWith('./sw.js', { updateViaCache: 'none' })
        expect(onUpdateReady).not.toHaveBeenCalled()
    })

    it('does not register in the dev server', async () => {
        vi.stubEnv('PROD', false)

        pwa.registerServiceWorker({ onUpdateReady })
        await settle()

        expect(container.register).not.toHaveBeenCalled()
    })

    it('does not register when the browser has no service workers', async () => {
        Reflect.deleteProperty(navigator, 'serviceWorker')

        expect(() => pwa.registerServiceWorker({ onUpdateReady })).not.toThrow()
    })

    it('waits for the page to load', async () => {
        vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive')

        pwa.registerServiceWorker({ onUpdateReady })
        await settle()
        expect(container.register).not.toHaveBeenCalled()

        window.dispatchEvent(new Event('load'))
        await settle()
        expect(container.register).toHaveBeenCalledOnce()
    })

    it('continues when the registration fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        container.register.mockRejectedValue(new Error('no storage'))

        pwa.registerServiceWorker({ onUpdateReady })
        await settle()

        expect(warn).toHaveBeenCalledOnce()
    })

    it('reports a worker that already waits when the page has a controller', async () => {
        container.controller = OURS
        container.registration.waiting = new FakeWorker()

        pwa.registerServiceWorker({ onUpdateReady })
        await settle()

        expect(onUpdateReady).toHaveBeenCalledOnce()
    })

    it('reports a new worker after its install', async () => {
        container.controller = OURS
        pwa.registerServiceWorker({ onUpdateReady })
        await settle()

        const worker = findUpdate()
        expect(onUpdateReady).not.toHaveBeenCalled()
        finishInstall(worker)

        expect(onUpdateReady).toHaveBeenCalledOnce()
    })

    it('reports a worker that the browser started to install before the registration', async () => {
        container.controller = OURS
        // The browser found the update during the page load. No updatefound event comes now.
        const worker = new FakeWorker()
        container.registration.installing = worker

        pwa.registerServiceWorker({ onUpdateReady })
        await settle()
        expect(onUpdateReady).not.toHaveBeenCalled()
        finishInstall(worker)

        expect(onUpdateReady).toHaveBeenCalledOnce()
    })

    it('does not report the first install, and does not reload when it takes control', async () => {
        pwa.registerServiceWorker({ onUpdateReady })
        await settle()

        finishInstall(findUpdate())
        container.controller = OURS
        container.dispatchEvent(new Event('controllerchange'))

        expect(onUpdateReady).not.toHaveBeenCalled()
        expect(reload).not.toHaveBeenCalled()
    })

    describe('with a worker of a different site of the origin in control', () => {
        it('does not report the first install, and does not reload at a controller change', async () => {
            container.controller = OTHER_SITE
            pwa.registerServiceWorker({ onUpdateReady })
            await settle()

            // The other site gets a new version of its worker.
            container.dispatchEvent(new Event('controllerchange'))
            expect(reload).not.toHaveBeenCalled()

            finishInstall(findUpdate())
            expect(onUpdateReady).not.toHaveBeenCalled()

            // The first worker of the app takes the page from the other worker.
            container.controller = OURS
            container.dispatchEvent(new Event('controllerchange'))
            expect(reload).not.toHaveBeenCalled()
        })

        it('does not report a worker that waits', async () => {
            container.controller = OTHER_SITE
            container.registration.waiting = new FakeWorker()

            pwa.registerServiceWorker({ onUpdateReady })
            await settle()

            expect(onUpdateReady).not.toHaveBeenCalled()
        })

        it('reports the next version and reloads after the worker of the app took control', async () => {
            container.controller = OTHER_SITE
            pwa.registerServiceWorker({ onUpdateReady })
            await settle()
            finishInstall(findUpdate())
            container.controller = OURS
            container.dispatchEvent(new Event('controllerchange'))

            finishInstall(findUpdate())
            expect(onUpdateReady).toHaveBeenCalledOnce()
            container.dispatchEvent(new Event('controllerchange'))

            expect(reload).toHaveBeenCalledOnce()
        })
    })

    it('starts the waiting worker and reloads one time when the user accepts', async () => {
        container.controller = OURS
        pwa.registerServiceWorker({ onUpdateReady })
        await settle()
        const worker = findUpdate()
        finishInstall(worker)

        pwa.applyUpdate()
        expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
        expect(reload).not.toHaveBeenCalled()

        container.dispatchEvent(new Event('controllerchange'))
        worker.setState('activated')
        container.dispatchEvent(new Event('controllerchange'))

        expect(reload).toHaveBeenCalledOnce()
    })

    it('reloads when the worker is active but the page got no controller event', async () => {
        container.controller = OURS
        pwa.registerServiceWorker({ onUpdateReady })
        await settle()
        const worker = findUpdate()
        finishInstall(worker)

        pwa.applyUpdate()
        worker.setState('activating')
        expect(reload).not.toHaveBeenCalled()
        worker.setState('activated')

        expect(reload).toHaveBeenCalledOnce()
    })

    it('reloads when a different tab accepted the update', async () => {
        container.controller = OURS
        pwa.registerServiceWorker({ onUpdateReady })
        await settle()

        container.dispatchEvent(new Event('controllerchange'))

        expect(reload).toHaveBeenCalledOnce()
    })

    it('reloads at once when the user accepts and no worker waits', async () => {
        container.controller = OURS
        pwa.registerServiceWorker({ onUpdateReady })
        await settle()

        pwa.applyUpdate()

        expect(reload).toHaveBeenCalledOnce()
    })

    it('checks for an update when the page is visible again, one time each hour', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(0)
        pwa.registerServiceWorker({ onUpdateReady })
        await settle()
        const { update } = container.registration

        vi.setSystemTime(HOUR - 1)
        setVisibility('hidden')
        setVisibility('visible')
        expect(update).not.toHaveBeenCalled()

        vi.setSystemTime(HOUR)
        setVisibility('hidden')
        expect(update).not.toHaveBeenCalled()
        setVisibility('visible')
        expect(update).toHaveBeenCalledOnce()

        vi.setSystemTime(HOUR + 60_000)
        setVisibility('hidden')
        setVisibility('visible')
        expect(update).toHaveBeenCalledOnce()

        vi.setSystemTime(2 * HOUR)
        setVisibility('visible')
        expect(update).toHaveBeenCalledTimes(2)
    })
})
