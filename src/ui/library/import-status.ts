/** The status region above the grid: the file in work, and the files that failed. */

import type { ImportProgress } from '$lib/storage/import'
import { cloneTemplate, qs } from '../dom'
import { importFraction, phaseLabel } from './import-queue'
import type { ImportFailure } from './import-queue'

export interface ImportStatusView {
    start(info: { fileName: string; position: number; total: number }): void
    progress(progress: ImportProgress): void
    fail(failure: ImportFailure): void
    /** No file is in work. The failures stay until the user closes them. */
    idle(): void
}

export function createImportStatusView(root: HTMLElement): ImportStatusView {
    const current = qs('.import-current', root)
    const fileText = qs('.import-file', root)
    const phaseText = qs('.import-phase', root)
    const countText = qs('.import-count', root)
    const bar = qs('.progress', root)
    const failures = qs('.import-failures', root)

    let latest: ImportProgress | null = null
    let frame = 0

    function render(): void {
        frame = 0
        if (!latest) return
        const { phase, done, total } = latest
        phaseText.textContent = phaseLabel(phase)
        countText.textContent = phase === 'measure' && total > 0 ? `${done} of ${total}` : ''
        const fraction = importFraction(latest)
        bar.style.setProperty('--value', String(fraction))
        bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)))
    }

    // The measure phase sends one event for each chapter. One write for each frame is enough.
    function schedule(): void {
        if (frame) return
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(render)
        else render()
    }

    function cancel(): void {
        if (frame) cancelAnimationFrame(frame)
        frame = 0
    }

    root.addEventListener('click', (event) => {
        const button = (event.target as Element).closest('[data-action="dismiss-failure"]')
        const item = button?.closest('.import-failure')
        if (!item) return
        const hadFocus = item.contains(document.activeElement)
        const neighbour = item.nextElementSibling ?? item.previousElementSibling
        item.remove()
        // The focus goes to the next message, so a keyboard user can close them in a row.
        if (hadFocus) {
            neighbour?.querySelector<HTMLElement>('[data-action="dismiss-failure"]')?.focus()
        }
    })

    return {
        start({ fileName, position, total }) {
            cancel()
            fileText.textContent =
                total > 1 ? `Adding ${fileName} (${position} of ${total})` : `Adding ${fileName}`
            latest = { phase: 'hash', done: 0, total: 1 }
            render()
            current.hidden = false
        },
        progress(progress) {
            latest = progress
            schedule()
        },
        fail({ fileName, message, detail }) {
            const item = cloneTemplate('import-failure-template')
            qs('.import-failure-file', item).textContent = fileName
            qs('.import-failure-message', item).textContent = message
            const details = qs('.import-failure-details', item)
            details.hidden = detail === null
            qs('.import-failure-detail', item).textContent = detail ?? ''
            failures.append(item)
        },
        idle() {
            cancel()
            latest = null
            current.hidden = true
        },
    }
}
