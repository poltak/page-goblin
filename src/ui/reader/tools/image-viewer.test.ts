import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installOverlayMethods } from '../../app/testing/page'
import { clearToasts } from '../../app/toast'
import type { Part } from '../parts'
import { createImageViewer } from './image-viewer'
import {
    createFakeSession,
    makeRelocate,
    pointer,
    rect,
    trackListeners,
} from './testing/fake-session'
import type { FakeSession } from './testing/fake-session'
import { ZOOM_RESET, wheelZoom, zoomTransform } from './zoom'
import type { ZoomBounds } from './zoom'

const SRC = 'blob:https://reader.example/7f1c'
const AT_REST = zoomTransform(ZOOM_RESET)

/** The stage is 800 by 600 px at the top left of the screen, and the image fills it. */
const bounds: ZoomBounds = {
    image: { width: 800, height: 600 },
    stage: { width: 800, height: 600 },
}

let host: HTMLElement
let fake: FakeSession
let viewer: Part

const dialog = () => host.querySelector<HTMLDialogElement>('dialog.img-viewer')!
const stage = () => dialog().querySelector<HTMLElement>('.img-viewer-stage')!
const image = () => dialog().querySelector<HTMLImageElement>('.img-viewer-image')!
const closeButton = () => dialog().querySelector<HTMLButtonElement>('.img-viewer-close')!
const transform = () => image().style.transform

function mount(): void {
    fake = createFakeSession()
    viewer = createImageViewer({ session: fake.session, host })
}

/** Opens the viewer and gives the stage and the image a size, as the load event does. */
function open(alt = 'A map of the sea'): void {
    fake.emit('image-tap', { src: SRC, alt })
    stage().getBoundingClientRect = () => rect({ left: 0, top: 0, width: 800, height: 600 })
    Object.defineProperty(image(), 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(image(), 'offsetHeight', { configurable: true, value: 600 })
    image().dispatchEvent(new Event('load'))
    // After this time a tap on the background closes the viewer.
    vi.advanceTimersByTime(1000)
}

let time = 5000

/** A short press with no move. `x` and `y` are viewport coordinates. */
function tap(target: Element, { x, y }: { x: number; y: number }): void {
    target.dispatchEvent(pointer('pointerdown', { clientX: x, clientY: y, timeStamp: time }))
    time += 60
    target.dispatchEvent(pointer('pointerup', { clientX: x, clientY: y, timeStamp: time }))
    time += 60
}

function wheel(init: WheelEventInit): WheelEvent {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    image().dispatchEvent(event)
    return event
}

function key(name: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    closeButton().dispatchEvent(event)
    return event
}

beforeEach(() => {
    vi.useFakeTimers()
    installOverlayMethods()
    time = 5000
    document.body.innerHTML = '<div id="toasts"></div><div id="host"></div>'
    host = document.getElementById('host')!
    mount()
})

afterEach(() => {
    viewer.destroy()
    clearToasts()
    vi.useRealTimers()
})

describe('the image viewer', () => {
    it('opens a dialog with the image and its alt text as the label', () => {
        expect(dialog().open).toBe(false)

        open('A map of the sea')

        expect(dialog().open).toBe(true)
        expect(image().getAttribute('src')).toBe(SRC)
        expect(image().alt).toBe('A map of the sea')
        expect(dialog().getAttribute('aria-label')).toBe('A map of the sea')
        expect(closeButton().getAttribute('aria-label')).toBe('Close')
    })

    it('has a general label for an image with no alt text', () => {
        open('  ')

        expect(dialog().getAttribute('aria-label')).toBe('Image')
        expect(image().alt).toBe('')
    })

    it('does not read the alt text as HTML', () => {
        open('<img src=x onerror=alert(1)>')

        expect(dialog().querySelectorAll('img')).toHaveLength(1)
        expect(dialog().getAttribute('aria-label')).toBe('<img src=x onerror=alert(1)>')
    })

    it('opens a data URL of an image', () => {
        fake.emit('image-tap', { src: 'data:image/svg+xml,%3Csvg/%3E', alt: '' })

        expect(dialog().open).toBe(true)
    })

    it('does not load an address that is not a file of the book', () => {
        fake.emit('image-tap', { src: 'https://tracker.example/pixel.gif', alt: '' })
        fake.emit('image-tap', { src: 'data:text/html,<p>x</p>', alt: '' })

        expect(dialog().open).toBe(false)
        expect(image().hasAttribute('src')).toBe(false)
    })

    it('starts each time with a zoom of 1', () => {
        open()
        wheel({ deltaY: -300, clientX: 400, clientY: 300 })
        expect(transform()).not.toBe(AT_REST)

        closeButton().click()
        expect(dialog().open).toBe(false)
        open()

        expect(transform()).toBe(AT_REST)
        expect(dialog().classList.contains('is-zoomed')).toBe(false)
    })

    it('closes with the close button', () => {
        open()

        closeButton().click()

        expect(dialog().open).toBe(false)
    })

    it('does not close for the click of the tap that opened it', () => {
        fake.emit('image-tap', { src: SRC, alt: '' })
        const click = () =>
            closeButton().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))

        // On a touch screen the click of the tap comes after the viewer opened below the finger.
        click()
        expect(dialog().open).toBe(true)

        // A press on the button is a new tap.
        closeButton().dispatchEvent(pointer('pointerdown'))
        closeButton().dispatchEvent(pointer('pointerup'))
        click()
        expect(dialog().open).toBe(false)
    })

    it('closes for a click with no press before it after a moment', () => {
        fake.emit('image-tap', { src: SRC, alt: '' })
        vi.advanceTimersByTime(1000)

        closeButton().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))

        expect(dialog().open).toBe(false)
    })

    it('closes and shows a toast when the image does not load', () => {
        open()

        image().dispatchEvent(new Event('error'))

        expect(dialog().open).toBe(false)
        expect(document.querySelector('#toasts .toast span')?.textContent).toBe(
            'The image could not be shown.',
        )
    })

    it('closes when the page turns, because the image address can stop then', () => {
        open()

        fake.emit('relocate', makeRelocate(900))

        expect(dialog().open).toBe(false)
    })

    it('stays open for a relocate event with the same position', () => {
        fake.emit('relocate', makeRelocate(900))
        open()

        fake.emit('relocate', makeRelocate(900))

        expect(dialog().open).toBe(true)
    })
})

