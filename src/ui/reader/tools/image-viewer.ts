/**
 * Shows an image of the book on the full screen, with zoom and pan.
 *
 * The zoom is a transform on the image only, so a gesture causes no layout. The sizes that
 * the zoom math needs are read when the image loads and after a resize, not during a gesture.
 */

import './image-viewer.css'
import { openDialog } from '../../app/dialog'
import { showToast } from '../../app/toast'
import { on, qs } from '../../dom'
import type { Part, PartOptions } from '../parts'
import { isGhostClick } from './ghost-click'
import { onPositionChange } from './position-change'
import { iconMarkup, templateOf } from './template'
import {
    ZOOM_MIN,
    ZOOM_RESET,
    clampZoom,
    isDoubleTap,
    panBy,
    pinch,
    toggleZoom,
    wheelZoom,
    zoomAt,
    zoomTransform,
} from './zoom'
import type { PinchPoints, Point, Tap, ZoomBounds, ZoomState } from './zoom'

/** A press that moves more than this, or lasts longer than this, is not a tap. */
const TAP_SLOP = 10
const TAP_MAX_MS = 500

/**
 * A tap on the background does not close the viewer in this time after it opened. The second
 * click of a double click on the image in the book comes in this time.
 */
const OPEN_GUARD_MS = 400

/** One press of the plus or minus key. */
const KEY_ZOOM_FACTOR = 1.5
/** One press of an arrow key, in pixels. */
const KEY_PAN = 80

/** The content module gives an object URL or a data URL. Nothing else is loaded. */
const LOCAL_IMAGE = /^(?:blob:|data:image\/)/i

const NO_BOUNDS: ZoomBounds = {
    image: { width: 0, height: 0 },
    stage: { width: 0, height: 0 },
}

/** The gesture event of Safari for a pinch on a trackpad. */
interface SafariGestureEvent extends UIEvent {
    scale: number
    clientX: number
    clientY: number
}

// The black theme gives the viewer a dark background and light controls on each theme.
const createViewer = templateOf<HTMLDialogElement>(`
<dialog class="img-viewer" data-theme="black" aria-label="Image" autofocus>
    <div class="img-viewer-stage">
        <img class="img-viewer-image" alt="" draggable="false" />
    </div>
    <button type="button" class="icon-btn img-viewer-close" aria-label="Close">
        ${iconMarkup('x')}
    </button>
</dialog>`)

