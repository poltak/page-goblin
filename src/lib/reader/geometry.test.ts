import { describe, expect, it } from 'vitest'
import {
    columnOfLeft,
    pagedGeometry,
    pageOfLeft,
    pagesOfScrollWidth,
    resolveColumns,
    sameGeometry,
    scrollGeometry,
} from './geometry'
import type { ColumnChoice, MarginSize } from './types'

const MARGINS: MarginSize[] = ['narrow', 'normal', 'wide']
const COLUMNS: ColumnChoice[] = ['auto', 1, 2]

describe('resolveColumns', () => {
    it('keeps a fixed choice', () => {
        expect(resolveColumns({ columns: 1, width: 2000, height: 800 })).toBe(1)
        expect(resolveColumns({ columns: 2, width: 320, height: 800 })).toBe(2)
    })

    it('uses two columns only on a wide landscape container', () => {
        expect(resolveColumns({ columns: 'auto', width: 1400, height: 900 })).toBe(2)
        expect(resolveColumns({ columns: 'auto', width: 1000, height: 800 })).toBe(2)
        expect(resolveColumns({ columns: 'auto', width: 999, height: 600 })).toBe(1)
        // Wide, but not wider than 1.15 times the height.
        expect(resolveColumns({ columns: 'auto', width: 1024, height: 900 })).toBe(1)
        expect(resolveColumns({ columns: 'auto', width: 375, height: 812 })).toBe(1)
    })
})

describe('pagedGeometry', () => {
    it('gives the specified margins for a phone', () => {
        const narrow = pagedGeometry({ width: 375, height: 812, margin: 'narrow', columns: 'auto' })
        const normal = pagedGeometry({ width: 375, height: 812, margin: 'normal', columns: 'auto' })
        const wide = pagedGeometry({ width: 375, height: 812, margin: 'wide', columns: 'auto' })
        expect(narrow.marginX).toBe(16)
        expect(normal.marginX).toBe(26)
        expect(wide.marginX).toBe(41)
        expect(normal.marginY).toBe(28)
        expect(normal.columns).toBe(1)
        expect(normal.columnWidth).toBe(375 - 52)
        expect(normal.columnGap).toBe(52)
        expect(normal.contentWidth).toBe(375 - 52)
        expect(normal.contentHeight).toBe(812 - 56)
    })

    it('clamps the margins on a large screen', () => {
        const narrow = pagedGeometry({ width: 2000, height: 1400, margin: 'narrow', columns: 1 })
        const normal = pagedGeometry({ width: 2000, height: 1400, margin: 'normal', columns: 1 })
        const wide = pagedGeometry({ width: 2000, height: 1400, margin: 'wide', columns: 1 })
        expect(narrow.marginX).toBe(28)
        expect(normal.marginX).toBe(72)
        expect(wide.marginX).toBe(140)
        expect(normal.marginY).toBe(40)
    })

    it('gives two columns at 1400 by 900', () => {
        const geometry = pagedGeometry({
            width: 1400,
            height: 900,
            margin: 'normal',
            columns: 'auto',
        })
        expect(geometry.columns).toBe(2)
        expect(geometry.marginX).toBe(72)
        expect(geometry.columnGap).toBe(144)
        expect(geometry.columnWidth).toBe(556)
        expect(geometry.contentWidth).toBe(1400 - 144)
    })

    it('cuts fractions and makes an odd width even for two columns', () => {
        const one = pagedGeometry({ width: 1401.7, height: 900.9, margin: 'normal', columns: 1 })
        expect(one.width).toBe(1401)
        expect(one.height).toBe(900)
        const two = pagedGeometry({ width: 1401.7, height: 900.9, margin: 'normal', columns: 2 })
        expect(two.width).toBe(1400)
    })

    it('keeps the strip one screen wide for each column count and size', () => {
        for (let width = 240; width <= 2600; width += 37) {
            for (const height of [320, 667, 900, 1440]) {
                for (const margin of MARGINS) {
                    for (const columns of COLUMNS) {
                        const g = pagedGeometry({ width, height, margin, columns })
                        const step = g.columnWidth + g.columnGap
                        // One screen has `columns` columns with their gaps, and no more.
                        expect(step * g.columns).toBe(g.width)
                        expect(Number.isInteger(g.columnWidth)).toBe(true)
                        expect(g.columnWidth).toBeGreaterThan(0)
                        expect(g.columnGap).toBe(2 * g.marginX)
                        // The columns and the gaps between them fill the content box.
                        expect(g.columns * g.columnWidth + (g.columns - 1) * g.columnGap).toBe(
                            g.contentWidth,
                        )
                        expect(g.contentWidth + 2 * g.marginX).toBe(g.width)
                        expect(g.contentHeight + 2 * g.marginY).toBe(g.height)
                        expect(g.width).toBeLessThanOrEqual(width)
                    }
                }
            }
        }
    })

    it('puts the first column of screen k at k times the width plus the margin', () => {
        const g = pagedGeometry({ width: 1400, height: 900, margin: 'wide', columns: 2 })
        const step = g.columnWidth + g.columnGap
        for (let screen = 0; screen < 5; screen++) {
            // Column positions are from the left edge of rd-html, which has the margin.
            const left = screen * g.columns * step
            expect(left + g.marginX).toBe(screen * g.width + g.marginX)
        }
    })

    it('keeps some text width in a very small container', () => {
        const g = pagedGeometry({ width: 90, height: 20, margin: 'wide', columns: 1 })
        expect(g.columnWidth).toBeGreaterThanOrEqual(80)
        expect(g.contentHeight).toBeGreaterThan(0)
        const empty = pagedGeometry({ width: 0, height: 0, margin: 'normal', columns: 'auto' })
        expect(empty.width).toBe(1)
        expect(empty.columnWidth).toBeGreaterThan(0)
    })
})

