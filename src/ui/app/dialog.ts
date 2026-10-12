/** Behaviour that all dialogs of the app shell share. */

/**
 * Opens a modal dialog. When it closes, the focus goes back to the element that opened it.
 * The default opener is the element that has the focus now.
 */
export function openDialog(
    dialog: HTMLDialogElement,
    opener: Element | null = document.activeElement,
): void {
    if (dialog.open) return
    // The value of the last close must not count for this one.
    dialog.returnValue = ''
    dialog.showModal()
    dialog.addEventListener(
        'close',
        () => {
            if (opener instanceof HTMLElement && opener.isConnected) {
                opener.focus({ preventScroll: true })
            }
        },
        { once: true },
    )
}

/** Resolves with the return value of the dialog when it closes. */
export function whenClosed(dialog: HTMLDialogElement): Promise<string> {
    return new Promise((resolve) => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true })
    })
}

/**
 * Connects a dialog of the page:
 * - a button with `data-close` closes the dialog, and its value becomes the return value
 * - a press on the backdrop closes the dialog in a browser that has no `closedby` attribute
 */
export function connectDialog(dialog: HTMLDialogElement): void {
    const hasClosedBy = 'closedBy' in HTMLDialogElement.prototype

    dialog.addEventListener('click', (event) => {
        const target = event.target as Element
        const button = target.closest<HTMLButtonElement>('[data-close]')
        if (button) {
            dialog.close(button.value)
            return
        }
        // A press on the backdrop has the dialog as its target. A press on the padding of the
        // dialog has it too, so compare the point with the box. One layout read for a press.
        if (hasClosedBy || target !== dialog) return
        const box = dialog.getBoundingClientRect()
        const inside =
            event.clientX >= box.left &&
            event.clientX <= box.right &&
            event.clientY >= box.top &&
            event.clientY <= box.bottom
        if (!inside) dialog.close('')
    })
}
