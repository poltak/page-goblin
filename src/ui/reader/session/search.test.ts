import { describe, expect, it, vi } from 'vitest'
import type { SpineItem } from '$lib/epub/types'
import type { SearchResult } from '../types'
import {
    buildSearchPattern,
    runSearch,
    searchChapter,
    searchOrder,
    SEARCH_RESULT_LIMIT,
    yieldToEventLoop,
} from './search'
import type { RunSearchOptions } from './search'

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

function matchesOf(query: string, text: string): string[] {
    const pattern = buildSearchPattern(query)
    if (!pattern) return []
    return searchChapter({ model: { text, blocks: [] }, spineIndex: 0, pattern, limit: 100 }).map(
        (match) => text.slice(match.range.start, match.range.end),
    )
}

interface Run {
    results: SearchResult[][]
    progress: [number, number][]
    calls: string[]
}

/** Runs a search over chapter texts with no wait between the chapters. */
function setup(texts: (string | Error)[], changes: Partial<RunSearchOptions> = {}) {
    const run: Run = { results: [], progress: [], calls: [] }
    const options: RunSearchOptions = {
        pattern: buildSearchPattern('needle') as RegExp,
        spine: spine(texts.length),
        loadText: vi.fn(async (index: number) => {
            run.calls.push(`load ${index}`)
            const text = texts[index]
            if (text instanceof Error) throw text
            return { text, blocks: [] }
        }),
        isActive: () => true,
        titleAt: (locator) => `Title ${locator.spineIndex}`,
        onResults: (results) => {
            run.calls.push(`results ${results[0].range.spineIndex}`)
            run.results.push(results)
        },
        onProgress: (done, total) => {
            run.calls.push(`progress ${done}`)
            run.progress.push([done, total])
        },
        yieldControl: async () => {
            run.calls.push('yield')
        },
        ...changes,
    }
    return { run, options }
}

describe('buildSearchPattern', () => {
    it.each(['', ' ', 'a', ' a ', '\n\tx  '])('gives null for the short query %j', (query) => {
        expect(buildSearchPattern(query)).toBeNull()
    })

    it('accepts a query of 2 characters', () => {
        expect(buildSearchPattern('ab')).toBeInstanceOf(RegExp)
        expect(buildSearchPattern(' ab ')).toBeInstanceOf(RegExp)
        expect(buildSearchPattern('a b')).toBeInstanceOf(RegExp)
    })

    it('finds text with no difference between upper and lower case', () => {
        expect(matchesOf('whale', 'The Whale and the WHALE and a whale.')).toEqual([
            'Whale',
            'WHALE',
            'whale',
        ])
        expect(matchesOf('ÉCOLE', 'une école')).toEqual(['école'])
        expect(matchesOf('война', 'Война и мир')).toEqual(['Война'])
    })

    it('reads each run of white space in the query as one or more white-space characters', () => {
        const text = 'white whale, white  whale, white\n      whale, white whale, whitewhale'
        expect(matchesOf('white whale', text)).toHaveLength(4)
        expect(matchesOf('white   \t whale', text)).toHaveLength(4)
        expect(matchesOf('  white whale  ', text)).toHaveLength(4)
        expect(matchesOf('whitewhale', text)).toEqual(['whitewhale'])
    })

    it('reads the characters of the query as text, not as a pattern', () => {
        expect(matchesOf('a.c', 'abc a.c')).toEqual(['a.c'])
        expect(matchesOf('(what?)', 'so (what?) then')).toEqual(['(what?)'])
        expect(matchesOf('[x]', 'x [x]')).toEqual(['[x]'])
        expect(matchesOf('1+1', '11 1+1')).toEqual(['1+1'])
        expect(matchesOf('a\\b', 'a\\b')).toEqual(['a\\b'])
        expect(matchesOf('$5', 'costs $5 now')).toEqual(['$5'])
        expect(matchesOf('x-y', 'x-y')).toEqual(['x-y'])
        expect(matchesOf('^a|b{2}', '^a|b{2}')).toEqual(['^a|b{2}'])
    })

    it('finds typographic quotation marks for the marks of the keyboard', () => {
        expect(matchesOf("don't", "I don’t and don‘t and don't")).toHaveLength(3)
        expect(matchesOf('"yes"', 'said “yes” and "yes"')).toHaveLength(2)
        expect(matchesOf('don’t', "I don't")).toEqual([])
    })

    it('finds text with characters outside the basic plane', () => {
        expect(matchesOf('\u{1F600}!', 'ok \u{1F600}! done')).toEqual(['\u{1F600}!'])
    })
})

