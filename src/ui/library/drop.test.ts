import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectFileDrop } from './drop'

interface FakeTransfer {
    types: string[]
    files: File[]
    dropEffect: string
}

const epub = new File(['bytes'], 'book.epub')

function fileTransfer(files: File[] = [epub]): FakeTransfer {
    return { types: ['Files'], files, dropEffect: 'none' }
}

function textTransfer(): FakeTransfer {
    return { types: ['text/plain', 'text/uri-list'], files: [], dropEffect: 'none' }
}

/** jsdom has no DragEvent, so a plain event carries the data. */
function drag(type: string, target: Element, dataTransfer: FakeTransfer): Event {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        dataTransfer,
    })
    target.dispatchEvent(event)
    return event
}

let overlay: HTMLElement
let first: HTMLElement
let second: HTMLElement
let active: boolean
let onFiles: ReturnType<typeof vi.fn<(files: File[]) => void>>
let stop: () => void

beforeEach(() => {
    document.body.innerHTML = '<div id="overlay" hidden></div><p id="one"></p><p id="two"></p>'
    overlay = document.getElementById('overlay')!
    first = document.getElementById('one')!
    second = document.getElementById('two')!
    active = true
    onFiles = vi.fn<(files: File[]) => void>()
    stop = connectFileDrop({ overlay, isActive: () => active, onFiles })
})

afterEach(() => {
    stop()
})

describe('connectFileDrop', () => {
    it('shows the overlay while files are above the window', () => {
        drag('dragenter', first, fileTransfer())
        expect(overlay.hidden).toBe(false)
    })

    it('keeps the overlay when the drag moves from one element to the next', () => {
        drag('dragenter', first, fileTransfer())
        // The browser sends the enter of the new element before the leave of the old one.
        drag('dragenter', second, fileTransfer())
        drag('dragleave', first, fileTransfer())

        expect(overlay.hidden).toBe(false)
    })

    it('hides the overlay when the drag leaves the window', () => {
        drag('dragenter', first, fileTransfer())
        drag('dragenter', second, fileTransfer())
        drag('dragleave', first, fileTransfer())
        drag('dragleave', second, fileTransfer())

        expect(overlay.hidden).toBe(true)
    })

    it('gives the dropped files to the listener and hides the overlay', () => {
        const other = new File(['more'], 'second.epub')
        drag('dragenter', first, fileTransfer())

        const event = drag('drop', first, fileTransfer([epub, other]))

        expect(onFiles).toHaveBeenCalledWith([epub, other])
        expect(overlay.hidden).toBe(true)
        // Without this the browser opens the file in place of the app.
        expect(event.defaultPrevented).toBe(true)
    })

    it('lets the browser know that a drop is possible', () => {
        const transfer = fileTransfer()
        const event = drag('dragover', first, transfer)

        expect(event.defaultPrevented).toBe(true)
        expect(transfer.dropEffect).toBe('copy')
    })

    it('ignores a drag that has no files', () => {
        const transfer = textTransfer()

        expect(drag('dragenter', first, transfer).defaultPrevented).toBe(false)
        expect(overlay.hidden).toBe(true)
        expect(drag('dragover', first, transfer).defaultPrevented).toBe(false)
        expect(drag('drop', first, transfer).defaultPrevented).toBe(false)
        expect(onFiles).not.toHaveBeenCalled()
    })

    it('does not call the listener for a drop with no files in it', () => {
        drag('drop', first, fileTransfer([]))

        expect(onFiles).not.toHaveBeenCalled()
    })

    it('takes no files while it is not active, but still stops the browser', () => {
        active = false
        const transfer = fileTransfer()

        drag('dragenter', first, transfer)
        expect(overlay.hidden).toBe(true)

        const over = drag('dragover', first, transfer)
        expect(over.defaultPrevented).toBe(true)
        expect(transfer.dropEffect).toBe('none')

        const drop = drag('drop', first, transfer)
        expect(drop.defaultPrevented).toBe(true)
        expect(onFiles).not.toHaveBeenCalled()
    })

    it('removes its listeners', () => {
        stop()

        drag('dragenter', first, fileTransfer())
        drag('drop', first, fileTransfer())

        expect(overlay.hidden).toBe(true)
        expect(onFiles).not.toHaveBeenCalled()
    })
})
