import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installOverlayMethods } from '../../app/testing/page'
import { createShortcutsDialog, SHORTCUT_GROUPS } from './shortcuts'

function setup() {
    const host = document.createElement('div')
    document.body.append(host)
    const shortcuts = createShortcutsDialog({ host })
    const dialog = host.querySelector('dialog')!
    return { host, shortcuts, dialog }
}

/** The text of each row as 'keys => action'. */
function rows(dialog: HTMLElement): string[] {
    return Array.from(dialog.querySelectorAll('tbody tr'), (row) => {
        const keys = Array.from(row.querySelectorAll('kbd'), (key) => key.textContent)
        return `${keys.join(', ')} => ${row.querySelector('td')!.textContent}`
    })
}

describe('createShortcutsDialog', () => {
    beforeAll(installOverlayMethods)

    afterEach(() => {
        document.body.replaceChildren()
    })

    it('puts a closed modal dialog in the host', () => {
        const { dialog } = setup()
        expect(dialog.classList.contains('modal')).toBe(true)
        expect(dialog.open).toBe(false)
        const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)
        expect(title?.textContent).toBe('Keyboard shortcuts')
    })

    it('lists each key of the reader in a table with two columns', () => {
        const { dialog } = setup()
        const list = rows(dialog)
        expect(list).toEqual(
            expect.arrayContaining([
                'Right arrow, Page Down, Space => Next page',
                'Left arrow, Page Up, Shift + Space => Previous page',
                'T => Contents',
                'B => Bookmark this page',
                'A => Reading settings',
                '/, Ctrl + F, Cmd + F => Search',
                'S => Speed read',
                'L => Listen',
                'F => Full screen',
                '+ => Larger text',
                '- => Smaller text',
                'Backspace => Go back after a jump',
                'Esc => Hide the toolbars',
                '? => Keyboard shortcuts',
            ]),
        )
        for (const row of dialog.querySelectorAll('tbody tr')) {
            expect(row.children).toHaveLength(2)
        }
    })

    it('lists the keys of the speed reader and of the listen bar', () => {
        const { dialog } = setup()
        const titles = Array.from(dialog.querySelectorAll('h3'), (title) => title.textContent)
        expect(titles).toEqual(['Reading', 'Speed reader', 'Listening'])

        const [, speed, listen] = Array.from(dialog.querySelectorAll('section'))
        expect(rows(speed)).toEqual(
            expect.arrayContaining([
                'Space, K => Play or pause',
                'Left arrow, Right arrow => Previous or next sentence',
                'Up arrow, Down arrow => Faster or slower',
                'Esc => Close the speed reader',
            ]),
        )
        expect(rows(listen)).toEqual(
            expect.arrayContaining([
                'Space, K => Play or pause',
                'Left arrow, Right arrow => Previous or next sentence',
                'Esc => Stop listening',
            ]),
        )
    })

    it('has one row for each shortcut of the data', () => {
        const { dialog } = setup()
        const count = SHORTCUT_GROUPS.reduce((sum, group) => sum + group.shortcuts.length, 0)
        expect(dialog.querySelectorAll('tbody tr')).toHaveLength(count)
    })

    it('gives the first focus to the list at the top, not to the Done button at the end', () => {
        const { dialog } = setup()
        // The browser gives the focus to the first element of the dialog that can have it,
        // and scrolls to that element. The keys then scroll the list.
        const focusable = dialog.querySelectorAll<HTMLElement>('[tabindex], button')
        const list = dialog.querySelector<HTMLElement>('.reader-shortcuts-groups')!
        expect(focusable[0]).toBe(list)
        expect(list.tabIndex).toBe(0)
        expect(list.getAttribute('aria-label')).toBe('List of shortcuts')
        expect(list.querySelectorAll('section')).toHaveLength(SHORTCUT_GROUPS.length)
        expect(dialog.querySelector('[data-close]')!.closest('.reader-shortcuts-groups')).toBeNull()
    })

    it('opens, and closes with the Done button', () => {
        const { shortcuts, dialog } = setup()
        shortcuts.open()
        expect(dialog.open).toBe(true)
        dialog.querySelector<HTMLButtonElement>('[data-close]')!.click()
        expect(dialog.open).toBe(false)
    })

    it('gives the focus back to the element that opened it', () => {
        const { shortcuts, dialog } = setup()
        const opener = document.createElement('button')
        document.body.append(opener)
        opener.focus()

        shortcuts.open()
        dialog.querySelector<HTMLButtonElement>('[data-close]')!.focus()
        dialog.close()
        expect(document.activeElement).toBe(opener)
    })

    it('closes and removes the dialog in destroy()', () => {
        const { host, shortcuts, dialog } = setup()
        shortcuts.open()
        shortcuts.destroy()
        expect(dialog.open).toBe(false)
        expect(host.querySelector('dialog')).toBeNull()
    })
})