describe('sameGeometry', () => {
    it('compares the values that change the layout', () => {
        const a = pagedGeometry({ width: 800, height: 600, margin: 'normal', columns: 1 })
        const b = pagedGeometry({ width: 800.4, height: 600.2, margin: 'normal', columns: 1 })
        const c = pagedGeometry({ width: 801, height: 600, margin: 'normal', columns: 1 })
        const d = pagedGeometry({ width: 800, height: 600, margin: 'wide', columns: 1 })
        expect(sameGeometry(a, b)).toBe(true)
        expect(sameGeometry(a, c)).toBe(false)
        expect(sameGeometry(a, d)).toBe(false)
    })
})

describe('columnOfLeft and pageOfLeft', () => {
    const one = pagedGeometry({ width: 375, height: 812, margin: 'normal', columns: 1 })
    const two = pagedGeometry({ width: 1400, height: 900, margin: 'normal', columns: 2 })

    it('finds the column of a point', () => {
        expect(columnOfLeft(0, one)).toBe(0)
        expect(columnOfLeft(322, one)).toBe(0)
        expect(columnOfLeft(375, one)).toBe(1)
        expect(columnOfLeft(375 * 7 + 100, one)).toBe(7)
    })

    it('gives text that sticks out of its column to that column', () => {
        // A negative indent of 10 pixels in column 3.
        expect(columnOfLeft(3 * 375 - 10, one)).toBe(3)
        // Text that overflows the right edge of column 2 by 10 pixels.
        expect(columnOfLeft(2 * 375 + one.columnWidth + 10, one)).toBe(2)
        expect(columnOfLeft(-5, one)).toBe(0)
    })

    it('counts two columns as one page', () => {
        const step = two.columnWidth + two.columnGap
        expect(pageOfLeft(0, two)).toBe(0)
        expect(pageOfLeft(step, two)).toBe(0)
        expect(pageOfLeft(2 * step, two)).toBe(1)
        expect(pageOfLeft(3 * step + 20, two)).toBe(1)
        expect(pageOfLeft(4 * step, two)).toBe(2)
    })
})

describe('pagesOfScrollWidth', () => {
    it('counts the screens that the columns need', () => {
        const one = pagedGeometry({ width: 375, height: 812, margin: 'normal', columns: 1 })
        const step = one.columnWidth + one.columnGap
        expect(pagesOfScrollWidth(one.columnWidth, one)).toBe(1)
        expect(pagesOfScrollWidth(4 * step - one.columnGap, one)).toBe(4)

        const two = pagedGeometry({ width: 1400, height: 900, margin: 'normal', columns: 2 })
        const wide = two.columnWidth + two.columnGap
        expect(pagesOfScrollWidth(two.contentWidth, two)).toBe(1)
        expect(pagesOfScrollWidth(3 * wide - two.columnGap, two)).toBe(2)
        expect(pagesOfScrollWidth(4 * wide - two.columnGap, two)).toBe(2)
        expect(pagesOfScrollWidth(0, two)).toBe(1)
    })
})

describe('scrollGeometry', () => {
    it('gives the text width and the side padding for each margin', () => {
        expect(scrollGeometry('narrow')).toEqual({ maxWidthEm: 46, sidePadding: 16 })
        expect(scrollGeometry('normal')).toEqual({ maxWidthEm: 38, sidePadding: 20 })
        expect(scrollGeometry('wide')).toEqual({ maxWidthEm: 30, sidePadding: 28 })
    })
})
