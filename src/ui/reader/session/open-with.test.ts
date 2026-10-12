import { Blob as NodeBlob } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContentLoader } from '$lib/content'
import type { ContentLoader } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import { EpubError } from '$lib/epub/types'
import { createSettingsStore } from '$lib/settings'
import type { OwnedSettingsStore } from '$lib/settings'
import { createLibraryStorage } from '$lib/storage'
import type { LibraryStorage } from '$lib/storage/types'
import type { ReaderSession } from '../types'
import { FONT_WAIT_MS, openSessionWith } from './open-with'
import type { SessionParts } from './open-with'
import {
    BOOK_ID,
    CHAPTER_1,
    CHAPTER_2,
    createFakeViews,
    makeBook,
    makeBookmark,
    makeHighlight,
    makeRecord,
} from './testing/fixtures'
import type { FakeViews } from './testing/fixtures'

// The session also starts the load of the font. These tests look only at the loader of the
// open, which is an input.
vi.mock('$lib/fonts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/fonts')>()),
    ensureFontLoaded: vi.fn(() => Promise.resolve()),
}))

const OPEN_TIME = 1_700_000_123_456

let storage: LibraryStorage
let settings: OwnedSettingsStore
let views: FakeViews
let container: HTMLElement
let book: EpubBook
/** The content loaders that the opens made, each with spies on prepare and dispose. */
let loaders: ContentLoader[]
/** The embedded font families that the content loaders report. Null gives those of the book. */
let bookFonts: string[] | null
let order: string[]
const sessions: ReaderSession[] = []

