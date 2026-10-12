import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchPanel } from '../parts'
import { SEARCH_RESULT_LIMIT } from '../session/search'
import type { SearchResult } from '../types'
import {
    createSearchPanel,
    resultCountText,
    SEARCH_DEBOUNCE_MS,
    SEARCH_ROWS_PER_CHUNK,
} from './search'
import {
    createFakeSession,
    focusOpener,
    HOSTILE,
    makeResult,
    mountHost,
} from './testing/fake-session'
import type { FakeSearch, FakeSession } from './testing/fake-session'

let host: HTMLElement
let session: FakeSession
let panel: SearchPanel | null = null

function mount(): SearchPanel {
    host = mountHost()
    session = createFakeSession()
    panel = createSearchPanel({ session, host })
    return panel
}

const sheet = () => host.querySelector<HTMLDialogElement>('.search-panel')!
const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    sheet().querySelector<T>(selector)!
const input = () => q<HTMLInputElement>('input[type="search"]')
const statusText = () => q('.search-status-text').textContent
const announced = () => q('[role="status"]').textContent
const progress = () => q('.progress')
const rows = () => Array.from(sheet().querySelectorAll<HTMLElement>('.list > li > .list-row'))
const clearButton = () => q('[data-action="clear"]')
const lastSearch = (): FakeSearch => session.searches[session.searches.length - 1]

function type(value: string): void {
    input().value = value
    input().dispatchEvent(new Event('input', { bubbles: true }))
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
}

/** Lets the callbacks of a settled promise run. */
async function flush(): Promise<void> {
    for (let round = 0; round < 3; round++) await Promise.resolve()
}

/** Results in one chapter, each at a different offset. */
function makeResults(count: number, spineIndex = 1): SearchResult[] {
    return Array.from({ length: count }, (_, index) =>
        makeResult({
            range: { spineIndex, start: index * 10, end: index * 10 + 5 },
            excerpt: `Result ${index} of the whale`,
            matchStart: 0,
            matchEnd: 6,
        }),
    )
}

/** Types a query, waits for the search to start and gives it results. */
async function searchFor(query: string, results: SearchResult[], end = true): Promise<void> {
    type(query)
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    if (results.length > 0) lastSearch().options.onResults(results)
    vi.runOnlyPendingTimers()
    vi.runOnlyPendingTimers()
    if (end) {
        lastSearch().resolve()
        await flush()
    }
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    panel?.destroy()
    panel = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('the search panel', () => {
    it('is a sheet with a search field that gets the focus', () => {
        const search = mount()
        const opener = focusOpener()
        expect(sheet().parentElement).toBe(host)
        expect(sheet().open).toBe(false)

        search.open()

        expect(sheet().open).toBe(true)
        expect(sheet().classList.contains('sheet')).toBe(true)
        expect(input().getAttribute('aria-label')).toBe('Search in this book')
        expect(input().hasAttribute('autofocus')).toBe(true)
        expect(document.activeElement).toBe(input())
        expect(statusText()).toBe('')
        expect(progress().hidden).toBe(true)

        search.close()
        expect(sheet().open).toBe(false)
        expect(document.activeElement).toBe(opener)
    })

    it('closes with its close button', () => {
        mount().open()
        q('[data-close]').click()

        expect(sheet().open).toBe(false)
    })
})

describe('the start of a search', () => {
    it('waits 250 ms after the last key', () => {
        mount().open()

        type('wh')
        vi.advanceTimersByTime(100)
        type('wha')
        vi.advanceTimersByTime(100)
        type('whale')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1)
        expect(session.search).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        expect(session.search).toHaveBeenCalledTimes(1)
        expect(lastSearch().options.query).toBe('whale')
        expect(lastSearch().options.signal.aborted).toBe(false)
        expect(SEARCH_DEBOUNCE_MS).toBe(250)
    })

    it('starts at once on Enter, and not a second time after the wait', () => {
        mount().open()
        type('whale')

        const event = press(input(), 'Enter')

        expect(event.defaultPrevented).toBe(true)
        expect(session.search).toHaveBeenCalledTimes(1)
        expect(lastSearch().options.query).toBe('whale')

        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
        press(input(), 'Enter')
        expect(session.search).toHaveBeenCalledTimes(1)
    })

    it('does not start on the Enter that ends a composition', () => {
        mount().open()
        type('クジラ')

        press(input(), 'Enter', { isComposing: true })

        expect(session.search).not.toHaveBeenCalled()
    })

    it('sends the query with no space at the ends and one space between words', () => {
        mount().open()
        type('  white \t  whale ')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)

        expect(lastSearch().options.query).toBe('white whale')

        // The same query with more spaces is not a new search.
        type('white whale  ')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
        expect(session.search).toHaveBeenCalledTimes(1)
    })

    it('fills the field and starts at once for open(query)', () => {
        const search = mount()

        search.open('white whale')

        expect(sheet().open).toBe(true)
        expect(input().value).toBe('white whale')
        expect(session.search).toHaveBeenCalledTimes(1)
        expect(lastSearch().options.query).toBe('white whale')
        expect(statusText()).toBe('Searching')
    })

    it('keeps the results when open(query) gets the query of the results', async () => {
        const search = mount()
        search.open('whale')
        lastSearch().options.onResults(makeResults(2))
        lastSearch().resolve()
        await flush()
        search.close()

        search.open('whale')

        expect(session.search).toHaveBeenCalledTimes(1)
        expect(rows()).toHaveLength(2)

        search.open('ship')
        expect(session.search).toHaveBeenCalledTimes(2)
        expect(rows()).toHaveLength(0)
    })
})

