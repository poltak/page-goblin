/**
 * The library screen: the grid of books with search, sort, import and remove.
 *
 * The markup is in index.html. This file attaches the behaviour. The parts that the first
 * paint does not need (import, book details, app menu actions) load at their first use.
 */

import type { LibrarySort } from '$lib/settings/schema'
import type { SettingsStore } from '$lib/settings/store'
import type { BookRecord, LibraryStorage } from '$lib/storage/types'
import { connectDialog, openDialog, whenClosed } from '../app/dialog'
import { createMenu } from '../app/menu'
import { showToast } from '../app/toast'
import { on, qs, qsa } from '../dom'
import { bookIdOf, createBookCard, setCardBook, setCardCover, setCardProgress } from './card'
import { createCoverStore } from './covers'
import { connectFileDrop } from './drop'
import { bookCountText } from './format'
import { connectLibraryHeader } from './header'
import type { ImportSummary } from './import-queue'
import { lazy, reportLoadError } from './lazy'
import { compareBooks, insertIndex, matchesSearch, searchKey, searchWords } from './sort-filter'

export const LOAD_ERROR_TEXT = 'The browser did not open the book storage of this page.'

/**
 * The text for a library that did not open. A plain Error comes from the storage layer, which
 * writes a sentence for the user when it knows the cause, for example blocked site data. An
 * error of the browser has technical text, so it gets a general sentence.
 */
export function loadErrorText(error: unknown): string {
    const own = error instanceof Error && error.name === 'Error' ? error.message.trim() : ''
    return own || LOAD_ERROR_TEXT
}

/** How long a card keeps its mark. The animation in library.css takes 2 seconds. */
const MARK_MS = 2200
/** Covers load when a card is this near to the screen. */
const COVER_MARGIN = '400px 0px'

/** The parts of the sync that the library uses. */
export interface LibrarySync {
    isOn(): boolean
    /** Resolves false when the server does not have the file yet. */
    removeDownload(bookId: string): Promise<boolean>
    openDialog(opener: Element | null): void
}

export interface LibraryScreenOptions {
    /** The `main#library-view` element. */
    root: HTMLElement
    storage: LibraryStorage
    settings: SettingsStore
    onOpenBook(bookId: string): void
    /** Without it, the library works as with the sync off. */
    sync?: LibrarySync
}

export interface LibraryScreen {
    /** Reads the books and fills the grid. Later calls return the same promise. */
    load(): Promise<void>
    /** Adds book files, one after the other. Resolves when these files are done. Never rejects. */
    importFiles(files: readonly File[]): Promise<ImportSummary>
    /** Reads one book and its progress again, after the reader changed them. */
    refreshBook(bookId: string): Promise<void>
    /** Shows the books that a sync added, changed or removed, with their new covers. */
    applySyncChanges(bookIds: readonly string[]): Promise<void>
    /**
     * Call it before the library goes off screen for a book. The result puts the page back
     * at the same place when the library is on screen again.
     */
    capturePosition(bookId: string): () => void
    /** Removes the listeners on the window, the document and the settings. */
    destroy(): void
}

interface Entry {
    book: BookRecord
    fraction: number
    /** The normalised text that the search looks in. */
    key: string
    card: HTMLElement
}

function shorten(text: string, length: number): string {
    return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text
}

