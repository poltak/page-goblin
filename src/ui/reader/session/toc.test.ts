import { describe, expect, it } from 'vitest'
import type { SpineItem, TocItem } from '$lib/epub/types'
import type { TocEntry } from '../types'
import { buildToc, createTocIndex, fallbackToc, flattenToc } from './toc'

function item(title: string, target: string | null, children: TocItem[] = []): TocItem {
    if (target === null) return { title, path: null, fragment: null, spineIndex: -1, children }
    const [index, fragment] = target.split('#')
    const spineIndex = Number(index)
    return {
        title,
        path: spineIndex < 0 ? 'missing.xhtml' : `c${spineIndex}.xhtml`,
        fragment: fragment ?? null,
        spineIndex,
        children,
    }
}

function spine(count: number, nonLinear: number[] = []): SpineItem[] {
    return Array.from({ length: count }, (_, index) => ({
        index,
        idref: `item-${index}`,
        path: `c${index}.xhtml`,
        mediaType: 'application/xhtml+xml',
        linear: !nonLinear.includes(index),
        size: 100,
        properties: [],
    }))
}

function entry(title: string, spineIndex: number, fragment: string | null = null): TocEntry {
    return { title, depth: 0, spineIndex, fragment }
}

describe('flattenToc', () => {
    it('gives an empty list for an empty table of contents', () => {
        expect(flattenToc([])).toEqual([])
    })

    it('lists the entries in reading order with their depth', () => {
        const toc = [
            item('Part one', '0', [
                item('Chapter 1', '1'),
                item('Chapter 2', '2', [item('Section 2.1', '2#s1'), item('Section 2.2', '2#s2')]),
            ]),
            item('Part two', '3', [item('Chapter 3', '4')]),
        ]
        expect(flattenToc(toc)).toEqual([
            { title: 'Part one', depth: 0, spineIndex: 0, fragment: null },
            { title: 'Chapter 1', depth: 1, spineIndex: 1, fragment: null },
            { title: 'Chapter 2', depth: 1, spineIndex: 2, fragment: null },
            { title: 'Section 2.1', depth: 2, spineIndex: 2, fragment: 's1' },
            { title: 'Section 2.2', depth: 2, spineIndex: 2, fragment: 's2' },
            { title: 'Part two', depth: 0, spineIndex: 3, fragment: null },
            { title: 'Chapter 3', depth: 1, spineIndex: 4, fragment: null },
        ])
    })

    it('leaves out a heading with no target and moves its children up one level', () => {
        const toc = [
            item('Part one', null, [
                item('Chapter 1', '0', [item('Section', '0#s')]),
                item('Chapter 2', '1'),
            ]),
            item('Afterword', '2'),
        ]
        expect(flattenToc(toc)).toEqual([
            { title: 'Chapter 1', depth: 0, spineIndex: 0, fragment: null },
            { title: 'Section', depth: 1, spineIndex: 0, fragment: 's' },
            { title: 'Chapter 2', depth: 0, spineIndex: 1, fragment: null },
            { title: 'Afterword', depth: 0, spineIndex: 2, fragment: null },
        ])
    })

    it('leaves out an entry whose file is not in the spine and keeps its children', () => {
        const toc = [
            item('Book', '0', [
                item('Missing', '-1', [item('Kept', '1', [item('Deep', '1#d')])]),
                item('Also missing', '-1#x'),
            ]),
        ]
        expect(flattenToc(toc)).toEqual([
            { title: 'Book', depth: 0, spineIndex: 0, fragment: null },
            { title: 'Kept', depth: 1, spineIndex: 1, fragment: null },
            { title: 'Deep', depth: 2, spineIndex: 1, fragment: 'd' },
        ])
    })

    it('keeps the depth through two levels of headings with no target', () => {
        const toc = [item('Volume', null, [item('Part', null, [item('Chapter', '0')])])]
        expect(flattenToc(toc)).toEqual([
            { title: 'Chapter', depth: 0, spineIndex: 0, fragment: null },
        ])
    })

    it('does not change the input', () => {
        const toc = [item('A', '0', [item('B', null, [item('C', '1')])])]
        const copy = JSON.parse(JSON.stringify(toc))
        flattenToc(toc)
        expect(toc).toEqual(copy)
    })
})

