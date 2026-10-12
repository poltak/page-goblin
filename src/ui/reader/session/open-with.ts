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

/**
 * The options of `openSessionWith`. With `signal` the caller can stop an open that runs, for
 * example when the user leaves the reader before the book is on screen.
 */
export interface OpenSessionOptions extends OpenReaderSessionOptions {
    /**
     * Stops the open. The promise then rejects with an error that has the name 'AbortError',
     * and nothing stays open.
     */
    signal?: AbortSignal
}

export const ABORT_ERROR_NAME = 'AbortError'

function ignore(): void {}

function abortError(): Error {
    const error = new Error('The open was stopped.')
    error.name = ABORT_ERROR_NAME
    return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw abortError()
}

/** Settles as `work` does, or rejects at once when the signal aborts first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return work
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortError())
        signal.addEventListener('abort', onAbort, { once: true })
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
}

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
    { bookId, storage, container, signal }: OpenSessionOptions,
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
    throwIfAborted(signal)
    if (!record || !file) throw new Error('book-not-found')

    const book = await parts.openEpub(file)
    const content = parts.createContentLoader({ book })
    let session: ReaderSession | undefined
    try {
        throwIfAborted(signal)
        const [[progress, bookmarks, highlights]] = await Promise.all([saved, content.prepare()])
        throwIfAborted(signal)
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
        // A view in an element that is not on screen has no size, and it waits for one with
        // no time limit. So the wait must stop when the caller stops the open.
        await untilAborted(whenViewReady(session), signal)
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