describe('a short query', () => {
    it('starts no search and removes the marks in the book', () => {
        mount().open()

        type('w')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)

        expect(session.search).not.toHaveBeenCalled()
        expect(session.clearSearch).toHaveBeenCalledTimes(1)
        expect(statusText()).toBe('Type 2 or more characters.')
    })

    it('clears the results at once and stops the search that runs', async () => {
        mount().open()
        await searchFor('whale', makeResults(3), false)
        const running = lastSearch()
        expect(rows()).toHaveLength(3)

        type('w')

        expect(rows()).toHaveLength(0)
        expect(running.options.signal.aborted).toBe(true)
        expect(session.clearSearch).toHaveBeenCalledTimes(1)
        expect(progress().hidden).toBe(true)

        type('')
        expect(statusText()).toBe('')
        expect(session.clearSearch).toHaveBeenCalledTimes(2)
    })

    it('does not count spaces', () => {
        mount().open()
        type('  a  ')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)

        expect(session.search).not.toHaveBeenCalled()
    })
})

describe('a new search', () => {
    it('stops the search that runs and ignores its later calls', async () => {
        mount().open()
        await searchFor('whale', makeResults(2), false)
        const first = lastSearch()

        type('ship')
        // The results of the old query stay until the new search starts.
        expect(rows()).toHaveLength(2)
        expect(first.options.signal.aborted).toBe(false)
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)

        expect(first.options.signal.aborted).toBe(true)
        expect(session.search).toHaveBeenCalledTimes(2)
        expect(rows()).toHaveLength(0)

        first.options.onResults(makeResults(5))
        first.options.onProgress?.(3, 9)
        first.resolve()
        await flush()

        expect(rows()).toHaveLength(0)
        expect(statusText()).toBe('Searching')

        lastSearch().options.onResults(makeResults(1))
        lastSearch().resolve()
        await flush()
        expect(rows()).toHaveLength(1)
        expect(statusText()).toBe('1 result')
    })
})