describe('zoom and pan', () => {
    it('zooms at the pointer with the wheel and stops the page scroll', () => {
        open()

        const event = wheel({ deltaY: -100, clientX: 600, clientY: 400 })

        expect(event.defaultPrevented).toBe(true)
        expect(transform()).toBe(
            zoomTransform(
                wheelZoom({ state: ZOOM_RESET, deltaY: -100, point: { x: 200, y: 100 }, bounds }),
            ),
        )
        expect(dialog().classList.contains('is-zoomed')).toBe(true)
    })

    it('zooms faster for a pinch on a trackpad', () => {
        open()

        wheel({ deltaY: -10, ctrlKey: true, clientX: 400, clientY: 300 })

        expect(transform()).toBe(`translate3d(0px, 0px, 0) scale(${Math.exp(0.1)})`)
    })

    it('does not zoom out below 1', () => {
        open()

        wheel({ deltaY: 400, clientX: 100, clientY: 100 })

        expect(transform()).toBe(AT_REST)
    })

    it('zooms to 2.5 at the point of a double tap, and back with the next one', () => {
        open()

        // 100 px to the right of the centre of the stage.
        tap(image(), { x: 500, y: 300 })
        expect(transform()).toBe(AT_REST)
        tap(image(), { x: 500, y: 300 })
        expect(transform()).toBe('translate3d(-150px, 0px, 0) scale(2.5)')
        expect(image().classList.contains('is-smooth')).toBe(true)

        time += 1000
        tap(image(), { x: 200, y: 200 })
        tap(image(), { x: 200, y: 200 })
        expect(transform()).toBe(AT_REST)
    })

    it('does not read two slow taps as a double tap', () => {
        open()

        tap(image(), { x: 500, y: 300 })
        time += 400
        tap(image(), { x: 500, y: 300 })

        expect(transform()).toBe(AT_REST)
    })

    it('zooms around the point between two fingers', () => {
        open()

        image().dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 }))
        image().dispatchEvent(
            pointer('pointerdown', { pointerId: 2, clientX: 500, clientY: 300, isPrimary: false }),
        )
        // The distance goes from 200 to 400 px, and the middle moves 100 px to the right.
        image().dispatchEvent(
            pointer('pointermove', { pointerId: 2, clientX: 700, clientY: 300, isPrimary: false }),
        )

        expect(transform()).toBe('translate3d(100px, 0px, 0) scale(2)')
        expect(image().classList.contains('is-smooth')).toBe(false)
    })

    it('goes on as a pan when one of two fingers lifts, and does not close', () => {
        open()
        image().dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 }))
        image().dispatchEvent(pointer('pointerdown', { pointerId: 2, clientX: 500, clientY: 300 }))
        image().dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 700, clientY: 300 }))

        image().dispatchEvent(pointer('pointerup', { pointerId: 2, clientX: 700, clientY: 300 }))
        image().dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 340, clientY: 280 }))
        image().dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 340, clientY: 280 }))

        expect(transform()).toBe('translate3d(140px, -20px, 0) scale(2)')
        expect(dialog().open).toBe(true)
    })

    it('pans with one pointer when zoomed in, up to the edge of the image', () => {
        open()
        key('+')
        key('+')
        expect(transform()).toBe('translate3d(0px, 0px, 0) scale(2.25)')

        image().dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 300 }))
        image().dispatchEvent(pointer('pointermove', { clientX: 450, clientY: 270 }))
        expect(transform()).toBe('translate3d(50px, -30px, 0) scale(2.25)')

        // The image is 1800 px wide now, so it can move 500 px to each side.
        image().dispatchEvent(pointer('pointermove', { clientX: 3000, clientY: -3000 }))
        expect(transform()).toBe('translate3d(500px, -375px, 0) scale(2.25)')
        image().dispatchEvent(pointer('pointerup', { clientX: 3000, clientY: -3000 }))
    })

    it('does not pan at a zoom of 1', () => {
        open()

        image().dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 300 }))
        image().dispatchEvent(pointer('pointermove', { clientX: 500, clientY: 400 }))
        image().dispatchEvent(pointer('pointerup', { clientX: 500, clientY: 400 }))

        expect(transform()).toBe(AT_REST)
        expect(dialog().open).toBe(true)
    })

    it('ignores the move of a pointer that is not down', () => {
        open()
        key('+')

        image().dispatchEvent(pointer('pointermove', { clientX: 900, clientY: 900 }))

        expect(transform()).toBe('translate3d(0px, 0px, 0) scale(1.5)')
    })

    it('zooms and pans with the keys, and keeps them from the page', () => {
        const onKey = vi.fn()
        document.addEventListener('keydown', onKey)
        open()

        expect(key('+').defaultPrevented).toBe(true)
        expect(transform()).toBe('translate3d(0px, 0px, 0) scale(1.5)')
        key('ArrowRight')
        expect(transform()).toBe('translate3d(-80px, 0px, 0) scale(1.5)')
        key('-')
        expect(transform()).toBe(AT_REST)
        key('+')
        key('0')
        expect(transform()).toBe(AT_REST)
        expect(key('a').defaultPrevented).toBe(false)

        document.removeEventListener('keydown', onKey)
        expect(onKey).not.toHaveBeenCalled()
    })

    it('reads the pinch of a trackpad in Safari', () => {
        open()
        const gesture = (type: string, scale: number): Event =>
            Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
                scale,
                clientX: 400,
                clientY: 300,
            })

        const start = gesture('gesturestart', 1)
        image().dispatchEvent(start)
        image().dispatchEvent(gesture('gesturechange', 1.5))
        image().dispatchEvent(gesture('gesturechange', 3))

        expect(start.defaultPrevented).toBe(true)
        expect(transform()).toBe('translate3d(0px, 0px, 0) scale(3)')
    })

    it('leaves the pinch to the pointer events while fingers are down', () => {
        open()
        image().dispatchEvent(pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 }))

        image().dispatchEvent(
            Object.assign(new Event('gesturechange', { bubbles: true, cancelable: true }), {
                scale: 3,
                clientX: 400,
                clientY: 300,
            }),
        )

        expect(transform()).toBe(AT_REST)
    })

    it('measures again after a resize and keeps the image on the screen', () => {
        open()
        key('+')
        key('+')
        image().dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 300 }))
        image().dispatchEvent(pointer('pointermove', { clientX: 900, clientY: 300 }))
        image().dispatchEvent(pointer('pointerup', { clientX: 900, clientY: 300 }))
        expect(transform()).toBe('translate3d(500px, 0px, 0) scale(2.25)')

        // The image is 400 px wide now: 900 px at this zoom, in a stage of 800 px.
        Object.defineProperty(image(), 'offsetWidth', { configurable: true, value: 400 })
        window.dispatchEvent(new Event('resize'))

        expect(transform()).toBe('translate3d(50px, 0px, 0) scale(2.25)')
    })
})