export function createLibraryScreen(options: LibraryScreenOptions): LibraryScreen {
    const { root, storage, settings } = options
    const grid = qs('#library-grid', root)
    const toolbar = qs('#library-toolbar', root)
    const searchInput = qs<HTMLInputElement>('#library-search', root)
    const searchClear = qs('.library-search-clear', root)
    const sortSelect = qs<HTMLSelectElement>('#library-sort', root)
    const countText = qs('#library-count', root)
    const emptyState = qs('#library-empty', root)
    const errorState = qs('#library-error', root)
    const errorText = qs('#library-error-text', root)
    const noMatch = qs('#library-no-match', root)
    const fileInput = qs<HTMLInputElement>('#book-files', root)
    const header = qs('.library-header', root)
    const statusRoot = qs('#import-status', root)
    const removeDialog = qs<HTMLDialogElement>('#remove-dialog')

    const covers = createCoverStore(storage)
    const entries = new Map<string, Entry>()
    /** The books in the order of the grid. */
    let order: BookRecord[] = []
    let sort: LibrarySort = settings.get().librarySort
    let words: string[] = []
    let loading: Promise<void> | null = null
    const marks = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()
    /** The functions that remove the listeners outside the view. */
    const stops: Array<() => void> = []

    // ---------- Covers ----------

    async function showCover(card: HTMLElement): Promise<void> {
        const bookId = card.dataset.bookId ?? ''
        const url = await covers.url(bookId)
        // The book can be gone when the image arrives.
        if (entries.get(bookId)?.card === card) setCardCover(card, url)
    }

    // One observer for all cards. A cover is read from storage only when its card comes near
    // the screen, so a large library does not load each image at the start.
    const coverObserver =
        typeof IntersectionObserver === 'function'
            ? new IntersectionObserver(
                  (observed) => {
                      for (const item of observed) {
                          if (!item.isIntersecting) continue
                          coverObserver?.unobserve(item.target)
                          void showCover(item.target as HTMLElement)
                      }
                  },
                  { rootMargin: COVER_MARGIN },
              )
            : null

    // ---------- Grid ----------

    function makeEntry(book: BookRecord, fraction: number): Entry {
        const card = createBookCard(book, fraction)
        const entry: Entry = { book, fraction, key: searchKey(book), card }
        entries.set(book.id, entry)
        if (book.hasCover) {
            if (coverObserver) coverObserver.observe(card)
            else void showCover(card)
        }
        return entry
    }

    /** Shows the cards that match the search, and the parts around the grid. */
    function updateView(): void {
        const total = order.length
        let shown = 0
        for (const book of order) {
            const entry = entries.get(book.id)!
            const match = matchesSearch(entry.key, words)
            if (match) shown += 1
            if (entry.card.hidden === match) entry.card.hidden = !match
        }
        toolbar.hidden = total === 0
        emptyState.hidden = total > 0
        noMatch.hidden = total === 0 || shown > 0
        countText.textContent = total === 0 ? '' : bookCountText(shown, total)
    }

    /** Puts a card at its place in the sort order. */
    function place(entry: Entry): void {
        const index = insertIndex(order, entry.book, sort)
        const next = order[index]
        const before = next ? entries.get(next.id)!.card : null
        order.splice(index, 0, entry.book)
        // A card that is at its place already does not move, so it keeps the focus.
        if (entry.card.parentNode !== grid || entry.card.nextElementSibling !== before) {
            grid.insertBefore(entry.card, before)
        }
    }

    function addBook(book: BookRecord): Entry {
        const existing = entries.get(book.id)
        if (existing) return existing
        const entry = makeEntry(book, 0)
        place(entry)
        updateView()
        return entry
    }

    function removeBook(bookId: string): void {
        const entry = entries.get(bookId)
        if (!entry) return
        entries.delete(bookId)
        order = order.filter((book) => book.id !== bookId)
        coverObserver?.unobserve(entry.card)
        entry.card.remove()
        covers.release(bookId)
        updateView()
    }

    function applySort(next: LibrarySort): void {
        sort = next
        sortSelect.value = next
        order.sort(compareBooks(next))
        // One append moves all cards. The cards themselves do not change.
        grid.append(...order.map((book) => entries.get(book.id)!.card))
    }

    function setSearch(text: string): void {
        if (searchInput.value !== text) searchInput.value = text
        searchClear.hidden = text === ''
        words = searchWords(text)
        updateView()
    }

    function mark(card: HTMLElement): void {
        clearTimeout(marks.get(card))
        card.classList.add('is-marked')
        marks.set(
            card,
            setTimeout(() => card.classList.remove('is-marked'), MARK_MS),
        )
    }

    const prefersReducedMotion = (): boolean =>
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

    /** Scrolls to the card of a book and marks it for a moment. */
    function reveal(entry: Entry): void {
        if (entry.card.hidden) setSearch('')
        entry.card.scrollIntoView?.({
            block: 'center',
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        })
        mark(entry.card)
    }

    async function readLibrary(): Promise<void> {
        const [books, progress] = await Promise.all([storage.listBooks(), storage.listProgress()])
        const fractions = new Map(progress.map((record) => [record.bookId, record.fraction]))
        // An import that ran before this read added its book already.
        const fresh = books.filter((book) => !entries.has(book.id))
        if (order.length > 0) {
            for (const book of fresh) place(makeEntry(book, fractions.get(book.id) ?? 0))
        } else {
            order = fresh.sort(compareBooks(sort))
            const fragment = document.createDocumentFragment()
            for (const book of order) {
                fragment.append(makeEntry(book, fractions.get(book.id) ?? 0).card)
            }
            grid.append(fragment)
        }
        updateView()
    }

    function load(): Promise<void> {
        loading ??= readLibrary().then(
            () => {
                errorState.hidden = true
            },
            (error: unknown) => {
                console.error(error)
                // The next call tries again.
                loading = null
                // The message stays in the page. With no message, a library that did not
                // open looks like a library that lost its books.
                errorText.textContent = loadErrorText(error)
                errorState.hidden = false
            },
        )
        return loading
    }

    async function refreshBook(bookId: string): Promise<void> {
        const wasLoaded = loading !== null
        await load()
        // The first read has the new values already.
        if (!wasLoaded) return
        const [book, progress] = await Promise.all([
            storage.getBook(bookId),
            storage.getProgress(bookId),
        ])
        if (!book) {
            removeBook(bookId)
            return
        }
        // A book that a different tab added has no card yet.
        const entry = entries.get(bookId) ?? addBook(book)
        entry.book = book
        entry.key = searchKey(book)
        entry.fraction = progress?.fraction ?? 0
        setCardBook(entry.card, book)
        setCardProgress(entry.card, entry.fraction)
        // With the sort 'Recent', the book that was open moves to the front. A card that
        // moves in the page loses the focus, so the element that had it gets it again.
        order = order.filter((item) => item.id !== bookId)
        const focused = entry.card.contains(document.activeElement) ? document.activeElement : null
        place(entry)
        if (focused instanceof HTMLElement && document.activeElement !== focused) {
            focused.focus({ preventScroll: true })
        }
        updateView()
    }

    async function applySyncChanges(bookIds: readonly string[]): Promise<void> {
        // The first read of the library gets all books, so it needs no refresh.
        if (loading === null) return
        for (const bookId of bookIds) {
            await refreshBook(bookId)
            const entry = entries.get(bookId)
            // A cover that arrived after its card showed the fallback tile.
            if (entry?.book.hasCover && entry.card.dataset.cover !== 'shown') {
                covers.release(bookId)
                void showCover(entry.card)
            }
        }
    }

    function capturePosition(bookId: string): () => void {
        const offset = window.scrollY
        const card = entries.get(bookId)?.card
        const top = card && !card.hidden ? card.getBoundingClientRect().top : null
        return () => {
            window.scrollTo(0, offset)
            // A card that is off screen has an estimated height until the browser draws it,
            // so the same offset can show a different row. The card of the book that was
            // open gives the exact place.
            if (card?.isConnected && top !== null) {
                window.scrollBy(0, card.getBoundingClientRect().top - top)
            }
            // The focus goes back to the book that was open, as it does after a dialog. The
            // card is read again here, because a page that starts in a book has no cards yet
            // at the time of the capture.
            const current = entries.get(bookId)?.card
            if (current && !current.hidden) {
                qs('.book-card-open', current).focus({ preventScroll: true })
            }
        }
    }

    async function refreshProgress(): Promise<void> {
        const fractions = new Map(
            (await storage.listProgress()).map((record) => [record.bookId, record.fraction]),
        )
        for (const entry of entries.values()) {
            const fraction = fractions.get(entry.book.id) ?? 0
            if (fraction === entry.fraction) continue
            entry.fraction = fraction
            setCardProgress(entry.card, fraction)
        }
    }

    // ---------- Import ----------

    const importFlow = lazy(async () => {
        const { createImportFlow } = await import('./import-flow')
        return createImportFlow({
            storage,
            statusRoot,
            onAdded(book) {
                const { card } = addBook(book)
                // A search that does not match the new book would hide its card.
                if (card.hidden) setSearch('')
                mark(card)
            },
            onDuplicate(book) {
                showToast({ message: 'This book is already in your library.' })
                reveal(addBook(book))
            },
        })
    })

    /**
     * The import status is at the top of the grid. When the page is scrolled down, the user
     * sees no progress and no message for a file that failed, so the page goes to the top.
     */
    function showImportStatus(): void {
        // Two layout reads for each batch of files.
        if (statusRoot.getBoundingClientRect().top >= header.getBoundingClientRect().bottom) return
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }

    async function importFiles(files: readonly File[]): Promise<ImportSummary> {
        if (files.length === 0) return { added: [], duplicates: [], failures: [] }
        // The grid must have its books first, so a new card goes to the correct place.
        await load()
        if (!root.hidden) showImportStatus()
        let summary: ImportSummary
        try {
            summary = await (await importFlow()).add(files)
        } catch (error) {
            reportLoadError(error)
            return { added: [], duplicates: [], failures: [] }
        }
        // The scroll to a book that was in the library already can hide the messages.
        if (summary.failures.length > 0 && !root.hidden) showImportStatus()
        const count = summary.added.length
        if (count > 0) {
            showToast({
                message: count === 1 ? 'The book was added.' : `${count} books were added.`,
            })
        }
        return summary
    }

    on(fileInput, 'change', () => {
        const files = Array.from(fileInput.files ?? [])
        // Without the reset, the same file gives no change event after an error.
        fileInput.value = ''
        if (files.length > 0) void importFiles(files)
    })

    stops.push(
        connectFileDrop({
            overlay: qs('#drop-overlay'),
            isActive: () => !root.hidden,
            onFiles: (files) => void importFiles(files),
        }),
    )

    // ---------- Remove ----------

    async function removeFromLibrary(book: BookRecord): Promise<void> {
        try {
            await storage.deleteBook(book.id)
        } catch (error) {
            console.error(error)
            showToast({ message: 'The book was not removed.', tone: 'error' })
            return
        }
        const card = entries.get(book.id)?.card
        const hadFocus = card?.contains(document.activeElement) === true
        // The next card that the search does not hide, or else the one before.
        const shown = order
            .map((item) => entries.get(item.id)!.card)
            .filter((item) => !item.hidden || item === card)
        const index = card ? shown.indexOf(card) : -1
        const neighbour = shown[index + 1] ?? shown[index - 1]
        removeBook(book.id)
        // The focus must not fall back to the top of the page.
        if (hadFocus) {
            const target = neighbour
                ? qs('.book-card-open', neighbour)
                : qs('[data-action="add-books"]', root)
            target.focus()
        }
        showToast({ message: `"${shorten(book.title, 60)}" was removed.` })
    }

    async function removeDownload(book: BookRecord): Promise<void> {
        let removed: boolean
        try {
            removed = (await options.sync?.removeDownload(book.id)) === true
        } catch (error) {
            console.error(error)
            showToast({ message: 'The download was not removed.', tone: 'error' })
            return
        }
        if (!removed) {
            showToast({
                message:
                    'The sync server does not have this book yet, so the download stays. Try again after the next sync.',
                tone: 'error',
            })
            return
        }
        await refreshBook(book.id)
        showToast({ message: `The download of "${shorten(book.title, 60)}" was removed.` })
    }

    function confirmRemove(book: BookRecord, opener: Element | null): void {
        const synced = options.sync?.isOn() === true
        const download = synced && !book.remoteOnly
        qs('.remove-name', removeDialog).textContent = book.title
        qs('.remove-scope', removeDialog).textContent = synced ? 'all your devices' : 'this device'
        qs('.remove-download', removeDialog).hidden = !download
        qs('.remove-download-text', removeDialog).hidden = !download
        openDialog(removeDialog, opener)
        void whenClosed(removeDialog).then((value) => {
            if (value === 'remove') void removeFromLibrary(book)
            else if (value === 'remove-download' && download) void removeDownload(book)
        })
    }

    // ---------- Details ----------

    const detailsSheet = lazy(async () => {
        const { createDetailsSheet } = await import('./details')
        return createDetailsSheet({
            dialog: qs<HTMLDialogElement>('#details-sheet'),
            storage,
            covers,
            onOpenBook: options.onOpenBook,
            onRemove: confirmRemove,
        })
    })

    function showDetails(entry: Entry, opener: Element | null): void {
        void detailsSheet().then(
            (sheet) => sheet.show({ book: entry.book, fraction: entry.fraction, opener }),
            reportLoadError,
        )
    }

    // ---------- Cards and their menu ----------

    const bookMenu = createMenu({
        menu: qs('#book-menu'),
        onSelect(item, anchor) {
            const entry = entries.get(bookIdOf(anchor) ?? '')
            if (!entry) return
            const { action } = item.dataset
            if (action === 'open') options.onOpenBook(entry.book.id)
            else if (action === 'details') showDetails(entry, anchor)
            else if (action === 'remove') confirmRemove(entry.book, anchor)
        },
    })

    // One listener for all cards.
    on(grid, 'click', (event) => {
        const target = event.target as Element
        const menuButton = target.closest<HTMLElement>('.book-card-menu')
        if (menuButton) {
            event.preventDefault()
            bookMenu.toggle(menuButton)
            return
        }
        const link = target.closest('.book-card-open')
        // A click with a modifier key opens the book in a new tab, as each link does.
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const bookId = bookIdOf(link)
        if (!bookId) return
        // The router adds the history entry and marks it, so the link must not add one too.
        event.preventDefault()
        options.onOpenBook(bookId)
    })

    // ---------- Toolbar, keys and the other controls ----------

    on(searchInput, 'input', () => setSearch(searchInput.value))
    // Only some browsers clear a search field for the Escape key.
    on(searchInput, 'keydown', (event) => {
        if (event.key !== 'Escape' || searchInput.value === '') return
        event.preventDefault()
        setSearch('')
    })

    sortSelect.value = sort
    on(sortSelect, 'change', () => {
        settings.update({ librarySort: sortSelect.value as LibrarySort })
    })
    // The change also comes from a different tab.
    stops.push(
        settings.subscribe((next) => {
            if (next.librarySort !== sort) applySort(next.librarySort)
        }),
    )

    on(root, 'click', (event) => {
        const action = (event.target as Element).closest<HTMLElement>('[data-action]')?.dataset
            .action
        if (action === 'add-books') fileInput.click()
        else if (action === 'retry-library') void load()
        else if (action === 'clear-search') {
            setSearch('')
            searchInput.focus()
        }
    })

    stops.push(
        on(document, 'keydown', (event) => {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
            if (root.hidden || toolbar.hidden || document.querySelector('dialog[open]')) return
            const { target } = event
            // In an open menu the focus must stay there, or the menu stays open with no focus.
            const inField =
                target instanceof Element &&
                target.closest('input, textarea, select, [contenteditable], [role="menu"]') !== null
            if (inField) return
            event.preventDefault()
            searchInput.focus()
            searchInput.select()
        }),
    )

    for (const dialog of qsa<HTMLDialogElement>('dialog')) connectDialog(dialog)

    connectLibraryHeader({
        settings,
        storage,
        bookCount: () => order.length,
        onRestored: () => void refreshProgress(),
        syncOn: () => options.sync?.isOn() === true,
        onSync: options.sync && ((opener) => options.sync?.openDialog(opener)),
    })

    return {
        load,
        importFiles,
        refreshBook,
        applySyncChanges,
        capturePosition,
        destroy() {
            for (const stop of stops) stop()
            coverObserver?.disconnect()
        },
    }
}
