import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Outcome = 'accepted' | 'dismissed'

/** Sends the event that Chromium sends when the app can be installed. */
function sendInstallEvent(outcome: Outcome = 'accepted') {
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: vi.fn(async () => undefined),
        userChoice: Promise.resolve({ outcome }),
    })
    window.dispatchEvent(event)
    return event
}

const NAVIGATOR_FIELDS = ['userAgent', 'platform', 'maxTouchPoints', 'standalone'] as const

/** Puts own properties on the navigator. They hide the values of jsdom until a test ends. */
function setNavigator(values: Partial<Record<(typeof NAVIGATOR_FIELDS)[number], unknown>>): void {
    for (const [name, value] of Object.entries(values)) {
        Object.defineProperty(navigator, name, { value, configurable: true })
    }
}

describe('install prompt', () => {
    let install: typeof import('./install')

    beforeEach(async () => {
        vi.resetModules()
        install = await import('./install')
    })

    afterEach(() => {
        for (const name of NAVIGATOR_FIELDS) Reflect.deleteProperty(navigator, name)
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('cannot install before the browser offers it', async () => {
        expect(install.canInstall()).toBe(false)
        expect(await install.promptInstall()).toBe('unavailable')
    })

    it('keeps the browser event and stops the install bar of the browser', () => {
        const listener = vi.fn()
        install.onInstallAvailabilityChange(listener)

        const event = sendInstallEvent()

        expect(event.defaultPrevented).toBe(true)
        expect(event.prompt).not.toHaveBeenCalled()
        expect(install.canInstall()).toBe(true)
        expect(listener).toHaveBeenCalledExactlyOnceWith(true)
    })

    it('shows the prompt one time and reports that the user accepted', async () => {
        const event = sendInstallEvent('accepted')
        const listener = vi.fn()
        install.onInstallAvailabilityChange(listener)

        expect(await install.promptInstall()).toBe('accepted')

        expect(event.prompt).toHaveBeenCalledOnce()
        expect(install.canInstall()).toBe(false)
        expect(listener).toHaveBeenCalledExactlyOnceWith(false)
        expect(await install.promptInstall()).toBe('unavailable')
        expect(event.prompt).toHaveBeenCalledOnce()
    })

    it('reports that the user dismissed the prompt', async () => {
        sendInstallEvent('dismissed')

        expect(await install.promptInstall()).toBe('dismissed')
    })

    it('reports unavailable when the browser refuses the prompt', async () => {
        const event = sendInstallEvent()
        event.prompt.mockRejectedValue(new Error('not allowed'))

        expect(await install.promptInstall()).toBe('unavailable')
    })

    it('cannot install after the app is installed', () => {
        sendInstallEvent()
        const listener = vi.fn()
        install.onInstallAvailabilityChange(listener)

        window.dispatchEvent(new Event('appinstalled'))

        expect(install.canInstall()).toBe(false)
        expect(listener).toHaveBeenCalledExactlyOnceWith(false)
    })

    it('does not call a listener again when a second event replaces the first', () => {
        sendInstallEvent()
        const listener = vi.fn()
        install.onInstallAvailabilityChange(listener)

        sendInstallEvent()

        expect(install.canInstall()).toBe(true)
        expect(listener).not.toHaveBeenCalled()
    })

    it('stops the calls to a removed listener', () => {
        const listener = vi.fn()
        const remove = install.onInstallAvailabilityChange(listener)

        remove()
        sendInstallEvent()

        expect(listener).not.toHaveBeenCalled()
    })

    describe('isStandalone', () => {
        it('is false in a browser tab', () => {
            expect(install.isStandalone()).toBe(false)
        })

        it('is true when the display mode is standalone', () => {
            const matchMedia = vi.fn((query: string) => ({
                matches: query === '(display-mode: standalone)',
            }))
            vi.stubGlobal('matchMedia', matchMedia)

            expect(install.isStandalone()).toBe(true)
        })

        it('is true for an app on the iOS home screen', () => {
            setNavigator({ standalone: true })

            expect(install.isStandalone()).toBe(true)
        })
    })

    describe('isIos', () => {
        it('is true on an iPhone', () => {
            setNavigator({
                userAgent:
                    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
            })

            expect(install.isIos()).toBe(true)
        })

        it('is true on an iPad that reports a Mac', () => {
            setNavigator({
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
                platform: 'MacIntel',
                maxTouchPoints: 5,
            })

            expect(install.isIos()).toBe(true)
        })

        it('is false on a Mac and on Android', () => {
            setNavigator({
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
                platform: 'MacIntel',
                maxTouchPoints: 0,
            })
            expect(install.isIos()).toBe(false)

            setNavigator({
                userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36',
                platform: 'Linux armv81',
                maxTouchPoints: 5,
            })
            expect(install.isIos()).toBe(false)
        })
    })
})
