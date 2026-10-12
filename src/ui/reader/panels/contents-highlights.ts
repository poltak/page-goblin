/**
 * The Highlights tab of the contents panel: the list, the menu of a row, the note dialog and
 * the export.
 *
 * The text of a highlight and its note go into the page through textContent and the value
 * property only.
 */

import type { HighlightRecord } from '$lib/storage/types'
import { HIGHLIGHT_COLORS } from '$lib/types'
import type { HighlightColor } from '$lib/types'
import { openDialog } from '../../app/dialog'
import { createMenu } from '../../app/menu'
import { showToast } from '../../app/toast'
import type { ToastOptions } from '../../app/toast'
import { on, qs, qsa } from '../../dom'
import type { ReaderSession } from '../types'
import { createKeyedList, ignoreRejection, renderKeepingFocus } from './shared'
import type { Notice } from './shared'

type Annotations = typeof import('$lib/annotations')

export type ExportKind = 'markdown' | 'kindle' | 'copy'

const COLOR_NAMES: Record<HighlightColor, string> = {
    yellow: 'Yellow',
    green: 'Green',
    blue: 'Blue',
    pink: 'Pink',
    purple: 'Purple',
}

export const HIGHLIGHT_UNDO_ERROR = 'The highlight was not put back.'

/** The longest file name start that a title gives. */
const FILE_NAME_MAX = 80

/**
 * A book title as the start of a file name. Only letters and digits stay (with their marks, in
 * each script), and a hyphen replaces each run of other characters.
 */
export function fileNameStem(title: string): string {
    const words = title
        .normalize('NFKC')
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '')
    // Code points, so the cut is not in the middle of a character.
    const stem = Array.from(words).slice(0, FILE_NAME_MAX).join('').replace(/-$/, '')
    return stem || 'book'
}

export interface HighlightsViewOptions {
    session: ReaderSession
    /** The sheet. It holds the two menus. */
    dialog: HTMLDialogElement
    noteDialog: HTMLDialogElement
    /** The tab panel of this view. */
    pane: HTMLElement
    notice: Notice
    makeRow(): HTMLElement
    /** Gets the focus when the last highlight is removed. */
    focusFallback: HTMLElement
    /** The user chose a highlight. The panel closes. */
    onGo(): void
}

export interface HighlightsView {
    render(): void
    /** Closes the two menus and the note dialog. */
    closeOverlays(): void
}

