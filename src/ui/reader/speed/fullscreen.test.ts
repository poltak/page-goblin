import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFullscreen } from './fullscreen'
import { flush } from './testing/fixtures'

type Stub = Record<string, unknown>

const added: [object, string][] = []
const root = document.documentElement

/** jsdom has no full screen. A test adds the members that it needs and they go away after it. */
function define(target: object, members: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(members)) {
        Object.defineProperty(target, name, { configurable: true, writable: true, value })
        added.push([target, name])
    }
}

/** The standard members. The full screen element changes with the two calls. */
function stubStandard() {
    const request = vi.fn(() => {
        define(document, { fullscreenElement: root })
        return Promise.resolve()
    })
    const exit = vi.fn(() => {
        define(document, { fullscreenElement: null })
        return Promise.resolve()
    })
    define(root, { requestFullscreen: request })
    define(document, { exitFullscreen: exit })
    return { request, exit }
}

afterEach(() => {
    for (const [target, name] of added.splice(0)) delete (target as Stub)[name]
})

describe('createFullscreen', () => {
    it('is not supported in a browser with no full screen for elements', () => {
        const control = createFullscreen({ onChange: vi.fn() })
        expect(control.supported).toBe(false)
        expect(control.active).toBe(false)
        // The calls do nothing and do not throw.
        control.toggle()
        control.leave()
        control.destroy()
    })

    it('is not supported when the document does not permit full screen', () => {
        stubStandard()
        define(document, { fullscreenEnabled: false })
        expect(createFullscreen({ onChange: vi.fn() }).supported).toBe(false)
    })

    it('enters and leaves full screen for the root element', () => {
        const { request, exit } = stubStandard()
        const onChange = vi.fn()
        const control = createFullscreen({ onChange })
        expect(control.supported).toBe(true)

        control.toggle()
        expect(request).toHaveBeenCalledTimes(1)
        expect(request.mock.contexts[0]).toBe(root)
        document.dispatchEvent(new Event('fullscreenchange'))
        expect(onChange).toHaveBeenLastCalledWith(true)
        expect(control.active).toBe(true)

        control.toggle()
        expect(exit).toHaveBeenCalledTimes(1)
        expect(exit.mock.contexts[0]).toBe(document)
        document.dispatchEvent(new Event('fullscreenchange'))
        expect(onChange).toHaveBeenLastCalledWith(false)
        expect(control.active).toBe(false)
    })

    it('uses the prefixed names of older Safari', () => {
        const onChange = vi.fn()
        const request = vi.fn(() => define(document, { webkitFullscreenElement: root }))
        const exit = vi.fn(() => define(document, { webkitFullscreenElement: null }))
        define(root, { webkitRequestFullscreen: request })
        define(document, { webkitExitFullscreen: exit })

        const control = createFullscreen({ onChange })
        expect(control.supported).toBe(true)
        control.toggle()
        expect(request).toHaveBeenCalledTimes(1)
        document.dispatchEvent(new Event('webkitfullscreenchange'))
        expect(onChange).toHaveBeenLastCalledWith(true)

        control.leave()
        expect(exit).toHaveBeenCalledTimes(1)
    })

    it('leaves the full screen of a different part only on a toggle', () => {
        const { exit } = stubStandard()
        define(document, { fullscreenElement: root })
        const control = createFullscreen({ onChange: vi.fn() })
        expect(control.active).toBe(true)

        control.leave()
        expect(exit).not.toHaveBeenCalled()
        control.toggle()
        expect(exit).toHaveBeenCalledTimes(1)
    })

    it('leaves the full screen that it entered, one time', () => {
        const { exit } = stubStandard()
        const control = createFullscreen({ onChange: vi.fn() })
        control.toggle()
        control.leave()
        control.leave()
        expect(exit).toHaveBeenCalledTimes(1)
    })

    it('does not leave after the browser left full screen and a different part entered it', () => {
        const { exit } = stubStandard()
        const control = createFullscreen({ onChange: vi.fn() })
        control.toggle()
        // The user pushed Escape.
        define(document, { fullscreenElement: null })
        document.dispatchEvent(new Event('fullscreenchange'))
        // The reader screen entered full screen again.
        define(document, { fullscreenElement: root })
        document.dispatchEvent(new Event('fullscreenchange'))

        control.leave()
        expect(exit).not.toHaveBeenCalled()
    })

    it('keeps its state when the browser refuses the request', async () => {
        const { exit } = stubStandard()
        define(root, { requestFullscreen: vi.fn(() => Promise.reject(new Error('refused'))) })
        const control = createFullscreen({ onChange: vi.fn() })
        control.toggle()
        // A rejection with no handler would fail the test run.
        await flush()
        expect(control.active).toBe(false)

        // A different part enters full screen later. This object did not, so it does not leave.
        define(document, { fullscreenElement: root })
        control.leave()
        expect(exit).not.toHaveBeenCalled()
    })

    it('sends no change after destroy', () => {
        stubStandard()
        const onChange = vi.fn()
        const control = createFullscreen({ onChange })
        control.destroy()
        document.dispatchEvent(new Event('fullscreenchange'))
        expect(onChange).not.toHaveBeenCalled()
    })
})
