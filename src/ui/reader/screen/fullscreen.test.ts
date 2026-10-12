import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFullscreen } from './fullscreen'
import type { FullscreenControl } from './fullscreen'

type Names =
    | 'requestFullscreen'
    | 'webkitRequestFullscreen'
    | 'exitFullscreen'
    | 'webkitExitFullscreen'
    | 'fullscreenElement'
    | 'webkitFullscreenElement'
    | 'fullscreenEnabled'
    | 'webkitFullscreenEnabled'

const added: Array<[object, string]> = []
const controls: FullscreenControl[] = []

/** jsdom has no Fullscreen API. A test adds the members of the browser that it needs. */
function define(target: object, name: Names, value: unknown): void {
    Object.defineProperty(target, name, { value, configurable: true, writable: true })
    added.push([target, name])
}

function setElement(
    name: 'fullscreenElement' | 'webkitFullscreenElement',
    element: Element | null,
) {
    define(document, name, element)
    const type = name === 'fullscreenElement' ? 'fullscreenchange' : 'webkitfullscreenchange'
    document.dispatchEvent(new Event(type))
}

/** The standard API. A request or an exit changes the state as a browser does. */
function installStandard() {
    const request = vi.fn(async () => setElement('fullscreenElement', document.documentElement))
    const exit = vi.fn(async () => setElement('fullscreenElement', null))
    define(document.documentElement, 'requestFullscreen', request)
    define(document, 'exitFullscreen', exit)
    define(document, 'fullscreenElement', null)
    define(document, 'fullscreenEnabled', true)
    return { request, exit }
}

function make(onChange: (active: boolean) => void = () => {}): FullscreenControl {
    const control = createFullscreen({ onChange })
    controls.push(control)
    return control
}

afterEach(() => {
    for (const control of controls.splice(0)) control.destroy()
    for (const [target, name] of added.splice(0)) Reflect.deleteProperty(target, name)
})

describe('createFullscreen', () => {
    it('is not supported in a browser with no Fullscreen API for elements', async () => {
        const fullscreen = make()
        expect(fullscreen.supported).toBe(false)
        expect(fullscreen.active).toBe(false)
        await expect(fullscreen.toggle()).resolves.toBeUndefined()
        await expect(fullscreen.leave()).resolves.toBeUndefined()
    })

    it('is not supported when the browser turns full screen off', () => {
        installStandard()
        define(document, 'fullscreenEnabled', false)
        expect(make().supported).toBe(false)
    })

    it('asks for full screen on the root element', async () => {
        const { request } = installStandard()
        const fullscreen = make()
        expect(fullscreen.supported).toBe(true)

        await fullscreen.toggle()
        expect(request).toHaveBeenCalledTimes(1)
        expect(request.mock.contexts[0]).toBe(document.documentElement)
        expect(fullscreen.active).toBe(true)
    })

    it('leaves full screen at the second toggle', async () => {
        const { request, exit } = installStandard()
        const fullscreen = make()
        await fullscreen.toggle()
        await fullscreen.toggle()
        expect(request).toHaveBeenCalledTimes(1)
        expect(exit).toHaveBeenCalledTimes(1)
        expect(exit.mock.contexts[0]).toBe(document)
        expect(fullscreen.active).toBe(false)
    })

    it('reads the state from the document, also after a change that the browser made', () => {
        installStandard()
        const onChange = vi.fn()
        const fullscreen = make(onChange)

        setElement('fullscreenElement', document.body)
        expect(fullscreen.active).toBe(true)
        expect(onChange).toHaveBeenLastCalledWith(true)

        // The user left full screen with the Escape key.
        setElement('fullscreenElement', null)
        expect(fullscreen.active).toBe(false)
        expect(onChange).toHaveBeenLastCalledWith(false)
    })

    it('rejects when the browser refuses the request', async () => {
        installStandard()
        define(
            document.documentElement,
            'requestFullscreen',
            vi.fn(async () => {
                throw new TypeError('Permissions check failed')
            }),
        )
        const fullscreen = make()
        await expect(fullscreen.toggle()).rejects.toThrow('Permissions check failed')
        expect(fullscreen.active).toBe(false)
    })

    it('uses the names with the webkit prefix when the standard names are not there', async () => {
        const request = vi.fn(() => setElement('webkitFullscreenElement', document.documentElement))
        const exit = vi.fn(() => setElement('webkitFullscreenElement', null))
        define(document.documentElement, 'webkitRequestFullscreen', request)
        define(document, 'webkitExitFullscreen', exit)
        define(document, 'webkitFullscreenEnabled', true)
        const onChange = vi.fn()
        const fullscreen = make(onChange)
        expect(fullscreen.supported).toBe(true)

        await fullscreen.toggle()
        expect(request).toHaveBeenCalledTimes(1)
        expect(fullscreen.active).toBe(true)
        expect(onChange).toHaveBeenLastCalledWith(true)

        await fullscreen.toggle()
        expect(exit).toHaveBeenCalledTimes(1)
        expect(fullscreen.active).toBe(false)
        expect(onChange).toHaveBeenLastCalledWith(false)
    })

    describe('leave', () => {
        it('leaves full screen that this object entered', async () => {
            const { exit } = installStandard()
            const fullscreen = make()
            await fullscreen.toggle()
            await fullscreen.leave()
            expect(exit).toHaveBeenCalledTimes(1)
            expect(fullscreen.active).toBe(false)
        })

        it('does not leave full screen that a different part entered', async () => {
            const { exit } = installStandard()
            const fullscreen = make()
            setElement('fullscreenElement', document.body)
            await fullscreen.leave()
            expect(exit).not.toHaveBeenCalled()
        })

        it('does nothing after the user left full screen', async () => {
            const { exit } = installStandard()
            const fullscreen = make()
            await fullscreen.toggle()
            setElement('fullscreenElement', null)
            // A different part enters full screen later.
            setElement('fullscreenElement', document.body)
            await fullscreen.leave()
            expect(exit).not.toHaveBeenCalled()
        })

        it('does not reject when the exit fails', async () => {
            installStandard()
            const exit = vi.fn(async () => {
                throw new TypeError('Not in fullscreen mode')
            })
            define(document, 'exitFullscreen', exit)
            const fullscreen = make()
            await fullscreen.toggle()
            await expect(fullscreen.leave()).resolves.toBeUndefined()
            expect(exit).toHaveBeenCalledTimes(1)
        })
    })

    it('stops the change events after destroy()', () => {
        installStandard()
        const onChange = vi.fn()
        const fullscreen = make(onChange)
        fullscreen.destroy()
        setElement('fullscreenElement', document.body)
        expect(onChange).not.toHaveBeenCalled()
    })
})
