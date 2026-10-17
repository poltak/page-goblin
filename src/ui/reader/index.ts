/**
 * Entry point of the reader screen. The app shell loads this module on demand, so the
 * session, the two reader views and the screen are not in the first chunk.
 */

import { settings } from '$lib/settings/store'
import { showToast } from '../app/toast'
import { partModules } from './screen/part-modules'
import { startReader } from './screen/start'
import { openReaderSession } from './session'
import type { MountedReader, ReaderMountOptions } from './types'

export type * from './types'

export const MISSING_FILE_MESSAGE = 'The file of this book is missing. Add the book again.'

/**
 * Shows the reader screen in `options.root` and starts to open the book. Resolves at once,
 * while the book still opens, so the app shell can close the reader in that time. If it had
 * to wait, a user who leaves during the open would leave a reader that never closes: the app
 * shell hides the reader view, and a hidden view waits for a size with no time limit.
 *
 * The screen shows its own message for a book that did not open. For a book with no file in
 * the library it shows a toast and calls `options.onExit`.
 */
export async function mountReader(options: ReaderMountOptions): Promise<MountedReader> {
    const reader = startReader(options, {
        openSession: openReaderSession,
        settings,
        parts: partModules,
    })
    reader.ready.catch((error: unknown) => {
        console.error(error)
        showToast({ message: MISSING_FILE_MESSAGE, tone: 'error' })
        options.onExit()
    })
    return { destroy: reader.destroy, offerPosition: reader.offerPosition }
}
