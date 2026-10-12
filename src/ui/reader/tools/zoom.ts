/**
 * The zoom and pan math of the image viewer. Pure functions with no DOM access.
 *
 * The image is in the centre of the stage. Its transform is `translate(x, y) scale(scale)`
 * with the origin in the centre of the image, so `x` and `y` are the distance between the
 * centre of the image and the centre of the stage. A point is also relative to the centre of
 * the stage.
 */

export const ZOOM_MIN = 1
export const ZOOM_MAX = 6
/** The zoom of a double click or a double tap. */
export const ZOOM_STEP_IN = 2.5

/** Wheel distance to zoom factor. A pinch on a trackpad is a wheel event with the Control key. */
const WHEEL_RATE = 0.002
const PINCH_WHEEL_RATE = 0.01
/** Pixels for one line or one page of a wheel event that does not give pixels. */
const WHEEL_LINE = 16
const WHEEL_PAGE = 400

/** Two taps are a double tap when they are this near in time and in place. */
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_DISTANCE = 30

export interface Point {
    x: number
    y: number
}

export interface Size {
    width: number
    height: number
}

export interface ZoomState {
    scale: number
    x: number
    y: number
}

/** The sizes that limit the pan. */
export interface ZoomBounds {
    /** The size of the image on screen at a zoom of 1. */
    image: Size
    stage: Size
}

/** The two fingers of a pinch: the point between them and the distance between them. */
export interface PinchPoints {
    center: Point
    distance: number
}

export const ZOOM_RESET: ZoomState = { scale: 1, x: 0, y: 0 }

export function clampScale(scale: number): number {
    if (!Number.isFinite(scale)) return ZOOM_MIN
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

/**
 * The largest pan on each axis. An image that is larger than the stage can move until its
 * edge is at the edge of the stage. An image that fits stays in the centre. The image thus
 * never leaves the screen.
 */
export function panLimit({ scale, bounds }: { scale: number; bounds: ZoomBounds }): Point {
    const { image, stage } = bounds
    return {
        x: Math.max(0, (image.width * scale - stage.width) / 2),
        y: Math.max(0, (image.height * scale - stage.height) / 2),
    }
}

/** The state with its zoom and its pan inside the limits. */
export function clampZoom(state: ZoomState, bounds: ZoomBounds): ZoomState {
    const scale = clampScale(state.scale)
    const limit = panLimit({ scale, bounds })
    return {
        scale,
        // The sum with 0 makes -0 a plain 0.
        x: Math.min(limit.x, Math.max(-limit.x, state.x)) + 0,
        y: Math.min(limit.y, Math.max(-limit.y, state.y)) + 0,
    }
}

export interface ZoomAtOptions {
    state: ZoomState
    /** The new zoom. It is put between the limits. */
    scale: number
    /** The point of the stage that keeps its part of the image. */
    point: Point
    bounds: ZoomBounds
}

/** Changes the zoom. The part of the image at `point` stays there, as far as the pan limits allow. */
export function zoomAt({ state, scale, point, bounds }: ZoomAtOptions): ZoomState {
    const next = clampScale(scale)
    const ratio = next / state.scale
    return clampZoom(
        {
            scale: next,
            x: point.x - (point.x - state.x) * ratio,
            y: point.y - (point.y - state.y) * ratio,
        },
        bounds,
    )
}

export interface PanOptions {
    state: ZoomState
    dx: number
    dy: number
    bounds: ZoomBounds
}

export function panBy({ state, dx, dy, bounds }: PanOptions): ZoomState {
    return clampZoom({ scale: state.scale, x: state.x + dx, y: state.y + dy }, bounds)
}

export interface PinchOptions {
    state: ZoomState
    /** The fingers at the last step, and now. */
    from: PinchPoints
    to: PinchPoints
    bounds: ZoomBounds
}

/**
 * One step of a pinch with two fingers. The zoom follows the distance between the fingers,
 * and the part of the image between them follows the point between them.
 */
export function pinch({ state, from, to, bounds }: PinchOptions): ZoomState {
    const factor = from.distance > 0 ? to.distance / from.distance : 1
    const next = clampScale(state.scale * factor)
    const ratio = next / state.scale
    return clampZoom(
        {
            scale: next,
            x: to.center.x - (from.center.x - state.x) * ratio,
            y: to.center.y - (from.center.y - state.y) * ratio,
        },
        bounds,
    )
}

export interface WheelOptions {
    state: ZoomState
    /** `deltaY` of the wheel event. A positive value zooms out. */
    deltaY: number
    /** `deltaMode` of the wheel event: 0 for pixels, 1 for lines, 2 for pages. */
    deltaMode?: number
    /** True for a pinch on a trackpad (the Control key of the wheel event). */
    pinch?: boolean
    point: Point
    bounds: ZoomBounds
}

export function wheelZoom(options: WheelOptions): ZoomState {
    const { state, deltaY, deltaMode = 0, point, bounds } = options
    const unit = deltaMode === 1 ? WHEEL_LINE : deltaMode === 2 ? WHEEL_PAGE : 1
    const rate = options.pinch ? PINCH_WHEEL_RATE : WHEEL_RATE
    const factor = Math.exp(-deltaY * unit * rate)
    return zoomAt({ state, scale: state.scale * factor, point, bounds })
}

export interface ToggleOptions {
    state: ZoomState
    point: Point
    bounds: ZoomBounds
}

/** A double click: zoom in at the point, or back to the full image when it is zoomed in. */
export function toggleZoom({ state, point, bounds }: ToggleOptions): ZoomState {
    if (state.scale > ZOOM_MIN) return { ...ZOOM_RESET }
    return zoomAt({ state, scale: ZOOM_STEP_IN, point, bounds })
}

export interface Tap extends Point {
    time: number
}

export function isDoubleTap(first: Tap | null, second: Tap): boolean {
    return (
        first !== null &&
        second.time - first.time <= DOUBLE_TAP_MS &&
        Math.hypot(second.x - first.x, second.y - first.y) <= DOUBLE_TAP_DISTANCE
    )
}

/** The CSS transform of the image for a state. */
export function zoomTransform({ scale, x, y }: ZoomState): string {
    return `translate3d(${x}px, ${y}px, 0) scale(${scale})`
}