describe('the result rows', () => {
    it('shows the excerpt with the match in a mark, the chapter and the percent', async () => {
        mount().open()
        await searchFor('whale', [
            makeResult({
                range: { spineIndex: 3, start: 500, end: 505 },
                excerpt: 'The white whale swam',
                matchStart: 10,
                matchEnd: 15,
                chapterTitle: 'Chapter One',
            }),
        ])

        const [row] = rows()
        const excerpt = row.querySelector('.list-row-title')!
        expect(excerpt.textContent).toBe('The white whale swam')
        // Three text nodes: before the match, the match, after the match.
        expect(Array.from(excerpt.childNodes, (node) => node.nodeType)).toEqual([
            Node.TEXT_NODE,
            Node.ELEMENT_NODE,
            Node.TEXT_NODE,
        ])
        expect(excerpt.childNodes[0].textContent).toBe('The white ')
        const mark = excerpt.querySelector('mark')!
        expect(mark.childNodes).toHaveLength(1)
        expect(mark.firstChild!.nodeType).toBe(Node.TEXT_NODE)
        expect(mark.textContent).toBe('whale')
        expect(excerpt.childNodes[2].textContent).toBe(' swam')

        expect(row.querySelector('.list-row-meta')!.textContent).toBe('Chapter One')
        expect(row.querySelector('.list-row-trail')!.textContent).toBe('35%')
    })

    it('keeps an excerpt with markup characters as text', async () => {
        mount().open()
        const excerpt = `${HOSTILE} whale ${HOSTILE}`
        await searchFor('whale', [
            makeResult({
                excerpt,
                matchStart: HOSTILE.length + 1,
                matchEnd: HOSTILE.length + 6,
                chapterTitle: HOSTILE,
            }),
        ])

        const [row] = rows()
        expect(row.querySelector('.list-row-title')!.textContent).toBe(excerpt)
        expect(row.querySelector('mark')!.textContent).toBe('whale')
        expect(row.querySelector('.list-row-meta')!.textContent).toBe(HOSTILE)
        expect(sheet().querySelector('img, b')).toBeNull()
    })

    it('keeps a match with markup characters as text', async () => {
        mount().open()
        await searchFor('<b>', [makeResult({ excerpt: 'a <b> c', matchStart: 2, matchEnd: 5 })])

        expect(rows()[0].querySelector('mark')!.textContent).toBe('<b>')
        expect(rows()[0].querySelector('b')).toBeNull()
    })

    it('hides the chapter line of a result with no chapter title', async () => {
        mount().open()
        await searchFor('whale', [makeResult({ chapterTitle: '' })])

        expect(rows()[0].querySelector<HTMLElement>('.list-row-meta')!.hidden).toBe(true)
    })

    it('does not fail for match positions outside the excerpt', async () => {
        mount().open()
        await searchFor('whale', [makeResult({ excerpt: 'short', matchStart: 3, matchEnd: 99 })])

        expect(rows()[0].querySelector('.list-row-title')!.textContent).toBe('short')
        expect(rows()[0].querySelector('mark')!.textContent).toBe('rt')
    })

    it('adds the rows of each chapter as they arrive', () => {
        mount().open()
        type('whale')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)

        lastSearch().options.onResults(makeResults(2, 1))
        expect(rows()).toHaveLength(2)

        lastSearch().options.onResults(makeResults(3, 2))
        expect(rows()).toHaveLength(5)
        expect(rows().map((row) => row.dataset.index)).toEqual(['0', '1', '2', '3', '4'])
    })

    it('makes the rows of a large call in chunks', () => {
        mount().open()
        type('whale')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
        const count = SEARCH_ROWS_PER_CHUNK * 2 + 20

        lastSearch().options.onResults(makeResults(count))
        expect(rows()).toHaveLength(SEARCH_ROWS_PER_CHUNK)

        // Results that arrive while a chunk waits do not start a second chain of chunks.
        lastSearch().options.onResults(makeResults(5, 2))
        expect(rows()).toHaveLength(SEARCH_ROWS_PER_CHUNK)

        vi.runOnlyPendingTimers()
        expect(rows()).toHaveLength(SEARCH_ROWS_PER_CHUNK * 2)

        vi.runOnlyPendingTimers()
        vi.runOnlyPendingTimers()
        expect(rows()).toHaveLength(count + 5)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('stops the chunks of an old search', () => {
        mount().open()
        type('whale')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
        lastSearch().options.onResults(makeResults(SEARCH_ROWS_PER_CHUNK * 3))

        type('')
        vi.runAllTimers()

        expect(rows()).toHaveLength(0)
    })
})

describe('the status line', () => {
    it('shows the progress during the search', () => {
        mount().open()
        type('whale')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)

        expect(statusText()).toBe('Searching')
        expect(progress().hidden).toBe(false)
        expect(progress().getAttribute('role')).toBe('progressbar')
        expect(progress().style.getPropertyValue('--value')).toBe('0')

        lastSearch().options.onProgress?.(12, 40)

        expect(statusText()).toBe('Searching, 12 of 40 chapters')
        expect(progress().style.getPropertyValue('--value')).toBe('0.3')
        expect(progress().getAttribute('aria-valuenow')).toBe('30')
        // A screen reader does not get each step.
        expect(announced()).toBe('')
    })

    it('shows the number of results at the end', async () => {
        mount().open()
        await searchFor('whale', makeResults(37))

        expect(statusText()).toBe('37 results')
        expect(announced()).toBe('37 results')
        expect(progress().hidden).toBe(true)
        expect(rows()).toHaveLength(37)
    })

    it('shows "No results"', async () => {
        mount().open()
        await searchFor('xyzzy', [])

        expect(statusText()).toBe('No results')
        expect(rows()).toHaveLength(0)
    })

    it('says that the search stops at the limit', async () => {
        mount().open()
        type('the')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
        lastSearch().options.onResults(makeResults(SEARCH_RESULT_LIMIT - 10))
        // A session that sends too many results gets no more rows than the limit.
        lastSearch().options.onResults(makeResults(30, 2))
        vi.runAllTimers()
        lastSearch().resolve()
        await flush()

        expect(rows()).toHaveLength(SEARCH_RESULT_LIMIT)
        expect(statusText()).toBe('500 results. The search stops at 500.')
    })

    it('says when the search did not finish, and Enter tries again', async () => {
        mount().open()
        type('whale')
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
        lastSearch().options.onResults(makeResults(2))
        lastSearch().reject(new Error('no chapter'))
        await flush()

        expect(statusText()).toBe('The search did not finish. Press Enter to try again.')
        expect(progress().hidden).toBe(true)

        press(input(), 'Enter')
        expect(session.search).toHaveBeenCalledTimes(2)
        expect(lastSearch().options.query).toBe('whale')
        expect(rows()).toHaveLength(0)
    })
})

