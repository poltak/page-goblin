import { Blob as NodeBlob } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EpubError } from '$lib/epub/types'
import { createSettingsStore } from '$lib/settings/store'
import type { OwnedSettingsStore } from '$lib/settings/store'
import type { ImportBookOptions, ImportResult } from '$lib/storage/import'
import { createLibraryStorage } from '$lib/storage/library-storage'
import type { BookRecord, LibraryStorage } from '$lib/storage/types'
import { installOverlayMethods, mountPage } from '../app/testing/page'
import { clearToasts } from '../app/toast'
import { createLibraryScreen, LOAD_ERROR_TEXT, loadErrorText } from './index'
import type { LibraryScreen } from './index'

const mocks = vi.hoisted(() => ({
    importBook: vi.fn<(options: ImportBookOptions) => Promise<ImportResult>>(),
    requestPersistentStorage: vi.fn(async () => true),
}))

// The importer and the parser are separate chunks. The test gives its own importer.
vi.mock('$lib/storage/import', () => ({ importBook: mocks.importBook }))
vi.mock('$lib/epub', () => ({ openEpub: vi.fn() }))
vi.mock('$lib/storage/storage-info', async (original) => ({
    ...(await original<typeof import('$lib/storage/storage-info')>()),
    requestPersistentStorage: mocks.requestPersistentStorage,
}))

const HOSTILE_TITLE = '<img src=x onerror="window.hacked = true">'
const ZIP_START = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

function makeBook(id: string, changes: Partial<BookRecord> = {}): BookRecord {
    return {
        id,
        title: `Title ${id}`,
        author: 'An Author',
        language: 'en',
        identifier: null,
        publisher: null,
        description: null,
        published: null,
        subjects: [],
        series: null,
        fileName: `${id}.epub`,
        fileSize: 3,
        fileHash: `hash-${id}`,
        hasCover: false,
        spineStats: [{ chars: 100, words: 20 }],
        totalChars: 100,
        totalWords: 20,
        addedAt: 1000,
        lastOpenedAt: null,
        ...changes,
    }
}

function epubFile(name: string): File {
    return new File([ZIP_START, name], name, { type: 'application/epub+zip' })
}

let storage: LibraryStorage
let settings: OwnedSettingsStore
let onOpenBook: ReturnType<typeof vi.fn<(bookId: string) => void>>
let screen: LibraryScreen
let screens: LibraryScreen[] = []

const el = <T extends HTMLElement = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)!
const grid = () => el('#library-grid')
const cards = () => Array.from(grid().querySelectorAll<HTMLElement>('.book-card'))
const cardIds = () => cards().map((card) => card.dataset.bookId)
const visibleIds = () =>
    cards()
        .filter((card) => !card.hidden)
        .map((card) => card.dataset.bookId)
const card = (id: string) => cards().find((item) => item.dataset.bookId === id)!
const toastTexts = () =>
    Array.from(document.querySelectorAll('#toasts .toast span')).map((item) => item.textContent)

async function addBooks(...books: BookRecord[]): Promise<void> {
    for (const record of books) {
        await storage.addBook({ record, file: new NodeBlob(['x']) as Blob, cover: null })
    }
}

function startScreen(): LibraryScreen {
    screen = createLibraryScreen({
        root: el('#library-view'),
        storage,
        settings,
        onOpenBook,
    })
    screens.push(screen)
    return screen
}

function search(text: string): void {
    const input = el<HTMLInputElement>('#library-search')
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
    mountPage()
    installOverlayMethods()
    storage = createLibraryStorage({
        databaseName: 'library-screen-test',
        indexedDB: new IDBFactory(),
    })
    settings = createSettingsStore({ storage: null })
    onOpenBook = vi.fn<(bookId: string) => void>()
    mocks.importBook.mockReset()
    mocks.requestPersistentStorage.mockClear()
})

afterEach(() => {
    // Each screen listens on the window and the document, which all tests share.
    for (const made of screens) made.destroy()
    screens = []
    clearToasts()
    settings.destroy()
    storage.close()
})

