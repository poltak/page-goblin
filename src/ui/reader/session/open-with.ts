/**
 * The steps that open a book of the library as a reader session.
 *
 * The modules that do the work are inputs, so that tests can replace them. `open.ts` gives the
 * real modules.
 */

import type { ContentLoader } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import type { ReaderView } from '$lib/reader/types'
import type { OpenReaderSessionOptions, ReaderSession } from '../types'
import { createReaderSession } from './session'
import type { ReaderSessionDeps } from './session'

export interface SessionParts extends Pick<
    ReaderSessionDeps,
    'settings' | 'createView' | 'systemDark' | 'watchSystemTheme' | 'now'
> {
    openEpub(file: Blob): Promise<EpubBook>
    createContentLoader(options: { book: EpubBook }): ContentLoader
}

function ignore(): void {}

/** Settles when the view that the session has now showed its first chapter, or failed. */
function whenViewReady(session: ReaderSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const watch = (view: ReaderView): void => {
            view.ready.then(
                () => {
                    if (session.view !== view) return
                    stop()
                    resolve()
                },
                (error: unknown) => {
                    if (session.view !== view) return
                    stop()
                    reject(error)
                },
            )
        }
        // A change of the layout setting during the load replaces the view.
        const stop = session.on('view', watch)
        watch(session.view)
    })
}

/**
 * Rejects with an Error that has the message 'book-not-found' when the library does not have
 * the book or its file. Rejects with the error of the EPUB parser, of storage or of the first
 * chapter when the book does not open. Nothing stays open after a rejection.
 */
export async function openSessionWith(
    { bookId, storage, container }: OpenReaderSessionOptions,
    parts: SessionParts,
): Promise<ReaderSession> {
    // The saved position and annotations do not need the book file, so these reads start now.
    const saved = Promise.all([
        storage.getProgress(bookId),
        storage.listBookmarks(bookId),
        storage.listHighlights(bookId),
    ])
    saved.catch(ignore)

    const [record, file] = await Promise.all([storage.getBook(bookId), storage.getFile(bookId)])
    if (!record || !file) throw new Error('book-not-found')

    const book = await parts.openEpub(file)
    const content = parts.createContentLoader({ book })
    let session: ReaderSession | undefined
    try {
        const [[progress, bookmarks, highlights]] = await Promise.all([saved, content.prepare()])
        session = createReaderSession({
            record,
            book,
            content,
            storage,
            container,
            settings: parts.settings,
            createView: parts.createView,
            initialProgress: progress,
            bookmarks,
            highlights,
            systemDark: parts.systemDark,
            watchSystemTheme: parts.watchSystemTheme,
            now: parts.now,
        })
        await whenViewReady(session)
    } catch (error) {
        if (session) await session.destroy()
        else content.dispose()
        throw error
    }

    // The library sorts by this time. A failed write must not stop the reader.
    try {
        storage.updateBook(bookId, { lastOpenedAt: parts.now() }).catch(ignore)
    } catch {
        // The storage method did not start the write.
    }
    return session
}
