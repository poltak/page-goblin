/**
 * The contents panel of the reader screen: a sheet with the tabs Contents, Bookmarks and
 * Highlights. The reader screen loads this file when the user opens the panel for the first
 * time.
 */

import { connectDialog, openDialog } from '../../app/dialog'
import { on, qs } from '../../dom'
import type { ContentsPanel, ContentsTab, PartOptions } from '../parts'
import { createBookmarksView } from './contents-bookmarks'
import { createHighlightsView } from './contents-highlights'
import { createTocView } from './contents-toc'
import markup from './contents.html?raw'
import { createNotice, parseMarkup, rowFactory } from './shared'
import './contents.css'

const TABS: readonly ContentsTab[] = ['contents', 'bookmarks', 'highlights']

const template = parseMarkup(markup)
const makeTocRow = rowFactory(template, 'toc')
const makeBookmarkRow = rowFactory(template, 'bookmark')
const makeHighlightRow = rowFactory(template, 'highlight')

export function createContentsPanel({ session, host }: PartOptions): ContentsPanel {
    const root = document.importNode(template, true)
    const dialog = qs<HTMLDialogElement>('.contents-panel', root)
    const noteDialog = qs<HTMLDialogElement>('.contents-note-dialog', root)
    const body = qs('.sheet-body', dialog)
    const tabList = qs('.tabs', dialog)
    const tabButton = (tab: ContentsTab) => qs<HTMLButtonElement>(`[data-tab="${tab}"]`, tabList)
    const tabPane = (tab: ContentsTab) => qs(`[data-pane="${tab}"]`, dialog)
    const tabs = TABS.map((name) => ({ name, button: tabButton(name), pane: tabPane(name) }))

    // The title comes from the book file. It is text, never markup.
    qs('.sheet-title', dialog).textContent = session.record.title
    connectDialog(dialog)
    host.append(dialog, noteDialog)

    const notice = createNotice(dialog)

    function close(): void {
        // The reader screen can close the panel while a menu or the note dialog is open. They
        // close first, so the focus goes back to the control that opened the sheet. A menu that
        // stays open with no place on screen would also take the next press on the page.
        highlights.closeOverlays()
        dialog.close()
    }

    const toc = createTocView({
        session,
        pane: tabPane('contents'),
        scroller: body,
        makeRow: makeTocRow,
        onGo: close,
    })
    const bookmarks = createBookmarksView({
        session,
        pane: tabPane('bookmarks'),
        notice,
        makeRow: makeBookmarkRow,
        focusFallback: tabButton('bookmarks'),
        onGo: close,
    })
    const highlights = createHighlightsView({
        session,
        dialog,
        noteDialog,
        pane: tabPane('highlights'),
        notice,
        makeRow: makeHighlightRow,
        focusFallback: tabButton('highlights'),
        onGo: close,
    })
    const views = { contents: toc, bookmarks, highlights }

    /** The tab that shows now, and at the next open that names no tab. */
    let selected: ContentsTab = 'contents'

    function setSelected(tab: ContentsTab): void {
        selected = tab
        for (const { name, button, pane } of tabs) {
            const isSelected = name === tab
            button.setAttribute('aria-selected', String(isSelected))
            // Only the selected tab is a stop of the Tab key. The arrow keys move between tabs.
            button.tabIndex = isSelected ? 0 : -1
            // The dialog gives the focus to this tab when it opens.
            button.toggleAttribute('autofocus', isSelected)
            pane.hidden = !isSelected
        }
    }

    /** Brings the pane of the selected tab up to date. The sheet must be open. */
    function showSelected(): void {
        views[selected].render()
        // The position in the book changed since the last open, so the row is found again.
        if (selected === 'contents') toc.centerCurrent()
    }

    function selectTab(tab: ContentsTab): void {
        if (tab === selected) return
        setSelected(tab)
        body.scrollTop = 0
        showSelected()
    }

    on(tabList, 'click', (event) => {
        const button = (event.target as Element).closest<HTMLElement>('[data-tab]')
        if (button) selectTab(button.dataset.tab as ContentsTab)
    })

    on(tabList, 'keydown', (event) => {
        const index = TABS.indexOf(selected)
        let next = index
        if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
        else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = TABS.length - 1
        else return
        event.preventDefault()
        selectTab(TABS[next])
        tabs[next].button.focus()
    })

    /** A list changed. Its pane is drawn again only while it is on screen. */
    function changed(tab: ContentsTab): void {
        if (dialog.open && selected === tab) views[tab].render()
    }

    const stops = [
        session.on('bookmarks', () => changed('bookmarks')),
        session.on('highlights', () => changed('highlights')),
        // The contents entry of the position can change a moment after a jump.
        session.on('relocate', () => changed('contents')),
    ]

    setSelected(selected)

    return {
        open(tab) {
            const otherTab = tab !== undefined && TABS.includes(tab) && tab !== selected
            if (otherTab) setSelected(tab)
            const wasOpen = dialog.open
            openDialog(dialog)
            if (!wasOpen) tabButton(selected).focus({ preventScroll: true })
            // The browser ignores a scroll write to a closed dialog, so it comes after the open.
            if (otherTab) body.scrollTop = 0
            showSelected()
        },
        close,
        destroy() {
            for (const stop of stops) stop()
            // A message on screen must not move to the toasts of the app at this close.
            notice.destroy()
            toc.destroy()
            highlights.closeOverlays()
            // The toasts of the app wait for the close event of an open dialog.
            if (dialog.open) dialog.close()
            dialog.remove()
            noteDialog.remove()
        },
    }
}
