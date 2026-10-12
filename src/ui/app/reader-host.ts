/**
 * Shows the reader in place of the library and back. The reader screen is a separate chunk
 * that loads when the first book opens.
 */

import type { LibraryStorage } from '$lib/storage/types'
import { cloneTemplate } from '../dom'
import type { MountedReader, ReaderMountOptions } from '../reader/types'

export const APP_TITLE = 'Page Goblin'
/** A load that is faster than this shows no loading state. */
export const LOADING_DELAY_MS = 150

type MountReader = (options: ReaderMountOptions) => Promise<MountedReader>

export interface ReaderHostOptions {
    libraryView: HTMLElement
    readerView: HTMLElement
    storage: LibraryStorage
    /** The user closed the book in the reader. The router then asks for the library. */
    onExit(): void
    /** The book is not in storage, or the reader did not start. The library is on screen. */
    onOpenFailed(failure: { bookId: string; reason: 'missing' | 'error'; error?: unknown }): void
    /** The reader of this book is gone. Its progress in storage is final. */
    onClosed(bookId: string): void
    /**
     * Runs before the library goes off screen for a book. The result puts the library back
     * at the same place. The default keeps the scroll offset of the page.
     */
    captureLibraryPosition?(bookId: string): () => void
    /** Loads the reader screen. The default is the dynamic import of `src/ui/reader`. */
    loadReader?: () => Promise<{ mountReader: MountReader }>
}

export interface ReaderHost {
    /** The book that the screen must show, or null for the library. */
    readonly bookId: string | null
    /**
     * Shows the reader for a book, or the library for null. The views change at once. The
     * reader mounts and unmounts in the background, one step after the other.
     */
    show(bookId: string | null): void
    /** Resolves when the screen shows what the last `show` call asked for. */
    settled(): Promise<void>
}

export function createReaderHost(options: ReaderHostOptions): ReaderHost {
    const { libraryView, readerView, storage } = options
    const loadReader = options.loadReader ?? (() => import('../reader'))
    const capturePosition =
        options.captureLibraryPosition ??
        (() => {
            const offset = window.scrollY
            return () => window.scrollTo(0, offset)
        })

    let wanted: string | null = null
    let mounted: { bookId: string; title: string; reader: MountedReader | null } | null = null
    let work: Promise<void> = Promise.resolve()
    let working = false
    let restoreLibraryPosition: (() => void) | null = null

    function showViews(): void {
        const reading = wanted !== null
        // theme-init.js sets this on a reload inside a book. From here the hidden attribute rules.
        // It comes before the return: theme-init.js also sets it for a book address that the
        // router does not accept, and the library must then show.
        delete document.documentElement.dataset.route
        if (reading === libraryView.hidden) return
        // A hidden library has no height, so the page loses its scroll position.
        if (wanted !== null) restoreLibraryPosition = capturePosition(wanted)
        libraryView.hidden = reading
        readerView.hidden = !reading
        if (!reading) {
            restoreLibraryPosition?.()
            restoreLibraryPosition = null
            document.title = APP_TITLE
        }
    }

    function fail(bookId: string, reason: 'missing' | 'error', error?: unknown): void {
        // The route still names the book. Without this, the loop would try the book again.
        if (wanted === bookId) wanted = null
        showViews()
        options.onOpenFailed({ bookId, reason, error })
    }

    async function mount(bookId: string): Promise<void> {
        const loading = setTimeout(() => {
            readerView.replaceChildren(cloneTemplate('reader-loading-template'))
        }, LOADING_DELAY_MS)

        try {
            const [module, book] = await Promise.all([
                loadReader(),
                storage.getBook(bookId),
            ]).finally(() => clearTimeout(loading))
            if (wanted !== bookId) return
            if (!book) {
                fail(bookId, 'missing')
                return
            }
            document.title = book.title
            // The reader gets an empty element. It shows its own state while the book opens.
            readerView.replaceChildren()
            mounted = { bookId, title: book.title, reader: null }
            mounted.reader = await module.mountReader({
                root: readerView,
                bookId,
                storage,
                onExit: () => {
                    if (wanted === bookId) options.onExit()
                },
            })
        } catch (error) {
            mounted = null
            if (wanted === bookId) fail(bookId, 'error', error)
        } finally {
            // Nothing of a book that did not open can stay, also not the loading state.
            if (!mounted) readerView.replaceChildren()
        }
    }

    async function unmount(): Promise<void> {
        const { bookId, reader } = mounted!
        try {
            await reader?.destroy()
        } catch (error) {
            console.error('The reader did not close cleanly.', error)
        }
        readerView.replaceChildren()
        mounted = null
        options.onClosed(bookId)
    }

    async function reconcile(): Promise<void> {
        working = true
        try {
            while ((mounted?.bookId ?? null) !== wanted) {
                if (mounted) await unmount()
                else await mount(wanted!)
            }
        } finally {
            working = false
        }
    }

    return {
        get bookId() {
            return wanted
        },
        show(bookId) {
            wanted = bookId
            showViews()
            // Back and then Forward can come before the reader of the book is gone. That
            // reader stays, and the title that the library view set must change again.
            if (mounted && mounted.bookId === bookId) document.title = mounted.title
            if (!working) work = reconcile()
        },
        settled: () => work,
    }
}