describe('the library at the start', () => {
    it('shows no empty state and no toolbar before the books are read', async () => {
        await addBooks(makeBook('a'))
        startScreen()

        expect(el('#library-empty').hidden).toBe(true)
        expect(el('#library-toolbar').hidden).toBe(true)
        expect(cards()).toHaveLength(0)
    })

    it('shows the empty state for a library with no books', async () => {
        await startScreen().load()

        expect(el('#library-empty').hidden).toBe(false)
        expect(el('#library-toolbar').hidden).toBe(true)
        expect(el('#library-no-match').hidden).toBe(true)
    })

    it('links to free books in a new tab from the empty state', () => {
        const links = Array.from(el('#library-empty').querySelectorAll('a'))

        expect(links.map((link) => link.getAttribute('href'))).toEqual([
            'https://standardebooks.org',
            'https://www.gutenberg.org',
        ])
        for (const link of links) {
            expect(link.target).toBe('_blank')
            expect(link.rel).toBe('noopener noreferrer')
        }
    })

    it('reads the books and the progress in parallel, one time', async () => {
        const order: string[] = []
        const listBooks = vi.spyOn(storage, 'listBooks').mockImplementation(async () => {
            order.push('books start')
            await Promise.resolve()
            order.push('books end')
            return []
        })
        const listProgress = vi.spyOn(storage, 'listProgress').mockImplementation(async () => {
            order.push('progress start')
            return []
        })
        startScreen()

        await Promise.all([screen.load(), screen.load()])

        expect(order).toEqual(['books start', 'progress start', 'books end'])
        expect(listBooks).toHaveBeenCalledTimes(1)
        expect(listProgress).toHaveBeenCalledTimes(1)
    })

    it('renders the cards one time, in the "recent" order', async () => {
        await addBooks(
            makeBook('old', { addedAt: 100 }),
            makeBook('new', { addedAt: 300 }),
            makeBook('read', { addedAt: 50, lastOpenedAt: 900 }),
        )
        startScreen()
        const append = vi.spyOn(grid(), 'append')

        await screen.load()

        expect(cardIds()).toEqual(['read', 'new', 'old'])
        expect(append).toHaveBeenCalledTimes(1)
        expect(append.mock.calls[0][0]).toBeInstanceOf(DocumentFragment)
        expect(el('#library-toolbar').hidden).toBe(false)
        expect(el('#library-empty').hidden).toBe(true)
        expect(el('#library-count').textContent).toBe('3 books')
    })

    it('is a list of list items', async () => {
        await addBooks(makeBook('a'))
        await startScreen().load()

        expect(grid().tagName).toBe('UL')
        expect(grid().getAttribute('role')).toBe('list')
        expect(card('a').tagName).toBe('LI')
    })

    it('shows the progress of each book', async () => {
        await addBooks(makeBook('a'), makeBook('b'), makeBook('c'))
        await storage.saveProgress({
            bookId: 'a',
            locator: { spineIndex: 0, offset: 5 },
            fraction: 0.37,
            updatedAt: 1,
        })
        await storage.saveProgress({
            bookId: 'c',
            locator: { spineIndex: 0, offset: 99 },
            fraction: 1,
            updatedAt: 1,
        })
        await startScreen().load()

        expect(card('a').querySelector('.book-card-percent')?.textContent).toBe('37%')
        expect(card('b').querySelector<HTMLElement>('.book-card-percent')?.hidden).toBe(true)
        expect(card('c').querySelector('.book-card-percent')?.textContent).toBe('Finished')
    })

    it('keeps a title with markup as text', async () => {
        await addBooks(makeBook('a', { title: HOSTILE_TITLE, author: '<b>x</b>' }))
        await startScreen().load()

        expect(grid().querySelector('img')).toBeNull()
        expect(grid().querySelector('b')).toBeNull()
        expect(card('a').querySelector('.book-card-title')?.textContent).toBe(HOSTILE_TITLE)
        expect((window as { hacked?: boolean }).hacked).toBeUndefined()
    })

    it('shows no message about the storage for a library that opens', async () => {
        expect(el('#library-error').hidden).toBe(true)

        await startScreen().load()

        expect(el('#library-error').hidden).toBe(true)
    })
})

describe('a library that does not open', () => {
    const UNAVAILABLE = 'Book storage is not available in this browser.'
    const errorState = () => el('#library-error')
    const errorText = () => el('#library-error-text').textContent

    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    /** A browser that blocks the site data of the page. */
    function blockStorage(): void {
        storage.close()
        storage = createLibraryStorage({
            databaseName: 'library-screen-test',
            indexedDB: {
                open() {
                    throw new DOMException('The operation is insecure.', 'SecurityError')
                },
            } as unknown as IDBFactory,
        })
    }

    it('says in the page why, with the text of the storage, and shows no empty library', async () => {
        blockStorage()
        startScreen()

        await screen.load()

        expect(errorState().hidden).toBe(false)
        expect(errorState().getAttribute('role')).toBe('alert')
        expect(errorState().querySelector('.empty-state-title')?.textContent).toBe(
            'The library did not open',
        )
        expect(errorText()).toContain(UNAVAILABLE)
        expect(errorText()).toContain('Private browsing or blocked site data can cause this.')
        expect(el('#library-empty').hidden).toBe(true)
        expect(el('#library-toolbar').hidden).toBe(true)
        // The message stays. A toast goes away after some seconds.
        expect(toastTexts()).toEqual([])
    })

    it('uses a general sentence for an error of the browser', async () => {
        vi.spyOn(storage, 'listBooks').mockRejectedValueOnce(
            new DOMException('The connection is closing.', 'InvalidStateError'),
        )
        startScreen()

        await screen.load()

        expect(errorState().hidden).toBe(false)
        expect(errorText()).toBe(LOAD_ERROR_TEXT)
        expect(LOAD_ERROR_TEXT).toBe('The browser did not open the book storage of this page.')
    })

    it('uses the general sentence for an error with no sentence for the user', () => {
        expect(loadErrorText(new Error('  '))).toBe(LOAD_ERROR_TEXT)
        expect(loadErrorText(new TypeError('x is not a function'))).toBe(LOAD_ERROR_TEXT)
        expect(loadErrorText('a string')).toBe(LOAD_ERROR_TEXT)
        expect(loadErrorText(undefined)).toBe(LOAD_ERROR_TEXT)
        expect(loadErrorText(new Error('Close that tab and try again.'))).toBe(
            'Close that tab and try again.',
        )
    })

    it('puts the text of the error into the page as text', async () => {
        vi.spyOn(storage, 'listBooks').mockRejectedValueOnce(new Error(HOSTILE_TITLE))
        startScreen()

        await screen.load()

        expect(errorText()).toBe(HOSTILE_TITLE)
        expect(errorState().querySelector('img')).toBeNull()
    })

    it('tries again at the next load, and the message goes away', async () => {
        const listBooks = vi
            .spyOn(storage, 'listBooks')
            .mockRejectedValueOnce(new Error('The database did not open.'))
        startScreen()

        await screen.load()
        expect(errorState().hidden).toBe(false)
        expect(errorText()).toBe('The database did not open.')

        await screen.load()
        expect(listBooks).toHaveBeenCalledTimes(2)
        expect(errorState().hidden).toBe(true)
        expect(el('#library-empty').hidden).toBe(false)
    })

    it('tries again with the button, and shows the books', async () => {
        await addBooks(makeBook('a'))
        const listBooks = vi
            .spyOn(storage, 'listBooks')
            .mockRejectedValueOnce(new Error('The database did not open.'))
        startScreen()
        await screen.load()

        errorState().querySelector<HTMLElement>('[data-action="retry-library"]')!.click()

        await vi.waitFor(() => expect(cardIds()).toEqual(['a']))
        expect(listBooks).toHaveBeenCalledTimes(2)
        expect(errorState().hidden).toBe(true)
        expect(el('#library-toolbar').hidden).toBe(false)
    })

    it('keeps the message when the next try fails too', async () => {
        blockStorage()
        startScreen()
        await screen.load()

        errorState().querySelector<HTMLElement>('[data-action="retry-library"]')!.click()
        await screen.load()

        expect(errorState().hidden).toBe(false)
        expect(errorText()).toContain(UNAVAILABLE)
    })

    it('keeps the header in use', async () => {
        blockStorage()
        startScreen()
        await screen.load()
        const openFiles = vi.spyOn(el<HTMLInputElement>('#book-files'), 'click')

        el('.library-add').click()
        el('#app-menu-button').click()

        expect(openFiles).toHaveBeenCalledTimes(1)
        expect('open' in el('#app-menu').dataset).toBe(true)
    })
})

