/** Files that the user drags from the system and drops anywhere on the window. */

import { on } from '../dom'

export interface FileDropOptions {
    /** The element that shows while files are above the window. */
    overlay: HTMLElement
    /** False while the app must not take files. A drop then does nothing. */
    isActive(): boolean
    onFiles(files: File[]): void
}

// A drag of text or of a link from the page has no 'Files' type.
function hasFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') === true
}

/** Returns the function that removes the listeners. */
export function connectFileDrop({ overlay, isActive, onFiles }: FileDropOptions): () => void {
    // The element that the drag entered last. The browser sends dragenter for the new element
    // before dragleave for the old one, so a leave of this element is a leave of the window.
    let lastEntered: EventTarget | null = null

    const stops = [
        on(window, 'dragenter', (event) => {
            if (!hasFiles(event)) return
            event.preventDefault()
            lastEntered = event.target
            if (isActive()) overlay.hidden = false
        }),
        // This event comes many times each second. It must stay small.
        on(window, 'dragover', (event) => {
            if (!hasFiles(event)) return
            // Without this the browser opens the dropped file in place of the app.
            event.preventDefault()
            if (event.dataTransfer) event.dataTransfer.dropEffect = isActive() ? 'copy' : 'none'
        }),
        on(window, 'dragleave', (event) => {
            if (event.target !== lastEntered) return
            lastEntered = null
            overlay.hidden = true
        }),
        on(window, 'drop', (event) => {
            if (!hasFiles(event)) return
            event.preventDefault()
            lastEntered = null
            overlay.hidden = true
            if (!isActive()) return
            const files = Array.from(event.dataTransfer?.files ?? [])
            if (files.length > 0) onFiles(files)
        }),
    ]

    return () => {
        for (const stop of stops) stop()
    }
}
