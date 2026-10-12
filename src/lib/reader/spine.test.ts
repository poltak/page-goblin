import { describe, expect, it } from 'vitest'
import { clampSpineIndex, linearNeighbour } from './spine'

function spineOf(pattern: string) {
    // 'L' is a linear item, 'n' is a non-linear item.
    return [...pattern].map((letter) => ({ linear: letter === 'L' }))
}

describe('linearNeighbour', () => {
    it('gives the next and the previous item in a spine with only linear items', () => {
        const spine = spineOf('LLLL')
        expect(linearNeighbour({ spine, index: 1, direction: 1 })).toBe(2)
        expect(linearNeighbour({ spine, index: 1, direction: -1 })).toBe(0)
    })

    it('gives -1 at the ends of the book', () => {
        const spine = spineOf('LLL')
        expect(linearNeighbour({ spine, index: 0, direction: -1 })).toBe(-1)
        expect(linearNeighbour({ spine, index: 2, direction: 1 })).toBe(-1)
    })

    it('skips the items that are not linear', () => {
        const spine = spineOf('LnnLnL')
        expect(linearNeighbour({ spine, index: 0, direction: 1 })).toBe(3)
        expect(linearNeighbour({ spine, index: 3, direction: -1 })).toBe(0)
        expect(linearNeighbour({ spine, index: 3, direction: 1 })).toBe(5)
        expect(linearNeighbour({ spine, index: 5, direction: -1 })).toBe(3)
    })

    it('gives the linear items around a non-linear item', () => {
        const spine = spineOf('LnnLnL')
        expect(linearNeighbour({ spine, index: 2, direction: -1 })).toBe(0)
        expect(linearNeighbour({ spine, index: 2, direction: 1 })).toBe(3)
        expect(linearNeighbour({ spine, index: 4, direction: -1 })).toBe(3)
        expect(linearNeighbour({ spine, index: 4, direction: 1 })).toBe(5)
    })

    it('gives -1 when only non-linear items are on that side', () => {
        const spine = spineOf('nLLnn')
        expect(linearNeighbour({ spine, index: 1, direction: -1 })).toBe(-1)
        expect(linearNeighbour({ spine, index: 2, direction: 1 })).toBe(-1)
        expect(linearNeighbour({ spine, index: 4, direction: -1 })).toBe(2)
        expect(linearNeighbour({ spine, index: 0, direction: 1 })).toBe(1)
    })

    it('reads a spine with no linear item in its written order', () => {
        const spine = spineOf('nnn')
        expect(linearNeighbour({ spine, index: 0, direction: 1 })).toBe(1)
        expect(linearNeighbour({ spine, index: 2, direction: -1 })).toBe(1)
        expect(linearNeighbour({ spine, index: 2, direction: 1 })).toBe(-1)
    })

    it('gives -1 for an empty spine', () => {
        expect(linearNeighbour({ spine: [], index: 0, direction: 1 })).toBe(-1)
    })
})

describe('clampSpineIndex', () => {
    it('keeps a valid index', () => {
        expect(clampSpineIndex(spineOf('LLL'), 1)).toBe(1)
    })

    it('moves an index from outside into the spine', () => {
        const spine = spineOf('LLL')
        expect(clampSpineIndex(spine, -4)).toBe(0)
        expect(clampSpineIndex(spine, 99)).toBe(2)
        expect(clampSpineIndex(spine, 1.8)).toBe(1)
        expect(clampSpineIndex(spine, Number.NaN)).toBe(0)
    })

    it('gives -1 for an empty spine', () => {
        expect(clampSpineIndex([], 0)).toBe(-1)
    })
})