describe('sort', () => {
    beforeEach(async () => {
        await addBooks(
            makeBook('1', { title: 'Middlemarch', author: 'George Eliot', addedAt: 100 }),
            makeBook('2', { title: 'Anna Karenina', author: 'Leo Tolstoy', addedAt: 300 }),
            makeBook('3', {
                title: 'Emma',
                author: 'Jane Austen',
                addedAt: 200,
                lastOpenedAt: 999,
            }),
        )
    })

    it('uses the saved sort order at the start', async () => {
        settings.update({ librarySort: 'title' })
        await startScreen().load()

        expect(el<HTMLSelectElement>('#library-sort').value).toBe('title')
        expect(cardIds()).toEqual(['2', '3', '1'])
    })

    it('saves a new sort order and moves the same cards', async () => {
        await startScreen().load()
        expect(cardIds()).toEqual(['3', '2', '1'])
        const before = new Map(cards().map((item) => [item.dataset.bookId, item]))

        const select = el<HTMLSelectElement>('#library-sort')
        for (const [value, expected] of [
            ['added', ['2', '3', '1']],
            ['title', ['2', '3', '1']],
            ['author', ['1', '3', '2']],
            ['recent', ['3', '2', '1']],
        ] as const) {
            select.value = value
            select.dispatchEvent(new Event('change', { bubbles: true }))

            expect(settings.get().librarySort).toBe(value)
            expect(cardIds()).toEqual(expected)
        }
        for (const item of cards()) expect(before.get(item.dataset.bookId)).toBe(item)
    })

    it('follows a sort change from a different tab', async () => {
        await startScreen().load()

        settings.update({ librarySort: 'author' })

        expect(cardIds()).toEqual(['1', '3', '2'])
        expect(el<HTMLSelectElement>('#library-sort').value).toBe('author')
    })

    it('offers the four sort orders', () => {
        const options = Array.from(el<HTMLSelectElement>('#library-sort').options)

        expect(options.map((option) => [option.value, option.textContent])).toEqual([
            ['recent', 'Recent'],
            ['added', 'Date added'],
            ['title', 'Title'],
            ['author', 'Author'],
        ])
    })
})