describe('fallbackToc', () => {
    it('has one entry for each linear spine item', () => {
        expect(fallbackToc(spine(5, [1, 4]))).toEqual([
            { title: 'Section 1', depth: 0, spineIndex: 0, fragment: null },
            { title: 'Section 2', depth: 0, spineIndex: 2, fragment: null },
            { title: 'Section 3', depth: 0, spineIndex: 3, fragment: null },
        ])
    })
})

describe('buildToc', () => {
    it('uses the table of contents of the book when it has 2 entries or more', () => {
        const toc = [item('One', '0'), item('Two', '5')]
        expect(buildToc({ toc, spine: spine(10) }).map((row) => row.title)).toEqual(['One', 'Two'])
    })

    it('uses the fallback for no entries and more than 3 linear spine items', () => {
        const result = buildToc({ toc: [], spine: spine(4) })
        expect(result.map((row) => row.title)).toEqual([
            'Section 1',
            'Section 2',
            'Section 3',
            'Section 4',
        ])
    })

    it('uses the fallback for one entry and more than 3 linear spine items', () => {
        const result = buildToc({ toc: [item('Start', '0')], spine: spine(6, [5]) })
        expect(result).toHaveLength(5)
        expect(result[4]).toEqual({ title: 'Section 5', depth: 0, spineIndex: 4, fragment: null })
    })

    it('uses the fallback when all entries point to files that are not in the book', () => {
        const toc = [item('A', '-1'), item('B', '-1'), item('C', null)]
        expect(buildToc({ toc, spine: spine(4) })).toHaveLength(4)
    })

    it('keeps the short list when the book has 3 linear spine items or fewer', () => {
        expect(buildToc({ toc: [], spine: spine(3) })).toEqual([])
        expect(buildToc({ toc: [item('Only', '1')], spine: spine(3) })).toEqual([
            { title: 'Only', depth: 0, spineIndex: 1, fragment: null },
        ])
        // 5 spine items, but only 3 are linear.
        expect(buildToc({ toc: [], spine: spine(5, [3, 4]) })).toEqual([])
    })
})