async function settle(rounds = 6): Promise<void> {
    for (let round = 0; round < rounds; round++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
}

async function addBook(): Promise<void> {
    await storage.addBook({
        record: makeRecord(),
        file: new NodeBlob(['epub bytes']) as unknown as Blob,
        cover: null,
    })
}

function makeParts(changes: Partial<SessionParts> = {}): SessionParts {
    return {
        openEpub: vi.fn(async () => book),
        createContentLoader: vi.fn((options: { book: EpubBook }) => {
            const loader = createContentLoader(options)
            const spied: ContentLoader = {
                prepare: vi.fn(async () => {
                    await loader.prepare()
                    order.push('prepared')
                }),
                get bookFonts() {
                    return bookFonts ?? loader.bookFonts
                },
                load: loader.load,
                loadText: loader.loadText,
                dispose: vi.fn(loader.dispose),
            }
            loaders.push(spied)
            return spied
        }),
        loadFont: vi.fn(async () => {
            order.push('font')
        }),
        settings,
        createView: vi.fn((mode, options) => {
            order.push('view')
            return views.createView(mode, options)
        }),
        systemDark: () => false,
        watchSystemTheme: () => () => {},
        now: () => OPEN_TIME,
        ...changes,
    }
}

function openBook(parts: SessionParts = makeParts(), signal?: AbortSignal): Promise<ReaderSession> {
    const opened = openSessionWith({ bookId: BOOK_ID, storage, container, signal }, parts)
    opened.then(
        (session) => sessions.push(session),
        () => {},
    )
    return opened
}

beforeEach(() => {
    // A jsdom Blob does not survive the structured clone of fake-indexeddb.
    vi.stubGlobal('Blob', NodeBlob)
    storage = createLibraryStorage({ databaseName: 'open-test', indexedDB: new IDBFactory() })
    settings = createSettingsStore({ storage: null })
    views = createFakeViews()
    container = document.createElement('div')
    book = makeBook()
    loaders = []
    bookFonts = null
    order = []
})

afterEach(async () => {
    for (const session of sessions.splice(0)) await session.destroy()
    settings.destroy()
    storage.close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('openSessionWith', () => {
    it('rejects with "book-not-found" when the library does not have the book', async () => {
        const parts = makeParts()
        const opened = openBook(parts)
        await expect(opened).rejects.toThrow('book-not-found')
        await expect(opened).rejects.toBeInstanceOf(Error)
        expect(parts.openEpub).not.toHaveBeenCalled()
        expect(parts.createView).not.toHaveBeenCalled()
    })

    it('rejects with "book-not-found" when the file of the book is not there', async () => {
        await addBook()
        vi.spyOn(storage, 'getFile').mockResolvedValue(undefined)
        const parts = makeParts()
        await expect(openBook(parts)).rejects.toThrow('book-not-found')
        expect(parts.openEpub).not.toHaveBeenCalled()
    })

    it('does not leave a rejection with no handler when the book is not there', async () => {
        const failure = new Error('Unable to read the bookmarks.')
        vi.spyOn(storage, 'listBookmarks').mockRejectedValue(failure)
        const unhandled = vi.fn()
        process.on('unhandledRejection', unhandled)
        try {
            await expect(openBook()).rejects.toThrow('book-not-found')
            await settle()
            expect(unhandled).not.toHaveBeenCalled()
        } finally {
            process.off('unhandledRejection', unhandled)
        }
    })

    it('opens the book file and makes a session with the saved data', async () => {
        await addBook()
        const progress = {
            bookId: BOOK_ID,
            locator: { spineIndex: CHAPTER_2, offset: 77 },
            fraction: 0.3,
            updatedAt: 5,
        }
        const bookmark = makeBookmark('b1', { locator: { spineIndex: CHAPTER_2, offset: 80 } })
        const highlight = makeHighlight('h1')
        await storage.saveProgress(progress)
        await storage.putBookmark(bookmark)
        await storage.putHighlight(highlight)
        const parts = makeParts()

        const session = await openBook(parts)

        expect(parts.openEpub).toHaveBeenCalledTimes(1)
        const [file] = vi.mocked(parts.openEpub).mock.calls[0]
        expect(await file.text()).toBe('epub bytes')
        expect(parts.createContentLoader).toHaveBeenCalledWith({ book })

        expect(session.record).toEqual(makeRecord())
        expect(session.book).toBe(book)
        expect(session.content).toBe(loaders[0])
        expect(session.bookmarks).toEqual([bookmark])
        expect(session.highlights).toEqual([highlight])
        expect(session.toc).toHaveLength(5)

        expect(parts.createView).toHaveBeenCalledTimes(1)
        const { mode, options } = views.current
        expect(mode).toBe('paged')
        expect(session.view).toBe(views.current)
        expect(options.container).toBe(container)
        expect(options.book).toBe(book)
        expect(options.content).toBe(loaders[0])
        expect(options.initial).toEqual({ spineIndex: CHAPTER_2, offset: 77 })
        expect(options.highlights).toEqual([expect.objectContaining({ id: 'h1' })])
        expect(options.appearance.theme).toBe('light')
    })

    it('starts at the first linear spine item when the book has no saved position', async () => {
        await addBook()
        book = makeBook({ nonLinear: ['OEBPS/cover.xhtml'] })
        await openBook()
        expect(views.current.options.initial).toEqual({ spineIndex: CHAPTER_1, offset: 0 })
    })

    it('uses the settings store and the system colour scheme that it gets', async () => {
        await addBook()
        settings.update({ layout: 'scroll', fontSize: 27 })
        let themeListener: ((dark: boolean) => void) | undefined
        const session = await openBook(
            makeParts({
                systemDark: () => true,
                watchSystemTheme(listener) {
                    themeListener = listener
                    return () => {}
                },
            }),
        )
        expect(views.current.mode).toBe('scroll')
        expect(views.current.options.appearance).toMatchObject({ theme: 'dark', fontSize: 27 })

        themeListener?.(false)
        expect(views.current.setAppearance).toHaveBeenLastCalledWith(
            expect.objectContaining({ theme: 'light' }),
        )
        settings.update({ layout: 'paged' })
        expect(session.view).toBe(views.current)
        expect(views.current.mode).toBe('paged')
    })

    it('prepares the content loader before it makes the view', async () => {
        await addBook()
        await openBook()
        expect(loaders[0].prepare).toHaveBeenCalledTimes(1)
        expect(order).toEqual(['prepared', 'view'])
    })

    it('reads the saved data while the book file opens', async () => {
        await addBook()
        const reads: string[] = []
        const getProgress = storage.getProgress
        vi.spyOn(storage, 'getProgress').mockImplementation((id) => {
            reads.push('progress')
            return getProgress(id)
        })
        const parts = makeParts({
            openEpub: vi.fn(async () => {
                reads.push('open')
                return book
            }),
        })
        await openBook(parts)
        expect(reads).toEqual(['progress', 'open'])
    })

    it('resolves only after the first chapter of the view is shown', async () => {
        await addBook()
        views = createFakeViews({ manualReady: true })
        let done = false
        const opened = openBook().then((session) => {
            done = true
            return session
        })
        await settle()
        expect(views.views).toHaveLength(1)
        expect(done).toBe(false)

        views.current.resolveReady()
        const session = await opened
        expect(session.view).toBe(views.current)
    })

    it('writes the time of the open to the book record and does not wait for it', async () => {
        await addBook()
        let finishWrite = (): void => {}
        const update = vi.spyOn(storage, 'updateBook').mockReturnValue(
            new Promise<void>((resolve) => {
                finishWrite = resolve
            }),
        )
        await openBook()
        expect(update).toHaveBeenCalledTimes(1)
        expect(update).toHaveBeenCalledWith(BOOK_ID, { lastOpenedAt: OPEN_TIME })
        finishWrite()
    })

    it('stores the time of the open and keeps the other fields of the record', async () => {
        await addBook()
        await openBook()
        await settle()
        expect(await storage.getBook(BOOK_ID)).toEqual(makeRecord({ lastOpenedAt: OPEN_TIME }))
    })

    it('opens the book when the write of the open time fails', async () => {
        await addBook()
        vi.spyOn(storage, 'updateBook').mockRejectedValue(new Error('quota'))
        const session = await openBook()
        await settle()
        expect(session.view).toBe(views.current)
    })

    it('opens the book when the write of the open time throws', async () => {
        await addBook()
        vi.spyOn(storage, 'updateBook').mockImplementation(() => {
            throw new Error('closed')
        })
        const session = await openBook()
        expect(session.view).toBe(views.current)
        expect(views.current.isDestroyed).toBe(false)
    })

    it('destroys the view and the loader and rejects when the first chapter does not load', async () => {
        await addBook()
        views = createFakeViews({ manualReady: true })
        const update = vi.spyOn(storage, 'updateBook')
        const save = vi.spyOn(storage, 'saveProgress')
        const failure = new Error('The first chapter did not load.')
        const result = expect(openBook()).rejects.toBe(failure)
        await settle()
        views.current.rejectReady(failure)
        await result

        expect(views.current.isDestroyed).toBe(true)
        expect(loaders[0].dispose).toHaveBeenCalledTimes(1)
        expect(update).not.toHaveBeenCalled()
        expect(save).not.toHaveBeenCalled()
    })

    it('waits for the view of a new layout when the setting changes during the open', async () => {
        await addBook()
        views = createFakeViews({ manualReady: true })
        let done = false
        const opened = openBook().then((session) => {
            done = true
            return session
        })
        await settle()
        const first = views.current
        settings.update({ layout: 'scroll' })
        expect(views.views).toHaveLength(2)

        // The first view is gone, so its result does not count.
        first.rejectReady(new Error('destroyed'))
        await settle()
        expect(done).toBe(false)

        views.current.resolveReady()
        const session = await opened
        expect(session.view).toBe(views.current)
        expect(views.current.mode).toBe('scroll')
    })

    describe('a signal that stops the open', () => {
        it('destroys the view and the loader when the view waits for its first chapter', async () => {
            await addBook()
            views = createFakeViews({ manualReady: true })
            const update = vi.spyOn(storage, 'updateBook')
            const stop = new AbortController()
            const opened = openBook(makeParts(), stop.signal)
            const result = expect(opened).rejects.toMatchObject({ name: 'AbortError' })
            await settle()
            expect(views.views).toHaveLength(1)

            // The view never gets ready, as a view in a hidden element does.
            stop.abort()
            await result
            expect(views.current.isDestroyed).toBe(true)
            expect(loaders[0].dispose).toHaveBeenCalledTimes(1)
            expect(update).not.toHaveBeenCalled()
        })

        it('makes no view when the signal aborts while the book file opens', async () => {
            await addBook()
            const stop = new AbortController()
            let finish!: (book: EpubBook) => void
            const parts = makeParts({
                openEpub: vi.fn(() => new Promise<EpubBook>((resolve) => (finish = resolve))),
            })
            const result = expect(openBook(parts, stop.signal)).rejects.toMatchObject({
                name: 'AbortError',
            })
            await settle()
            stop.abort()
            finish(book)
            await result

            expect(parts.createView).not.toHaveBeenCalled()
            expect(loaders[0].dispose).toHaveBeenCalledTimes(1)
        })

        it('reads no book file for a signal that is aborted at the start', async () => {
            await addBook()
            const stop = new AbortController()
            stop.abort()
            const parts = makeParts()
            await expect(openBook(parts, stop.signal)).rejects.toMatchObject({
                name: 'AbortError',
            })
            expect(parts.openEpub).not.toHaveBeenCalled()
        })

        it('opens the book as usual when the signal does not abort', async () => {
            await addBook()
            const stop = new AbortController()
            const session = await openBook(makeParts(), stop.signal)
            expect(session.view).toBe(views.current)

            // An abort after the open does nothing to the session.
            stop.abort()
            await settle()
            expect(views.current.isDestroyed).toBe(false)
        })
    })

    describe('the font of the settings', () => {
        /** The time limit runs on a fake clock. The storage of the tests needs setImmediate. */
        function useFakeTimeouts(): void {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        }

        /** A font loader that the test completes by hand. */
        function manualFont(): { loadFont: SessionParts['loadFont']; arrive(): void } {
            let arrive = (): void => {}
            const ready = new Promise<void>((resolve) => (arrive = resolve))
            return { loadFont: vi.fn(() => ready), arrive: () => arrive() }
        }

        it('starts the load of a bundled font before the book file opens', async () => {
            await addBook()
            useFakeTimeouts()
            settings.update({ fontId: 'literata' })
            const parts = makeParts({
                openEpub: vi.fn(async () => {
                    order.push('open')
                    return book
                }),
            })

            // The font is ready at once. The clock does not move, so the open did not wait
            // for the time limit.
            await openBook(parts)
            expect(parts.loadFont).toHaveBeenCalledTimes(1)
            expect(parts.loadFont).toHaveBeenCalledWith('literata')
            expect(order).toEqual(['font', 'open', 'prepared', 'view'])
            expect(vi.getTimerCount()).toBe(0)
        })

        it('makes the view only after a bundled font is ready', async () => {
            await addBook()
            useFakeTimeouts()
            settings.update({ fontId: 'literata' })
            const font = manualFont()
            const opened = openBook(makeParts({ loadFont: font.loadFont }))
            await settle()
            // The book is ready and the font is not.
            expect(order).toEqual(['prepared'])

            font.arrive()
            const session = await opened
            expect(order).toEqual(['prepared', 'view'])
            expect(session.view).toBe(views.current)
            expect(views.current.options.appearance.fontFamily).toContain('Literata Variable')
            expect(vi.getTimerCount()).toBe(0)
        })

        it('shows the book after 500 ms when a bundled font is not ready', async () => {
            await addBook()
            useFakeTimeouts()
            settings.update({ fontId: 'literata' })
            // The font file is on a slow network.
            const parts = makeParts({ loadFont: vi.fn(() => new Promise<void>(() => {})) })
            let done = false
            const opened = openBook(parts).then((session) => {
                done = true
                return session
            })
            await settle()
            expect(order).toEqual(['prepared'])

            vi.advanceTimersByTime(FONT_WAIT_MS - 1)
            await settle()
            expect(order).toEqual(['prepared'])
            expect(done).toBe(false)

            vi.advanceTimersByTime(1)
            const session = await opened
            expect(FONT_WAIT_MS).toBe(500)
            expect(order).toEqual(['prepared', 'view'])
            expect(session.view).toBe(views.current)
        })

        it.each([
            ['rejects', () => Promise.reject(new Error('offline'))],
            [
                'throws',
                () => {
                    throw new Error('no loader')
                },
            ],
        ])('opens the book at once when the font loader %s', async (_name, loadFont) => {
            await addBook()
            useFakeTimeouts()
            settings.update({ fontId: 'inter' })
            const session = await openBook(makeParts({ loadFont: vi.fn(loadFont) }))
            expect(session.view).toBe(views.current)
            expect(vi.getTimerCount()).toBe(0)
        })

        it.each(['publisher', 'georgia', 'system-serif', 'book:Not In This Book'])(
            'does not wait for a font with the font id "%s"',
            async (fontId) => {
                await addBook()
                useFakeTimeouts()
                settings.update({ fontId })
                let timersAtView = -1
                const parts = makeParts({
                    createView: vi.fn((mode, options) => {
                        timersAtView = vi.getTimerCount()
                        return views.createView(mode, options)
                    }),
                })

                const session = await openBook(parts)
                expect(session.view).toBe(views.current)
                expect(parts.loadFont).not.toHaveBeenCalled()
                // The open made no time limit.
                expect(timersAtView).toBe(0)
            },
        )

        it('waits for a font of the book after the loader has its font faces', async () => {
            await addBook()
            useFakeTimeouts()
            bookFonts = ['Minion']
            settings.update({ fontId: 'book:Minion' })
            const parts = makeParts()
            await openBook(parts)
            expect(parts.loadFont).toHaveBeenCalledTimes(1)
            expect(parts.loadFont).toHaveBeenCalledWith('book:Minion')
            expect(order).toEqual(['prepared', 'font', 'view'])
            expect(views.current.options.appearance.fontFamily).toBe('"Minion", serif')
        })

        it('shows the book after 500 ms when a font of the book is not ready', async () => {
            await addBook()
            useFakeTimeouts()
            bookFonts = ['Minion']
            settings.update({ fontId: 'book:Minion' })
            const parts = makeParts({ loadFont: vi.fn(() => new Promise<void>(() => {})) })
            const opened = openBook(parts)
            await settle()
            // The wait started, and its time limit is on the clock.
            expect(parts.loadFont).toHaveBeenCalledTimes(1)
            expect(order).toEqual(['prepared'])

            vi.advanceTimersByTime(FONT_WAIT_MS - 1)
            await settle()
            expect(order).toEqual(['prepared'])

            vi.advanceTimersByTime(1)
            await opened
            expect(order).toEqual(['prepared', 'view'])
        })

        it.each(['literata', 'book:Minion'])(
            'makes no view when the signal aborts during the wait for the font "%s"',
            async (fontId) => {
                await addBook()
                useFakeTimeouts()
                bookFonts = ['Minion']
                settings.update({ fontId })
                const font = manualFont()
                const parts = makeParts({ loadFont: font.loadFont })
                const stop = new AbortController()
                const result = expect(openBook(parts, stop.signal)).rejects.toMatchObject({
                    name: 'AbortError',
                })
                await settle()
                expect(order).toEqual(['prepared'])

                stop.abort()
                font.arrive()
                await result
                expect(parts.createView).not.toHaveBeenCalled()
                expect(loaders[0].dispose).toHaveBeenCalledTimes(1)
            },
        )
    })

    it('rejects with the error of the EPUB parser', async () => {
        await addBook()
        const failure = new EpubError('drm', 'The book has DRM.')
        const parts = makeParts({ openEpub: vi.fn(async () => Promise.reject(failure)) })
        await expect(openBook(parts)).rejects.toBe(failure)
        expect(parts.createContentLoader).not.toHaveBeenCalled()
        expect(parts.createView).not.toHaveBeenCalled()
    })

    it('disposes the loader and rejects when the saved data cannot be read', async () => {
        await addBook()
        const failure = new Error('Unable to read the bookmarks.')
        vi.spyOn(storage, 'listBookmarks').mockRejectedValue(failure)
        const parts = makeParts()
        await expect(openBook(parts)).rejects.toBe(failure)
        expect(loaders[0].dispose).toHaveBeenCalledTimes(1)
        expect(parts.createView).not.toHaveBeenCalled()
    })
})
