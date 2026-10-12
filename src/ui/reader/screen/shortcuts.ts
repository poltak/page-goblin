/**
 * The dialog that lists the keyboard shortcuts. The reader screen loads this file when the
 * user opens the dialog for the first time.
 */

import './shortcuts.css'
import { connectDialog, openDialog } from '../../app/dialog'
import { qs } from '../../dom'
import type { Part } from '../parts'

export interface ShortcutsDialog extends Part {
    open(): void
}

export interface ShortcutsOptions {
    /** The overlay layer of the reader screen. */
    host: HTMLElement
}

interface Shortcut {
    keys: readonly string[]
    action: string
}

interface ShortcutGroup {
    title: string
    shortcuts: readonly Shortcut[]
    note?: string
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
    {
        title: 'Reading',
        shortcuts: [
            { keys: ['Right arrow', 'Page Down', 'Space'], action: 'Next page' },
            { keys: ['Left arrow', 'Page Up', 'Shift + Space'], action: 'Previous page' },
            { keys: ['Up arrow', 'Down arrow'], action: 'Scroll by a small step' },
            { keys: ['T'], action: 'Contents' },
            { keys: ['B'], action: 'Bookmark this page' },
            { keys: ['A'], action: 'Reading settings' },
            { keys: ['/', 'Ctrl + F', 'Cmd + F'], action: 'Search' },
            { keys: ['S'], action: 'Speed read' },
            { keys: ['L'], action: 'Listen' },
            { keys: ['F'], action: 'Full screen' },
            { keys: ['+'], action: 'Larger text' },
            { keys: ['-'], action: 'Smaller text' },
            { keys: ['Backspace'], action: 'Go back after a jump' },
            { keys: ['Esc'], action: 'Hide the toolbars' },
            { keys: ['?'], action: 'Keyboard shortcuts' },
        ],
        note: 'In the scroll view, the page keys scroll the text. The Up and Down arrows work only there.',
    },
    {
        title: 'Speed reader',
        shortcuts: [
            { keys: ['Space', 'K'], action: 'Play or pause' },
            { keys: ['Left arrow', 'Right arrow'], action: 'Previous or next sentence' },
            { keys: ['Up arrow', 'Down arrow'], action: 'Faster or slower' },
            { keys: ['R'], action: 'Rewind while you hold the key' },
            { keys: ['F'], action: 'Full screen' },
            { keys: ['Esc'], action: 'Close the speed reader' },
        ],
    },
    {
        title: 'Listening',
        shortcuts: [
            { keys: ['Space', 'K'], action: 'Play or pause' },
            { keys: ['Left arrow', 'Right arrow'], action: 'Previous or next sentence' },
            { keys: ['Page Down', 'Page Up'], action: 'Next or previous page' },
            { keys: ['Esc'], action: 'Stop listening' },
        ],
        note: 'The other reading keys also work while the book is read aloud.',
    },
]

const DIALOG_MARKUP = `
<dialog class="modal reader-shortcuts" aria-labelledby="reader-shortcuts-title" closedby="any">
    <h2 class="modal-title" id="reader-shortcuts-title">Keyboard shortcuts</h2>
    <div
        class="reader-shortcuts-groups"
        role="group"
        aria-label="List of shortcuts"
        tabindex="0"
    ></div>
    <div class="modal-actions">
        <button class="btn btn-primary" type="button" data-close>Done</button>
    </div>
</dialog>`

const GROUP_MARKUP = `
<section class="reader-shortcuts-group">
    <h3 class="section-label"></h3>
    <table class="reader-shortcuts-table">
        <thead class="visually-hidden">
            <tr><th scope="col">Keys</th><th scope="col">Action</th></tr>
        </thead>
        <tbody></tbody>
    </table>
</section>`

const ROW_MARKUP = '<tr><th scope="row"></th><td></td></tr>'

function template(markup: string): HTMLTemplateElement {
    const element = document.createElement('template')
    element.innerHTML = markup.trim()
    return element
}

function clone<T extends Element>(source: HTMLTemplateElement): T {
    return document.importNode(source.content.firstElementChild!, true) as T
}

function build(): HTMLDialogElement {
    const dialog = clone<HTMLDialogElement>(template(DIALOG_MARKUP))
    const groups = qs('.reader-shortcuts-groups', dialog)
    const groupTemplate = template(GROUP_MARKUP)
    const rowTemplate = template(ROW_MARKUP)

    for (const group of SHORTCUT_GROUPS) {
        const section = clone<HTMLElement>(groupTemplate)
        qs('.section-label', section).textContent = group.title
        const body = qs('tbody', section)
        for (const shortcut of group.shortcuts) {
            const row = clone<HTMLTableRowElement>(rowTemplate)
            const keys = qs('th', row)
            for (const key of shortcut.keys) {
                const cap = document.createElement('kbd')
                cap.textContent = key
                // The space lets a long list of keys wrap, and a screen reader hears a pause.
                keys.append(cap, ' ')
            }
            qs('td', row).textContent = shortcut.action
            body.append(row)
        }
        if (group.note) {
            const note = document.createElement('p')
            note.className = 'reader-shortcuts-note'
            note.textContent = group.note
            section.append(note)
        }
        groups.append(section)
    }
    return dialog
}

export function createShortcutsDialog({ host }: ShortcutsOptions): ShortcutsDialog {
    const dialog = build()
    connectDialog(dialog)
    host.append(dialog)

    return {
        open() {
            openDialog(dialog)
        },
        destroy() {
            if (dialog.open) dialog.close()
            dialog.remove()
        },
    }
}
