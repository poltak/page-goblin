import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connectDialog, openDialog, whenClosed } from './dialog'
import { installOverlayMethods } from './testing/page'

let dialog: HTMLDialogElement
let opener: HTMLButtonElement

function press(target: Element, point: { clientX: number; clientY: number }): void {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...point }))
}

beforeEach(() => {
    installOverlayMethods()
    document.body.innerHTML = `
        <button id="opener">Open</button>
        <button id="other">Other</button>
        <dialog id="dialog">
            <p id="text">Text</p>
            <button id="cancel" data-close value="cancel">Cancel</button>
            <button id="confirm" data-close value="remove"><span id="label">Remove</span></button>
            <button id="plain">Plain</button>
        </dialog>`
    dialog = document.querySelector('dialog')!
    opener = document.querySelector('#opener')!
})

describe('openDialog', () => {
    it('opens the dialog as a modal dialog', () => {
        const showModal = vi.spyOn(dialog, 'showModal')

        openDialog(dialog, opener)

        expect(showModal).toHaveBeenCalledTimes(1)
        expect(dialog.open).toBe(true)
    })

    it('gives the focus back to the opener when the dialog closes', () => {
        openDialog(dialog, opener)
        document.querySelector<HTMLElement>('#other')!.focus()

        dialog.close()

        expect(document.activeElement).toBe(opener)
    })

    it('uses the element that has the focus as the default opener', () => {
        opener.focus()
        openDialog(dialog)
        document.querySelector<HTMLElement>('#other')!.focus()

        dialog.close()

        expect(document.activeElement).toBe(opener)
    })

    it('does not move the focus to an opener that left the page', () => {
        const other = document.querySelector<HTMLElement>('#other')!
        openDialog(dialog, opener)
        other.focus()
        opener.remove()

        dialog.close()

        expect(document.activeElement).toBe(other)
    })

    it('does not open a dialog that is open, and adds no second listener', () => {
        const focus = vi.spyOn(opener, 'focus')
        openDialog(dialog, opener)
        openDialog(dialog, opener)

        dialog.close()

        expect(focus).toHaveBeenCalledTimes(1)
    })

    it('clears the return value of the last close', async () => {
        connectDialog(dialog)
        openDialog(dialog, opener)
        document.querySelector<HTMLElement>('#confirm')!.click()
        expect(dialog.returnValue).toBe('remove')

        openDialog(dialog, opener)
        const closed = whenClosed(dialog)
        // A close with Escape gives no new value.
        dialog.close()

        expect(await closed).toBe('')
    })
})

describe('connectDialog', () => {
    beforeEach(() => {
        connectDialog(dialog)
        openDialog(dialog, opener)
    })

    it('closes with the value of a data-close button', async () => {
        const closed = whenClosed(dialog)

        document.querySelector<HTMLElement>('#cancel')!.click()

        expect(dialog.open).toBe(false)
        expect(await closed).toBe('cancel')
    })

    it('reads the button for a press on a child of the button', async () => {
        const closed = whenClosed(dialog)

        document.querySelector<HTMLElement>('#label')!.click()

        expect(await closed).toBe('remove')
    })

    it('stays open for a press on other content', () => {
        document.querySelector<HTMLElement>('#plain')!.click()
        document.querySelector<HTMLElement>('#text')!.click()

        expect(dialog.open).toBe(true)
    })

    it('closes for a press on the backdrop in a browser with no closedby attribute', () => {
        vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 300, 200))

        press(dialog, { clientX: 150, clientY: 150 })
        expect(dialog.open).toBe(true)

        press(dialog, { clientX: 20, clientY: 20 })
        expect(dialog.open).toBe(false)
    })

    it('does not read the box for a press inside the content', () => {
        const read = vi.spyOn(dialog, 'getBoundingClientRect')

        press(document.querySelector('#text')!, { clientX: 0, clientY: 0 })

        expect(read).not.toHaveBeenCalled()
        expect(dialog.open).toBe(true)
    })
})
