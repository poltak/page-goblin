/** The Contents tab of the contents panel: the table of contents of the book. */

import { on, qs } from '../../dom'
import type { ReaderSession, TocEntry } from '../types'
import { centerInScroller, ignoreRejection, percentText, whenIdle } from './shared'

/** A list with more rows than this is made in steps, and its rows off screen are not drawn. */
export const TOC_LONG_LIST = 400
/** The number of rows that the first step and each later step make. */
export const TOC_ROWS_PER_STEP = 200
/** A deeper entry gets no more indent, so its title keeps some width on a phone. */
const MAX_LEVEL = 5
/** Rows after the current row that the first step also makes, so the row can be in the centre. */
const ROWS_AFTER_CURRENT = 20

export interface TocViewOptions {
    session: ReaderSession
    /** The tab panel of this view. */
    pane: HTMLElement
    /** The element that scrolls the pane. */
    scroller: HTMLElement
    makeRow(): HTMLElement
    /** The user chose an entry. The panel closes. */
    onGo(): void
}

export interface TocView {
    /** Makes the rows at the first call. Marks the row of the current position at each call. */
    render(): void
    /** Scrolls the row of the current position to the centre. The pane must be on screen. */
    centerCurrent(): void
    destroy(): void
}

export function createTocView({ session, pane, scroller, makeRow, onGo }: TocViewOptions): TocView {
    const list = qs('.list', pane)
    const empty = qs('.empty-state', pane)
    const entries = session.toc
    /** The row buttons that are made, by entry index. */
    const rows: HTMLElement[] = []
    let current: HTMLElement | null = null
    let cancelStep: (() => void) | null = null

    function indexOf(entry: TocEntry | null): number {
        if (!entry) return -1
        const index = entries.indexOf(entry)
        if (index >= 0) return index
        // A session that makes a new object for each answer.
        return entries.findIndex(
            (other) =>
                other.spineIndex === entry.spineIndex &&
                other.fragment === entry.fragment &&
                other.title === entry.title,
        )
    }

    function build(until: number): void {
        const fragment = document.createDocumentFragment()
        for (let index = rows.length; index < until; index++) {
            const entry = entries[index]
            const item = makeRow()
            const button = qs('.list-row', item)
            button.dataset.index = String(index)
            if (entry.depth > 0) {
                button.style.setProperty('--level', String(Math.min(entry.depth, MAX_LEVEL)))
            }
            qs('.list-row-title', button).textContent = entry.title.trim() || 'Untitled'
            qs('.list-row-trail', button).textContent = percentText(
                session.fractionOf({ spineIndex: entry.spineIndex, offset: 0 }),
            )
            rows.push(button)
            fragment.append(item)
        }
        list.append(fragment)
    }

    function markCurrent(): void {
        const row = rows[indexOf(session.currentTocEntry)] ?? null
        if (row === current) return
        current?.removeAttribute('aria-current')
        row?.setAttribute('aria-current', 'true')
        current = row
    }

    function buildNextStep(): void {
        cancelStep = null
        build(Math.min(entries.length, rows.length + TOC_ROWS_PER_STEP))
        // The position can be in a row that was not there at the last mark.
        markCurrent()
        if (rows.length < entries.length) cancelStep = whenIdle(buildNextStep)
    }

    function buildFirstStep(): void {
        list.hidden = entries.length === 0
        empty.hidden = entries.length > 0
        if (entries.length <= TOC_LONG_LIST) {
            build(entries.length)
            return
        }
        // The browser then skips the layout and the paint of the rows that are off screen.
        list.classList.add('list-long')
        // The row of the current position must be there when the panel opens.
        const needed = indexOf(session.currentTocEntry) + 1 + ROWS_AFTER_CURRENT
        build(Math.min(entries.length, Math.max(TOC_ROWS_PER_STEP, needed)))
        if (rows.length < entries.length) cancelStep = whenIdle(buildNextStep)
    }

    on(list, 'click', (event) => {
        const row = (event.target as Element).closest<HTMLElement>('[data-index]')
        const entry = row ? entries[Number(row.dataset.index)] : undefined
        if (!entry) return
        ignoreRejection(session.goToTocEntry(entry))
        onGo()
    })

    let started = false

    return {
        render() {
            if (!started) {
                started = true
                buildFirstStep()
            }
            markCurrent()
        },
        centerCurrent() {
            if (current) centerInScroller(scroller, current)
        },
        destroy() {
            cancelStep?.()
            cancelStep = null
        },
    }
}