describe('searchChapter', () => {
    const pattern = buildSearchPattern('fox') as RegExp

    it('gives the range and the excerpt of each match in reading order', () => {
        const text = 'A fox met a second Fox near the river.'
        const matches = searchChapter({
            model: { text, blocks: [] },
            spineIndex: 4,
            pattern,
            limit: 10,
        })
        expect(matches).toEqual([
            {
                range: { spineIndex: 4, start: 2, end: 5 },
                excerpt: text,
                matchStart: 2,
                matchEnd: 5,
            },
            {
                range: { spineIndex: 4, start: 19, end: 22 },
                excerpt: text,
                matchStart: 19,
                matchEnd: 22,
            },
        ])
    })

    it('stops at the limit', () => {
        const model = { text: 'fox '.repeat(50), blocks: [] }
        expect(searchChapter({ model, spineIndex: 0, pattern, limit: 7 })).toHaveLength(7)
        expect(searchChapter({ model, spineIndex: 0, pattern, limit: 0 })).toEqual([])
    })

    it('starts at the chapter start each time', () => {
        const model = { text: 'fox fox', blocks: [] }
        expect(searchChapter({ model, spineIndex: 0, pattern, limit: 1 })).toHaveLength(1)
        expect(searchChapter({ model, spineIndex: 0, pattern, limit: 5 })).toHaveLength(2)
    })

    it('gives the offsets of the text and the positions of the collapsed excerpt', () => {
        const text = 'so   the quick\n\n   brown\tfox   sat'
        const [match] = searchChapter({
            model: { text, blocks: [] },
            spineIndex: 0,
            pattern: buildSearchPattern('brown fox') as RegExp,
            limit: 5,
        })
        expect(text.slice(match.range.start, match.range.end)).toBe('brown\tfox')
        expect(match.excerpt).toBe('so the quick brown fox sat')
        expect(match.excerpt.slice(match.matchStart, match.matchEnd)).toBe('brown fox')
    })
})

describe('searchOrder', () => {
    it('has the linear spine items first and then the others', () => {
        expect(searchOrder(spine(6, [0, 3]))).toEqual([1, 2, 4, 5, 0, 3])
        expect(searchOrder(spine(3))).toEqual([0, 1, 2])
        expect(searchOrder([])).toEqual([])
    })
})