describe('search', () => {
    beforeEach(async () => {
        await addBooks(
            makeBook('1', { title: 'Les Misérables', author: 'Victor Hugo', addedAt: 3 }),
            makeBook('2', { title: 'Germinal', author: 'Émile Zola', addedAt: 2 }),
            makeBook('3', { title: 'Hard Times', author: 'Charles Dickens', addedAt: 1 }),
        )
        await startScreen().load()
    })

    it('filters by title and author as the user types', () => {
        search('miserables')
        expect(visibleIds()).toEqual(['1'])
        expect(el('#library-count').textContent).toBe('1 of 3 books')

        search('emile zola')
        expect(visibleIds()).toEqual(['2'])

        search('')
        expect(visibleIds()).toEqual(['1', '2', '3'])
        expect(el('#library-count').textContent).toBe('3 books')
    })

    it('keeps the cards in the grid and only hides them', () => {
        const before = cards()

        search('dickens')

        expect(cards()).toEqual(before)
    })

    it('shows a message when no book matches, with a button that clears the search', () => {
        search('tolstoy')
        expect(visibleIds()).toEqual([])
        expect(el('#library-no-match').hidden).toBe(false)
        expect(el('#library-empty').hidden).toBe(true)
        expect(el('#library-count').textContent).toBe('0 of 3 books')

        el('#library-no-match [data-action="clear-search"]').click()

        expect(visibleIds()).toEqual(['1', '2', '3'])
        expect(el('#library-no-match').hidden).toBe(true)
        expect(el<HTMLInputElement>('#library-search').value).toBe('')
        expect(document.activeElement).toBe(el('#library-search'))
    })

    it('has a clear button in the field, only while the field has text', () => {
        const clear = el('.library-search-clear')
        expect(clear.hidden).toBe(true)
        expect(clear.getAttribute('aria-label')).toBe('Clear the search')

        search('dickens')
        expect(clear.hidden).toBe(false)

        clear.click()

        expect(clear.hidden).toBe(true)
        expect(visibleIds()).toEqual(['1', '2', '3'])
        expect(el<HTMLInputElement>('#library-search').value).toBe('')
        expect(document.activeElement).toBe(el('#library-search'))
    })

    it('clears the search for the Escape key in the field', () => {
        const input = el<HTMLInputElement>('#library-search')
        search('dickens')
        const event = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        })
        input.dispatchEvent(event)

        expect(event.defaultPrevented).toBe(true)
        expect(input.value).toBe('')
        expect(visibleIds()).toEqual(['1', '2', '3'])
        expect(el('.library-search-clear').hidden).toBe(true)

        // An empty field keeps the key, for example for a browser that closes its own popup.
        const second = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        })
        input.dispatchEvent(second)
        expect(second.defaultPrevented).toBe(false)
    })

    it('focuses the search field for the "/" key', () => {
        const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
        document.body.dispatchEvent(event)

        expect(document.activeElement).toBe(el('#library-search'))
        expect(event.defaultPrevented).toBe(true)
    })

    it('leaves the "/" key alone in a text field and while a dialog is open', () => {
        const input = el<HTMLInputElement>('#library-search')
        input.focus()
        const typed = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
        input.dispatchEvent(typed)
        expect(typed.defaultPrevented).toBe(false)

        input.blur()
        el<HTMLDialogElement>('#about-dialog').showModal()
        const inDialog = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
        document.body.dispatchEvent(inDialog)
        expect(inDialog.defaultPrevented).toBe(false)
        expect(document.activeElement).not.toBe(input)
    })

    it('leaves the "/" key alone while the focus is in an open menu', () => {
        el('#theme-button').click()
        const item = el('#theme-menu .menu-item')
        item.focus()
        const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
        item.dispatchEvent(event)

        expect(event.defaultPrevented).toBe(false)
        expect(document.activeElement).toBe(item)
    })

    it('leaves the "/" key alone while the library is hidden', () => {
        el('#library-view').hidden = true
        const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
        document.body.dispatchEvent(event)

        expect(event.defaultPrevented).toBe(false)
    })
})

describe('cards', () => {
    beforeEach(async () => {
        await addBooks(makeBook('a', { addedAt: 2 }), makeBook('b', { addedAt: 1 }))
        await startScreen().load()
    })

    function click(target: Element, init: MouseEventInit = {}): MouseEvent {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
        target.dispatchEvent(event)
        return event
    }

    it('opens the book for a click on the card, through the router', () => {
        const event = click(card('b').querySelector('.book-card-title')!)

        expect(onOpenBook).toHaveBeenCalledWith('b')
        // The router adds the history entry, so the link must not add one too.
        expect(event.defaultPrevented).toBe(true)
    })

    it('leaves a click with a modifier key to the browser', () => {
        const link = card('a').querySelector('.book-card-open')!

        expect(click(link, { ctrlKey: true }).defaultPrevented).toBe(false)
        expect(click(link, { metaKey: true }).defaultPrevented).toBe(false)
        expect(onOpenBook).not.toHaveBeenCalled()
    })

    it('opens the shared menu for the menu button of a card', () => {
        const button = card('a').querySelector<HTMLElement>('.book-card-menu')!

        const event = click(button)

        expect('open' in el('#book-menu').dataset).toBe(true)
        expect(button.getAttribute('aria-expanded')).toBe('true')
        expect(event.defaultPrevented).toBe(true)
        expect(onOpenBook).not.toHaveBeenCalled()
        expect(document.querySelectorAll('#book-menu')).toHaveLength(1)
        expect(grid().querySelector('.menu')).toBeNull()
    })

    it('opens the book from the menu', () => {
        click(card('b').querySelector('.book-card-menu')!)
        click(el('#book-menu [data-action="open"]'))

        expect(onOpenBook).toHaveBeenCalledWith('b')
    })

    it('opens no book for the press that closes the menu', () => {
        click(card('a').querySelector('.book-card-menu')!)
        const title = card('b').querySelector('.book-card-title')!

        // A press with a pointer on a different card. The browser closes the menu itself.
        title.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        el('#book-menu').hidePopover()
        const event = click(title, { detail: 1 })

        expect(onOpenBook).not.toHaveBeenCalled()
        // The link must not go to the book address by itself.
        expect(event.defaultPrevented).toBe(true)

        // The next press opens the book.
        title.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        click(title, { detail: 1 })
        expect(onOpenBook).toHaveBeenCalledWith('b')
    })

    it('asks before it removes a book, and names the book', async () => {
        const deleteBook = vi.spyOn(storage, 'deleteBook')
        const button = card('a').querySelector<HTMLElement>('.book-card-menu')!
        click(button)
        click(el('#book-menu [data-action="remove"]'))

        const dialog = el<HTMLDialogElement>('#remove-dialog')
        expect(dialog.open).toBe(true)
        expect(dialog.querySelector('.remove-name')?.textContent).toBe('Title a')
        expect(dialog.textContent?.replace(/\s+/g, ' ')).toContain(
            'its bookmarks and highlights are removed',
        )
        expect(deleteBook).not.toHaveBeenCalled()

        click(dialog.querySelector('[value="cancel"]')!)
        await vi.waitFor(() => expect(dialog.open).toBe(false))
        await Promise.resolve()

        expect(deleteBook).not.toHaveBeenCalled()
        expect(cardIds()).toEqual(['a', 'b'])
        expect(document.activeElement).toBe(button)
    })

    it('removes the book from storage and the card from the grid after the confirmation', async () => {
        click(card('a').querySelector('.book-card-menu')!)
        click(el('#book-menu [data-action="remove"]'))
        const other = card('b')

        click(el('#remove-dialog [value="remove"]'))

        await vi.waitFor(() => expect(cardIds()).toEqual(['b']))
        expect(await storage.getBook('a')).toBeUndefined()
        expect(card('b')).toBe(other)
        expect(el('#library-count').textContent).toBe('1 book')
        expect(toastTexts()).toEqual(['"Title a" was removed.'])
        // The focus goes to the next card, not to the top of the page.
        expect(document.activeElement).toBe(other.querySelector('.book-card-open'))
    })

    it('shows the empty state after the last book is removed', async () => {
        for (const id of ['a', 'b']) {
            click(card(id).querySelector('.book-card-menu')!)
            click(el('#book-menu [data-action="remove"]'))
            click(el('#remove-dialog [value="remove"]'))
            await vi.waitFor(() => expect(cardIds()).not.toContain(id))
        }

        expect(el('#library-empty').hidden).toBe(false)
        expect(el('#library-toolbar').hidden).toBe(true)
    })

    it('keeps the card and shows a toast when the remove fails', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(storage, 'deleteBook').mockRejectedValue(new Error('blocked'))
        click(card('a').querySelector('.book-card-menu')!)
        click(el('#book-menu [data-action="remove"]'))
        click(el('#remove-dialog [value="remove"]'))

        await vi.waitFor(() => expect(toastTexts()).toEqual(['The book was not removed.']))
        expect(cardIds()).toEqual(['a', 'b'])
        error.mockRestore()
    })
})