describe('resultCountText', () => {
    it('gives the text for each number of results', () => {
        expect(resultCountText(0)).toBe('No results')
        expect(resultCountText(1)).toBe('1 result')
        expect(resultCountText(37)).toBe('37 results')
        expect(resultCountText(SEARCH_RESULT_LIMIT - 1)).toBe('499 results')
        expect(resultCountText(SEARCH_RESULT_LIMIT)).toBe('500 results. The search stops at 500.')
    })
})

describe('a click on a result', () => {
    it('goes to the match with a place on the back stack, and closes', async () => {
        mount().open()
        await searchFor('whale', [
            makeResult({ range: { spineIndex: 1, start: 10, end: 15 } }),
            makeResult({ range: { spineIndex: 4, start: 200, end: 205 } }),
        ])

        rows()[1].querySelector<HTMLElement>('mark')!.click()

        expect(session.goTo).toHaveBeenCalledTimes(1)
        expect(session.goTo).toHaveBeenCalledWith(
            { spineIndex: 4, offset: 200 },
            { remember: true },
        )
        expect(sheet().open).toBe(false)
        // The marks stay in the book.
        expect(session.clearSearch).not.toHaveBeenCalled()
    })

    it('keeps the results, and opens again at the result that was opened', async () => {
        const search = mount()
        search.open()
        await searchFor('whale', makeResults(3))
        rows()[1].click()

        search.open()

        expect(session.search).toHaveBeenCalledTimes(1)
        expect(rows()).toHaveLength(3)
        expect(input().value).toBe('whale')
        expect(statusText()).toBe('3 results')
        expect(rows()[1].getAttribute('aria-current')).toBe('true')
        expect(document.activeElement).toBe(rows()[1])
        // The dialog must not give the focus to the field, or the keyboard of a phone opens.
        expect(input().hasAttribute('autofocus')).toBe(false)

        press(rows()[1], 'ArrowDown')
        expect(document.activeElement).toBe(rows()[2])
        rows()[2].click()
        expect(session.goTo).toHaveBeenLastCalledWith(
            { spineIndex: 1, offset: 20 },
            { remember: true },
        )
        expect(rows()[1].hasAttribute('aria-current')).toBe(false)
        expect(rows()[2].getAttribute('aria-current')).toBe('true')
    })

    it('gets the results of a search that ends while the panel is closed', async () => {
        const search = mount()
        search.open()
        await searchFor('whale', makeResults(2), false)
        rows()[0].click()

        lastSearch().options.onResults(makeResults(3, 2))
        lastSearch().resolve()
        await flush()
        search.open()

        expect(lastSearch().options.signal.aborted).toBe(false)
        expect(rows()).toHaveLength(5)
        expect(statusText()).toBe('5 results')
    })

    it('does not fail when the jump rejects', async () => {
        mount().open()
        await searchFor('whale', makeResults(1))
        session.goTo.mockRejectedValueOnce(new Error('no chapter'))

        rows()[0].click()
        await flush()

        expect(sheet().open).toBe(false)
    })
})

describe('the Clear button', () => {
    it('removes the marks, the text of the field and the results', async () => {
        mount().open()
        await searchFor('whale', makeResults(4))

        clearButton().click()

        expect(clearButton().textContent).toBe('Clear')
        expect(session.clearSearch).toHaveBeenCalledTimes(1)
        expect(input().value).toBe('')
        expect(rows()).toHaveLength(0)
        expect(statusText()).toBe('')
        expect(announced()).toBe('')
        expect(sheet().open).toBe(true)
        expect(document.activeElement).toBe(input())
    })

    it('stops the search that runs and a search that waits', async () => {
        mount().open()
        await searchFor('whale', makeResults(1), false)
        const running = lastSearch()
        type('whales')

        clearButton().click()
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
        running.options.onResults(makeResults(2))
        running.resolve()
        await flush()

        expect(running.options.signal.aborted).toBe(true)
        expect(session.search).toHaveBeenCalledTimes(1)
        expect(rows()).toHaveLength(0)
        expect(statusText()).toBe('')
        expect(progress().hidden).toBe(true)
    })

    it('lets the same query start again', async () => {
        mount().open()
        await searchFor('whale', makeResults(1))
        clearButton().click()

        await searchFor('whale', makeResults(1))

        expect(session.search).toHaveBeenCalledTimes(2)
        expect(rows()).toHaveLength(1)
    })
})