describe('createTocIndex', () => {
    const toc = [
        entry('Preface', 1),
        entry('Chapter 1', 2),
        entry('Section 1.1', 2, 's1'),
        entry('Section 1.2', 2, 's2'),
        entry('Chapter 2', 4),
    ]

    it('gives null for a position before the first entry', () => {
        const index = createTocIndex(toc)
        expect(index.find({ spineIndex: 0, offset: 0 })).toBeNull()
        expect(index.find({ spineIndex: 0, offset: 5000 })).toBeNull()
    })

    it('gives null for an empty contents list', () => {
        expect(createTocIndex([]).find({ spineIndex: 3, offset: 3 })).toBeNull()
    })

    it('gives the last entry at or before a position', () => {
        const index = createTocIndex(toc)
        expect(index.find({ spineIndex: 1, offset: 0 })?.title).toBe('Preface')
        expect(index.find({ spineIndex: 1, offset: 999 })?.title).toBe('Preface')
        // Spine item 3 has no entry.
        expect(index.find({ spineIndex: 4, offset: 0 })?.title).toBe('Chapter 2')
        expect(index.find({ spineIndex: 9, offset: 0 })?.title).toBe('Chapter 2')
    })

    it('treats a fragment offset as 0 before the chapter loads', () => {
        const index = createTocIndex(toc)
        // All three entries of spine item 2 are at offset 0, so the last one is the result.
        expect(index.find({ spineIndex: 2, offset: 0 })?.title).toBe('Section 1.2')
        expect(index.find({ spineIndex: 3, offset: 0 })?.title).toBe('Section 1.2')
    })

    it('compares entries of one spine item by their fragment offset after the load', () => {
        const index = createTocIndex(toc)
        index.setAnchors(
            2,
            new Map([
                ['s1', 400],
                ['s2', 900],
                ['other', 20],
            ]),
        )
        expect(index.find({ spineIndex: 2, offset: 0 })?.title).toBe('Chapter 1')
        expect(index.find({ spineIndex: 2, offset: 399 })?.title).toBe('Chapter 1')
        expect(index.find({ spineIndex: 2, offset: 400 })?.title).toBe('Section 1.1')
        expect(index.find({ spineIndex: 2, offset: 899 })?.title).toBe('Section 1.1')
        expect(index.find({ spineIndex: 2, offset: 900 })?.title).toBe('Section 1.2')
        expect(index.find({ spineIndex: 3, offset: 0 })?.title).toBe('Section 1.2')
        expect(index.find({ spineIndex: 1, offset: 50 })?.title).toBe('Preface')
    })

    it('gives null before a fragment when the first entry of the book has one', () => {
        const index = createTocIndex([entry('Start', 0, 'start'), entry('Next', 1)])
        expect(index.find({ spineIndex: 0, offset: 0 })?.title).toBe('Start')
        index.setAnchors(0, new Map([['start', 120]]))
        expect(index.find({ spineIndex: 0, offset: 119 })).toBeNull()
        expect(index.find({ spineIndex: 0, offset: 120 })?.title).toBe('Start')
    })

    it('keeps a fragment that the chapter does not have at the chapter start', () => {
        const index = createTocIndex(toc)
        index.setAnchors(2, new Map([['s2', 900]]))
        expect(index.find({ spineIndex: 2, offset: 10 })?.title).toBe('Section 1.1')
        expect(index.find({ spineIndex: 2, offset: 900 })?.title).toBe('Section 1.2')
    })

    it('handles fragments that are not in document order', () => {
        const index = createTocIndex([
            entry('First in list', 0, 'late'),
            entry('Second in list', 0, 'early'),
        ])
        index.setAnchors(
            0,
            new Map([
                ['late', 500],
                ['early', 100],
            ]),
        )
        expect(index.find({ spineIndex: 0, offset: 50 })).toBeNull()
        expect(index.find({ spineIndex: 0, offset: 100 })?.title).toBe('Second in list')
        expect(index.find({ spineIndex: 0, offset: 600 })?.title).toBe('First in list')
    })

    it('says which spine items need anchor offsets', () => {
        const index = createTocIndex(toc)
        expect(index.needsAnchors(1)).toBe(false)
        expect(index.needsAnchors(2)).toBe(true)
        expect(index.needsAnchors(4)).toBe(false)
        index.setAnchors(2, new Map())
        expect(index.needsAnchors(2)).toBe(false)
    })

    it('ignores a second set of anchors for the same spine item', () => {
        const index = createTocIndex(toc)
        index.setAnchors(2, new Map([['s1', 400]]))
        index.setAnchors(2, new Map([['s1', 5]]))
        expect(index.find({ spineIndex: 2, offset: 100 })?.title).toBe('Section 1.2')
        expect(index.find({ spineIndex: 2, offset: 400 })?.title).toBe('Section 1.1')
    })

    it('returns the entry objects of the list', () => {
        const index = createTocIndex(toc)
        expect(index.find({ spineIndex: 4, offset: 1 })).toBe(toc[4])
    })

    it('finds entries in a list that is not in spine order', () => {
        const index = createTocIndex([entry('Late', 5), entry('Early', 1)])
        expect(index.find({ spineIndex: 0, offset: 0 })).toBeNull()
        expect(index.find({ spineIndex: 3, offset: 0 })?.title).toBe('Early')
        expect(index.find({ spineIndex: 5, offset: 0 })?.title).toBe('Late')
    })
})