describe('refreshBook', () => {
    beforeEach(async () => {
        await addBooks(
            makeBook('a', { addedAt: 300 }),
            makeBook('b', { addedAt: 200 }),
            makeBook('c', { addedAt: 100 }),
        )
        await startScreen().load()
    })

    it('updates the progress of the card and moves it to the front in the "recent" order', async () => {
        const cardC = card('c')
        const others = [card('a'), card('b')]
        await storage.updateBook('c', { lastOpenedAt: 5000 })
        await storage.saveProgress({
            bookId: 'c',
            locator: { spineIndex: 0, offset: 10 },
            fraction: 0.25,
            updatedAt: 5000,
        })

        await screen.refreshBook('c')

        expect(cardIds()).toEqual(['c', 'a', 'b'])
        expect(card('c')).toBe(cardC)
        expect([card('a'), card('b')]).toEqual(others)
        expect(cardC.querySelector('.book-card-percent')?.textContent).toBe('25%')
    })

    it('does not move a card that is at its place', async () => {
        const insertBefore = vi.spyOn(grid(), 'insertBefore')
        await storage.updateBook('a', { lastOpenedAt: 5000 })

        await screen.refreshBook('a')

        expect(cardIds()).toEqual(['a', 'b', 'c'])
        expect(insertBefore).not.toHaveBeenCalled()
    })

    it('keeps the focus in a card that moves to the front', async () => {
        const link = card('c').querySelector<HTMLElement>('.book-card-open')!
        link.focus()
        await storage.updateBook('c', { lastOpenedAt: 5000 })

        await screen.refreshBook('c')

        expect(cardIds()).toEqual(['c', 'a', 'b'])
        expect(document.activeElement).toBe(link)
    })

    it('removes the card of a book that is not in storage any more', async () => {
        await storage.deleteBook('b')

        await screen.refreshBook('b')

        expect(cardIds()).toEqual(['a', 'c'])
    })

    it('reads the full library when the grid was never filled', async () => {
        mountPage()
        const listBooks = vi.spyOn(storage, 'listBooks')
        const getBook = vi.spyOn(storage, 'getBook')
        startScreen()

        await screen.refreshBook('a')

        expect(listBooks).toHaveBeenCalledTimes(1)
        expect(getBook).not.toHaveBeenCalled()
        expect(cardIds()).toEqual(['a', 'b', 'c'])
    })
})

