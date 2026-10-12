/**
 * The floating toolbar for a text selection, and the same kind of toolbar for a saved
 * highlight (change the colour, the note, copy, remove).
 *
 * All text of the book goes into the page through textContent or the value property.
 */

import './selection.css'
// Not from the index of the module: that would put the export and backup code into this
// chunk. The copy must start in the click handler, so a dynamic import is not possible.
import { copyText } from '$lib/annotations/download'
import { HIGHLIGHT_CLASS } from '$lib/reader/marks'
import type { SelectionInfo } from '$lib/reader/types'
import type { HighlightRecord } from '$lib/storage/types'
import { HIGHLIGHT_COLORS } from '$lib/types'
import type { HighlightColor } from '$lib/types'
import { TOAST_ACTION_DURATION_MS, showToast } from '../../app/toast'
import { on, qs, qsa } from '../../dom'
import type { IconName } from '../../dom'
import type { Part, SelectionToolsOptions } from '../parts'
import { watchScreenArea, isFloatOpen, moveFloat, setFloatOpen, startedIn } from './floating'
import { isGhostClick } from './ghost-click'
import { isHighlightColor, readLastColor, saveLastColor } from './last-color'
import { createNoteDialog } from './note-dialog'
import { dockFloating, placeFloating } from './place'
import type { Box, Side, Size } from './place'
import { onPositionChange } from './position-change'
import { iconMarkup, templateOf } from './template'

/** Time after the last selection event before the toolbar shows, when no pointer is down. */
export const SELECTION_SETTLE_MS = 300
/**
 * Time after the release of the pointer before the toolbar shows. The view reads the
 * selection again after the release, and its event must come first.
 */
export const RELEASE_SETTLE_MS = 40
/** A selection event in this time after the release is the result of the release. */
const RELEASE_WINDOW_MS = 250
/**
 * Time after the last selection event before the toolbar shows while a pointer is down. A
 * long press that selects a word can end with no pointer event for the page, and the toolbar
 * must not wait for the release without end.
 */
export const HELD_SETTLE_MS = 1500
/**
 * The longest time between the release on a toolbar button and its click. A mouse sends the
 * click in the task of the release. A touch screen can send it in a later task.
 */
export const CLICK_WAIT_MS = 400

export const SEARCH_QUERY_MAX = 80

export const HIGHLIGHT_SAVE_ERROR = 'The highlight was not saved.'
export const HIGHLIGHT_REMOVE_ERROR = 'The highlight was not removed.'
export const HIGHLIGHT_UNDO_ERROR = 'The highlight was not put back.'

const SWATCHES = HIGHLIGHT_COLORS.map(
    (color) =>
        `<button type="button" class="swatch swatch-${color}" data-color="${color}" ` +
        `aria-label="Highlight ${color}" aria-pressed="false"></button>`,
).join('')

function actionButton({
    action,
    icon,
    label,
}: {
    action: string
    icon: IconName
    label: string
}): string {
    return (
        `<button type="button" class="icon-btn" data-action="${action}" ` +
        `aria-label="${label}" title="${label}">${iconMarkup(icon)}</button>`
    )
}

const createSelectionBar = templateOf(`
<div class="float sel-bar" role="toolbar" aria-label="Selection">
    <div class="float-surface">
        <div class="sel-bar-body">
            <div class="sel-group" role="group" aria-label="Highlight colour">${SWATCHES}</div>
            <div class="sel-group sel-actions">
                ${actionButton({ action: 'note', icon: 'note', label: 'Add note' })}
                ${actionButton({ action: 'copy', icon: 'copy', label: 'Copy' })}
                ${actionButton({ action: 'search', icon: 'search', label: 'Search' })}
                ${actionButton({ action: 'speed', icon: 'zap', label: 'Speed read from here' })}
                ${actionButton({ action: 'listen', icon: 'headphones', label: 'Listen from here' })}
            </div>
        </div>
    </div>
</div>`)

const createEditBar = templateOf(`
<div class="float sel-bar" role="toolbar" aria-label="Highlight">
    <div class="float-surface">
        <p class="sel-note" hidden></p>
        <div class="sel-bar-body">
            <div class="sel-group" role="group" aria-label="Highlight colour">${SWATCHES}</div>
            <div class="sel-group sel-actions">
                ${actionButton({ action: 'note', icon: 'note', label: 'Add note' })}
                ${actionButton({ action: 'copy', icon: 'copy', label: 'Copy' })}
                ${actionButton({ action: 'remove', icon: 'trash', label: 'Remove highlight' })}
            </div>
        </div>
    </div>
</div>`)