describe('the keyboard', () => {
    it('moves from the field into the list with the down arrow', async () => {
        mount().open()
        await searchFor('whale', makeResults(3))

        const event = press(input(), 'ArrowDown')

        expect(event.defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(rows()[0])
    })

    it('leaves the down arrow alone when the list is empty', () => {
        mount().open()

        expect(press(input(), 'ArrowDown').defaultPrevented).toBe(false)
        expect(document.activeElement).toBe(input())
    })

    it('moves in the list with the arrow keys, Home and End', async () => {
        mount().open()
        await searchFor('whale', makeResults(4))
        press(input(), 'ArrowDown')

        press(rows()[0], 'ArrowDown')
        expect(document.activeElement).toBe(rows()[1])
        press(rows()[1], 'ArrowDown')
        expect(document.activeElement).toBe(rows()[2])
        press(rows()[2], 'ArrowUp')
        expect(document.activeElement).toBe(rows()[1])

        expect(press(rows()[1], 'End').defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(rows()[3])
        // The last row is the end of the list.
        press(rows()[3], 'ArrowDown')
        expect(document.activeElement).toBe(rows()[3])

        press(rows()[3], 'Home')
        expect(document.activeElement).toBe(rows()[0])
    })

    it('goes back to the field with the up arrow on the first row', async () => {
        mount().open()
        await searchFor('whale', makeResults(2))
        press(input(), 'ArrowDown')

        press(rows()[0], 'ArrowUp')

        expect(document.activeElement).toBe(input())
    })

    it('has one row as a stop of the Tab key, the row that had the focus last', async () => {
        mount().open()
        await searchFor('whale', makeResults(3))
        const stops = () => rows().filter((row) => row.tabIndex === 0)
        expect(stops()).toEqual([rows()[0]])

        press(input(), 'ArrowDown')
        press(rows()[0], 'ArrowDown')
        expect(stops()).toEqual([rows()[1]])

        // The down arrow in the field goes back to that row.
        input().focus()
        press(input(), 'ArrowDown')
        expect(document.activeElement).toBe(rows()[1])
    })

    it('opens a result with a click, which the Enter key gives on a button', async () => {
        mount().open()
        await searchFor('whale', makeResults(2))
        press(input(), 'ArrowDown')

        expect(rows()[0].tagName).toBe('BUTTON')
        expect(press(rows()[0], 'Enter').defaultPrevented).toBe(false)
        rows()[0].click()

        expect(session.goTo).toHaveBeenCalledWith({ spineIndex: 1, offset: 0 }, { remember: true })
    })

    it('leaves a key with a modifier, and a key in a header button, alone', async () => {
        mount().open()
        await searchFor('whale', makeResults(2))

        expect(press(input(), 'ArrowDown', { altKey: true }).defaultPrevented).toBe(false)
        expect(press(clearButton(), 'ArrowDown').defaultPrevented).toBe(false)
        expect(press(clearButton(), 'Enter').defaultPrevented).toBe(false)
        expect(session.search).toHaveBeenCalledTimes(1)
    })

    it('moves the focus from the field to the sheet on Enter with a touch keyboard', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
        mount().open()
        await searchFor('whale', makeResults(2))

        press(input(), 'Enter')
        expect(document.activeElement).toBe(sheet())

        // The arrow key still reaches the list.
        press(sheet(), 'ArrowDown')
        expect(document.activeElement).toBe(rows()[0])
    })
})

describe('destroy', () => {
    it('stops the search and removes the sheet', async () => {
        const search = mount()
        search.open()
        await searchFor('whale', makeResults(SEARCH_ROWS_PER_CHUNK * 2), false)
        const running = lastSearch()
        const dialog = sheet()
        type('whales')

        search.destroy()
        panel = null

        expect(host.children).toHaveLength(0)
        expect(dialog.open).toBe(false)
        expect(running.options.signal.aborted).toBe(true)
        expect(vi.getTimerCount()).toBe(0)

        running.options.onResults(makeResults(2))
        running.resolve()
        await flush()
        expect(session.search).toHaveBeenCalledTimes(1)
    })
})
