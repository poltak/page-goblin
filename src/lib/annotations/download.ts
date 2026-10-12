/**
 * Gives text to the user: as a file download or through the clipboard.
 */

export interface DownloadTextFileOptions {
    /** The file name with its extension. */
    name: string
    text: string
    /** The media type, for example `text/markdown;charset=utf-8`. */
    type: string
}

/**
 * iOS Safari asks the user before it starts a download, and the URL must live until the answer.
 * Until then the browser keeps the text in memory.
 */
const REVOKE_DELAY_MS = 40_000

/** Characters that a file system does not accept in a file name. A book title can have them. */
const UNSAFE_NAME_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

function safeFileName(name: string): string {
    return name.replace(/\s+/g, ' ').replace(UNSAFE_NAME_CHARACTERS, '-').trim() || 'download'
}

/** Starts the download of a text file. Call it from the handler of a user action. */
export function downloadTextFile({ name, text, type }: DownloadTextFileOptions): void {
    const url = URL.createObjectURL(new Blob([text], { type }))

    const link = document.createElement('a')
    link.href = url
    link.download = safeFileName(name)
    link.hidden = true
    // Some browsers ignore a click on a link that is not in the document.
    document.body.append(link)
    link.click()
    link.remove()

    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}

/**
 * Puts the field into the page and gives it the focus. A modal dialog makes the page behind it
 * inert, and an inert field cannot get the focus, so the field then goes into the open dialog.
 */
function placeWithFocus(area: HTMLTextAreaElement): boolean {
    for (const host of [document.body, ...document.querySelectorAll('dialog[open]')]) {
        host.append(area)
        area.focus({ preventScroll: true })
        if (document.activeElement === area) return true
    }
    return false
}

/** The copy method for a page without the Clipboard API. It replaces the selection for a moment. */
function copyWithTextArea(text: string): boolean {
    if (typeof document.execCommand !== 'function') return false

    const selection = document.getSelection()
    const ranges: Range[] = []
    for (let index = 0; index < (selection?.rangeCount ?? 0); index++) {
        ranges.push(selection!.getRangeAt(index))
    }
    const focused = document.activeElement

    const area = document.createElement('textarea')
    area.value = text
    // A read-only field does not open the keyboard of a phone.
    area.readOnly = true
    area.setAttribute('aria-hidden', 'true')
    // A fixed position stops a scroll to the field. iOS Safari zooms the page when a field with
    // text smaller than 16px gets the focus.
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;font-size:16px'

    let copied = false
    // Without the focus in the field, the copy command copies the selection of the page.
    if (placeWithFocus(area)) {
        area.select()
        // iOS Safari selects nothing with select() alone.
        area.setSelectionRange(0, text.length)
        try {
            copied = document.execCommand('copy')
        } catch {
            copied = false
        }
    }
    area.remove()

    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
    if (selection && ranges.length > 0) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
    }
    return copied
}

/**
 * Copies text to the clipboard. The result is false when the browser refused. Call it from the
 * handler of a user action, because browsers refuse a copy that no user action started.
 */
export async function copyText(text: string): Promise<boolean> {
    // The Clipboard API is not there on a page without HTTPS. It rejects when the page has no
    // focus or no permission.
    if (typeof navigator.clipboard?.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text)
            return true
        } catch {
            // The older method can still work.
        }
    }
    return copyWithTextArea(text)
}
