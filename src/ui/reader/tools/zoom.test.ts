import { describe, expect, it } from 'vitest'
import {
    ZOOM_MAX,
    ZOOM_RESET,
    ZOOM_STEP_IN,
    clampScale,
    clampZoom,
    isDoubleTap,
    panBy,
    panLimit,
    pinch,
    toggleZoom,
    wheelZoom,
    zoomAt,
    zoomTransform,
} from './zoom'
import type { Point, ZoomBounds, ZoomState } from './zoom'

/** An image that fills the stage at a zoom of 1. */
const bounds: ZoomBounds = {
    image: { width: 800, height: 600 },
    stage: { width: 800, height: 600 },
}

/** The point of the image (in image pixels from its centre) that is at a point of the stage. */
function imagePointAt(state: ZoomState, point: Point): Point {
    return { x: (point.x - state.x) / state.scale, y: (point.y - state.y) / state.scale }
}

function expectPoint(actual: Point, expected: Point): void {
    expect(actual.x).toBeCloseTo(expected.x, 6)
    expect(actual.y).toBeCloseTo(expected.y, 6)
}

describe('clampScale', () => {
    it('keeps the zoom between 1 and 6', () => {
        expect(clampScale(0.2)).toBe(1)
        expect(clampScale(3)).toBe(3)
        expect(clampScale(40)).toBe(6)
        expect(ZOOM_MAX).toBe(6)
    })

    it('gives 1 for a value that is not a number', () => {
        expect(clampScale(Number.NaN)).toBe(1)
        expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1)
    })
})

describe('the pan limits', () => {
    it('is 0 when the image fits in the stage', () => {
        expect(panLimit({ scale: 1, bounds })).toEqual({ x: 0, y: 0 })
    })

    it('lets the edge of the image go to the edge of the stage', () => {
        expect(panLimit({ scale: 2, bounds })).toEqual({ x: 400, y: 300 })
    })

    it('has a limit for each axis', () => {
        const wide: ZoomBounds = {
            image: { width: 800, height: 200 },
            stage: { width: 800, height: 600 },
        }

        // At a zoom of 2 the image is 400 px high, which is less than the stage.
        expect(panLimit({ scale: 2, bounds: wide })).toEqual({ x: 400, y: 0 })
    })

    it('keeps a pan inside the limits, so the image cannot leave the screen', () => {
        const state = { scale: 2, x: 0, y: 0 }

        expect(panBy({ state, dx: 100, dy: -50, bounds })).toEqual({ scale: 2, x: 100, y: -50 })
        expect(panBy({ state, dx: 5000, dy: 5000, bounds })).toEqual({ scale: 2, x: 400, y: 300 })
        expect(panBy({ state, dx: -5000, dy: -5000, bounds })).toEqual({
            scale: 2,
            x: -400,
            y: -300,
        })
    })

    it('does not pan at a zoom of 1', () => {
        expect(panBy({ state: ZOOM_RESET, dx: 80, dy: 80, bounds })).toEqual(ZOOM_RESET)
    })

    it('puts the image back in the centre when the sizes are not known', () => {
        const unknown: ZoomBounds = {
            image: { width: 0, height: 0 },
            stage: { width: 0, height: 0 },
        }

        expect(clampZoom({ scale: 3, x: 50, y: -50 }, unknown)).toEqual({ scale: 3, x: 0, y: 0 })
    })
})

describe('zoomAt', () => {
    it('keeps the part of the image at the point in its place', () => {
        const point = { x: 120, y: -80 }
        const before = { scale: 1.5, x: 30, y: 10 }
        const after = zoomAt({ state: before, scale: 3, point, bounds })

        expect(after.scale).toBe(3)
        expectPoint(imagePointAt(after, point), imagePointAt(before, point))
    })

    it('zooms at the centre with no pan', () => {
        expect(zoomAt({ state: ZOOM_RESET, scale: 2, point: { x: 0, y: 0 }, bounds })).toEqual({
            scale: 2,
            x: 0,
            y: 0,
        })
    })

    it('stops at the largest zoom', () => {
        const after = zoomAt({ state: ZOOM_RESET, scale: 50, point: { x: 0, y: 0 }, bounds })

        expect(after.scale).toBe(6)
    })

    it('goes back to the centre at a zoom of 1', () => {
        const after = zoomAt({
            state: { scale: 3, x: 400, y: -200 },
            scale: 1,
            point: { x: 300, y: 200 },
            bounds,
        })

        expect(after).toEqual(ZOOM_RESET)
    })
})

