import { describe, expect, it } from 'vitest'
import {
    createVelocityTracker,
    createWheelAccumulator,
    dragAxis,
    dragOffset,
    isTap,
    settleDuration,
    swipeDecision,
    tapZone,
} from './gestures'

describe('isTap', () => {
    it('accepts a short press that did not move', () => {
        expect(isTap({ dx: 0, dy: 0, elapsed: 80 })).toBe(true)
        expect(isTap({ dx: 6, dy: -6, elapsed: 499 })).toBe(true)
    })

    it('rejects a press that moved 10 pixels or more', () => {
        expect(isTap({ dx: 10, dy: 0, elapsed: 80 })).toBe(false)
        expect(isTap({ dx: 0, dy: -10, elapsed: 80 })).toBe(false)
        // 8 pixels on each axis is more than 10 pixels in total.
        expect(isTap({ dx: 8, dy: 8, elapsed: 80 })).toBe(false)
    })

    it('rejects a long press', () => {
        expect(isTap({ dx: 0, dy: 0, elapsed: 500 })).toBe(false)
        expect(isTap({ dx: 0, dy: 0, elapsed: 2000 })).toBe(false)
    })

    it('rejects a release with a time before the press', () => {
        expect(isTap({ dx: 0, dy: 0, elapsed: -1 })).toBe(false)
    })
})

describe('tapZone', () => {
    const view = { left: 100, width: 1000 }

    it('gives the left 28 percent to the previous page', () => {
        expect(tapZone({ x: 100, ...view })).toBe('prev')
        expect(tapZone({ x: 379, ...view })).toBe('prev')
    })

    it('gives the right 28 percent to the next page', () => {
        expect(tapZone({ x: 821, ...view })).toBe('next')
        expect(tapZone({ x: 1100, ...view })).toBe('next')
    })

    it('gives the centre to the app', () => {
        expect(tapZone({ x: 380, ...view })).toBe('center')
        expect(tapZone({ x: 600, ...view })).toBe('center')
        expect(tapZone({ x: 820, ...view })).toBe('center')
    })

    it('has no turn zone when the view has no width', () => {
        expect(tapZone({ x: 5, left: 0, width: 0 })).toBe('center')
    })
})

describe('dragAxis', () => {
    it('waits until the pointer moved more than 8 pixels', () => {
        expect(dragAxis({ dx: 8, dy: 0 })).toBe('undecided')
        expect(dragAxis({ dx: -8, dy: 8 })).toBe('undecided')
    })

    it('locks to the larger movement', () => {
        expect(dragAxis({ dx: 9, dy: 3 })).toBe('horizontal')
        expect(dragAxis({ dx: -20, dy: 12 })).toBe('horizontal')
        expect(dragAxis({ dx: 3, dy: -9 })).toBe('vertical')
        // The same distance on both axes is not a horizontal drag.
        expect(dragAxis({ dx: 12, dy: 12 })).toBe('vertical')
    })
})

describe('dragOffset', () => {
    it('follows the finger', () => {
        expect(dragOffset({ dx: -120, blocked: false, width: 400 })).toBe(-120)
        expect(dragOffset({ dx: 55, blocked: false, width: 400 })).toBe(55)
    })

    it('moves at 0.3 of the distance when there is no page on that side', () => {
        expect(dragOffset({ dx: -100, blocked: true, width: 400 })).toBeCloseTo(-30)
        expect(dragOffset({ dx: 200, blocked: true, width: 400 })).toBeCloseTo(60)
    })

    it('never moves more than one page', () => {
        expect(dragOffset({ dx: -900, blocked: false, width: 400 })).toBe(-400)
        expect(dragOffset({ dx: 900, blocked: false, width: 400 })).toBe(400)
    })
})

describe('swipeDecision', () => {
    const width = 400

    it('turns forward after a drag to the left of more than 20 percent', () => {
        expect(swipeDecision({ dx: -81, velocity: 0, width })).toBe(1)
        expect(swipeDecision({ dx: -300, velocity: 0, width })).toBe(1)
    })

    it('turns back after a drag to the right of more than 20 percent', () => {
        expect(swipeDecision({ dx: 81, velocity: 0, width })).toBe(-1)
    })

    it('returns after a short slow drag', () => {
        expect(swipeDecision({ dx: -80, velocity: 0, width })).toBeNull()
        expect(swipeDecision({ dx: 40, velocity: 0.4, width })).toBeNull()
        expect(swipeDecision({ dx: -40, velocity: -0.2, width })).toBeNull()
    })

    it('turns after a short fast flick in the drag direction', () => {
        expect(swipeDecision({ dx: -30, velocity: -0.41, width })).toBe(1)
        expect(swipeDecision({ dx: 30, velocity: 0.9, width })).toBe(-1)
    })

    it('ignores a flick against the drag direction', () => {
        expect(swipeDecision({ dx: -30, velocity: 0.9, width })).toBeNull()
        expect(swipeDecision({ dx: 30, velocity: -0.9, width })).toBeNull()
    })

    it('does nothing with no movement or no width', () => {
        expect(swipeDecision({ dx: 0, velocity: 2, width })).toBeNull()
        expect(swipeDecision({ dx: -200, velocity: -2, width: 0 })).toBeNull()
    })
})

