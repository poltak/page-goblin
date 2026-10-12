/**
 * Opens a book of the library as a reader session with the real modules.
 */

import { createContentLoader } from '$lib/content'
import { openEpub } from '$lib/epub'
import { createPagedView, createScrollView } from '$lib/reader'
import { settings, systemPrefersDark, watchSystemTheme } from '$lib/settings'
import type { ReaderSession } from '../types'
import { openSessionWith } from './open-with'
import type { OpenSessionOptions } from './open-with'

/**
 * Rejects with an Error that has the message 'book-not-found' when the library does not have
 * the book or its file. Resolves after the first chapter is shown. With `options.signal` the
 * caller can stop the open. The promise then rejects with an error named 'AbortError'.
 */
export function openReaderSession(options: OpenSessionOptions): Promise<ReaderSession> {
    return openSessionWith(options, {
        openEpub,
        // The scroll view can show 8 short chapters at one time, and the loader revokes the
        // image URLs of a chapter that leaves its cache. So the cache is larger than that.
        createContentLoader: ({ book }) => createContentLoader({ book, cacheSize: 12 }),
        settings,
        createView: (mode, viewOptions) =>
            mode === 'scroll' ? createScrollView(viewOptions) : createPagedView(viewOptions),
        systemDark: systemPrefersDark,
        watchSystemTheme,
        now: Date.now,
    })
}