describe('pinch', () => {
    it('zooms around the point between the fingers', () => {
        const center = { x: 100, y: 50 }
        const before = { scale: 1, x: 0, y: 0 }
        const after = pinch({
            state: before,
            from: { center, distance: 100 },
            to: { center, distance: 250 },
            bounds,
        })

        expect(after.scale).toBeCloseTo(2.5, 6)
        expectPoint(imagePointAt(after, center), imagePointAt(before, center))
    })

    it('moves the image with the fingers', () => {
        const before = { scale: 2, x: 0, y: 0 }
        const from = { center: { x: 0, y: 0 }, distance: 200 }
        const to = { center: { x: 60, y: -40 }, distance: 200 }
        const after = pinch({ state: before, from, to, bounds })

        expect(after).toEqual({ scale: 2, x: 60, y: -40 })
    })

    it('keeps the part of the image between the fingers there while they move and spread', () => {
        const before = { scale: 2, x: 20, y: -10 }
        const from = { center: { x: 50, y: 50 }, distance: 100 }
        const to = { center: { x: 80, y: 20 }, distance: 150 }
        const after = pinch({ state: before, from, to, bounds })

        expect(after.scale).toBeCloseTo(3, 6)
        expectPoint(imagePointAt(after, to.center), imagePointAt(before, from.center))
    })

    it('stays between 1 and 6', () => {
        const center = { x: 0, y: 0 }
        const smaller = pinch({
            state: { scale: 1.2, x: 0, y: 0 },
            from: { center, distance: 300 },
            to: { center, distance: 30 },
            bounds,
        })
        const larger = pinch({
            state: { scale: 4, x: 0, y: 0 },
            from: { center, distance: 30 },
            to: { center, distance: 300 },
            bounds,
        })

        expect(smaller.scale).toBe(1)
        expect(larger.scale).toBe(6)
    })

    it('ignores a start distance of 0', () => {
        const center = { x: 0, y: 0 }
        const state = { scale: 2, x: 0, y: 0 }

        expect(
            pinch({ state, from: { center, distance: 0 }, to: { center, distance: 90 }, bounds }),
        ).toEqual(state)
    })
})

describe('wheelZoom', () => {
    const point = { x: 200, y: 100 }

    it('zooms in for a wheel move up, at the pointer', () => {
        const after = wheelZoom({ state: ZOOM_RESET, deltaY: -100, point, bounds })

        expect(after.scale).toBeCloseTo(Math.exp(0.2), 6)
        expectPoint(imagePointAt(after, point), imagePointAt(ZOOM_RESET, point))
    })

    it('zooms out for a wheel move down', () => {
        const state = { scale: 3, x: 0, y: 0 }
        const after = wheelZoom({ state, deltaY: 100, point, bounds })

        expect(after.scale).toBeCloseTo(3 * Math.exp(-0.2), 6)
    })

    it('does not go below a zoom of 1', () => {
        expect(wheelZoom({ state: ZOOM_RESET, deltaY: 500, point, bounds })).toEqual(ZOOM_RESET)
    })

    it('reads a wheel that gives lines', () => {
        const lines = wheelZoom({ state: ZOOM_RESET, deltaY: -3, deltaMode: 1, point, bounds })
        const pixels = wheelZoom({ state: ZOOM_RESET, deltaY: -48, point, bounds })

        expect(lines.scale).toBeCloseTo(pixels.scale, 6)
    })

    it('is faster for a pinch on a trackpad', () => {
        const plain = wheelZoom({ state: ZOOM_RESET, deltaY: -10, point, bounds })
        const pinched = wheelZoom({ state: ZOOM_RESET, deltaY: -10, pinch: true, point, bounds })

        expect(pinched.scale).toBeGreaterThan(plain.scale)
        expect(pinched.scale).toBeCloseTo(Math.exp(0.1), 6)
    })
})

describe('toggleZoom', () => {
    it('zooms to 2.5 at the point', () => {
        const point = { x: -100, y: 60 }
        const after = toggleZoom({ state: ZOOM_RESET, point, bounds })

        expect(ZOOM_STEP_IN).toBe(2.5)
        expect(after.scale).toBe(2.5)
        expectPoint(imagePointAt(after, point), imagePointAt(ZOOM_RESET, point))
    })

    it('goes back to 1 from each zoom above 1', () => {
        expect(
            toggleZoom({ state: { scale: 2.5, x: 90, y: 0 }, point: { x: 0, y: 0 }, bounds }),
        ).toEqual(ZOOM_RESET)
        expect(
            toggleZoom({ state: { scale: 1.1, x: 0, y: 0 }, point: { x: 5, y: 5 }, bounds }),
        ).toEqual(ZOOM_RESET)
    })
})

describe('isDoubleTap', () => {
    const first = { x: 100, y: 100, time: 1000 }

    it('is true for two taps that are near in time and place', () => {
        expect(isDoubleTap(first, { x: 110, y: 95, time: 1250 })).toBe(true)
    })

    it('is false for a slow second tap', () => {
        expect(isDoubleTap(first, { x: 100, y: 100, time: 1301 })).toBe(false)
    })

    it('is false for a second tap in a different place', () => {
        expect(isDoubleTap(first, { x: 140, y: 100, time: 1100 })).toBe(false)
    })

    it('is false with no first tap', () => {
        expect(isDoubleTap(null, first)).toBe(false)
    })
})

describe('zoomTransform', () => {
    it('moves, then scales', () => {
        expect(zoomTransform({ scale: 2.5, x: 12, y: -8 })).toBe(
            'translate3d(12px, -8px, 0) scale(2.5)',
        )
    })
})