export function createImageViewer({ session, host }: PartOptions): Part {
    const dialog = createViewer()
    const stage = qs('.img-viewer-stage', dialog)
    const image = qs<HTMLImageElement>('.img-viewer-image', dialog)
    const closeButton = qs<HTMLButtonElement>('.img-viewer-close', dialog)
    host.append(dialog)

    let state: ZoomState = ZOOM_RESET
    let bounds: ZoomBounds = NO_BOUNDS
    /** The centre of the stage in viewport coordinates. */
    let center: Point = { x: 0, y: 0 }
    /** The pointers that are down, as points relative to the centre of the stage. */
    const pointers = new Map<number, Point>()
    /** The two fingers at the last step of a pinch. */
    let fingers: PinchPoints | null = null
    /** The press that can still be a tap. */
    let press: { id: number; start: Point; time: number; onImage: boolean } | null = null
    let lastTap: Tap | null = null
    /** The zoom at the start of a trackpad pinch in Safari. */
    let gestureScale = 1
    let openedAt = 0
    /** True when a press started in the viewer after it opened. */
    let pressedInside = false
    let destroyed = false

    function apply(next: ZoomState, { smooth = false } = {}): void {
        state = next
        image.classList.toggle('is-smooth', smooth)
        image.style.transform = zoomTransform(next)
        dialog.classList.toggle('is-zoomed', next.scale > ZOOM_MIN)
    }

    /** One layout read. The size of the image box does not change with its transform. */
    function measure(): void {
        const box = stage.getBoundingClientRect()
        center = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        bounds = {
            image: { width: image.offsetWidth, height: image.offsetHeight },
            stage: { width: box.width, height: box.height },
        }
        apply(clampZoom(state, bounds))
    }

    function pointOf(event: { clientX: number; clientY: number }): Point {
        return { x: event.clientX - center.x, y: event.clientY - center.y }
    }

    function fingersNow(): PinchPoints | null {
        if (pointers.size < 2) return null
        const [a, b] = [...pointers.values()]
        return {
            center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            distance: Math.hypot(a.x - b.x, a.y - b.y),
        }
    }

    function resetGesture(): void {
        pointers.clear()
        fingers = null
        press = null
        lastTap = null
    }

    function close(): void {
        if (dialog.open) dialog.close()
    }

    function open({ src, alt }: { src: string; alt: string }): void {
        if (!LOCAL_IMAGE.test(src)) return
        close()
        resetGesture()
        apply(ZOOM_RESET)
        const label = alt.trim()
        image.alt = label
        dialog.setAttribute('aria-label', label || 'Image')
        image.src = src
        openedAt = Date.now()
        pressedInside = false
        openDialog(dialog)
        // An image that the browser has in memory has its size now. For each other image
        // the load event measures.
        measure()
    }

    function onDown(event: PointerEvent): void {
        pressedInside = true
        const target = event.target as Element
        if (target.closest('button')) return
        if (event.pointerType === 'mouse' && event.button !== 0) return
        // The gesture continues when the pointer leaves the window.
        try {
            dialog.setPointerCapture?.(event.pointerId)
        } catch {
            // The pointer is not active any more.
        }
        const point = pointOf(event)
        pointers.set(event.pointerId, point)
        if (pointers.size === 1) {
            press = {
                id: event.pointerId,
                start: point,
                time: event.timeStamp,
                onImage: target === image,
            }
        } else {
            press = null
            fingers = fingersNow()
        }
    }

    function onMove(event: PointerEvent): void {
        const last = pointers.get(event.pointerId)
        if (!last) return
        const point = pointOf(event)
        pointers.set(event.pointerId, point)

        if (pointers.size >= 2) {
            const now = fingersNow()
            if (fingers && now) apply(pinch({ state, from: fingers, to: now, bounds }))
            fingers = now
            return
        }
        if (press && Math.hypot(point.x - press.start.x, point.y - press.start.y) > TAP_SLOP) {
            press = null
        }
        if (state.scale > ZOOM_MIN) {
            apply(panBy({ state, dx: point.x - last.x, dy: point.y - last.y, bounds }))
        }
    }

    function onUp(event: PointerEvent): void {
        if (!pointers.delete(event.pointerId)) return
        fingers = fingersNow()
        const start = press
        press = null
        if (!start || start.id !== event.pointerId || event.type !== 'pointerup') return
        if (event.timeStamp - start.time > TAP_MAX_MS) return

        const tap: Tap = { ...pointOf(event), time: event.timeStamp }
        if (isDoubleTap(lastTap, tap)) {
            lastTap = null
            apply(toggleZoom({ state, point: tap, bounds }), { smooth: true })
            return
        }
        lastTap = tap
        const guarded = Date.now() - openedAt < OPEN_GUARD_MS
        if (!start.onImage && state.scale === ZOOM_MIN && !guarded) close()
    }

    function onWheel(event: WheelEvent): void {
        // The wheel must not scroll or zoom the page behind the viewer.
        event.preventDefault()
        apply(
            wheelZoom({
                state,
                deltaY: event.deltaY,
                deltaMode: event.deltaMode,
                pinch: event.ctrlKey,
                point: pointOf(event),
                bounds,
            }),
        )
    }

    function onKeydown(event: KeyboardEvent): void {
        // A key in the viewer must not also turn the page behind it.
        event.stopPropagation()
        const origin = { x: 0, y: 0 }
        const zoomTo = (scale: number): ZoomState => zoomAt({ state, scale, point: origin, bounds })
        const pan = (dx: number, dy: number): ZoomState => panBy({ state, dx, dy, bounds })
        let next: ZoomState
        switch (event.key) {
            case '+':
            case '=':
                next = zoomTo(state.scale * KEY_ZOOM_FACTOR)
                break
            case '-':
                next = zoomTo(state.scale / KEY_ZOOM_FACTOR)
                break
            case '0':
                next = ZOOM_RESET
                break
            case 'ArrowLeft':
                next = pan(KEY_PAN, 0)
                break
            case 'ArrowRight':
                next = pan(-KEY_PAN, 0)
                break
            case 'ArrowUp':
                next = pan(0, KEY_PAN)
                break
            case 'ArrowDown':
                next = pan(0, -KEY_PAN)
                break
            default:
                return
        }
        event.preventDefault()
        apply(next, { smooth: true })
    }

    // Safari on macOS sends a pinch on a trackpad as gesture events and zooms the page. On
    // iOS these events come together with the pointer events of the two fingers, which do
    // the zoom there.
    function onGesture(event: SafariGestureEvent): void {
        event.preventDefault()
        if (pointers.size > 0) return
        if (event.type === 'gesturestart') {
            gestureScale = state.scale
        } else if (Number.isFinite(event.scale)) {
            apply(
                zoomAt({ state, scale: gestureScale * event.scale, point: pointOf(event), bounds }),
            )
        }
    }

    const stops = [
        session.on('image-tap', open),
        // The image can be an object URL that stops when its chapter leaves the screen.
        onPositionChange(session, close),

        on(dialog, 'pointerdown', onDown),
        on(dialog, 'pointermove', onMove),
        on(dialog, 'pointerup', onUp),
        on(dialog, 'pointercancel', onUp),
        on(dialog, 'wheel', onWheel, { passive: false }),
        on(dialog, 'keydown', onKeydown),
        on<SafariGestureEvent>(dialog, 'gesturestart', onGesture),
        on<SafariGestureEvent>(dialog, 'gesturechange', onGesture),
        on(dialog, 'dragstart', (event) => event.preventDefault()),
        on(dialog, 'close', resetGesture),
        on(closeButton, 'click', (event) => {
            // The tap on the image in the book opened the viewer. Its click must not close it.
            if (!isGhostClick(event, { openedAt, pressedInside })) close()
        }),
        on(image, 'load', () => {
            if (dialog.open) measure()
        }),
        on(image, 'error', () => {
            if (!dialog.open) return
            close()
            showToast({ message: 'The image could not be shown.', tone: 'error' })
        }),
        on(window, 'resize', () => {
            if (dialog.open) measure()
        }),
    ]

    return {
        destroy() {
            if (destroyed) return
            destroyed = true
            for (const stop of stops) stop()
            close()
            image.removeAttribute('src')
            dialog.remove()
        },
    }
}
