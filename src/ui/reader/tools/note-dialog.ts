/** The dialog that adds, changes or removes the note of a highlight. */

import type { HighlightRecord } from '$lib/storage/types'
import { openDialog } from '../../app/dialog'
import { showToast } from '../../app/toast'
import { on, qs } from '../../dom'
import { templateOf } from './template'

export const NOTE_MAX_LENGTH = 5000

export const NOTE_SAVE_ERROR = 'The note was not saved.'

export interface NoteDialogOptions {
    /** The dialog goes into this element. */
    host: HTMLElement
    /** Writes the note. An empty text removes it. Rejects when storage did not write. */
    save(id: string, note: string): Promise<void>
}

export interface NoteDialog {
    readonly isOpen: boolean
    open(highlight: HighlightRecord): void
    destroy(): void
}

const createDialog = templateOf<HTMLDialogElement>(`
<dialog class="modal note-dialog">
    <h2 class="modal-title"></h2>
    <blockquote class="note-dialog-quote"></blockquote>
    <textarea
        class="input note-dialog-input"
        aria-label="Note"
        maxlength="${NOTE_MAX_LENGTH}"
        rows="5"
        autofocus
    ></textarea>
    <p class="field-error note-dialog-error" role="alert" hidden></p>
    <div class="modal-actions">
        <button type="button" class="btn btn-quiet btn-danger note-dialog-remove" data-action="remove">
            Remove note
        </button>
        <button type="button" class="btn btn-quiet" data-action="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-action="save">Save</button>
    </div>
</dialog>`)

let dialogCount = 0

export function createNoteDialog({ host, save }: NoteDialogOptions): NoteDialog {
    const dialog = createDialog()
    const title = qs('.modal-title', dialog)
    const quote = qs('.note-dialog-quote', dialog)
    const input = qs<HTMLTextAreaElement>('.note-dialog-input', dialog)
    const error = qs('.note-dialog-error', dialog)
    const removeButton = qs<HTMLButtonElement>('[data-action="remove"]', dialog)
    const saveButton = qs<HTMLButtonElement>('[data-action="save"]', dialog)

    title.id = `note-dialog-title-${++dialogCount}`
    dialog.setAttribute('aria-labelledby', title.id)
    host.append(dialog)

    let current: HighlightRecord | null = null
    let busy = false

    function setBusy(value: boolean): void {
        busy = value
        saveButton.disabled = value
        removeButton.disabled = value
    }

    async function write(note: string): Promise<void> {
        const highlight = current
        if (!highlight || busy) return
        setBusy(true)
        error.hidden = true
        try {
            await save(highlight.id, note)
            if (current === highlight) dialog.close()
        } catch {
            // The dialog stays open, so the user does not lose the text.
            if (current === highlight) {
                error.textContent = NOTE_SAVE_ERROR
                error.hidden = false
            } else {
                showToast({ message: NOTE_SAVE_ERROR, tone: 'error' })
            }
        } finally {
            setBusy(false)
        }
    }

    function submit(): void {
        void write(input.value.trim().slice(0, NOTE_MAX_LENGTH))
    }

    const stops = [
        on(dialog, 'click', (event) => {
            const button = (event.target as Element).closest<HTMLElement>('[data-action]')
            switch (button?.dataset.action) {
                case 'save':
                    submit()
                    break
                case 'remove':
                    void write('')
                    break
                case 'cancel':
                    dialog.close()
                    break
            }
        }),
        on(input, 'keydown', (event) => {
            if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
            event.preventDefault()
            submit()
        }),
        // The keys of the text field must not reach the shortcuts of the reader.
        on(dialog, 'keydown', (event) => event.stopPropagation()),
        on(dialog, 'close', () => {
            // The event comes late. The dialog can be open again for a different highlight.
            if (!dialog.open) current = null
        }),
    ]

    return {
        get isOpen() {
            return dialog.open
        },
        open(highlight) {
            if (dialog.open) dialog.close()
            current = highlight
            const hasNote = highlight.note !== ''
            title.textContent = hasNote ? 'Edit note' : 'Add note'
            quote.textContent = highlight.text
            input.value = highlight.note
            removeButton.hidden = !hasNote
            error.hidden = true
            setBusy(false)
            openDialog(dialog)
            input.focus({ preventScroll: true })
            input.setSelectionRange(input.value.length, input.value.length)
        },
        destroy() {
            for (const stop of stops) stop()
            current = null
            if (dialog.open) dialog.close()
            dialog.remove()
        },
    }
}