describe('settleDuration', () => {
    it('is in proportion to the distance, from 120 to 300 milliseconds', () => {
        expect(settleDuration({ distance: 0, width: 400 })).toBe(120)
        expect(settleDuration({ distance: 200, width: 400 })).toBe(210)
        expect(settleDuration({ distance: -200, width: 400 })).toBe(210)
        expect(settleDuration({ distance: 400, width: 400 })).toBe(300)
        expect(settleDuration({ distance: 4000, width: 400 })).toBe(300)
        expect(settleDuration({ distance: 100, width: 0 })).toBe(120)
    })
})

describe('createWheelAccumulator', () => {
    it('turns one page when the sum passes 50', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: 0, deltaY: 20, time: 0 })).toBe(0)
        expect(wheel.push({ deltaX: 0, deltaY: 20, time: 16 })).toBe(0)
        expect(wheel.push({ deltaX: 0, deltaY: 20, time: 32 })).toBe(1)
    })

    it('uses the larger of the two deltas', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: -60, deltaY: 10, time: 0 })).toBe(-1)
        const other = createWheelAccumulator()
        expect(other.push({ deltaX: 5, deltaY: 120, time: 0 })).toBe(1)
    })

    it('turns one page for one notch of a mouse wheel', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: 0, deltaY: -100, time: 0 })).toBe(-1)
        // Lines, as Firefox sends them.
        const lines = createWheelAccumulator()
        expect(lines.push({ deltaX: 0, deltaY: 3, deltaMode: 1, time: 0 })).toBe(1)
    })

    it('ignores the glide of a trackpad after a turn', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: 0, deltaY: 80, time: 0 })).toBe(1)
        let turns = 0
        // 600 milliseconds of events with no pause of 80 milliseconds.
        for (let time = 16; time <= 600; time += 16) {
            if (wheel.push({ deltaX: 0, deltaY: 80, time })) turns++
        }
        expect(turns).toBe(0)
    })

    it('accepts a new gesture after a pause, but not before 250 milliseconds', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: 0, deltaY: 80, time: 0 })).toBe(1)
        // A pause of 100 milliseconds, but only 100 milliseconds after the turn.
        expect(wheel.push({ deltaX: 0, deltaY: 80, time: 100 })).toBe(0)
        // A pause of 90 milliseconds, and 290 milliseconds after the turn.
        expect(wheel.push({ deltaX: 0, deltaY: 30, time: 200 })).toBe(0)
        expect(wheel.push({ deltaX: 0, deltaY: 80, time: 290 })).toBe(1)
    })

    it('starts the sum again when the direction changes', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: 0, deltaY: 40, time: 0 })).toBe(0)
        expect(wheel.push({ deltaX: 0, deltaY: -40, time: 16 })).toBe(0)
        expect(wheel.push({ deltaX: 0, deltaY: -20, time: 32 })).toBe(-1)
    })

    it('forgets an old part of a gesture', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: 0, deltaY: 40, time: 0 })).toBe(0)
        expect(wheel.push({ deltaX: 0, deltaY: 40, time: 1000 })).toBe(0)
        expect(wheel.push({ deltaX: 0, deltaY: 40, time: 1016 })).toBe(1)
    })

    it('ignores an event with no movement', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: 0, deltaY: 0, time: 0 })).toBe(0)
    })

    it('can start again', () => {
        const wheel = createWheelAccumulator()
        expect(wheel.push({ deltaX: 0, deltaY: 80, time: 0 })).toBe(1)
        wheel.reset()
        expect(wheel.push({ deltaX: 0, deltaY: 80, time: 10 })).toBe(1)
    })
})

describe('createVelocityTracker', () => {
    it('gives the speed of the last movement with its direction', () => {
        const tracker = createVelocityTracker()
        tracker.add(300, 0)
        tracker.add(280, 16)
        tracker.add(250, 32)
        tracker.add(220, 48)
        const speed = tracker.read(50)
        expect(speed).toBeLessThan(-1)
        expect(speed).toBeGreaterThan(-2.5)
    })

    it('gives no speed after the pointer stopped', () => {
        const tracker = createVelocityTracker()
        tracker.add(300, 0)
        tracker.add(200, 16)
        expect(tracker.read(200)).toBe(0)
    })

    it('starts again after a pause in the movement', () => {
        const tracker = createVelocityTracker()
        tracker.add(300, 0)
        tracker.add(100, 16)
        tracker.add(100, 400)
        expect(tracker.read(401)).toBe(0)
    })

    it('gives no speed with one sample', () => {
        const tracker = createVelocityTracker()
        tracker.add(300, 10)
        expect(tracker.read(12)).toBe(0)
    })
})
