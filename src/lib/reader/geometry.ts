/**
 * The numbers of the page layout. All values are whole CSS pixels, so that the columns and
 * the page step of the track never drift apart.
 */

import type { ColumnChoice, MarginSize } from './types'

export interface PagedGeometry {
    /** Width of one screen of the column strip. This is also the step of a page turn. */
    width: number
    height: number
    /** Text columns on one screen. */
    columns: 1 | 2
    /** Space at the left and right of each column. */
    marginX: number
    /** Space above and below the columns. */
    marginY: number
    columnWidth: number
    columnGap: number
    /** Size of the `rd-html` element. */
    contentWidth: number
    contentHeight: number
}

export interface PagedGeometryOptions {
    /** Size of the container. Fractions are cut off. */
    width: number
    height: number
    margin: MarginSize
    columns: ColumnChoice
}

export interface ScrollGeometry {
    /** Largest text width in `em` of the body font size. */
    maxWidthEm: number
    /** Smallest space at the left and right of the text in pixels. */
    sidePadding: number
}

const MIN_COLUMN_WIDTH = 80

export function clamp(min: number, value: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

export function resolveColumns({
    columns,
    width,
    height,
}: {
    columns: ColumnChoice
    width: number
    height: number
}): 1 | 2 {
    if (columns === 1 || columns === 2) return columns
    return width >= 1000 && width > height * 1.15 ? 2 : 1
}

function horizontalMargin(margin: MarginSize, width: number): number {
    if (margin === 'narrow') return Math.round(clamp(16, width * 0.04, 28))
    if (margin === 'wide') return Math.round(clamp(28, width * 0.11, 140))
    return Math.round(clamp(20, width * 0.07, 72))
}

export function pagedGeometry(options: PagedGeometryOptions): PagedGeometry {
    const height = Math.max(1, Math.floor(options.height))
    let width = Math.max(1, Math.floor(options.width))
    const columns = resolveColumns({ columns: options.columns, width, height })
    // Two columns need an even width, or the column width is not a whole pixel.
    if (columns === 2 && width % 2 === 1) width -= 1

    let marginX = horizontalMargin(options.margin, width)
    // A very small container keeps some text width.
    const widest = Math.floor((width / columns - MIN_COLUMN_WIDTH) / 2)
    marginX = Math.max(0, Math.min(marginX, widest))

    let marginY = Math.round(clamp(12, height * 0.035, 40))
    marginY = Math.max(0, Math.min(marginY, Math.floor((height - 1) / 2)))

    const columnGap = 2 * marginX
    const columnWidth = (width - columnGap * columns) / columns

    return {
        width,
        height,
        columns,
        marginX,
        marginY,
        columnWidth,
        columnGap,
        contentWidth: width - 2 * marginX,
        contentHeight: height - 2 * marginY,
    }
}

export function sameGeometry(a: PagedGeometry, b: PagedGeometry): boolean {
    return (
        a.width === b.width &&
        a.height === b.height &&
        a.columns === b.columns &&
        a.marginX === b.marginX &&
        a.marginY === b.marginY
    )
}

/**
 * The column that has a point. `left` is the distance from the left edge of `rd-html`.
 * Text can stick out of its column by a negative indent, so each column also owns half of
 * the gap on each side.
 */
export function columnOfLeft(left: number, geometry: PagedGeometry): number {
    const step = geometry.columnWidth + geometry.columnGap
    const slack = Math.max(0.5, geometry.columnGap / 2)
    return Math.max(0, Math.floor((left + slack) / step))
}

/** The 0-based page (one screen) that has a point. */
export function pageOfLeft(left: number, geometry: PagedGeometry): number {
    return Math.floor(columnOfLeft(left, geometry) / geometry.columns)
}

/** The page count of a strip, from the width that its content needs. */
export function pagesOfScrollWidth(scrollWidth: number, geometry: PagedGeometry): number {
    return Math.max(1, Math.ceil((scrollWidth + geometry.columnGap) / geometry.width))
}

export function scrollGeometry(margin: MarginSize): ScrollGeometry {
    if (margin === 'narrow') return { maxWidthEm: 46, sidePadding: 16 }
    if (margin === 'wide') return { maxWidthEm: 30, sidePadding: 28 }
    return { maxWidthEm: 38, sidePadding: 20 }
}
