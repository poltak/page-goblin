/** Reading order of the spine. Page turns skip the items that are not linear. */

export interface SpineEntry {
    linear: boolean
}

function isReadable(spine: readonly SpineEntry[], index: number, anyLinear: boolean): boolean {
    return anyLinear ? spine[index].linear : true
}

/**
 * The nearest linear item before (`direction` -1) or after (1) an index, or -1 when there is
 * none. The item at `index` itself can be non-linear: a link can open such an item, and its
 * neighbours are then the linear items around it. A spine with no linear item at all is read
 * in its written order.
 */
export function linearNeighbour({
    spine,
    index,
    direction,
}: {
    spine: readonly SpineEntry[]
    index: number
    direction: 1 | -1
}): number {
    const anyLinear = spine.some((item) => item.linear)
    for (let i = index + direction; i >= 0 && i < spine.length; i += direction) {
        if (isReadable(spine, i, anyLinear)) return i
    }
    return -1
}

/** A valid spine index for a number from outside, for example a saved position. */
export function clampSpineIndex(spine: readonly SpineEntry[], index: number): number {
    if (!spine.length) return -1
    return Math.max(0, Math.min(Math.floor(index) || 0, spine.length - 1))
}
