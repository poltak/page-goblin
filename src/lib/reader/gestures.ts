/**
 * The decisions for pointer and wheel input. These functions use no DOM, so the tests need
 * no view.
 */

export const TAP_MAX_DISTANCE = 10
export const TAP_MAX_MS = 500
export const DRAG_START_DISTANCE = 8
export const SWIPE_MIN_FRACTION = 0.2
export const SWIPE_MIN_SPEED = 0.4
export const EDGE_RESISTANCE = 0.3
export const TAP_ZONE_FRACTION = 0.28
export const WHEEL_THRESHOLD = 50
export const WHEEL_QUIET_MS = 80
export const WHEEL_LOCK_MS = 250

export type TapZone = 'prev' | 'center' | 'next'

/** 1 is one page forward, -1 is one page back. */
export type TurnDirection = 1 | -1

export interface Press {
    /** Movement from the press point in pixels. */
    dx: number
    dy: number
    /** Time from the press to the release in milliseconds. */
    elapsed: number
}

/** A long press or a press that moved is not a tap. */
export function isTap({ dx, dy, elapsed }: Press): boolean {
    return Math.hypot(dx, dy) < TAP_MAX_DISTANCE && elapsed >= 0 && elapsed < TAP_MAX_MS
}

export function tapZone({ x, left, width }: { x: number; left: number; width: number }): TapZone {
    if (!(width > 0)) return 'center'
    const position = (x - left) / width
    if (position < TAP_ZONE_FRACTION) return 'prev'
    if (position > 1 - TAP_ZONE_FRACTION) return 'next'
    return 'center'
}

export type DragAxis = 'undecided' | 'horizontal' | 'vertical'

/** The axis lock of a touch movement. The first axis that passes the limit wins. */
export function dragAxis({ dx, dy }: { dx: number; dy: number }): DragAxis {
    const x = Math.abs(dx)
    const y = Math.abs(dy)
    if (x <= DRAG_START_DISTANCE && y <= DRAG_START_DISTANCE) return 'undecided'
    return x > y ? 'horizontal' : 'vertical'
}

/** How far the page moves for a finger movement. A page with no neighbour moves less. */
export function dragOffset({
    dx,
    blocked,
    width,
}: {
    dx: number
    blocked: boolean
    width: number
}): number {
    const limited = Math.max(-width, Math.min(dx, width))
    return blocked ? limited * EDGE_RESISTANCE : limited
}

export interface SwipeRelease {
    /** Finger movement from the start of the drag. Negative is to the left. */
    dx: number
    /** Speed at the release in pixels for each millisecond, with the sign of the direction. */
    velocity: number
    /** Width of one page. */
    width: number
}

/** The page turn for the end of a drag, or null when the page must return. */
export function swipeDecision({ dx, velocity, width }: SwipeRelease): TurnDirection | null {
    if (!dx || !(width > 0)) return null
    const direction: TurnDirection = dx < 0 ? 1 : -1
    if (Math.abs(dx) > width * SWIPE_MIN_FRACTION) return direction
    // A fast flick counts only when it goes the same way as the drag.
    const speed = dx < 0 ? -velocity : velocity
    return speed > SWIPE_MIN_SPEED ? direction : null
}

/** Time of the motion after a release, in proportion to the distance that is left. */
export function settleDuration({ distance, width }: { distance: number; width: number }): number {
    if (!(width > 0)) return 120
    const fraction = Math.min(1, Math.abs(distance) / width)
    return Math.round(120 + 180 * fraction)
}

export interface WheelSample {
    deltaX: number
    deltaY: number
    /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
    deltaMode?: number
    /** Time of the event in milliseconds. */
    time: number
}

export interface WheelAccumulator {
    /** Add one wheel event. The result is the page turn to do now, or 0. */
    push(sample: WheelSample): TurnDirection | 0
    reset(): void
}

/**
 * Turn wheel events into page turns. A trackpad sends many events for one gesture and more
 * events while the content glides. One gesture must turn one page.
 */
export function createWheelAccumulator(): WheelAccumulator {
    let sum = 0
    let lastEvent = -Infinity
    let lastTurn = -Infinity
    let locked = false

    function push({ deltaX, deltaY, deltaMode = 0, time }: WheelSample): TurnDirection | 0 {
        const quiet = time - lastEvent
        lastEvent = time

        if (locked) {
            if (quiet < WHEEL_QUIET_MS || time - lastTurn < WHEEL_LOCK_MS) return 0
            locked = false
            sum = 0
        } else if (quiet > 400) {
            // An old part of a gesture does not count for a new one.
            sum = 0
        }

        const scale = deltaMode === 1 ? 20 : deltaMode === 2 ? 100 : 1
        const delta = (Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY) * scale
        if (!delta) return 0
        if (sum && Math.sign(delta) !== Math.sign(sum)) sum = 0
        sum += delta
        if (Math.abs(sum) <= WHEEL_THRESHOLD) return 0

        const direction: TurnDirection = sum > 0 ? 1 : -1
        sum = 0
        locked = true
        lastTurn = time
        return direction
    }

    function reset(): void {
        sum = 0
        locked = false
        lastEvent = -Infinity
        lastTurn = -Infinity
    }

    return { push, reset }
}

export interface VelocityTracker {
    add(x: number, time: number): void
    /** Speed in pixels for each millisecond at `time`. 0 when the pointer stopped. */
    read(time: number): number
}

/** The speed of the last part of a drag. A release after a pause has no speed. */
export function createVelocityTracker(): VelocityTracker {
    let lastX = 0
    let lastTime = -Infinity
    let velocity = 0

    return {
        add(x, time) {
            const elapsed = time - lastTime
            if (elapsed > 0 && elapsed < 100) {
                const instant = (x - lastX) / elapsed
                velocity = velocity * 0.3 + instant * 0.7
            } else if (elapsed >= 100) {
                velocity = 0
            }
            lastX = x
            lastTime = time
        },
        read(time) {
            return time - lastTime > 100 ? 0 : velocity
        },
    }
}
