/**
 * The search panel of the reader screen. The reader screen loads this file when the user
 * opens the panel for the first time.
 *
 * An excerpt is text from the book. It goes into the page as text nodes only.
 */

import { connectDialog, openDialog } from '../../app/dialog'
import { on, qs } from '../../dom'
import type { PartOptions, SearchPanel } from '../parts'
import { SEARCH_MIN_QUERY_LENGTH, SEARCH_RESULT_LIMIT } from '../session/search'
import type { SearchResult } from '../types'
import markup from './search.html?raw'
import { ignoreRejection, parseMarkup, percentText, rowFactory } from './shared'
import './search.css'

/**
 * The wait after the last key before a search starts. Each search reads all chapters of the
 * book, so a search for each key is too much work.
 */
export const SEARCH_DEBOUNCE_MS = 250

/** The largest number of result rows that one task makes. */
export const SEARCH_ROWS_PER_CHUNK = 50

type SearchState = 'idle' | 'searching' | 'done' | 'failed'

const template = parseMarkup(markup)
const makeRow = rowFactory(template, 'result')

/** The query as the session reads it: no space at the ends, and one space between words. */
function normalizeQuery(value: string): string {
    return value.trim().replace(/\s+/g, ' ')
}

/** The status line of a search that is complete. */
export function resultCountText(count: number): string {
    if (count === 0) return 'No results'
    if (count >= SEARCH_RESULT_LIMIT) {
        return `${SEARCH_RESULT_LIMIT} results. The search stops at ${SEARCH_RESULT_LIMIT}.`
    }
    return count === 1 ? '1 result' : `${count} results`
}