/** The start of the text for a search, with no half of a surrogate pair at the end. */
export function searchQuery(text: string): string {
    let end = Math.min(text.length, SEARCH_QUERY_MAX)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    return text.slice(0, end).trim()
}

/** True when the press is on a saved highlight in the book text. */
function isOnHighlight(event: Event): boolean {
    return event
        .composedPath()
        .some(
            (target) =>
                target instanceof Element &&
                target.localName === 'mark' &&
                target.classList.contains(HIGHLIGHT_CLASS),
        )
}

function sizeOf(element: HTMLElement): Size {
    return { width: element.offsetWidth, height: element.offsetHeight }
}

function markColor(bar: HTMLElement, color: HighlightColor): void {
    for (const swatch of qsa('[data-color]', bar)) {
        swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color))
    }
}

export function createSelectionTools(options: SelectionToolsOptions): Part {
    const { session, host } = options

    const selectionBar = createSelectionBar()
    const editBar = createEditBar()
    const editNote = qs('.sel-note', editBar)
    const editNoteButton = qs<HTMLButtonElement>('[data-action="note"]', editBar)
    host.append(selectionBar, editBar)

    const noteDialog = createNoteDialog({
        host,
        save: (id, note) => session.updateHighlight(id, { note }),
    })

    // A phone shows its own selection menu next to the selection, above it or below it.
    const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null

    /** The selection that the toolbar is for, also while the toolbar waits for the end of a drag. */
    let current: SelectionInfo | null = null
    /** The highlight that the edit toolbar is open for. */
    let editing: HighlightRecord | null = null
    let editBounds: Box | null = null
    let editOpenedAt = 0
    let lastColor = readLastColor()
    /** The size of the selection toolbar. It changes only with the width of the screen. */
    let selectionBarSize: Size | null = null
    let showTimer: ReturnType<typeof setTimeout> | null = null
    let pressing = false
    let releasedAt = Number.NEGATIVE_INFINITY
    /** The toolbar that the last press started in. */
    let pressedBar: HTMLElement | null = null
    /** A press on the selection toolbar whose click did not come yet. */
    let barPress = false
    /** The selection at the start of that press. */
    let armed: SelectionInfo | null = null
    let hideAfterPress = false
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    /** The removed highlights that the Undo of the toast on screen adds again. */
    let undoBatch: HighlightRecord[] = []
    /** The end of the time of that toast. */
    let undoUntil = 0
    /** The press that closed the edit toolbar was on this highlight. Its tap must not open it again. */
    let closedByPress: string | null = null
    let destroyed = false

    const area = watchScreenArea(host, () => {
        selectionBarSize = null
        dismiss()
    })

    function clearShowTimer(): void {
        if (showTimer !== null) clearTimeout(showTimer)
        showTimer = null
    }

    function place(
        bar: HTMLElement,
        placement: { anchor: Box; size: Size; prefer: Side; gap?: number },
    ): void {
        const { viewport, safe } = area.get()
        moveFloat(bar, placeFloating({ ...placement, viewport, safe }))
    }

    function closeEditBar(): void {
        editing = null
        editBounds = null
        setFloatOpen(editBar, false)
    }

    /** Close both toolbars. The selection toolbar stays closed until the selection changes. */
    function dismiss(): void {
        clearShowTimer()
        current = null
        hideAfterPress = false
        // A hidden button that keeps the focus would also keep the keys from the page.
        const focused = document.activeElement
        if (focused instanceof HTMLElement && selectionBar.contains(focused)) focused.blur()
        setFloatOpen(selectionBar, false)
        closeEditBar()
    }

    function showSelectionBar(): void {
        showTimer = null
        if (destroyed || !current) return
        closeEditBar()
        markColor(selectionBar, lastColor)
        // One layout read, at the first time and after a resize.
        selectionBarSize ??= sizeOf(selectionBar)
        if (coarse?.matches) {
            // The toolbar stays clear of the system menu at an edge of the screen.
            const { viewport, safe } = area.get()
            moveFloat(
                selectionBar,
                dockFloating({ anchor: current.bounds, size: selectionBarSize, viewport, safe }),
            )
        } else {
            place(selectionBar, {
                anchor: current.bounds,
                size: selectionBarSize,
                prefer: 'above',
            })
        }
        setFloatOpen(selectionBar, true)
    }

    function renderEditBar(highlight: HighlightRecord): void {
        const hasNote = highlight.note !== ''
        const label = hasNote ? 'Edit note' : 'Add note'
        markColor(editBar, highlight.color)
        editNote.textContent = highlight.note
        editNote.hidden = !hasNote
        editNoteButton.setAttribute('aria-label', label)
        editNoteButton.title = label
    }

    function showEditBar(highlight: HighlightRecord, bounds: Box): void {
        clearShowTimer()
        current = null
        setFloatOpen(selectionBar, false)
        editing = highlight
        editBounds = bounds
        editOpenedAt = Date.now()
        renderEditBar(highlight)
        // The size changes with the note text. One layout read for each tap on a highlight.
        place(editBar, { anchor: bounds, size: sizeOf(editBar), prefer: 'above' })
        setFloatOpen(editBar, true)
    }

    function useColor(color: HighlightColor): void {
        lastColor = color
        saveLastColor(color)
    }

    function saveFailed(): void {
        showToast({ message: HIGHLIGHT_SAVE_ERROR, tone: 'error' })
    }

    /** Resolves with null when storage did not write. */
    async function addHighlight(
        selection: SelectionInfo,
        color: HighlightColor,
    ): Promise<HighlightRecord | null> {
        try {
            return await session.addHighlight({
                range: selection.range,
                text: selection.text,
                color,
            })
        } catch {
            saveFailed()
            return null
        }
    }

    function copy(text: string): void {
        void copyText(text).then((copied) => {
            if (copied) showToast({ message: 'Copied' })
            else showToast({ message: 'The text was not copied.', tone: 'error' })
        })
    }

    function clearSelection(): void {
        session.view.clearSelection()
        dismiss()
    }

    function runSelectionAction(button: HTMLElement, selection: SelectionInfo): void {
        const { color, action } = button.dataset
        const { range } = selection
        const locator = { spineIndex: range.spineIndex, offset: range.start }

        if (isHighlightColor(color)) {
            useColor(color)
            // The session clears the selection after the write. The toolbar closes now, so a
            // second click cannot add the highlight two times.
            dismiss()
            void addHighlight(selection, color)
            return
        }
        switch (action) {
            case 'note':
                dismiss()
                void addHighlight(selection, lastColor).then((highlight) => {
                    if (highlight && !destroyed) noteDialog.open(highlight)
                })
                break
            case 'copy':
                copy(selection.text)
                clearSelection()
                break
            case 'search':
                options.onSearch(searchQuery(selection.text))
                clearSelection()
                break
            case 'speed':
                options.onSpeedRead(locator)
                clearSelection()
                break
            case 'listen':
                // Speech must start in the handler of the click, so the call comes first.
                options.onListen(locator)
                clearSelection()
                break
        }
    }

    /** The Undo of a removal. The toast can be on screen after the reader closed the book. */
    async function addAgain(removed: HighlightRecord): Promise<void> {
        const { spineIndex, start, end, text, color, note } = removed
        try {
            const added = await session.addHighlight({
                range: { spineIndex, start, end },
                text,
                color,
                note,
            })
            // A record that the session does not have is not in storage.
            if (session.highlights.some((highlight) => highlight.id === added.id)) return
        } catch {
            // Storage did not write, or the book is closed.
        }
        showToast({ message: HIGHLIGHT_UNDO_ERROR, tone: 'error' })
    }

    async function removeHighlight(highlight: HighlightRecord): Promise<void> {
        try {
            await session.removeHighlight(highlight.id)
        } catch {
            showToast({ message: HIGHLIGHT_REMOVE_ERROR, tone: 'error' })
            return
        }
        // The toast module shows one toast for one message. A highlight that is removed in
        // the time of that toast gets no toast of its own, so the Undo of the toast on
        // screen adds each of these highlights again.
        const now = Date.now()
        if (now >= undoUntil) undoBatch = []
        // An empty list has no toast on screen: the time of the toast ended, or its Undo
        // was used. The next toast gets its full time.
        if (undoBatch.length === 0) undoUntil = now + TOAST_ACTION_DURATION_MS
        const batch = undoBatch
        batch.push(highlight)
        showToast({
            message: 'Highlight removed',
            action: {
                label: 'Undo',
                onSelect: () => batch.splice(0).forEach((removed) => void addAgain(removed)),
            },
        })
    }

    function runEditAction(button: HTMLElement, highlight: HighlightRecord): void {
        const { color, action } = button.dataset

        if (isHighlightColor(color)) {
            useColor(color)
            // The 'highlights' event sets the mark again from the saved record.
            markColor(editBar, color)
            session.updateHighlight(highlight.id, { color }).catch(() => {
                if (editing?.id === highlight.id) markColor(editBar, editing.color)
                saveFailed()
            })
            return
        }
        switch (action) {
            case 'note':
                // The dialog takes the element that has the focus as its opener, so it opens
                // before the toolbar closes.
                noteDialog.open(highlight)
                closeEditBar()
                break
            case 'copy':
                copy(highlight.text)
                closeEditBar()
                break
            case 'remove':
                closeEditBar()
                void removeHighlight(highlight)
                break
        }
    }

    function onSelection(selection: SelectionInfo | null): void {
        clearShowTimer()
        current = selection
        if (!selection) {
            // On a touch screen the press on a toolbar button can clear the selection. The
            // toolbar stays until the click of that press came.
            if (barPress) hideAfterPress = true
            else setFloatOpen(selectionBar, false)
            return
        }
        closeEditBar()
        // The toolbar does not follow the selection during a drag.
        setFloatOpen(selectionBar, false)
        if (pressing) showTimer = setTimeout(showSelectionBar, HELD_SETTLE_MS)
        else if (Date.now() - releasedAt < RELEASE_WINDOW_MS) showSelectionBar()
        else showTimer = setTimeout(showSelectionBar, SELECTION_SETTLE_MS)
    }

    function onHighlights(highlights: readonly HighlightRecord[]): void {
        if (!editing || !editBounds) return
        const id = editing.id
        const saved = highlights.find((highlight) => highlight.id === id)
        if (!saved) {
            closeEditBar()
        } else if (saved !== editing) {
            editing = saved
            renderEditBar(saved)
            place(editBar, { anchor: editBounds, size: sizeOf(editBar), prefer: 'above' })
        }
    }

    /** The press on the selection toolbar is over: its click came, or no click comes. */
    function endBarPress(): void {
        if (pressTimer !== null) clearTimeout(pressTimer)
        pressTimer = null
        barPress = false
        armed = null
        if (hideAfterPress) {
            hideAfterPress = false
            setFloatOpen(selectionBar, false)
        }
    }

    function onPress(event: PointerEvent): void {
        const inSelectionBar = startedIn(event, selectionBar)
        pressedBar = inSelectionBar ? selectionBar : startedIn(event, editBar) ? editBar : null
        if (pressedBar) {
            if (inSelectionBar) {
                if (pressTimer !== null) clearTimeout(pressTimer)
                pressTimer = null
                barPress = true
                // A second press can come before the click of the first one.
                armed = current ?? armed
            }
            // The default action of the press takes the text selection away.
            if ((event.target as Element).closest('button')) event.preventDefault()
            return
        }

        if (event.isPrimary) pressing = true
        closedByPress = null
        if (editing) {
            // A press on a highlight goes on to the view, which then sends 'highlight-tap'.
            // Each other press only closes the toolbar. It must not also turn the page.
            if (isOnHighlight(event)) closedByPress = editing.id
            else event.stopPropagation()
        }
        dismiss()
    }

    /** The press on the page is over. A selection that it made gets its toolbar. */
    function endPagePress(delay: number): void {
        pressing = false
        if (current && !isFloatOpen(selectionBar)) {
            clearShowTimer()
            showTimer = setTimeout(showSelectionBar, delay)
        }
    }

    function onRelease(event: PointerEvent): void {
        const released = event.type === 'pointerup'
        if (barPress && pressTimer === null) {
            // The click handler ends the press. The timer is for a press with no click.
            pressTimer = setTimeout(endBarPress, released ? CLICK_WAIT_MS : 0)
        }
        if (!event.isPrimary) return
        if (released) releasedAt = Date.now()
        // After a cancel the system has the pointer, for example for the handles of the
        // selection, and the selection can still change.
        endPagePress(released ? RELEASE_SETTLE_MS : SELECTION_SETTLE_MS)
    }

    function onBarKeydown(event: KeyboardEvent): void {
        // A key on a button of the toolbar must not also turn the page.
        event.stopPropagation()
        const { key } = event
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
        const buttons = qsa<HTMLButtonElement>('button', event.currentTarget as HTMLElement)
        const index = buttons.indexOf(event.target as HTMLButtonElement)
        if (index < 0) return
        event.preventDefault()
        let next = key === 'Home' ? 0 : buttons.length - 1
        if (key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length
        else if (key === 'ArrowRight') next = (index + 1) % buttons.length
        buttons[next].focus()
    }

    /**
     * The Tab key goes from the page to the open selection toolbar. The toolbar is after each
     * link of the book in the order of the Tab key, so the keyboard does not get to it without
     * this. Enter then adds a highlight in the colour that the user chose last.
     */
    function focusSelectionBar(event: KeyboardEvent): void {
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
        if (!current || !isFloatOpen(selectionBar)) return
        if (selectionBar.contains(document.activeElement)) return
        const swatch =
            selectionBar.querySelector<HTMLElement>('[aria-pressed="true"]') ??
            qs('button', selectionBar)
        swatch.focus({ preventScroll: true })
        // Below an open dialog the toolbar takes no focus, and the key stays with the dialog.
        if (document.activeElement === swatch) event.preventDefault()
    }

    const stops = [
        session.on('selection', onSelection),
        session.on('highlight-tap', ({ highlight, bounds }) => {
            const again = closedByPress === highlight.id
            closedByPress = null
            // The second tap on the same highlight closes its toolbar.
            if (!again) showEditBar(highlight, bounds)
        }),
        session.on('highlights', onHighlights),
        session.on('mode', dismiss),
        onPositionChange(session, dismiss),

        on(selectionBar, 'click', (event) => {
            const button = (event.target as Element).closest<HTMLElement>('button')
            const selection = armed ?? current
            endBarPress()
            if (button && selection) runSelectionAction(button, selection)
        }),
        on(editBar, 'click', (event) => {
            // The tap on the highlight opened the toolbar. Its click must not press a button.
            const opened = { openedAt: editOpenedAt, pressedInside: pressedBar === editBar }
            if (isGhostClick(event, opened)) return
            const button = (event.target as Element).closest<HTMLElement>('button')
            if (button && editing) runEditAction(button, editing)
        }),
        on(selectionBar, 'keydown', onBarKeydown),
        on(editBar, 'keydown', onBarKeydown),
        // Some browsers clear the selection on mousedown also when pointerdown was cancelled.
        on(selectionBar, 'mousedown', (event) => event.preventDefault()),

        on(document, 'pointerdown', onPress, true),
        on(document, 'pointerup', onRelease, true),
        on(document, 'pointercancel', onRelease, true),
        // The context menu of the system takes the release of the press that opened it.
        on(document, 'contextmenu', () => endPagePress(SELECTION_SETTLE_MS), true),
        on(
            document,
            'keydown',
            (event) => {
                if (event.key === 'Tab') focusSelectionBar(event)
                if (event.key !== 'Escape') return
                if (!isFloatOpen(selectionBar) && !isFloatOpen(editBar)) return
                dismiss()
                // The key closed the toolbar. It must not also close a panel or the book.
                event.stopPropagation()
            },
            true,
        ),
        // The toolbars have a fixed position, and the text that they belong to moves away.
        on(
            window,
            'scroll',
            () => {
                // A drag can scroll the page under the pointer. Its selection stays.
                const waits = showTimer !== null && !pressing
                if (isFloatOpen(selectionBar) || isFloatOpen(editBar) || waits) dismiss()
            },
            { capture: true, passive: true },
        ),
        on(window, 'blur', () => {
            pressing = false
        }),
    ]

    return {
        destroy() {
            if (destroyed) return
            destroyed = true
            clearShowTimer()
            if (pressTimer !== null) clearTimeout(pressTimer)
            for (const stop of stops) stop()
            area.destroy()
            noteDialog.destroy()
            selectionBar.remove()
            editBar.remove()
        },
    }
}