export function createHighlightsView(options: HighlightsViewOptions): HighlightsView {
    const { session, dialog, noteDialog, pane, notice } = options
    const list = qs('.list', pane)
    const empty = qs('.empty-state', pane)
    const actions = qs('.contents-actions', pane)
    const exportButton = qs('[data-action="export"]', actions)
    const rowMenuElement = qs('#contents-highlight-menu', dialog)
    const noteAction = qs('.contents-note-action', rowMenuElement)
    const swatches = qsa('.swatch', rowMenuElement)
    const noteTitle = qs('.modal-title', noteDialog)
    const noteField = qs<HTMLTextAreaElement>('textarea', noteDialog)
    const noteError = qs('.field-error', noteDialog)

    /** The highlight that the row menu is open for. */
    let menuId: string | null = null
    /** The highlight that the note dialog is open for. */
    let noteId: string | null = null
    /** Goes up at each open of the note dialog. A save that ends later knows its own open. */
    let noteOpening = 0
    /** The open of the note dialog that has a save in progress, or 0. */
    let savingOpening = 0

    function find(id: string | null): HighlightRecord | null {
        return session.highlights.find((highlight) => highlight.id === id) ?? null
    }

    const keyed = createKeyedList<HighlightRecord>({
        list,
        key: (highlight) => highlight.id,
        create: options.makeRow,
        fill(row, highlight) {
            const dot = qs('.contents-dot', row)
            dot.dataset.color = highlight.color
            dot.setAttribute('aria-label', COLOR_NAMES[highlight.color] ?? '')
            qs('.contents-highlight-text', row).textContent = highlight.text
            const note = qs('.contents-note', row)
            note.textContent = highlight.note
            note.hidden = highlight.note === ''
            const chapter = qs('.contents-chapter', row)
            chapter.textContent = highlight.chapterTitle
            chapter.hidden = highlight.chapterTitle === ''
        },
    })

    // Remove, with undo

    /** The highlights that the message on screen can add again. */
    let undo: { batch: HighlightRecord[]; message: ToastOptions } | null = null

    function notPutBack(): void {
        const message: ToastOptions = { message: HIGHLIGHT_UNDO_ERROR, tone: 'error' }
        // The Undo can be on screen as a toast of the app after the reader closed the book.
        // The notice of a panel that is gone shows nothing.
        if (dialog.isConnected) notice.show(message)
        else showToast(message)
    }

    async function restore(batch: HighlightRecord[]): Promise<void> {
        // The batch is emptied first, so a second run of the action adds nothing.
        for (const record of batch.splice(0)) {
            let isBack = false
            try {
                const added = await session.addHighlight({
                    range: { spineIndex: record.spineIndex, start: record.start, end: record.end },
                    text: record.text,
                    color: record.color,
                    ...(record.note ? { note: record.note } : {}),
                })
                // A record that the session does not have is not in storage.
                isBack = session.highlights.some((highlight) => highlight.id === added.id)
            } catch {
                // Storage did not write, or the book is closed.
            }
            if (!isBack) notPutBack()
        }
    }

    function offerUndo(removed: HighlightRecord): void {
        // While the message of the last removal is on screen, its action also covers this one.
        // That includes its time as a toast of the app after the sheet closed: the app shows
        // no second toast with the same text, so a separate Undo for this removal would be lost.
        const joins = undo !== null && undo.batch.length > 0 && notice.isLive(undo.message)
        const batch = undo && joins ? undo.batch : []
        batch.push(removed)
        const message: ToastOptions = {
            message:
                batch.length === 1 ? 'Highlight removed' : `${batch.length} highlights removed`,
            action: { label: 'Undo', onSelect: () => void restore(batch) },
        }
        undo = { batch, message }
        notice.show(message)
    }

    async function remove(highlight: HighlightRecord): Promise<void> {
        try {
            await session.removeHighlight(highlight.id)
        } catch {
            notice.show({ message: 'The highlight was not removed.', tone: 'error' })
            return
        }
        offerUndo(highlight)
    }

    async function setColor(highlight: HighlightRecord, color: HighlightColor): Promise<void> {
        try {
            await session.updateHighlight(highlight.id, { color })
        } catch {
            notice.show({ message: 'The colour was not changed.', tone: 'error' })
        }
    }

    // Note dialog

    function openNote(highlight: HighlightRecord, opener: HTMLElement): void {
        noteId = highlight.id
        noteOpening++
        noteTitle.textContent = highlight.note ? 'Edit note' : 'Add note'
        noteField.value = highlight.note
        noteError.hidden = true
        openDialog(noteDialog, opener)
        noteField.focus({ preventScroll: true })
    }

    async function saveNote(): Promise<void> {
        const opening = noteOpening
        // A second press on Save while the first one is at work.
        if (savingOpening === opening) return
        const highlight = find(noteId)
        const note = noteField.value.trim()
        if (!highlight || note === highlight.note) {
            noteDialog.close()
            return
        }
        // The user can cancel during the save and open the note of a different highlight.
        // The result of this save must not close or change that dialog.
        const isOnScreen = (): boolean => noteDialog.open && noteOpening === opening
        savingOpening = opening
        noteError.hidden = true
        try {
            await session.updateHighlight(highlight.id, { note })
            if (isOnScreen()) noteDialog.close()
        } catch {
            if (isOnScreen()) {
                // The dialog stays open, so the typed text is not lost.
                noteError.textContent = 'The note was not saved. Try again.'
                noteError.hidden = false
            } else {
                notice.show({ message: 'The note was not saved.', tone: 'error' })
            }
        } finally {
            if (savingOpening === opening) savingOpening = 0
        }
    }

    on(noteDialog, 'click', (event) => {
        const button = (event.target as Element).closest<HTMLElement>('[data-action]')
        if (button?.dataset.action === 'cancel-note') noteDialog.close()
        else if (button?.dataset.action === 'save-note') void saveNote()
    })

    on(noteField, 'keydown', (event) => {
        // Enter makes a new line. With Ctrl or Command it saves.
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
        event.preventDefault()
        void saveNote()
    })

    // Row menu

    const rowMenu = createMenu({
        menu: rowMenuElement,
        onOpen(anchor) {
            const highlight = keyed.itemOf(anchor)
            menuId = highlight?.id ?? null
            noteAction.textContent = highlight?.note ? 'Edit note' : 'Add note'
            for (const swatch of swatches) {
                swatch.setAttribute(
                    'aria-checked',
                    String(swatch.dataset.color === highlight?.color),
                )
            }
        },
        onSelect(item, anchor) {
            const highlight = find(menuId)
            if (!highlight) return
            if (item.dataset.action === 'note') openNote(highlight, anchor)
            else if (item.dataset.action === 'remove') void remove(highlight)
        },
    })

    // The swatches are not menu items of the menu helper, because they are in one row.
    on(rowMenuElement, 'click', (event) => {
        const swatch = (event.target as Element).closest<HTMLElement>('.swatch')
        if (!swatch) return
        rowMenu.close()
        const highlight = find(menuId)
        const color = swatch.dataset.color as HighlightColor
        if (!highlight || !HIGHLIGHT_COLORS.includes(color) || color === highlight.color) return
        void setColor(highlight, color)
    })

    on(rowMenuElement, 'keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const index = swatches.indexOf(document.activeElement as HTMLElement)
        if (index < 0) return
        event.preventDefault()
        const step = event.key === 'ArrowRight' ? 1 : -1
        swatches[(index + step + swatches.length) % swatches.length].focus()
    })

    on(list, 'click', (event) => {
        const target = event.target as Element
        const menuButton = target.closest<HTMLElement>('[data-menu]')
        if (menuButton) {
            // The menu helper opens the menu and sets its position.
            event.preventDefault()
            rowMenu.toggle(menuButton)
            return
        }
        const highlight = keyed.itemOf(target)
        if (!highlight || !target.closest('[data-go]')) return
        ignoreRejection(
            session.goTo(
                { spineIndex: highlight.spineIndex, offset: highlight.start },
                { remember: true },
            ),
        )
        options.onGo()
    })

    // Export

    let annotations: Annotations | null = null
    let loading: Promise<Annotations> | null = null

    function loadAnnotations(): Promise<Annotations> {
        return (loading ??= import('$lib/annotations').then(
            (module) => (annotations = module),
            (error: unknown) => {
                // The next export tries the load again.
                loading = null
                throw error
            },
        ))
    }

    function exportFailed(): void {
        notice.show({ message: 'The highlights were not exported.', tone: 'error' })
    }

    function deliver(kind: ExportKind, module: Annotations): void {
        const source = {
            book: session.record,
            highlights: session.highlights,
            bookmarks: session.bookmarks,
        }
        const stem = fileNameStem(session.record.title)
        if (kind === 'markdown') {
            module.downloadTextFile({
                name: `${stem}-highlights.md`,
                text: module.highlightsToMarkdown(source),
                type: 'text/markdown;charset=utf-8',
            })
        } else if (kind === 'kindle') {
            module.downloadTextFile({
                name: `${stem}-clippings.txt`,
                text: module.highlightsToKindleClippings(source),
                type: 'text/plain;charset=utf-8',
            })
        } else {
            void module.copyText(module.highlightsToMarkdown(source)).then((copied) => {
                notice.show(
                    copied
                        ? { message: 'Highlights copied' }
                        : { message: 'The highlights were not copied.', tone: 'error' },
                )
            })
        }
    }

    function runExport(kind: ExportKind): void {
        const run = (module: Annotations): void => {
            try {
                deliver(kind, module)
            } catch (error) {
                console.error(error)
                exportFailed()
            }
        }
        // Safari refuses a copy or a download that does not start in the handler of the tap.
        // The module loads when the menu opens, so it is here at this time in most cases.
        if (annotations) run(annotations)
        else loadAnnotations().then(run, exportFailed)
    }

    const exportMenu = createMenu({
        menu: qs('#contents-export-menu', dialog),
        onOpen() {
            loadAnnotations().catch(() => {})
        },
        onSelect(item) {
            const kind = item.dataset.export
            if (kind === 'markdown' || kind === 'kindle' || kind === 'copy') runExport(kind)
        },
    })

    on(exportButton, 'click', (event) => {
        event.preventDefault()
        exportMenu.toggle(exportButton)
    })

    return {
        render() {
            const highlights = session.highlights
            renderKeepingFocus({
                list,
                render: () => keyed.render(highlights),
                fallback: options.focusFallback,
            })
            const none = highlights.length === 0
            list.hidden = none
            actions.hidden = none
            empty.hidden = !none
        },
        closeOverlays() {
            // An open menu has listeners on the window. They go when it closes.
            rowMenu.close()
            exportMenu.close()
            if (noteDialog.open) noteDialog.close()
        },
    }
}