describe('sync', () => {
    it('has no Sync item in the app menu without the sync', async () => {
        await startScreen().load()

        expect(el('#app-menu [data-action="sync"]').hidden).toBe(true)
    })

    let sync: {
        isOn: ReturnType<typeof vi.fn<() => boolean>>
        syncNow: ReturnType<typeof vi.fn<() => Promise<void>>>
        removeDownload: ReturnType<typeof vi.fn<(bookId: string) => Promise<boolean>>>
        openDialog: ReturnType<typeof vi.fn<(opener: Element | null) => void>>
    }

    beforeEach(() => {
        sync = {
            isOn: vi.fn(() => true),
            syncNow: vi.fn(async () => {}),
            removeDownload: vi.fn(async (bookId: string) => {
                await storage.updateBook(bookId, { remoteOnly: true })
                return true
            }),
            openDialog: vi.fn(),
        }
    })

    function startSyncedScreen(): LibraryScreen {
        screen = createLibraryScreen({
            root: el('#library-view'),
            storage,
            settings,
            onOpenBook,
            sync,
        })
        screens.push(screen)
        return screen
    }

    function click(target: Element): void {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }

    function openRemove(id: string): HTMLDialogElement {
        click(card(id).querySelector('.book-card-menu')!)
        click(el('#book-menu [data-action="remove"]'))
        return el<HTMLDialogElement>('#remove-dialog')
    }

    const cloud = (id: string) => card(id).querySelector<HTMLElement>('.book-card-cloud')!

    it('marks a book that has no file on this device', async () => {
        await addBooks(makeBook('a', { remoteOnly: true }), makeBook('b'))
        await startSyncedScreen().load()

        expect(cloud('a').hidden).toBe(false)
        expect(card('a').querySelector<HTMLElement>('.book-card-remote')!.hidden).toBe(false)
        expect(cloud('b').hidden).toBe(true)
    })

    it('sends the delete of a book at once and tells that all devices lose the book', async () => {
        await addBooks(makeBook('a'), makeBook('b'))
        await startSyncedScreen().load()

        click(openRemove('a').querySelector('[value="remove"]')!)

        await vi.waitFor(() => expect(cardIds()).toEqual(['b']))
        expect(sync.syncNow).toHaveBeenCalledTimes(1)
        expect(toastTexts()).toEqual(['"Title a" was removed from all your devices.'])
    })

    it('removes a book from all devices, or only its download', async () => {
        await addBooks(makeBook('a'))
        await startSyncedScreen().load()

        const dialog = openRemove('a')
        expect(dialog.querySelector('.remove-scope')?.textContent).toBe('all your devices')
        expect(dialog.querySelector<HTMLElement>('.remove-download')!.hidden).toBe(false)

        click(dialog.querySelector('[value="remove-download"]')!)

        await vi.waitFor(() => expect(cloud('a').hidden).toBe(false))
        expect(sync.removeDownload).toHaveBeenCalledWith('a')
        expect(cardIds()).toEqual(['a'])
        expect(toastTexts()).toEqual(['The download of "Title a" was removed.'])
    })

    it('keeps the download when the server does not have the file yet', async () => {
        sync.removeDownload.mockResolvedValue(false)
        await addBooks(makeBook('a'))
        await startSyncedScreen().load()

        click(openRemove('a').querySelector('[value="remove-download"]')!)

        await vi.waitFor(() => expect(toastTexts()).toHaveLength(1))
        expect(toastTexts()[0]).toContain('does not have this book yet')
        expect(cloud('a').hidden).toBe(true)
    })

    it('offers no download removal for a book with no file here, or with the sync off', async () => {
        await addBooks(makeBook('a', { remoteOnly: true }), makeBook('b'))
        await startSyncedScreen().load()

        let dialog = openRemove('a')
        expect(dialog.querySelector<HTMLElement>('.remove-download')!.hidden).toBe(true)
        click(dialog.querySelector('[value="cancel"]')!)
        await vi.waitFor(() => expect(dialog.open).toBe(false))

        sync.isOn.mockReturnValue(false)
        dialog = openRemove('b')
        expect(dialog.querySelector<HTMLElement>('.remove-download')!.hidden).toBe(true)
        expect(dialog.querySelector('.remove-scope')?.textContent).toBe('this device')
    })

    it('shows the books that a sync added, changed and removed', async () => {
        await addBooks(makeBook('a'), makeBook('b'))
        await startSyncedScreen().load()

        await storage.deleteBook('a')
        await storage.updateBook('b', { title: 'A new title' })
        await addBooks(makeBook('c', { remoteOnly: true }))
        await screen.applySyncChanges(['a', 'b', 'c'])

        expect([...cardIds()].sort()).toEqual(['b', 'c'])
        expect(card('b').querySelector('.book-card-title')?.textContent).toBe('A new title')
        expect(cloud('c').hidden).toBe(false)
    })

    it('waits for the first read of the library, which gets all books', async () => {
        await addBooks(makeBook('a'))
        startSyncedScreen()

        await screen.applySyncChanges(['a'])

        expect(cards()).toHaveLength(0)
    })

    it('opens the sync dialog from the app menu', async () => {
        await startSyncedScreen().load()
        const item = el('#app-menu [data-action="sync"]')

        expect(item.hidden).toBe(false)
        click(el('#app-menu-button'))
        click(item)

        expect(sync.openDialog).toHaveBeenCalledTimes(1)
    })
})

describe('capturePosition', () => {
    let scrollY: number

    beforeEach(async () => {
        scrollY = 0
        Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
        vi.spyOn(window, 'scrollTo').mockImplementation(((_x: number, y: number) => {
            scrollY = y
        }) as typeof window.scrollTo)
        window.scrollBy = vi.fn((_x: number, y: number) => {
            scrollY += y
        }) as unknown as typeof window.scrollBy
        await addBooks(makeBook('a'))
        await startScreen().load()
    })

    it('puts the page back at the same scroll offset', () => {
        scrollY = 800
        const restore = screen.capturePosition('unknown-book')
        scrollY = 0

        restore()

        expect(scrollY).toBe(800)
        expect(window.scrollBy).not.toHaveBeenCalled()
    })

    it('puts the card of the book back at the same place on screen', () => {
        // The place of the card in the window: 300 before, 180 after the library came back,
        // because the rows above it have estimated heights now.
        const top = vi.spyOn(card('a'), 'getBoundingClientRect')
        top.mockReturnValueOnce(new DOMRect(0, 300, 100, 200))
        scrollY = 800
        const restore = screen.capturePosition('a')
        scrollY = 0
        top.mockReturnValueOnce(new DOMRect(0, 180, 100, 200))

        restore()

        expect(window.scrollTo).toHaveBeenCalledWith(0, 800)
        expect(window.scrollBy).toHaveBeenCalledWith(0, -120)
    })

    it('gives the focus back to the card of the book that was open', () => {
        const restore = screen.capturePosition('a')
        expect(document.activeElement).toBe(document.body)

        restore()

        expect(document.activeElement).toBe(card('a').querySelector('.book-card-open'))
    })

    it('leaves the focus alone when a search hides the card', () => {
        const restore = screen.capturePosition('a')
        search('no book has these words')

        restore()

        expect(document.activeElement).toBe(document.body)
    })

    it('uses only the offset when the card is gone', () => {
        vi.spyOn(card('a'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 300, 1, 1))
        scrollY = 500
        const restore = screen.capturePosition('a')
        card('a').remove()

        restore()

        expect(scrollY).toBe(500)
        expect(window.scrollBy).not.toHaveBeenCalled()
    })
})