function hasTouchKeyboard(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

export function createSearchPanel({ session, host }: PartOptions): SearchPanel {
    const root = document.importNode(template, true)
    const dialog = qs<HTMLDialogElement>('.search-panel', root)
    const input = qs<HTMLInputElement>('input[type="search"]', dialog)
    const statusText = qs('.search-status-text', dialog)
    const announcer = qs('[role="status"]', dialog)
    const progress = qs('.progress', dialog)
    const list = qs('.list', dialog)

    connectDialog(dialog)
    host.append(dialog)

    let state: SearchState = 'idle'
    /** The query of the rows in the list. */
    let activeQuery = ''
    /** Goes up at each new search and each clear. Calls of an older search are ignored. */
    let searchId = 0
    let controller: AbortController | null = null
    let results: SearchResult[] = []
    /** The number of results that have a row. */
    let rendered = 0
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let chunkTimer: ReturnType<typeof setTimeout> | undefined
    /** The one row that the Tab key stops at. The arrow keys move between the rows. */
    let tabStop: HTMLElement | null = null
    /** The row of the result that the user opened last. */
    let opened: HTMLElement | null = null

    function setStatus(text: string): void {
        if (statusText.textContent !== text) statusText.textContent = text
    }

    function setProgress(fraction: number | null): void {
        progress.hidden = fraction === null
        if (fraction === null) return
        progress.style.setProperty('--value', String(fraction))
        progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)))
    }

    function setTabStop(row: HTMLElement | null): void {
        if (tabStop === row) return
        if (tabStop) tabStop.tabIndex = -1
        if (row) row.tabIndex = 0
        tabStop = row
    }

    function setOpened(row: HTMLElement | null): void {
        opened?.removeAttribute('aria-current')
        row?.setAttribute('aria-current', 'true')
        opened = row
        if (row) setTabStop(row)
    }

    function buildRow(index: number): HTMLElement {
        const { excerpt, matchStart, matchEnd, chapterTitle, range } = results[index]
        const item = makeRow()
        const button = qs('.list-row', item)
        button.dataset.index = String(index)

        // Three text nodes: the text before the match, the match in a mark, the text after it.
        const start = Math.min(Math.max(0, matchStart), excerpt.length)
        const end = Math.min(Math.max(start, matchEnd), excerpt.length)
        const mark = document.createElement('mark')
        mark.className = 'search-match'
        mark.append(excerpt.slice(start, end))
        qs('.list-row-title', button).append(excerpt.slice(0, start), mark, excerpt.slice(end))

        const chapter = qs('.list-row-meta', button)
        chapter.textContent = chapterTitle
        chapter.hidden = chapterTitle === ''
        qs('.list-row-trail', button).textContent = percentText(
            session.fractionOf({ spineIndex: range.spineIndex, offset: range.start }),
        )
        return item
    }

    /** Makes the rows of some results. The rest waits for a new task, so input can run. */
    function renderChunk(): void {
        chunkTimer = undefined
        const end = Math.min(results.length, rendered + SEARCH_ROWS_PER_CHUNK)
        const rows = document.createDocumentFragment()
        while (rendered < end) rows.append(buildRow(rendered++))
        list.append(rows)
        if (!tabStop) setTabStop(list.querySelector<HTMLElement>('.list-row'))
        if (rendered < results.length) chunkTimer = setTimeout(renderChunk, 0)
    }

    function addResults(found: readonly SearchResult[]): void {
        const room = SEARCH_RESULT_LIMIT - results.length
        for (const result of found.slice(0, Math.max(0, room))) results.push(result)
        // A chunk that waits also makes the new rows.
        if (chunkTimer === undefined && rendered < results.length) renderChunk()
    }

    /** Stops the search that runs and removes the results. */
    function reset(): void {
        searchId++
        controller?.abort()
        controller = null
        clearTimeout(debounceTimer)
        clearTimeout(chunkTimer)
        debounceTimer = undefined
        chunkTimer = undefined
        results = []
        rendered = 0
        tabStop = null
        opened = null
        list.replaceChildren()
        setProgress(null)
        announcer.textContent = ''
    }

    function finish(nextState: 'done' | 'failed'): void {
        state = nextState
        controller = null
        setProgress(null)
        const text =
            nextState === 'done'
                ? resultCountText(results.length)
                : 'The search did not finish. Press Enter to try again.'
        setStatus(text)
        announcer.textContent = text
    }

    /** Starts the search for the text of the field now. The same query does not start again. */
    function start(): void {
        const query = normalizeQuery(input.value)
        if (query === activeQuery && state !== 'failed') {
            clearTimeout(debounceTimer)
            debounceTimer = undefined
            return
        }
        reset()
        activeQuery = query

        if (query.length < SEARCH_MIN_QUERY_LENGTH) {
            state = 'idle'
            session.clearSearch()
            setStatus(query === '' ? '' : `Type ${SEARCH_MIN_QUERY_LENGTH} or more characters.`)
            return
        }

        const id = searchId
        const { signal } = (controller = new AbortController())
        state = 'searching'
        setStatus('Searching')
        setProgress(0)
        session
            .search({
                query,
                signal,
                onResults(found) {
                    if (id === searchId) addResults(found)
                },
                onProgress(done, total) {
                    if (id !== searchId) return
                    setStatus(`Searching, ${done} of ${total} chapters`)
                    setProgress(total > 0 ? done / total : 0)
                },
            })
            .then(
                () => {
                    if (id === searchId) finish('done')
                },
                () => {
                    if (id === searchId) finish('failed')
                },
            )
    }

    function clear(): void {
        input.value = ''
        reset()
        activeQuery = ''
        state = 'idle'
        setStatus('')
        session.clearSearch()
        input.focus()
    }

    function goToResult(result: SearchResult, row: HTMLElement): void {
        setOpened(row)
        const { spineIndex, start: offset } = result.range
        ignoreRejection(session.goTo({ spineIndex, offset }, { remember: true }))
        dialog.close()
    }

    on(input, 'input', () => {
        clearTimeout(debounceTimer)
        debounceTimer = undefined
        // A short query has no search to wait for. The old results go at once.
        if (normalizeQuery(input.value).length < SEARCH_MIN_QUERY_LENGTH) start()
        else debounceTimer = setTimeout(start, SEARCH_DEBOUNCE_MS)
    })

    on(dialog, 'click', (event) => {
        const target = event.target as Element
        if (target.closest('[data-action="clear"]')) {
            clear()
            return
        }
        const row = target.closest<HTMLElement>('[data-index]')
        const result = row ? results[Number(row.dataset.index)] : undefined
        if (row && result) goToResult(result, row)
    })

    function rowBeside(row: HTMLElement, direction: 'next' | 'previous'): HTMLElement | null {
        const item = row.parentElement
        const beside =
            direction === 'next' ? item?.nextElementSibling : item?.previousElementSibling
        return beside?.querySelector<HTMLElement>('.list-row') ?? null
    }

    function focusRow(row: HTMLElement | null): void {
        if (!row) return
        setTabStop(row)
        row.focus()
    }

    on(dialog, 'keydown', (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        const { key } = event
        const target = event.target as Element
        const row = target.closest<HTMLElement>('[data-index]')

        if (!row) {
            // A key in a button of the header keeps its own action.
            if (target !== input && target !== dialog) return
            if (key === 'Enter' && target === input && !event.isComposing) {
                event.preventDefault()
                start()
                // The keyboard of a phone covers the results. It closes when the field loses
                // the focus. The sheet takes the focus, so the arrow keys still reach the list.
                if (hasTouchKeyboard()) dialog.focus({ preventScroll: true })
            } else if (key === 'ArrowDown' && tabStop) {
                event.preventDefault()
                focusRow(tabStop)
            }
            return
        }

        if (key === 'ArrowDown') {
            event.preventDefault()
            focusRow(rowBeside(row, 'next'))
        } else if (key === 'ArrowUp') {
            event.preventDefault()
            const previous = rowBeside(row, 'previous')
            if (previous) focusRow(previous)
            else input.focus()
        } else if (key === 'Home') {
            event.preventDefault()
            focusRow(list.firstElementChild?.querySelector<HTMLElement>('.list-row') ?? null)
        } else if (key === 'End') {
            event.preventDefault()
            focusRow(list.lastElementChild?.querySelector<HTMLElement>('.list-row') ?? null)
        }
    })

    return {
        open(query) {
            if (query !== undefined) input.value = query
            // With results from the last time, the user continues at the result that was opened.
            // The field does not get the focus then, so the keyboard of a phone stays closed.
            const row = query === undefined && opened?.isConnected ? opened : null
            input.toggleAttribute('autofocus', !row)
            row?.toggleAttribute('autofocus', true)
            openDialog(dialog)
            row?.removeAttribute('autofocus')
            if (query !== undefined) start()
            if (row) {
                row.focus()
            } else {
                input.focus()
                input.select()
            }
        },
        close() {
            dialog.close()
        },
        destroy() {
            reset()
            // The toasts of the app wait for the close event of an open dialog.
            if (dialog.open) dialog.close()
            dialog.remove()
        },
    }
}
