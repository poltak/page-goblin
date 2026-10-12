/**
 * The actions of the app menu that need more than a few lines: storage, backup and about.
 * The library screen loads this file when the user chooses one of them.
 */

import { getStorageEstimate } from '$lib/storage/storage-info'
import type { LibraryStorage } from '$lib/storage/types'
import { openDialog } from '../app/dialog'
import { showToast } from '../app/toast'
import { qs } from '../dom'
import { backupFileName, describeRestore, formatMegabytes } from './app-format'
import { bookCountText } from './format'

const NOT_A_BACKUP = 'This file is not a Web eReader backup.'

export interface AppActionsOptions {
    storage: LibraryStorage
    /** The number of books in the library now. */
    bookCount(): number
    /** A restore changed reading positions. The cards must read them again. */
    onRestored(): void
}

export interface AppActions {
    showStorage(opener: Element | null): Promise<void>
    showAbout(opener: Element | null): void
    exportBackup(): Promise<void>
    importBackup(file: File): Promise<void>
}

export function createAppActions({
    storage,
    bookCount,
    onRestored,
}: AppActionsOptions): AppActions {
    return {
        async showStorage(opener) {
            const dialog = qs<HTMLDialogElement>('#storage-dialog')
            const count = bookCount()
            qs('.storage-books', dialog).textContent = bookCountText(count, count)
            const usage = qs('.storage-usage', dialog)
            usage.textContent = ''
            openDialog(dialog, opener)

            const estimate = await getStorageEstimate()
            usage.textContent = estimate
                ? `${formatMegabytes(estimate.usage)} MB used`
                : 'This browser does not tell how much space is in use.'
        },

        showAbout(opener) {
            const dialog = qs<HTMLDialogElement>('#about-dialog')
            const version: unknown = import.meta.env.VITE_APP_VERSION
            const line = qs('.about-version', dialog)
            line.hidden = typeof version !== 'string' || version === ''
            line.textContent = line.hidden ? '' : `Version ${version}`
            openDialog(dialog, opener)
        },

        async exportBackup() {
            try {
                const { createBackup, downloadTextFile } = await import('$lib/annotations')
                // A build without the backup has no such functions.
                if (typeof createBackup !== 'function' || typeof downloadTextFile !== 'function') {
                    throw new Error('The backup is not in this build.')
                }
                const now = Date.now()
                const backup = await createBackup({ storage, now: () => now })
                downloadTextFile({
                    name: backupFileName(new Date(now)),
                    text: JSON.stringify(backup),
                    type: 'application/json',
                })
            } catch (error) {
                console.error(error)
                showToast({ message: 'The backup was not made.', tone: 'error' })
            }
        },

        async importBackup(file) {
            let text: string
            try {
                text = await file.text()
            } catch {
                showToast({ message: NOT_A_BACKUP, tone: 'error' })
                return
            }
            try {
                const { parseBackup, restoreBackup } = await import('$lib/annotations')
                if (typeof restoreBackup !== 'function') {
                    throw new Error('The backup is not in this build.')
                }
                // The check runs first, so a wrong file and a failed write get their own text.
                let backup: unknown = text
                if (typeof parseBackup === 'function') {
                    try {
                        backup = parseBackup(text)
                    } catch {
                        showToast({ message: NOT_A_BACKUP, tone: 'error' })
                        return
                    }
                }
                const result = await restoreBackup({ storage, backup })
                showToast({ message: describeRestore(result), duration: 8000 })
            } catch (error) {
                console.error(error)
                showToast({
                    message: 'The backup was not restored completely. You can try again.',
                    tone: 'error',
                })
            }
            // Also after an error, because the writes before it stay.
            onRestored()
        },
    }
}