describe('runSearch', () => {
    it('gives the results of each chapter with its title, and all ranges at the end', async () => {
        const { run, options } = setup(['a needle here', 'nothing', 'Needle and needle'])
        const ranges = await runSearch(options)

        expect(ranges).toEqual([
            { spineIndex: 0, start: 2, end: 8 },
            { spineIndex: 2, start: 0, end: 6 },
            { spineIndex: 2, start: 11, end: 17 },
        ])
        expect(run.results).toHaveLength(2)
        expect(run.results[0]).toEqual([
            {
                range: { spineIndex: 0, start: 2, end: 8 },
                excerpt: 'a needle here',
                matchStart: 2,
                matchEnd: 8,
                chapterTitle: 'Title 0',
            },
        ])
        expect(run.results[1].map((result) => result.chapterTitle)).toEqual(['Title 2', 'Title 2'])
    })

    it('calls onResults only for a chapter with matches and onProgress for each chapter', async () => {
        const { run, options } = setup(['a needle here', 'nothing', 'Needle and needle'])
        await runSearch(options)
        expect(run.progress).toEqual([
            [1, 3],
            [2, 3],
            [3, 3],
        ])
        expect(run.calls).toEqual([
            'load 0',
            'results 0',
            'progress 1',
            'yield',
            'load 1',
            'progress 2',
            'yield',
            'load 2',
            'results 2',
            'progress 3',
        ])
    })

    it('searches the linear spine items first', async () => {
        const { run, options } = setup(['needle 0', 'needle 1', 'needle 2', 'needle 3'], {
            spine: spine(4, [1]),
        })
        const ranges = await runSearch(options)
        expect(ranges?.map((range) => range.spineIndex)).toEqual([0, 2, 3, 1])
        expect(run.calls.filter((call) => call.startsWith('load'))).toEqual([
            'load 0',
            'load 2',
            'load 3',
            'load 1',
        ])
    })

    it('gives the title for the offset of each match', async () => {
        const titleAt = vi.fn(() => 'T')
        const { options } = setup(['xx needle', 'needle'], { titleAt })
        await runSearch(options)
        expect(titleAt.mock.calls).toEqual([
            [{ spineIndex: 0, offset: 3 }],
            [{ spineIndex: 1, offset: 0 }],
        ])
    })

    it('stops at 500 results in total', async () => {
        const { run, options } = setup([
            'needle '.repeat(300),
            'needle '.repeat(300),
            'needle '.repeat(300),
        ])
        const ranges = await runSearch(options)

        expect(SEARCH_RESULT_LIMIT).toBe(500)
        expect(ranges).toHaveLength(500)
        expect(run.results.map((results) => results.length)).toEqual([300, 200])
        expect(run.progress).toEqual([
            [1, 3],
            [2, 3],
        ])
        expect(options.loadText).toHaveBeenCalledTimes(2)
        expect(run.calls.at(-1)).toBe('progress 2')
    })

    it('uses a different limit', async () => {
        const { run, options } = setup(['needle needle needle', 'needle'], { limit: 2 })
        expect(await runSearch(options)).toHaveLength(2)
        expect(run.results.map((results) => results.length)).toEqual([2])
    })

    it('goes on after a chapter that does not load', async () => {
        const { run, options } = setup(['needle', new Error('bad chapter'), 'needle'])
        const ranges = await runSearch(options)
        expect(ranges?.map((range) => range.spineIndex)).toEqual([0, 2])
        expect(run.progress.map(([done]) => done)).toEqual([1, 2, 3])
    })

    it('gives an empty list for a book with no match and for a book with no chapters', async () => {
        const none = setup(['a', 'b'])
        expect(await runSearch(none.options)).toEqual([])
        expect(none.run.results).toEqual([])
        expect(none.run.progress).toHaveLength(2)

        const empty = setup([])
        expect(await runSearch(empty.options)).toEqual([])
        expect(empty.run.calls).toEqual([])
    })

    it('stops after a text load when the search is not active, and calls nothing more', async () => {
        let active = true
        const { run, options } = setup(['needle', 'needle', 'needle'], {
            isActive: () => active,
        })
        options.loadText = vi.fn(async (index: number) => {
            run.calls.push(`load ${index}`)
            if (index === 1) active = false
            return { text: 'needle', blocks: [] }
        })

        expect(await runSearch(options)).toBeNull()
        expect(run.calls).toEqual(['load 0', 'results 0', 'progress 1', 'yield', 'load 1'])
    })

    it('stops after a wait when the search is not active', async () => {
        let active = true
        const { run, options } = setup(['needle', 'needle'], { isActive: () => active })
        options.yieldControl = async () => {
            active = false
        }
        expect(await runSearch(options)).toBeNull()
        expect(run.calls).toEqual(['load 0', 'results 0', 'progress 1'])
    })

    it('does not call onProgress when onResults stops the search', async () => {
        let active = true
        const { run, options } = setup(['needle', 'needle'], { isActive: () => active })
        options.onResults = () => {
            active = false
        }
        expect(await runSearch(options)).toBeNull()
        expect(run.progress).toEqual([])
    })

    it('waits for prepareTitles before the titles of a chapter that has matches', async () => {
        const { run, options } = setup(['needle', 'no match', 'needle'])
        let prepared = -1
        options.prepareTitles = async (spineIndex) => {
            run.calls.push(`prepare ${spineIndex}`)
            await Promise.resolve()
            prepared = spineIndex
        }
        options.titleAt = (locator) => `Title ${locator.spineIndex}, prepared ${prepared}`

        await runSearch(options)
        expect(run.calls).toEqual([
            'load 0',
            'prepare 0',
            'results 0',
            'progress 1',
            'yield',
            'load 1',
            'progress 2',
            'yield',
            'load 2',
            'prepare 2',
            'results 2',
            'progress 3',
        ])
        expect(run.results.flat().map((result) => result.chapterTitle)).toEqual([
            'Title 0, prepared 0',
            'Title 2, prepared 2',
        ])
    })

    it('stops after prepareTitles when the search is not active', async () => {
        let active = true
        const { run, options } = setup(['needle', 'needle'], { isActive: () => active })
        options.prepareTitles = async () => {
            active = false
        }
        expect(await runSearch(options)).toBeNull()
        expect(run.calls).toEqual(['load 0'])
    })

    it('gives null when onProgress stops the search at the last chapter', async () => {
        let active = true
        const { options } = setup(['needle', 'needle'], { isActive: () => active })
        options.onProgress = (done) => {
            if (done === 2) active = false
        }
        expect(await runSearch(options)).toBeNull()
    })

    it('gives null when onProgress stops the search at the result limit', async () => {
        let active = true
        const { run, options } = setup(['needle needle', 'needle'], {
            isActive: () => active,
            limit: 2,
        })
        options.onProgress = () => {
            active = false
        }
        expect(await runSearch(options)).toBeNull()
        expect(run.calls).toEqual(['load 0', 'results 0'])
    })

    it('works with no onProgress', async () => {
        const { options } = setup(['needle'], { onProgress: undefined })
        expect(await runSearch(options)).toHaveLength(1)
    })
})

describe('yieldToEventLoop', () => {
    it('resolves', async () => {
        await expect(yieldToEventLoop()).resolves.toBeUndefined()
        await expect(yieldToEventLoop()).resolves.toBeUndefined()
    })

    it('uses scheduler.yield when the browser has it', async () => {
        const yieldNow = vi.fn(async () => {})
        vi.stubGlobal('scheduler', { yield: yieldNow })
        try {
            await yieldToEventLoop()
            expect(yieldNow).toHaveBeenCalledTimes(1)
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('lets a timer of the page run when the browser has no scheduler.yield', async () => {
        vi.stubGlobal('scheduler', undefined)
        try {
            let ran = false
            setTimeout(() => {
                ran = true
            }, 0)
            // The wait uses a timer only after some milliseconds of work.
            const start = performance.now()
            while (performance.now() - start < 12) {
                // Busy loop.
            }
            await yieldToEventLoop()
            expect(ran).toBe(true)
        } finally {
            vi.unstubAllGlobals()
        }
    })
})