describe('a tap on the background', () => {
    it('closes the viewer at a zoom of 1', () => {
        open()

        tap(stage(), { x: 20, y: 20 })

        expect(dialog().open).toBe(false)
    })

    it('does not close for a tap on the image', () => {
        open()

        tap(image(), { x: 400, y: 300 })

        expect(dialog().open).toBe(true)
    })

    it('does not close when the image is zoomed in', () => {
        open()
        key('+')

        tap(stage(), { x: 20, y: 20 })

        expect(dialog().open).toBe(true)
    })

    it('does not close for a press that moved', () => {
        open()

        stage().dispatchEvent(pointer('pointerdown', { clientX: 20, clientY: 20 }))
        stage().dispatchEvent(pointer('pointermove', { clientX: 60, clientY: 20 }))
        stage().dispatchEvent(pointer('pointerup', { clientX: 60, clientY: 20 }))

        expect(dialog().open).toBe(true)
    })

    it('does not close for a long press or a cancelled press', () => {
        open()

        stage().dispatchEvent(pointer('pointerdown', { clientX: 20, clientY: 20, timeStamp: 100 }))
        stage().dispatchEvent(pointer('pointerup', { clientX: 20, clientY: 20, timeStamp: 900 }))
        stage().dispatchEvent(pointer('pointerdown', { clientX: 20, clientY: 20, timeStamp: 2000 }))
        stage().dispatchEvent(
            pointer('pointercancel', { clientX: 20, clientY: 20, timeStamp: 2050 }),
        )

        expect(dialog().open).toBe(true)
    })

    it('does not close in the first moment after the viewer opened', () => {
        fake.emit('image-tap', { src: SRC, alt: '' })

        // The second click of a double click on the image in the book.
        tap(stage(), { x: 20, y: 20 })
        expect(dialog().open).toBe(true)

        vi.advanceTimersByTime(1000)
        time += 1000
        tap(stage(), { x: 20, y: 20 })
        expect(dialog().open).toBe(false)
    })

    it('does not close for a press on the close button that slides away', () => {
        open()

        closeButton().dispatchEvent(pointer('pointerdown', { clientX: 780, clientY: 20 }))
        closeButton().dispatchEvent(pointer('pointerup', { clientX: 780, clientY: 20 }))

        expect(dialog().open).toBe(true)
    })
})

describe('destroy', () => {
    it('removes its dialog and its listeners', () => {
        viewer.destroy()
        const onDocument = trackListeners(document)
        const onWindow = trackListeners(window)
        try {
            mount()
            expect(onDocument.active()).toEqual([])
            expect(onWindow.active()).toEqual(['resize'])
            expect(fake.listenerCount()).toBe(2)
            open()

            viewer.destroy()

            expect(host.childElementCount).toBe(0)
            expect(onWindow.active()).toEqual([])
            expect(fake.listenerCount()).toBe(0)
        } finally {
            onDocument.restore()
            onWindow.restore()
        }

        // Events after the end do nothing.
        fake.emit('image-tap', { src: SRC, alt: '' })
        expect(host.childElementCount).toBe(0)
        viewer.destroy()
    })
})