describe('import', () => {
    beforeEach(async () => {
        await addBooks(
            makeBook('m', { title: 'Middle', addedAt: 200 }),
            makeBook('z', { title: 'Zebra', addedAt: 100 }),
        )
        settings.update({ librarySort: 'title' })
        await startScreen().load()
    })

    it('adds the card of a new book at its place and keeps the other cards', async () => {
        const before = cards()
        mocks.importBook.mockResolvedValue({
            book: makeBook('n', { title: 'Nana' }),
            duplicate: false,
        })

        const summary = await screen.importFiles([epubFile('nana.epub')])

        expect(summary.added.map((book) => book.id)).toEqual(['n'])
        expect(cardIds()).toEqual(['m', 'n', 'z'])
        expect(cards().filter((item) => before.includes(item))).toEqual(before)
        expect(card('n').classList.contains('is-marked')).toBe(true)
        expect(el('#library-count').textContent).toBe('3 books')
        expect(toastTexts()).toEqual(['The book was added.'])
    })

    it('clears a search that hides the card of the new book', async () => {
        mocks.importBook.mockResolvedValue({
            book: makeBook('n', { title: 'Nana' }),
            duplicate: false,
        })
        search('zebra')

        await screen.importFiles([epubFile('nana.epub')])

        expect(card('n').hidden).toBe(false)
        expect(el<HTMLInputElement>('#library-search').value).toBe('')
        expect(visibleIds()).toEqual(['m', 'n', 'z'])
        expect(el('#library-count').textContent).toBe('3 books')
    })

    it('keeps a search that shows the card of the new book', async () => {
        mocks.importBook.mockResolvedValue({
            book: makeBook('n', { title: 'Nana' }),
            duplicate: false,
        })
        search('na')

        await screen.importFiles([epubFile('nana.epub')])

        expect(el<HTMLInputElement>('#library-search').value).toBe('na')
        expect(visibleIds()).toEqual(['n'])
    })

    it('gives the file, the storage and the parser to the importer', async () => {
        const file = epubFile('nana.epub')
        mocks.importBook.mockResolvedValue({ book: makeBook('n'), duplicate: false })

        await screen.importFiles([file])

        const options = mocks.importBook.mock.calls[0][0]
        expect(options.file).toBe(file)
        expect(options.storage).toBe(storage)
        expect(typeof options.open).toBe('function')
        expect(typeof options.onProgress).toBe('function')
    })

    it('imports the files one after the other and continues after a failure', async () => {
        const started: string[] = []
        mocks.importBook.mockImplementation(async ({ file }) => {
            const { name } = file as File
            started.push(name)
            if (name === 'locked.epub') throw new EpubError('drm', 'encrypted')
            if (name === 'broken.epub') throw new EpubError('no-container', 'no container.xml')
            if (name === 'odd.epub') throw new Error('Unexpected end of data')
            return { book: makeBook(name, { title: name }), duplicate: false }
        })

        const summary = await screen.importFiles([
            epubFile('locked.epub'),
            epubFile('a.epub'),
            epubFile('broken.epub'),
            epubFile('odd.epub'),
            epubFile('b.epub'),
        ])

        expect(started).toEqual(['locked.epub', 'a.epub', 'broken.epub', 'odd.epub', 'b.epub'])
        expect(summary.added.map((book) => book.id)).toEqual(['a.epub', 'b.epub'])
        expect(cardIds()).toEqual(['a.epub', 'b.epub', 'm', 'z'])
        expect(toastTexts()).toEqual(['2 books were added.'])

        const failures = Array.from(document.querySelectorAll('#import-status .import-failure'))
        expect(
            failures.map((item) => [
                item.querySelector('.import-failure-file')?.textContent,
                item.querySelector('.import-failure-message')?.textContent,
            ]),
        ).toEqual([
            ['locked.epub', 'This book has DRM protection and cannot be opened.'],
            ['broken.epub', 'This EPUB file has a structure that the reader cannot read.'],
            ['odd.epub', 'The book was not added.'],
        ])
        expect(failures[2].querySelector('details .import-failure-detail')?.textContent).toBe(
            'Unexpected end of data',
        )
        expect(el('#import-status .import-current').hidden).toBe(true)
    })

    it('refuses a file that is not a ZIP archive before the importer loads', async () => {
        const summary = await screen.importFiles([new File(['%PDF-1.7'], 'paper.pdf')])

        expect(mocks.importBook).not.toHaveBeenCalled()
        expect(summary.failures).toEqual([
            {
                fileName: 'paper.pdf',
                message: 'This file is not an EPUB file, or it is damaged.',
                detail: null,
            },
        ])
        expect(el('#import-status .import-failure-message').textContent).toBe(
            'This file is not an EPUB file, or it is damaged.',
        )
    })

    it('shows the storage message for a quota error', async () => {
        mocks.importBook.mockRejectedValue(new DOMException('full', 'QuotaExceededError'))

        await screen.importFiles([epubFile('big.epub')])

        expect(el('#import-status .import-failure-message').textContent).toBe(
            'There is not enough storage space on this device for this book.',
        )
    })

    it('shows a toast for a duplicate, clears the search and marks the card', async () => {
        const stored = (await storage.getBook('z'))!
        mocks.importBook.mockResolvedValue({ book: stored, duplicate: true })
        search('middle')
        expect(card('z').hidden).toBe(true)

        const summary = await screen.importFiles([epubFile('zebra-again.epub')])

        expect(summary.duplicates).toEqual([stored])
        expect(summary.added).toEqual([])
        expect(toastTexts()).toEqual(['This book is already in your library.'])
        expect(cardIds()).toEqual(['m', 'z'])
        expect(card('z').hidden).toBe(false)
        expect(card('z').classList.contains('is-marked')).toBe(true)
        expect(el<HTMLInputElement>('#library-search').value).toBe('')
    })

    it('scrolls to the card of a duplicate', async () => {
        const scrollIntoView = vi.fn()
        card('z').scrollIntoView = scrollIntoView
        mocks.importBook.mockResolvedValue({ book: (await storage.getBook('z'))!, duplicate: true })

        await screen.importFiles([epubFile('zebra-again.epub')])

        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    })

    describe('when the page is scrolled down', () => {
        let scrollTo: ReturnType<typeof vi.spyOn>

        // The status region is above the window, and the sticky header is at the top.
        function placeStatus(top: number): void {
            vi.spyOn(el('#import-status'), 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, top, 300, 0),
            )
            vi.spyOn(el('.library-header'), 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 300, 52),
            )
        }

        beforeEach(() => {
            scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
        })

        afterEach(() => {
            vi.restoreAllMocks()
        })

        it('goes to the top, where the import status is', async () => {
            placeStatus(-900)
            mocks.importBook.mockResolvedValue({ book: makeBook('n'), duplicate: false })

            await screen.importFiles([epubFile('n.epub')])

            expect(scrollTo).toHaveBeenCalledTimes(1)
            expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
        })

        it('goes to the top again after a file failed', async () => {
            placeStatus(-900)
            mocks.importBook.mockRejectedValue(new EpubError('drm', 'encrypted'))

            await screen.importFiles([epubFile('locked.epub')])

            expect(scrollTo).toHaveBeenCalledTimes(2)
        })

        it('does not move the page when the import status is on screen', async () => {
            placeStatus(120)
            mocks.importBook.mockRejectedValue(new EpubError('drm', 'encrypted'))

            await screen.importFiles([epubFile('locked.epub')])

            expect(scrollTo).not.toHaveBeenCalled()
        })

        it('does not move the page while the reader is on screen', async () => {
            placeStatus(-900)
            el('#library-view').hidden = true
            mocks.importBook.mockResolvedValue({ book: makeBook('n'), duplicate: false })

            await screen.importFiles([epubFile('n.epub')])

            expect(scrollTo).not.toHaveBeenCalled()
        })
    })

    it('asks for persistent storage one time, after the first book that was added', async () => {
        mocks.importBook
            .mockRejectedValueOnce(new EpubError('drm', 'encrypted'))
            .mockResolvedValueOnce({ book: makeBook('p'), duplicate: false })
            .mockResolvedValueOnce({ book: makeBook('q'), duplicate: false })

        await screen.importFiles([epubFile('locked.epub')])
        expect(mocks.requestPersistentStorage).not.toHaveBeenCalled()

        await screen.importFiles([epubFile('p.epub'), epubFile('q.epub')])
        expect(mocks.requestPersistentStorage).toHaveBeenCalledTimes(1)
    })

    it('imports the files of the file input and resets the input', async () => {
        mocks.importBook.mockResolvedValue({
            book: makeBook('n', { title: 'Nana' }),
            duplicate: false,
        })
        const input = el<HTMLInputElement>('#book-files')
        const file = epubFile('nana.epub')
        Object.defineProperty(input, 'files', { configurable: true, get: () => [file] })
        const setValue = vi.spyOn(input, 'value', 'set')

        input.dispatchEvent(new Event('change', { bubbles: true }))

        expect(setValue).toHaveBeenCalledWith('')
        await vi.waitFor(() => expect(cardIds()).toContain('n'))
    })

    it('has a file input for more than one EPUB file', () => {
        const input = el<HTMLInputElement>('#book-files')

        expect(input.type).toBe('file')
        expect(input.multiple).toBe(true)
        expect(input.accept).toBe('.epub,application/epub+zip')
    })

    it('opens the file input from each "Add books" button', () => {
        const input = el<HTMLInputElement>('#book-files')
        const open = vi.spyOn(input, 'click').mockImplementation(() => {})
        const buttons = document.querySelectorAll<HTMLElement>('[data-action="add-books"]')

        expect(buttons).toHaveLength(2)
        for (const button of buttons) button.click()

        expect(open).toHaveBeenCalledTimes(2)
    })

    it('imports files that the user drops on the window', async () => {
        mocks.importBook.mockResolvedValue({
            book: makeBook('n', { title: 'Nana' }),
            duplicate: false,
        })
        const drop = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
            dataTransfer: { types: ['Files'], files: [epubFile('nana.epub')] },
        })

        document.body.dispatchEvent(drop)

        await vi.waitFor(() => expect(cardIds()).toContain('n'))
    })

    it('takes no dropped files while the reader is on screen', async () => {
        el('#library-view').hidden = true
        const drop = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
            dataTransfer: { types: ['Files'], files: [epubFile('nana.epub')] },
        })

        document.body.dispatchEvent(drop)
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(drop.defaultPrevented).toBe(true)
        expect(mocks.importBook).not.toHaveBeenCalled()
    })
})
