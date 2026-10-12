/**
 * Opens a book of the library as a reader session with the real modules.
 */

import { createContentLoader } from '$lib/content'
import { openEpub } from '$lib/epub'
import { createPagedView, createScrollView } from '$lib/reader'
import { settings, systemPrefersDark, watchSystemTheme } from '$lib/settings'
import type { OpenReaderSessionOptions, ReaderSession } from '../types'
import { openSessionWith } from './open-with'

/**
 * Rejects with an Error that has the message 'book-not-found' when the library does not have
 * the book or its file. Resolves after the first chapter is shown.
 */
export function openReaderSession(options: OpenReaderSessionOptions): Promise<ReaderSession> {
    return openSessionWith(options, {
        openEpub,
        createContentLoader,
        settings,
        createView: (mode, viewOptions) =>
            mode === 'scroll' ? createScrollView(viewOptions) : createPagedView(viewOptions),
        systemDark: systemPrefersDark,
        watchSystemTheme,
        now: Date.now,
    })
}
