/**
 * Where a floating box goes relative to a piece of the page: a text selection, a highlight or
 * a link. Pure functions with no DOM access. All values are in viewport pixels.
 */

/** The part of a DOMRect that the functions use. */
export interface Box {
    left: number
    top: number
    right: number
    bottom: number
}

export interface Size {
    width: number
    height: number
}

export interface Insets {
    top: number
    right: number
    bottom: number
    left: number
}

export type Side = 'above' | 'below'

/** Space between the box and its anchor, and between the box and the screen edge. */
export const FLOAT_GAP = 8
export const FLOAT_MARGIN = 8

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

export interface PlaceOptions {
    /** The bounds of the selection, the highlight or the link. */
    anchor: Box
    /** The size of the floating box. */
    size: Size
    viewport: Size
    /** The safe-area insets of the screen. */
    safe?: Insets
    /** The side to try first. The default is 'above'. */
    prefer?: Side
    gap?: number
    margin?: number
}

export interface Placement {
    /** The left and top edge of the floating box. */
    x: number
    y: number
    side: Side
}

function clamp(value: number, min: number, max: number): number {
    // A box that is larger than the free area starts at the near edge.
    return Math.max(min, Math.min(value, Math.max(min, max)))
}

/** The free height above and below the anchor, inside the margin and the safe areas. */
export function roomAround({
    anchor,
    viewport,
    safe = NO_INSETS,
    gap = FLOAT_GAP,
    margin = FLOAT_MARGIN,
}: Omit<PlaceOptions, 'size' | 'prefer'>): Record<Side, number> {
    return {
        above: Math.max(0, anchor.top - gap - (safe.top + margin)),
        below: Math.max(0, viewport.height - safe.bottom - margin - (anchor.bottom + gap)),
    }
}

/**
 * Centres the box on the anchor, on the preferred side when it has room there, else on the
 * other side. When no side has room the box goes below the anchor. The result is always
 * inside the margin and the safe areas.
 */
export function placeFloating(options: PlaceOptions): Placement {
    const { anchor, size, viewport } = options
    const safe = options.safe ?? NO_INSETS
    const gap = options.gap ?? FLOAT_GAP
    const margin = options.margin ?? FLOAT_MARGIN
    const prefer = options.prefer ?? 'above'

    const room = roomAround({ anchor, viewport, safe, gap, margin })
    const other: Side = prefer === 'above' ? 'below' : 'above'
    let side: Side = 'below'
    if (size.height <= room[prefer]) side = prefer
    else if (size.height <= room[other]) side = other

    const x = clamp(
        (anchor.left + anchor.right) / 2 - size.width / 2,
        safe.left + margin,
        viewport.width - safe.right - margin - size.width,
    )
    const y = clamp(
        side === 'above' ? anchor.top - gap - size.height : anchor.bottom + gap,
        safe.top + margin,
        viewport.height - safe.bottom - margin - size.height,
    )
    // Whole pixels keep the text of the box sharp.
    return { x: Math.round(x), y: Math.round(y), side }
}

/**
 * The clear height between the docked box and the anchor. A phone shows its own selection menu
 * and the selection handles next to the selection. The docked box must not be under them.
 */
export const DOCK_CLEARANCE = 72

/**
 * Docks the box at the bottom edge of the screen, centred. When the anchor is too near to the
 * bottom edge, the box docks at the top edge. Used on a touch screen, where the selection menu
 * of the system takes the space next to the selection.
 */
export function dockFloating(options: Omit<PlaceOptions, 'prefer' | 'gap'>): Placement {
    const { anchor, size, viewport } = options
    const safe = options.safe ?? NO_INSETS
    const margin = options.margin ?? FLOAT_MARGIN

    const x = clamp(
        (viewport.width - size.width) / 2,
        safe.left + margin,
        viewport.width - safe.right - margin - size.width,
    )
    const bottomY = viewport.height - safe.bottom - margin - size.height
    const side: Side = anchor.bottom + DOCK_CLEARANCE <= bottomY ? 'below' : 'above'
    const y = side === 'below' ? bottomY : safe.top + margin
    return { x: Math.round(x), y: Math.round(y), side }
}
