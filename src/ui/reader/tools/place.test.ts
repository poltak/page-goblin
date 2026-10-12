import { describe, expect, it } from 'vitest'
import {
    FLOAT_GAP,
    FLOAT_MARGIN,
    placeFloating,
    roomAround,
    DOCK_CLEARANCE,
    dockFloating,
} from './place'
import type { Box } from './place'

const viewport = { width: 1000, height: 800 }
const size = { width: 300, height: 50 }

interface BoxInit {
    left: number
    top: number
    width?: number
    height?: number
}

function box({ left, top, width = 100, height = 20 }: BoxInit): Box {
    return { left, top, right: left + width, bottom: top + height }
}

describe('placeFloating', () => {
    it('centres the box above the anchor with a gap of 8 px', () => {
        const placement = placeFloating({ anchor: box({ left: 400, top: 300 }), size, viewport })

        expect(FLOAT_GAP).toBe(8)
        expect(placement).toEqual({ x: 300, y: 300 - 8 - 50, side: 'above' })
    })

    it('goes below the anchor when there is no room above it', () => {
        const placement = placeFloating({ anchor: box({ left: 400, top: 40 }), size, viewport })

        expect(placement).toEqual({ x: 300, y: 60 + 8, side: 'below' })
    })

    it('uses the room above to the last pixel', () => {
        // 8 px margin, 50 px box, 8 px gap.
        expect(placeFloating({ anchor: box({ left: 400, top: 66 }), size, viewport }).side).toBe(
            'above',
        )
        expect(placeFloating({ anchor: box({ left: 400, top: 65 }), size, viewport }).side).toBe(
            'below',
        )
    })

    it('stays 8 px inside the left edge', () => {
        const placement = placeFloating({
            anchor: box({ left: 0, top: 300, width: 40 }),
            size,
            viewport,
        })

        expect(FLOAT_MARGIN).toBe(8)
        expect(placement.x).toBe(8)
    })

    it('stays 8 px inside the right edge', () => {
        const placement = placeFloating({
            anchor: box({ left: 960, top: 300, width: 40 }),
            size,
            viewport,
        })

        expect(placement.x).toBe(1000 - 8 - 300)
    })

    it('stays inside the top edge when the anchor is above the screen', () => {
        const placement = placeFloating({
            anchor: box({ left: 400, top: -200, width: 100, height: 100 }),
            size,
            viewport,
        })

        expect(placement).toMatchObject({ y: 8, side: 'below' })
    })

    it('stays inside the bottom edge when the anchor fills the screen', () => {
        const placement = placeFloating({
            anchor: box({ left: 400, top: 0, width: 100, height: 800 }),
            size,
            viewport,
        })

        expect(placement).toMatchObject({ y: 800 - 8 - 50, side: 'below' })
    })

    it('keeps out of the safe areas', () => {
        const safe = { top: 47, right: 20, bottom: 34, left: 30 }

        expect(
            placeFloating({ anchor: box({ left: 0, top: 300, width: 40 }), size, viewport, safe })
                .x,
        ).toBe(38)
        expect(
            placeFloating({ anchor: box({ left: 960, top: 300, width: 40 }), size, viewport, safe })
                .x,
        ).toBe(1000 - 20 - 8 - 300)
        // Above needs 47 + 8 + 50 + 8 = 113 px.
        expect(
            placeFloating({ anchor: box({ left: 400, top: 112 }), size, viewport, safe }).side,
        ).toBe('below')
        expect(
            placeFloating({ anchor: box({ left: 400, top: 113 }), size, viewport, safe }).side,
        ).toBe('above')
        expect(
            placeFloating({
                anchor: box({ left: 400, top: 0, width: 100, height: 800 }),
                size,
                viewport,
                safe,
            }).y,
        ).toBe(800 - 34 - 8 - 50)
    })

    it('goes below the anchor for a coarse pointer', () => {
        const placement = placeFloating({
            anchor: box({ left: 400, top: 300 }),
            size,
            viewport,
            prefer: 'below',
        })

        expect(placement).toEqual({ x: 300, y: 320 + 8, side: 'below' })
    })

    it('goes above for a coarse pointer when there is no room below', () => {
        const placement = placeFloating({
            anchor: box({ left: 400, top: 740 }),
            size,
            viewport,
            prefer: 'below',
        })

        expect(placement).toEqual({ x: 300, y: 740 - 8 - 50, side: 'above' })
    })

    it('starts at the left margin when the box is wider than the screen', () => {
        const placement = placeFloating({
            anchor: box({ left: 100, top: 300 }),
            size: { width: 400, height: 50 },
            viewport: { width: 320, height: 800 },
        })

        expect(placement.x).toBe(8)
    })

    it('gives whole pixels', () => {
        const placement = placeFloating({
            anchor: { left: 100.4, top: 300.3, right: 151.1, bottom: 320 },
            size: { width: 33, height: 20 },
            viewport,
        })

        expect(Number.isInteger(placement.x)).toBe(true)
        expect(Number.isInteger(placement.y)).toBe(true)
    })
})

describe('roomAround', () => {
    it('gives the free height on each side of the anchor', () => {
        expect(roomAround({ anchor: box({ left: 400, top: 300 }), viewport })).toEqual({
            above: 300 - 8 - 8,
            below: 800 - 8 - 8 - 320,
        })
    })

    it('takes the safe areas away', () => {
        const safe = { top: 40, right: 0, bottom: 30, left: 0 }

        expect(roomAround({ anchor: box({ left: 400, top: 300 }), viewport, safe })).toEqual({
            above: 300 - 8 - 48,
            below: 800 - 30 - 8 - 8 - 320,
        })
    })

    it('is 0 for an anchor at the edge', () => {
        expect(
            roomAround({ anchor: box({ left: 400, top: 0, width: 100, height: 800 }), viewport }),
        ).toEqual({
            above: 0,
            below: 0,
        })
    })
})

describe('dockFloating', () => {
    const size = { width: 300, height: 100 }
    const viewport = { width: 390, height: 800 }
    const anchorAt = (top: number) => ({ left: 100, right: 200, top, bottom: top + 20 })

    it('docks at the bottom edge, centred', () => {
        expect(dockFloating({ anchor: anchorAt(300), size, viewport })).toEqual({
            x: 45,
            y: 800 - 8 - 100,
            side: 'below',
        })
    })

    it('stays above the bottom safe area', () => {
        const safe = { top: 47, right: 0, bottom: 34, left: 0 }
        expect(dockFloating({ anchor: anchorAt(300), size, viewport, safe }).y).toBe(
            800 - 34 - 8 - 100,
        )
    })

    it('docks at the top edge when the selection is near the bottom edge', () => {
        const safe = { top: 47, right: 0, bottom: 34, left: 0 }
        const bottomY = 800 - 34 - 8 - 100
        const near = anchorAt(bottomY - DOCK_CLEARANCE - 19)
        expect(dockFloating({ anchor: near, size, viewport, safe })).toEqual({
            x: 45,
            y: 47 + 8,
            side: 'above',
        })
        const clear = anchorAt(bottomY - DOCK_CLEARANCE - 20)
        expect(dockFloating({ anchor: clear, size, viewport, safe }).side).toBe('below')
    })

    it('starts at the left margin when the box is wider than the screen', () => {
        expect(
            dockFloating({ anchor: anchorAt(300), size: { width: 500, height: 100 }, viewport }).x,
        ).toBe(8)
    })
})
