import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContentLoader } from '$lib/content'
import type { ContentLoader } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import { ensureFontLoaded } from '$lib/fonts'
import { createFakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import type { FakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import type { RelocateInfo, SelectionInfo } from '$lib/reader/types'
import { createSettingsStore } from '$lib/settings'
import type { OwnedSettingsStore, SettingsPatch } from '$lib/settings'
import { createLibraryStorage } from '$lib/storage'
import type {
    BookmarkRecord,
    BookRecord,
    FontRecord,
    HighlightRecord,
    LibraryStorage,
    ProgressRecord,
} from '$lib/storage/types'
import type { ReaderSession, ReaderSessionEvents, SearchResult } from '../types'
import { createReaderSession, HIGHLIGHT_CLOSED_MESSAGE, PROGRESS_SAVE_DELAY_MS } from './session'
import {
    BOOK_ID,
    CHAPTER_1,
    CHAPTER_2,
    CHAPTER_3,
    chapterXhtml,
    COVER,
    createFakeViews,
    makeBook,
    makeBookmark,
    makeHighlight,
    makeRecord,
    NOTES,
    page,
} from './testing/fixtures'
import type { FakeViews } from './testing/fixtures'

vi.mock('$lib/fonts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/fonts')>()),
    ensureFontLoaded: vi.fn(() => Promise.resolve()),
}))

const START_TIME = 1_700_000_000_000

const EVENT_NAMES: (keyof ReaderSessionEvents)[] = [
    'relocate',
    'bookmarks',
    'highlights',
    'selection',
    'mode',
    'view',
    'center-tap',
    'highlight-tap',
    'image-tap',
    'error',
]

interface OpenOptions {
    book?: EpubBook
    record?: BookRecord
    progress?: ProgressRecord | null
    bookmarks?: BookmarkRecord[]
    highlights?: HighlightRecord[]
    settings?: SettingsPatch
    systemDark?: boolean
    bookFonts?: string[]
    userFonts?: FontRecord[]
}

interface Harness {
    session: ReaderSession
    views: FakeViews
    storage: LibraryStorage
    settings: OwnedSettingsStore
    content: ContentLoader
    fonts: FakeUserFonts
    container: HTMLElement
    /** Each event of the session in sequence. */
    events: [name: keyof ReaderSessionEvents, payload: unknown][]
    eventNames(): string[]
    systemTheme: { stopped: boolean; change(dark: boolean): void }
    /** The number of listeners that the session has on the settings store now. */
    settingsListeners(): number
}

const harnesses: Harness[] = []

/** Lets promise chains and IndexedDB requests complete. Fake timers do not move. */
async function settle(rounds = 4): Promise<void> {
    for (let round = 0; round < rounds; round++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
}

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
}

async function open(options: OpenOptions = {}): Promise<Harness> {
    const book = options.book ?? makeBook()
    const record = options.record ?? makeRecord()
    const storage = createLibraryStorage({
        databaseName: 'session-test',
        indexedDB: new IDBFactory(),
    })
    for (const bookmark of options.bookmarks ?? []) await storage.putBookmark(bookmark)
    for (const highlight of options.highlights ?? []) await storage.putHighlight(highlight)

    const settings = createSettingsStore({ storage: null })
    if (options.settings) settings.update(options.settings)
    const subscribe = settings.subscribe
    let settingsListeners = 0
    settings.subscribe = (listener) => {
        settingsListeners++
        const stop = subscribe(listener)
        return () => {
            settingsListeners--
            stop()
        }
    }

    const loader = createContentLoader({ book })
    const bookFonts = options.bookFonts ?? []
    // The registry gives each font to the mocked loader, as the real one does for a font that
    // is not a font of the user.
    const fonts = createFakeUserFonts({
        list: options.userFonts,
        load: (fontId) => ensureFontLoaded(fontId),
    })
    const content: ContentLoader = {
        prepare: loader.prepare,
        get bookFonts() {
            return bookFonts
        },
        load: vi.fn(loader.load),
        loadText: vi.fn(loader.loadText),
        dispose: vi.fn(loader.dispose),
    }

    const views = createFakeViews()
    const container = document.createElement('div')
    let themeListener: ((dark: boolean) => void) | undefined
    const systemTheme = {
        stopped: false,
        change(dark: boolean) {
            themeListener?.(dark)
        },
    }

    const session = createReaderSession({
        record,
        book,
        content,
        storage,
        container,
        settings,
        fonts,
        createView: views.createView,
        initialProgress: options.progress,
        bookmarks: options.bookmarks ?? [],
        highlights: options.highlights ?? [],
        systemDark: () => options.systemDark ?? false,
        watchSystemTheme(listener) {
            themeListener = listener
            return () => {
                themeListener = undefined
                systemTheme.stopped = true
            }
        },
        now: () => Date.now(),
    })

    const events: Harness['events'] = []
    for (const name of EVENT_NAMES) session.on(name, (payload) => events.push([name, payload]))

    const harness: Harness = {
        session,
        views,
        storage,
        settings,
        content,
        fonts,
        container,
        events,
        eventNames: () => events.map(([name]) => name),
        systemTheme,
        settingsListeners: () => settingsListeners,
    }
    harnesses.push(harness)
    return harness
}

function selectionOf(start: number, end: number): SelectionInfo {
    return {
        range: { spineIndex: CHAPTER_2, start, end },
        text: 'selected text',
        bounds: new DOMRect(1, 2, 3, 4),
    }
}

/** A page of chapter 2. The chapter has no contents entry with a fragment. */
function chapter2Page(start: number, end: number, chapterLength = 4000): RelocateInfo {
    return page({ spineIndex: CHAPTER_2, start, end, chapterLength })
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(START_TIME)
    // The search then needs no timer between two chapters.
    vi.stubGlobal('scheduler', { yield: () => Promise.resolve() })
    vi.mocked(ensureFontLoaded).mockClear()
})

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.session.destroy()
        harness.settings.destroy()
        harness.storage.close()
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'visibilityState')
})

describe('start', () => {
    it('makes the view of the layout setting with the book data', async () => {
        const highlight = makeHighlight('h1', { note: 'A note' })
        const { session, views, content, container } = await open({ highlights: [highlight] })

        expect(views.createView).toHaveBeenCalledTimes(1)
        const [mode, options] = views.createView.mock.calls[0]
        expect(mode).toBe('paged')
        expect(options.container).toBe(container)
        expect(options.book).toBe(session.book)
        expect(options.content).toBe(content)
        expect(options.highlights).toEqual([
            { id: 'h1', spineIndex: CHAPTER_1, start: 10, end: 20, color: 'yellow', hasNote: true },
        ])
        expect(session.view).toBe(views.current)
        expect(session.record.id).toBe(BOOK_ID)
        expect(session.content).toBe(content)
    })

    it('makes the scroll view when the layout setting is scroll', async () => {
        const { views } = await open({ settings: { layout: 'scroll' } })
        expect(views.current.mode).toBe('scroll')
    })

    it('starts at the saved position', async () => {
        const { views } = await open({
            progress: {
                bookId: BOOK_ID,
                locator: { spineIndex: CHAPTER_2, offset: 321 },
                fraction: 0.4,
                updatedAt: 1,
            },
        })
        expect(views.current.options.initial).toEqual({ spineIndex: CHAPTER_2, offset: 321 })
    })

    it.each([
        ['after the last spine item', 5],
        ['negative', -1],
        ['not an integer', 1.5],
        ['not a number', Number.NaN],
    ])('starts at the first linear spine item when the saved index is %s', async (_name, index) => {
        const book = makeBook({ nonLinear: ['OEBPS/cover.xhtml', 'OEBPS/notes.xhtml'] })
        const { views } = await open({
            book,
            progress: {
                bookId: BOOK_ID,
                locator: { spineIndex: index, offset: 50 },
                fraction: 0.4,
                updatedAt: 1,
            },
        })
        expect(views.current.options.initial).toEqual({ spineIndex: CHAPTER_1, offset: 0 })
    })

    it('starts at the first linear spine item when there is no saved position', async () => {
        const book = makeBook({ nonLinear: ['OEBPS/cover.xhtml'] })
        const first = await open({ book })
        expect(first.views.current.options.initial).toEqual({ spineIndex: CHAPTER_1, offset: 0 })

        const second = await open({ progress: null })
        expect(second.views.current.options.initial).toEqual({ spineIndex: COVER, offset: 0 })
    })

    it('starts at the chapter start when the saved offset is not valid', async () => {
        const { views } = await open({
            progress: {
                bookId: BOOK_ID,
                locator: { spineIndex: CHAPTER_2, offset: -7 },
                fraction: 0.4,
                updatedAt: 1,
            },
        })
        expect(views.current.options.initial).toEqual({ spineIndex: CHAPTER_2, offset: 0 })
    })

    it('has no position and no contents entry before the first relocate', async () => {
        const { session } = await open()
        expect(session.position).toBeNull()
        expect(session.currentTocEntry).toBeNull()
        expect(session.wordsRemaining).toBeNull()
        expect(session.isBookmarked).toBe(false)
        expect(session.canGoBack).toBe(false)
        expect(session.mode).toBe('read')
    })

    it('has the flat contents list of the book', async () => {
        const { session } = await open()
        expect(session.toc).toEqual([
            { title: 'Chapter One', depth: 0, spineIndex: CHAPTER_1, fragment: null },
            { title: 'Section 1.1', depth: 1, spineIndex: CHAPTER_1, fragment: 's1' },
            { title: 'Section 1.2', depth: 1, spineIndex: CHAPTER_1, fragment: 's2' },
            { title: 'Chapter Two', depth: 0, spineIndex: CHAPTER_2, fragment: null },
            { title: 'Chapter Three', depth: 0, spineIndex: CHAPTER_3, fragment: null },
        ])
    })

    it('has one entry for each linear spine item when the book has no contents list', async () => {
        const { session } = await open({ book: makeBook({ toc: [] }) })
        expect(session.toc.map((entry) => [entry.title, entry.spineIndex])).toEqual([
            ['Section 1', COVER],
            ['Section 2', CHAPTER_1],
            ['Section 3', CHAPTER_2],
            ['Section 4', CHAPTER_3],
        ])
    })

    it('sorts the bookmarks and highlights that it gets', async () => {
        const { session } = await open({
            bookmarks: [
                makeBookmark('late', { locator: { spineIndex: CHAPTER_3, offset: 0 } }),
                makeBookmark('early', { locator: { spineIndex: CHAPTER_1, offset: 9 } }),
            ],
            highlights: [
                makeHighlight('second', { start: 50, end: 60 }),
                makeHighlight('first', { start: 5, end: 8 }),
            ],
        })
        expect(session.bookmarks.map((bookmark) => bookmark.id)).toEqual(['early', 'late'])
        expect(session.highlights.map((highlight) => highlight.id)).toEqual(['first', 'second'])
    })
})

describe('appearance', () => {
    it('gives the view the appearance of the settings', async () => {
        const { views } = await open({
            settings: { theme: 'sepia', fontId: 'georgia', fontSize: 22, lineHeight: null },
        })
        expect(views.current.options.appearance).toEqual({
            theme: 'sepia',
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 22,
            lineHeight: null,
            margin: 'normal',
            textAlign: 'publisher',
            hyphenate: false,
            publisherStyles: true,
            columns: 'auto',
            pageTurn: 'slide',
        })
    })

    it('resolves the automatic theme with the system colour scheme', async () => {
        const light = await open()
        expect(light.views.current.options.appearance.theme).toBe('light')

        const dark = await open({ systemDark: true, settings: { darkTheme: 'black' } })
        expect(dark.views.current.options.appearance.theme).toBe('black')
    })

    it('uses a font of the book only when the book has it', async () => {
        const has = await open({ settings: { fontId: 'book:Minion' }, bookFonts: ['Minion'] })
        expect(has.views.current.options.appearance.fontFamily).toBe('"Minion", serif')

        const missing = await open({ settings: { fontId: 'book:Minion' } })
        expect(missing.views.current.options.appearance.fontFamily).toBeNull()
    })

    it('uses a font of the user only when its files are on this device', async () => {
        const font: FontRecord = {
            id: 'mine',
            name: 'Mine',
            fallback: 'sans-serif',
            faces: [],
            addedAt: 1,
            updatedAt: 1,
        }
        const has = await open({ settings: { fontId: 'user:mine' }, userFonts: [font] })
        expect(has.views.current.options.appearance.fontFamily).toBe('"pg-font-mine", sans-serif')
        expect(has.fonts.loads).toEqual(['user:mine'])

        const missing = await open({ settings: { fontId: 'user:mine' } })
        expect(missing.views.current.options.appearance.fontFamily).toBeNull()

        // The sync brings the font. The view changes to it, and the font loads.
        missing.fonts.setList([font])
        expect(missing.views.current.setAppearance).toHaveBeenLastCalledWith(
            expect.objectContaining({ fontFamily: '"pg-font-mine", sans-serif' }),
        )
        expect(missing.fonts.loads).toEqual(['user:mine', 'user:mine'])
    })

    it('stops following the fonts of the user after destroy', async () => {
        const { session, fonts, views } = await open()
        await session.destroy()
        fonts.setList([])
        expect(views.current.setAppearance).not.toHaveBeenCalled()
    })

    it('loads the font of the settings and does not wait for it', async () => {
        vi.mocked(ensureFontLoaded).mockReturnValue(new Promise(() => {}))
        const { views } = await open({ settings: { fontId: 'literata' } })
        expect(ensureFontLoaded).toHaveBeenCalledTimes(1)
        expect(ensureFontLoaded).toHaveBeenCalledWith('literata')
        expect(views.views).toHaveLength(1)
    })

    it('sends a changed appearance field to the view', async () => {
        const { views, settings } = await open()
        settings.update({ fontSize: 25 })
        expect(views.current.setAppearance).toHaveBeenCalledTimes(1)
        expect(views.current.setAppearance).toHaveBeenLastCalledWith(
            expect.objectContaining({ fontSize: 25, theme: 'light' }),
        )

        settings.update({ theme: 'dark', margin: 'wide' })
        expect(views.current.setAppearance).toHaveBeenCalledTimes(2)
        expect(views.current.setAppearance).toHaveBeenLastCalledWith(
            expect.objectContaining({ fontSize: 25, theme: 'dark', margin: 'wide' }),
        )
        expect(views.views).toHaveLength(1)
    })

    it('loads a new font and sends its font family', async () => {
        const { views, settings } = await open()
        vi.mocked(ensureFontLoaded).mockClear()
        settings.update({ fontId: 'inter' })
        expect(ensureFontLoaded).toHaveBeenCalledWith('inter')
        expect(views.current.setAppearance).toHaveBeenLastCalledWith(
            expect.objectContaining({ fontFamily: expect.stringContaining('Inter Variable') }),
        )

        settings.update({ fontSize: 30 })
        expect(ensureFontLoaded).toHaveBeenCalledTimes(1)
    })

    it('does not call the view for a setting that the view does not use', async () => {
        const { views, settings } = await open({ settings: { theme: 'sepia' } })
        settings.update({ keepAwake: false })
        settings.update({ librarySort: 'title' })
        settings.update({ readingWpm: 300 })
        settings.update({ rsvp: { wpm: 400 }, speech: { rate: 1.5 } })
        // The theme is not automatic, so this value has no effect.
        settings.update({ darkTheme: 'black' })
        // Two font ids that both give the publisher font.
        settings.update({ fontId: 'book:Not In This Book' })
        expect(views.current.setAppearance).not.toHaveBeenCalled()
    })

    it('follows the system colour scheme when the theme is automatic', async () => {
        const { views, systemTheme } = await open()
        systemTheme.change(true)
        expect(views.current.setAppearance).toHaveBeenCalledTimes(1)
        expect(views.current.setAppearance).toHaveBeenLastCalledWith(
            expect.objectContaining({ theme: 'dark' }),
        )
        // The same value again changes nothing.
        systemTheme.change(true)
        expect(views.current.setAppearance).toHaveBeenCalledTimes(1)

        systemTheme.change(false)
        expect(views.current.setAppearance).toHaveBeenLastCalledWith(
            expect.objectContaining({ theme: 'light' }),
        )
    })

    it('does not follow the system colour scheme when the theme is fixed', async () => {
        const { views, systemTheme, settings } = await open({ settings: { theme: 'sepia' } })
        systemTheme.change(true)
        expect(views.current.setAppearance).not.toHaveBeenCalled()

        // The session keeps the system value for a later change to the automatic theme.
        settings.update({ theme: 'auto' })
        expect(views.current.setAppearance).toHaveBeenLastCalledWith(
            expect.objectContaining({ theme: 'dark' }),
        )
    })
})

describe('layout change', () => {
    it('replaces the view at the same position and emits "view"', async () => {
        const highlight = makeHighlight('h1')
        const { session, views, settings, events, container } = await open({
            highlights: [highlight],
        })
        const old = views.current
        old.relocate(chapter2Page(700, 1100))
        events.length = 0

        settings.update({ layout: 'scroll' })

        expect(old.isDestroyed).toBe(true)
        expect(views.views).toHaveLength(2)
        const created = views.current
        expect(created.mode).toBe('scroll')
        expect(created.options.initial).toEqual({ spineIndex: CHAPTER_2, offset: 700 })
        expect(created.options.container).toBe(container)
        expect(created.options.highlights).toEqual([expect.objectContaining({ id: 'h1' })])
        expect(views.log.slice(-2)).toEqual(['paged.destroy', 'scroll.create'])
        expect(session.view).toBe(created)
        expect(events).toEqual([['view', created]])
        expect(old.setAppearance).not.toHaveBeenCalled()
    })

    it('keeps the start position when the first view did not relocate yet', async () => {
        const { views, settings } = await open({
            progress: {
                bookId: BOOK_ID,
                locator: { spineIndex: CHAPTER_3, offset: 12 },
                fraction: 0.9,
                updatedAt: 1,
            },
        })
        settings.update({ layout: 'scroll' })
        expect(views.current.options.initial).toEqual({ spineIndex: CHAPTER_3, offset: 12 })
    })

    it('gives the new view the appearance of the same settings change', async () => {
        const { views, settings } = await open()
        settings.update({ layout: 'scroll', fontSize: 30 })
        expect(views.current.options.appearance.fontSize).toBe(30)
        expect(views.current.setAppearance).not.toHaveBeenCalled()

        settings.update({ fontSize: 31 })
        expect(views.current.setAppearance).toHaveBeenCalledTimes(1)
    })

    it('gives the new view the highlights of this moment', async () => {
        const { session, views, settings } = await open()
        const added = await session.addHighlight({
            range: { spineIndex: CHAPTER_2, start: 3, end: 9 },
            text: 'second',
            color: 'green',
        })
        settings.update({ layout: 'scroll' })
        expect(views.current.options.highlights).toEqual([
            {
                id: added.id,
                spineIndex: CHAPTER_2,
                start: 3,
                end: 9,
                color: 'green',
                hasNote: false,
            },
        ])
    })

    it('ignores the callbacks of the old view', async () => {
        const { session, views, settings, events } = await open()
        const old = views.current
        old.relocate(chapter2Page(0, 400))
        settings.update({ layout: 'scroll' })
        events.length = 0

        old.relocate(chapter2Page(400, 800))
        old.options.callbacks.onCenterTap()
        old.options.callbacks.onSelection(selectionOf(1, 2))
        old.options.callbacks.onError(new Error('old'))

        expect(events).toEqual([])
        expect(session.position?.locator.offset).toBe(0)

        views.current.relocate(chapter2Page(0, 900))
        expect(session.position?.visible.end).toBe(900)
    })

    it('tells the screen that the selection of the old view is gone', async () => {
        const { views, settings, events } = await open()
        views.current.options.callbacks.onSelection(selectionOf(5, 9))
        events.length = 0
        settings.update({ layout: 'scroll' })
        expect(events).toEqual([
            ['selection', null],
            ['view', views.current],
        ])

        events.length = 0
        settings.update({ layout: 'paged' })
        expect(events).toEqual([['view', views.current]])
    })

    it('gives the search marks to the new view', async () => {
        const { session, views, settings } = await open()
        await session.search({
            query: 'harpoon',
            signal: new AbortController().signal,
            onResults: () => {},
        })
        settings.update({ layout: 'scroll' })
        expect(views.current.setSearchRanges).toHaveBeenCalledTimes(1)
        expect(views.current.setSearchRanges).toHaveBeenCalledWith([
            expect.objectContaining({ spineIndex: CHAPTER_2 }),
        ])
    })

    it('emits "error" when the new view cannot be made, and tries again later', async () => {
        const { session, views, settings, events } = await open()
        const old = views.current
        old.relocate(chapter2Page(700, 900))
        const failure = new Error('no view')
        views.createView.mockImplementationOnce(() => {
            throw failure
        })
        events.length = 0

        old.options.callbacks.onSelection(selectionOf(5, 9))
        events.length = 0

        expect(() => settings.update({ layout: 'scroll' })).not.toThrow()
        expect(old.isDestroyed).toBe(true)
        expect(events).toEqual([
            ['selection', null],
            ['error', failure],
        ])

        events.length = 0
        settings.update({ layout: 'paged', fontSize: 30 })
        expect(views.current).not.toBe(old)
        expect(views.current.mode).toBe('paged')
        expect(views.current.options.initial).toEqual({ spineIndex: CHAPTER_2, offset: 700 })
        expect(views.current.options.appearance.fontSize).toBe(30)
        expect(session.view).toBe(views.current)
        expect(events).toEqual([['view', views.current]])
    })

    it('emits "error" when the first chapter of the new view does not load', async () => {
        const { views, settings, events } = await open()
        settings.update({ layout: 'scroll' })
        // The fake view resolves `ready` at creation, so this test makes the next one fail.
        const failure = new Error('chapter failed')
        views.createView.mockImplementationOnce((mode, options) => {
            const manual = createFakeViews({ manualReady: true })
            const view = manual.createView(mode, options)
            manual.current.rejectReady(failure)
            return view
        })
        events.length = 0
        settings.update({ layout: 'paged' })
        await settle()
        expect(events).toEqual([
            ['view', expect.anything()],
            ['error', failure],
        ])
    })
})

describe('view callbacks', () => {
    it('keeps the position of a relocate and emits "relocate"', async () => {
        const { session, views, events } = await open()
        const info = chapter2Page(100, 500)
        views.current.relocate(info)
        expect(session.position).toBe(info)
        expect(events).toEqual([['relocate', info]])
    })

    it('passes the taps, the selection and the errors of the view on as events', async () => {
        const { views, events } = await open()
        const { callbacks } = views.current.options
        const selection = selectionOf(4, 9)
        const failure = new Error('no chapter')

        callbacks.onCenterTap()
        callbacks.onSelection(selection)
        callbacks.onSelection(null)
        callbacks.onImageTap({ src: 'blob:x', alt: 'A map' })
        callbacks.onError(failure)

        expect(events).toEqual([
            ['center-tap', undefined],
            ['selection', selection],
            ['selection', null],
            ['image-tap', { src: 'blob:x', alt: 'A map' }],
            ['error', failure],
        ])
    })

    it('emits "highlight-tap" with the record of the highlight', async () => {
        const highlight = makeHighlight('h1')
        const { views, events } = await open({ highlights: [highlight] })
        const bounds = new DOMRect(10, 20, 30, 40)
        views.current.options.callbacks.onHighlightTap('h1', bounds)
        views.current.options.callbacks.onHighlightTap('unknown', bounds)
        expect(events).toEqual([['highlight-tap', { highlight, bounds }]])
    })

    it('follows a link of the view', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(40, 300))
        views.current.options.callbacks.onLink({
            kind: 'internal',
            path: 'OEBPS/c3.xhtml',
            fragment: 'top',
            spineIndex: CHAPTER_3,
            noteref: false,
            bounds: new DOMRect(),
        })
        expect(views.current.goToAnchor).toHaveBeenCalledWith(CHAPTER_3, 'top')
        expect(session.canGoBack).toBe(true)
    })

    it('emits "error" when the view rejects the jump of a link', async () => {
        const { views, events } = await open()
        const failure = new Error('chapter failed')
        vi.mocked(views.current.goToAnchor).mockRejectedValueOnce(failure)
        const link = {
            kind: 'internal' as const,
            path: 'OEBPS/c3.xhtml',
            fragment: null,
            spineIndex: CHAPTER_3,
            noteref: false,
            bounds: new DOMRect(),
        }
        views.current.options.callbacks.onLink(link)
        await settle()
        expect(events).toEqual([['error', failure]])

        // The view can also report the same error itself. The screen gets it one time.
        const second = new Error('again')
        vi.mocked(views.current.goToAnchor).mockRejectedValueOnce(second)
        views.current.options.callbacks.onLink(link)
        views.current.options.callbacks.onError(second)
        await settle()
        expect(events).toHaveLength(2)
    })

    it('emits the events of a reading sequence in order', async () => {
        const { session, views, settings, eventNames } = await open()
        const view = views.current
        view.relocate(chapter2Page(0, 400))
        view.options.callbacks.onSelection(selectionOf(10, 20))
        await session.addHighlight({
            range: { spineIndex: CHAPTER_2, start: 10, end: 20 },
            text: 'chapter',
            color: 'blue',
        })
        await session.toggleBookmark()
        session.setMode('speed')
        view.options.callbacks.onCenterTap()
        settings.update({ layout: 'scroll' })
        views.current.relocate(chapter2Page(0, 2000))

        expect(eventNames()).toEqual([
            'relocate',
            'selection',
            'highlights',
            'bookmarks',
            'mode',
            'center-tap',
            'selection',
            'view',
            'relocate',
        ])
    })

    it('does not stop when a listener throws', async () => {
        const { session, views } = await open()
        const reported = vi.fn()
        vi.stubGlobal('reportError', reported)
        const failure = new Error('listener failed')
        session.on('relocate', () => {
            throw failure
        })
        const second = vi.fn()
        session.on('relocate', second)

        expect(() => views.current.relocate(chapter2Page(0, 400))).not.toThrow()
        expect(second).toHaveBeenCalledTimes(1)
        expect(reported).toHaveBeenCalledWith(failure)
        expect(session.position?.visible.end).toBe(400)
    })

    it('removes a listener with the function that on() returns', async () => {
        const { session, views } = await open()
        const listener = vi.fn()
        const off = session.on('relocate', listener)
        views.current.relocate(chapter2Page(0, 400))
        off()
        views.current.relocate(chapter2Page(400, 800))
        expect(listener).toHaveBeenCalledTimes(1)
    })
})

describe('progress', () => {
    it('writes the position 800 ms after a relocate', async () => {
        const { views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress')
        views.current.relocate(chapter2Page(500, 900))

        vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS - 1)
        expect(save).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(PROGRESS_SAVE_DELAY_MS).toBe(800)
        expect(save).toHaveBeenCalledTimes(1)

        // 100 + 1000 characters before the chapter, and one eighth of its 2000 characters.
        const expected: ProgressRecord = {
            bookId: BOOK_ID,
            locator: { spineIndex: CHAPTER_2, offset: 500 },
            fraction: 1350 / 4000,
            updatedAt: START_TIME + 800,
        }
        expect(save).toHaveBeenCalledWith(expected)
        expect(await storage.getProgress(BOOK_ID)).toEqual(expected)
    })

    it('waits for 800 ms with no further relocate', async () => {
        const { views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress')
        views.current.relocate(chapter2Page(0, 400))
        vi.advanceTimersByTime(500)
        views.current.relocate(chapter2Page(400, 800))
        vi.advanceTimersByTime(500)
        views.current.relocate(chapter2Page(800, 1200))
        vi.advanceTimersByTime(799)
        expect(save).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        expect(save).toHaveBeenCalledTimes(1)
        expect(save.mock.calls[0][0].locator).toEqual({ spineIndex: CHAPTER_2, offset: 800 })

        vi.advanceTimersByTime(5000)
        expect(save).toHaveBeenCalledTimes(1)
    })

    describe('a new layout of the same place', () => {
        const saved: ProgressRecord = {
            bookId: BOOK_ID,
            locator: { spineIndex: CHAPTER_2, offset: 700 },
            fraction: 0.3625,
            updatedAt: 1,
        }

        it('keeps the saved position when the page that has it starts earlier', async () => {
            const { session, views, storage } = await open({ progress: saved })
            const save = vi.spyOn(storage, 'saveProgress')
            // The fonts of the book are not loaded, so the page starts at a different place.
            views.current.relocate(chapter2Page(500, 900))
            // The screen shows the page as the view gives it.
            expect(session.position?.locator).toEqual({ spineIndex: CHAPTER_2, offset: 500 })

            // The position in storage is the same, so there is nothing to write.
            await session.destroy()
            expect(save).not.toHaveBeenCalled()
        })

        it('keeps the saved position through each new layout', async () => {
            const { views, storage } = await open({ progress: saved })
            const save = vi.spyOn(storage, 'saveProgress')
            views.current.relocate(chapter2Page(500, 900))
            views.current.relocate(chapter2Page(650, 1050))
            views.current.relocate(chapter2Page(700, 1100))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            expect(save).not.toHaveBeenCalled()
        })

        it('writes the saved position, not the page start, after a turn away and back', async () => {
            const { views, storage } = await open({ progress: saved })
            const save = vi.spyOn(storage, 'saveProgress')
            views.current.relocate(chapter2Page(500, 900))
            views.current.relocate(chapter2Page(900, 1300))
            // A new layout of the page after the turn. Its start is earlier now.
            views.current.relocate(chapter2Page(850, 1250))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            expect(save).toHaveBeenCalledTimes(1)
            // The fraction is that of the saved position too: 100 + 1000 characters before the
            // chapter, and 900 of 4000 parts of its 2000 characters.
            expect(save.mock.calls[0][0]).toMatchObject({
                locator: { spineIndex: CHAPTER_2, offset: 900 },
                fraction: 1550 / 4000,
            })
        })

        it('saves the first character of the page after a page turn', async () => {
            const { views, storage } = await open({ progress: saved })
            const save = vi.spyOn(storage, 'saveProgress')
            views.current.relocate(chapter2Page(500, 900))
            views.current.relocate(chapter2Page(900, 1300))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            expect(save.mock.calls[0][0].locator).toEqual({ spineIndex: CHAPTER_2, offset: 900 })
        })

        it('saves the first character of the page after a turn to the page before', async () => {
            const { views, storage } = await open({ progress: saved })
            const save = vi.spyOn(storage, 'saveProgress')
            views.current.relocate(chapter2Page(700, 1100))
            // The end of a range is exclusive, so this page does not have the saved position.
            views.current.relocate(chapter2Page(300, 700))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            expect(save.mock.calls[0][0].locator).toEqual({ spineIndex: CHAPTER_2, offset: 300 })
        })

        it('saves the first visible character in the scroll view', async () => {
            const { views, storage } = await open({ progress: saved })
            const save = vi.spyOn(storage, 'saveProgress')
            // The user scrolled up by some lines. The saved position is lower on the screen.
            views.current.relocate({ ...chapter2Page(500, 900), page: null, pageCount: null })
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            expect(save.mock.calls[0][0].locator).toEqual({ spineIndex: CHAPTER_2, offset: 500 })
        })

        it('saves the position of a page with no text', async () => {
            const { views, storage } = await open({ progress: saved })
            const save = vi.spyOn(storage, 'saveProgress')
            // The page is at the saved position, so there is nothing to write.
            views.current.relocate(chapter2Page(700, 700))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            expect(save).not.toHaveBeenCalled()

            views.current.relocate(chapter2Page(900, 900))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            expect(save).toHaveBeenCalledTimes(1)
            expect(save.mock.calls[0][0].locator).toEqual({ spineIndex: CHAPTER_2, offset: 900 })
        })
    })

    describe('a relocate at the position that storage has', () => {
        const OLD_TIME = START_TIME - 30 * 24 * 60 * 60 * 1000

        it('writes nothing for a new book that opens and closes at its first page', async () => {
            const { session, views, storage } = await open()
            const save = vi.spyOn(storage, 'saveProgress')
            views.current.relocate(page({ spineIndex: COVER, start: 0, end: 40 }))
            expect(session.position?.locator).toEqual({ spineIndex: COVER, offset: 0 })

            await session.destroy()
            expect(save).not.toHaveBeenCalled()
            expect(await storage.getProgress(BOOK_ID)).toBeUndefined()
        })

        it('keeps the time of the stored record when a book opens and closes', async () => {
            const stored: ProgressRecord = {
                bookId: BOOK_ID,
                locator: { spineIndex: CHAPTER_2, offset: 700 },
                fraction: 0.3625,
                updatedAt: OLD_TIME,
            }
            const { session, views, storage } = await open({ progress: stored })
            await storage.saveProgress(stored)
            // The view shows the page that has the saved position.
            views.current.relocate(chapter2Page(700, 1100))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            window.dispatchEvent(new Event('pagehide'))
            setVisibility('hidden')
            await session.destroy()

            // A backup with a later time than this one must be able to replace the position.
            expect(await storage.getProgress(BOOK_ID)).toEqual(stored)
        })

        it('writes a new time when the reader turns the page', async () => {
            const stored: ProgressRecord = {
                bookId: BOOK_ID,
                locator: { spineIndex: CHAPTER_2, offset: 700 },
                fraction: 0.3625,
                updatedAt: OLD_TIME,
            }
            const { session, views, storage } = await open({ progress: stored })
            await storage.saveProgress(stored)
            views.current.relocate(chapter2Page(700, 1100))
            views.current.relocate(chapter2Page(1100, 1500))
            await session.destroy()

            expect(await storage.getProgress(BOOK_ID)).toMatchObject({
                locator: { spineIndex: CHAPTER_2, offset: 1100 },
                updatedAt: START_TIME,
            })
        })

        it('tries a failed write again at a relocate at the same place', async () => {
            const { views, storage } = await open()
            const save = vi
                .spyOn(storage, 'saveProgress')
                .mockRejectedValueOnce(new Error('closed'))
            views.current.relocate(chapter2Page(120, 400))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            await settle()
            expect(await storage.getProgress(BOOK_ID)).toBeUndefined()

            // A new layout of the same page.
            views.current.relocate(chapter2Page(120, 380))
            vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
            expect(save).toHaveBeenCalledTimes(2)
            expect((await storage.getProgress(BOOK_ID))?.locator.offset).toBe(120)
        })
    })

    it('never writes before the first relocate', async () => {
        const { session, storage } = await open({
            progress: {
                bookId: BOOK_ID,
                locator: { spineIndex: CHAPTER_2, offset: 5 },
                fraction: 0.3,
                updatedAt: 1,
            },
        })
        const save = vi.spyOn(storage, 'saveProgress')
        await session.saveProgress()
        window.dispatchEvent(new Event('pagehide'))
        setVisibility('hidden')
        vi.advanceTimersByTime(5000)
        await session.destroy()
        expect(save).not.toHaveBeenCalled()
        expect(await storage.getProgress(BOOK_ID)).toBeUndefined()
    })

    it('writes at once on pagehide', async () => {
        const { views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress')
        views.current.relocate(chapter2Page(500, 900))
        vi.advanceTimersByTime(100)

        window.dispatchEvent(new Event('pagehide'))
        expect(save).toHaveBeenCalledTimes(1)
        expect(save.mock.calls[0][0].updatedAt).toBe(START_TIME + 100)

        // The timer of the relocate does not write a second time.
        vi.advanceTimersByTime(5000)
        window.dispatchEvent(new Event('pagehide'))
        expect(save).toHaveBeenCalledTimes(1)
    })

    it('writes at once when the document becomes hidden', async () => {
        const { views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress')
        views.current.relocate(chapter2Page(500, 900))

        setVisibility('visible')
        expect(save).not.toHaveBeenCalled()
        setVisibility('hidden')
        expect(save).toHaveBeenCalledTimes(1)

        setVisibility('visible')
        setVisibility('hidden')
        vi.advanceTimersByTime(5000)
        expect(save).toHaveBeenCalledTimes(1)
        expect((await storage.getProgress(BOOK_ID))?.locator.offset).toBe(500)
    })

    it('writes at once for a relocate while the page is hidden', async () => {
        // Speech can turn the page of a hidden tab, and a browser can stop that tab before a
        // timer runs.
        const { views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress')
        setVisibility('hidden')
        expect(save).not.toHaveBeenCalled()

        views.current.relocate(chapter2Page(500, 900))
        expect(save).toHaveBeenCalledTimes(1)
        views.current.relocate(chapter2Page(900, 1300))
        expect(save).toHaveBeenCalledTimes(2)
        expect(save.mock.calls[1][0].locator.offset).toBe(900)

        // No timer is left.
        vi.advanceTimersByTime(5000)
        expect(save).toHaveBeenCalledTimes(2)

        setVisibility('visible')
        views.current.relocate(chapter2Page(1300, 1700))
        expect(save).toHaveBeenCalledTimes(2)
        vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
        expect(save).toHaveBeenCalledTimes(3)
    })

    it('writes in destroy() when the position changed', async () => {
        const { session, views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress')
        views.current.relocate(chapter2Page(640, 900))
        await session.destroy()
        expect(save).toHaveBeenCalledTimes(1)
        expect((await storage.getProgress(BOOK_ID))?.locator).toEqual({
            spineIndex: CHAPTER_2,
            offset: 640,
        })

        vi.advanceTimersByTime(5000)
        expect(save).toHaveBeenCalledTimes(1)
    })

    it('writes the new position when a relocate listener destroys the session', async () => {
        const { session, views, storage } = await open()
        views.current.relocate(chapter2Page(0, 400))
        vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
        await settle()
        const save = vi.spyOn(storage, 'saveProgress')

        session.on('relocate', () => void session.destroy())
        views.current.relocate(chapter2Page(400, 800))
        expect(save).toHaveBeenCalledTimes(1)
        expect(save.mock.calls[0][0].locator.offset).toBe(400)
    })

    it('does not write in destroy() when the position is in storage already', async () => {
        const { session, views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress')
        views.current.relocate(chapter2Page(640, 900))
        vi.advanceTimersByTime(800)
        await session.destroy()
        expect(save).toHaveBeenCalledTimes(1)
    })

    it('writes the current position on saveProgress()', async () => {
        const { session, views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress')
        views.current.relocate(chapter2Page(250, 900))
        await session.saveProgress()
        expect((await storage.getProgress(BOOK_ID))?.locator.offset).toBe(250)

        // The timer of the relocate is gone.
        vi.advanceTimersByTime(5000)
        expect(save).toHaveBeenCalledTimes(1)
        await session.saveProgress()
        expect(save).toHaveBeenCalledTimes(2)
    })

    it('saves a fraction of 1 on the last page of the book', async () => {
        const { session, views, storage } = await open()
        views.current.relocate(
            page({ spineIndex: CHAPTER_3, start: 30, end: 60, chapterLength: 60, atBookEnd: true }),
        )
        expect(session.fraction).toBe(1)
        await session.saveProgress()
        expect((await storage.getProgress(BOOK_ID))?.fraction).toBe(1)
    })

    it('reports a failed write one time and lets the user read on', async () => {
        const { session, views, storage, events } = await open()
        const failure = new Error('quota')
        const save = vi.spyOn(storage, 'saveProgress').mockRejectedValue(failure)

        views.current.relocate(chapter2Page(0, 400))
        vi.advanceTimersByTime(800)
        await settle()
        const errors = events.filter(([name]) => name === 'error')
        expect(errors).toHaveLength(1)
        expect(errors[0][1]).toBeInstanceOf(Error)
        expect((errors[0][1] as Error).message).toBe('The reading position could not be saved.')
        expect((errors[0][1] as Error).cause).toBe(failure)

        views.current.relocate(chapter2Page(400, 800))
        expect(session.position?.locator.offset).toBe(400)
        vi.advanceTimersByTime(800)
        await expect(session.saveProgress()).resolves.toBeUndefined()
        await settle()
        expect(save).toHaveBeenCalledTimes(3)
        expect(events.filter(([name]) => name === 'error')).toHaveLength(1)
    })

    it('tries a failed write again at the next moment to save', async () => {
        const { views, storage } = await open()
        const save = vi.spyOn(storage, 'saveProgress').mockRejectedValueOnce(new Error('closed'))
        views.current.relocate(chapter2Page(120, 400))
        vi.advanceTimersByTime(800)
        await settle()
        expect(await storage.getProgress(BOOK_ID)).toBeUndefined()

        setVisibility('hidden')
        expect(save).toHaveBeenCalledTimes(2)
        expect((await storage.getProgress(BOOK_ID))?.locator.offset).toBe(120)
    })

    it('reports a storage method that throws', async () => {
        const { views, storage, events } = await open()
        vi.spyOn(storage, 'saveProgress').mockImplementation(() => {
            throw new Error('no database')
        })
        views.current.relocate(chapter2Page(0, 400))
        expect(() => vi.advanceTimersByTime(800)).not.toThrow()
        await settle()
        expect(events.filter(([name]) => name === 'error')).toHaveLength(1)
    })
})

describe('fractions', () => {
    it('uses the chapter length of the last relocate for the current chapter', async () => {
        const { session, views } = await open()
        // The estimate of the import is 2000 characters. The real chapter has 4000.
        views.current.relocate(chapter2Page(1000, 1400, 4000))
        expect(session.fraction).toBeCloseTo((1100 + 2000 * 0.25) / 4000, 12)
        expect(session.fractionOf({ spineIndex: CHAPTER_2, offset: 3000 })).toBeCloseTo(
            (1100 + 2000 * 0.75) / 4000,
            12,
        )
    })

    it('uses the estimate of the import for a chapter that was never shown', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(0, 400))
        expect(session.fractionOf({ spineIndex: CHAPTER_1, offset: 500 })).toBeCloseTo(
            (100 + 500) / 4000,
            12,
        )
        expect(session.fractionOf({ spineIndex: COVER, offset: 0 })).toBe(0)
    })

    it('limits the chapter fraction to 1 when the estimate is too small', async () => {
        const { session } = await open()
        // The estimate for the cover is 100 characters.
        expect(session.fractionOf({ spineIndex: COVER, offset: 250 })).toBeCloseTo(100 / 4000, 12)
        expect(session.fractionOf({ spineIndex: CHAPTER_3, offset: 9999 })).toBe(1)
    })

    it('keeps the length of a chapter that was shown before', async () => {
        const { session, views } = await open()
        views.current.relocate(
            page({ spineIndex: CHAPTER_1, start: 0, end: 100, chapterLength: 500 }),
        )
        views.current.relocate(chapter2Page(0, 400))
        expect(session.fractionOf({ spineIndex: CHAPTER_1, offset: 250 })).toBeCloseTo(
            (100 + 1000 * 0.5) / 4000,
            12,
        )
    })

    it('gives the fraction of the start position before the first relocate', async () => {
        const { session } = await open({
            progress: {
                bookId: BOOK_ID,
                locator: { spineIndex: CHAPTER_2, offset: 1000 },
                fraction: 0.9,
                updatedAt: 1,
            },
        })
        expect(session.fraction).toBeCloseTo((1100 + 1000) / 4000, 12)
    })

    it('gives the words to the end of the chapter and of the book', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(1000, 1400, 4000))
        // Three quarters of the 400 words of the chapter, then 100 and 80 words.
        expect(session.wordsRemaining).toEqual({ chapter: 300, book: 480 })
    })

    it('goes to a fraction of the book with the known length of the chapter', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(0, 400, 4000))
        // 0.4 of 4000 characters is 1600: 500 characters into chapter 2, one quarter of it.
        await session.goToFraction(0.4)
        expect(views.current.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_2, offset: 1000 })
    })

    it('remembers the position before a move of the slider', async () => {
        const { session, views } = await open()
        const view = views.current
        view.relocate(chapter2Page(0, 400, 4000))
        expect(session.canGoBack).toBe(false)

        await session.goToFraction(0.4)
        expect(session.canGoBack).toBe(true)
        view.relocate(chapter2Page(1000, 1400, 4000))

        await session.back()
        expect(view.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_2, offset: 0 })
        expect(session.canGoBack).toBe(false)
    })

    it('remembers one position for a run of slider moves', async () => {
        const { session, views } = await open()
        const view = views.current
        view.relocate(chapter2Page(0, 400, 4000))

        vi.mocked(view.goTo).mockImplementationOnce(async () => {
            view.relocate(chapter2Page(1000, 1400, 4000))
        })
        await session.goToFraction(0.4)
        vi.mocked(view.goTo).mockImplementationOnce(async () => {
            view.relocate(chapter2Page(2000, 2400, 4000))
        })
        await session.goToFraction(0.5)

        await session.back()
        expect(view.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_2, offset: 0 })
        expect(session.canGoBack).toBe(false)
    })

    it('remembers a new position for a slider move after a page turn', async () => {
        const { session, views } = await open()
        const view = views.current
        view.relocate(chapter2Page(0, 400, 4000))

        vi.mocked(view.goTo).mockImplementationOnce(async () => {
            view.relocate(chapter2Page(1000, 1400, 4000))
        })
        await session.goToFraction(0.4)
        // The user reads on from the new place.
        view.relocate(chapter2Page(1400, 1800, 4000))
        await session.goToFraction(0.5)

        await session.back()
        expect(view.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_2, offset: 1400 })
        await session.back()
        expect(view.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_2, offset: 0 })
        expect(session.canGoBack).toBe(false)
    })

    it('goes to a fraction of the book with the estimate for a chapter that was not shown', async () => {
        const { session, views } = await open()
        // 0.15 of 4000 is 600: 500 characters into chapter 1, which has 1000 by the estimate.
        await session.goToFraction(0.15)
        expect(views.current.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_1, offset: 500 })

        await session.goToFraction(0)
        expect(views.current.goTo).toHaveBeenLastCalledWith({ spineIndex: COVER, offset: 0 })
        await session.goToFraction(1)
        expect(views.current.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_3, offset: 400 })
    })
})

describe('contents entry of a position', () => {
    it('gives null and an empty title before the first entry', async () => {
        const { session, views } = await open()
        views.current.relocate(page({ spineIndex: COVER, start: 0, end: 30, chapterLength: 30 }))
        expect(session.currentTocEntry).toBeNull()
        expect(session.chapterTitleAt({ spineIndex: COVER, offset: 10 })).toBe('')
    })

    it('gives the last entry at or before the position', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(100, 400))
        expect(session.currentTocEntry).toBe(session.toc[3])
        expect(session.chapterTitleAt({ spineIndex: CHAPTER_2, offset: 0 })).toBe('Chapter Two')
        // The notes file has no entry.
        expect(session.chapterTitleAt({ spineIndex: NOTES, offset: 5 })).toBe('Chapter Two')
        expect(session.chapterTitleAt({ spineIndex: CHAPTER_3, offset: 5 })).toBe('Chapter Three')
    })

    it('treats a fragment offset as 0 while the chapter is not loaded', async () => {
        const { session, content } = await open()
        expect(session.chapterTitleAt({ spineIndex: CHAPTER_1, offset: 0 })).toBe('Section 1.2')
        expect(content.load).not.toHaveBeenCalled()
    })

    it('compares the entries of one chapter by their fragment offsets after the load', async () => {
        const { session, views, content } = await open()
        const chapter = await content.load(CHAPTER_1)
        const s1 = chapter.anchors.get('s1') as number
        const s2 = chapter.anchors.get('s2') as number
        expect(s1).toBeGreaterThan(0)
        expect(s2).toBeGreaterThan(s1)

        views.current.relocate(page({ spineIndex: CHAPTER_1, start: 0, end: s1 }))
        await settle()
        expect(session.currentTocEntry?.title).toBe('Chapter One')

        views.current.relocate(page({ spineIndex: CHAPTER_1, start: s1, end: s2 }))
        expect(session.currentTocEntry?.title).toBe('Section 1.1')
        views.current.relocate(page({ spineIndex: CHAPTER_1, start: s2 - 1, end: s2 + 5 }))
        expect(session.currentTocEntry?.title).toBe('Section 1.1')
        views.current.relocate(page({ spineIndex: CHAPTER_1, start: s2, end: s2 + 40 }))
        expect(session.currentTocEntry?.title).toBe('Section 1.2')

        expect(session.chapterTitleAt({ spineIndex: CHAPTER_1, offset: s1 - 1 })).toBe(
            'Chapter One',
        )
        expect(session.chapterTitleAt({ spineIndex: CHAPTER_1, offset: s1 })).toBe('Section 1.1')
    })

    it('emits "relocate" again when the loaded offsets change the current entry', async () => {
        const { session, views, events } = await open()
        const info = page({ spineIndex: CHAPTER_1, start: 0, end: 20 })
        const titles: (string | undefined)[] = []
        session.on('relocate', () => titles.push(session.currentTocEntry?.title))

        views.current.relocate(info)
        await settle()

        expect(events).toEqual([
            ['relocate', info],
            ['relocate', info],
        ])
        expect(titles).toEqual(['Section 1.2', 'Chapter One'])
    })

    it('does not emit again when the loaded offsets keep the current entry', async () => {
        const { session, views, content, events } = await open()
        const chapter = await content.load(CHAPTER_1)
        vi.mocked(content.load).mockClear()
        const s2 = chapter.anchors.get('s2') as number
        views.current.relocate(page({ spineIndex: CHAPTER_1, start: s2, end: s2 + 30 }))
        await settle()
        expect(session.currentTocEntry?.title).toBe('Section 1.2')
        expect(events).toHaveLength(1)

        // The offsets are known now, so the next relocate does not load the chapter again.
        views.current.relocate(page({ spineIndex: CHAPTER_1, start: 0, end: 30 }))
        await settle()
        expect(content.load).toHaveBeenCalledTimes(1)
        expect(events).toHaveLength(2)
    })

    it('does not load a chapter whose entries have no fragment', async () => {
        const { views, content } = await open()
        views.current.relocate(chapter2Page(0, 400))
        views.current.relocate(page({ spineIndex: COVER, start: 0, end: 30 }))
        await settle()
        expect(content.load).not.toHaveBeenCalled()
    })
})

describe('navigation and the back stack', () => {
    it('passes next() and prev() to the view', async () => {
        const { session, views } = await open()
        vi.mocked(views.current.next).mockResolvedValueOnce(false)
        expect(await session.next()).toBe(false)
        expect(await session.next()).toBe(true)
        expect(await session.prev()).toBe(true)
        expect(views.current.next).toHaveBeenCalledTimes(2)
        expect(views.current.prev).toHaveBeenCalledTimes(1)
    })

    it('goes to a locator and remembers the position only when asked', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(100, 500))

        await session.goTo({ spineIndex: CHAPTER_3, offset: 7 })
        expect(views.current.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_3, offset: 7 })
        expect(session.canGoBack).toBe(false)

        await session.goTo({ spineIndex: CHAPTER_3, offset: 9 }, { remember: false })
        expect(session.canGoBack).toBe(false)

        await session.goTo({ spineIndex: CHAPTER_3, offset: 11 }, { remember: true })
        expect(session.canGoBack).toBe(true)
    })

    it('goes back to the remembered positions, newest first', async () => {
        const { session, views } = await open()
        const view = views.current
        view.relocate(chapter2Page(100, 500))
        await session.goTo({ spineIndex: CHAPTER_3, offset: 0 }, { remember: true })
        view.relocate(page({ spineIndex: CHAPTER_3, start: 0, end: 30 }))
        await session.goToTocEntry(session.toc[0])
        view.relocate(page({ spineIndex: CHAPTER_1, start: 0, end: 30 }))

        await session.back()
        expect(view.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_3, offset: 0 })
        expect(session.canGoBack).toBe(true)
        await session.back()
        expect(view.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_2, offset: 100 })
        expect(session.canGoBack).toBe(false)

        const calls = vi.mocked(view.goTo).mock.calls.length
        await session.back()
        expect(view.goTo).toHaveBeenCalledTimes(calls)
    })

    it('emits "relocate" as usual after back()', async () => {
        const { session, views, events } = await open()
        const view = views.current
        view.relocate(chapter2Page(100, 500))
        await session.goTo({ spineIndex: CHAPTER_3, offset: 0 }, { remember: true })
        const arrived = chapter2Page(100, 500)
        vi.mocked(view.goTo).mockImplementationOnce(async () => view.relocate(arrived))
        events.length = 0
        await session.back()
        expect(events).toEqual([['relocate', arrived]])
    })

    it('goes to a contents entry by its anchor and remembers the position', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(100, 500))
        await session.goToTocEntry(session.toc[2])
        expect(views.current.goToAnchor).toHaveBeenCalledWith(CHAPTER_1, 's2')
        expect(session.canGoBack).toBe(true)

        await session.goToTocEntry(session.toc[3])
        expect(views.current.goToAnchor).toHaveBeenLastCalledWith(CHAPTER_2, null)
    })

    it('remembers nothing before the first relocate', async () => {
        const { session, views } = await open()
        await session.goToTocEntry(session.toc[0])
        await session.goTo({ spineIndex: CHAPTER_3, offset: 0 }, { remember: true })
        expect(views.current.goToAnchor).toHaveBeenCalledTimes(1)
        expect(session.canGoBack).toBe(false)
    })

    it('keeps 20 positions at most', async () => {
        const { session, views } = await open()
        for (let step = 0; step < 25; step++) {
            views.current.relocate(chapter2Page(step * 10, step * 10 + 10))
            await session.goTo({ spineIndex: CHAPTER_3, offset: 0 }, { remember: true })
        }
        const offsets: number[] = []
        while (session.canGoBack) {
            await session.back()
            const [locator] = vi.mocked(views.current.goTo).mock.lastCall ?? []
            offsets.push(locator?.offset ?? -1)
        }
        expect(offsets).toHaveLength(20)
        expect(offsets[0]).toBe(240)
        expect(offsets[19]).toBe(50)
    })

    it('follows an internal link to its anchor and remembers the position', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(100, 500))
        await session.followLink({
            kind: 'internal',
            path: 'OEBPS/notes.xhtml',
            fragment: 'n2',
            spineIndex: NOTES,
            noteref: true,
            bounds: new DOMRect(),
        })
        expect(views.current.goToAnchor).toHaveBeenCalledWith(NOTES, 'n2')
        expect(session.canGoBack).toBe(true)
        await session.back()
        expect(views.current.goTo).toHaveBeenLastCalledWith({ spineIndex: CHAPTER_2, offset: 100 })
    })

    it('emits "error" for a link to a file that is not in the book', async () => {
        const { session, views, events } = await open()
        views.current.relocate(chapter2Page(100, 500))
        events.length = 0
        await session.followLink({
            kind: 'internal',
            path: 'OEBPS/lost.xhtml',
            fragment: null,
            spineIndex: -1,
            noteref: false,
            bounds: new DOMRect(),
        })
        expect(events).toHaveLength(1)
        expect(events[0][0]).toBe('error')
        expect((events[0][1] as Error).message).toBe(
            'This link points to a file that is not in the book.',
        )
        expect(views.current.goToAnchor).not.toHaveBeenCalled()
        expect(session.canGoBack).toBe(false)
    })

    it('opens an external link in a new tab with no opener', async () => {
        const { session, views } = await open()
        const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
        views.current.relocate(chapter2Page(100, 500))

        await session.followLink({ kind: 'external', url: 'https://example.com/page?a=1' })
        expect(openWindow).toHaveBeenCalledWith(
            'https://example.com/page?a=1',
            '_blank',
            'noopener,noreferrer',
        )
        await session.followLink({ kind: 'external', url: 'mailto:someone@example.com' })
        expect(openWindow).toHaveBeenCalledTimes(2)
        expect(session.canGoBack).toBe(false)
        expect(views.current.goToAnchor).not.toHaveBeenCalled()
    })

    it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'page.html', ''])(
        'does not open the external link %j',
        async (url) => {
            const { session, events } = await open()
            const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
            await session.followLink({ kind: 'external', url })
            expect(openWindow).not.toHaveBeenCalled()
            expect(events.map(([name]) => name)).toEqual(['error'])
            expect((events[0][1] as Error).message).toBe('This link cannot be opened.')
        },
    )
})

describe('bookmarks', () => {
    it('adds a bookmark at the current position', async () => {
        const { session, views, storage, events, content } = await open()
        const model = await content.loadText(CHAPTER_2)
        const offset = model.text.indexOf('The second')
        views.current.relocate(chapter2Page(offset, offset + 30, model.text.length))
        events.length = 0
        expect(session.isBookmarked).toBe(false)

        vi.advanceTimersByTime(250)
        await session.toggleBookmark()

        expect(session.bookmarks).toHaveLength(1)
        const [bookmark] = session.bookmarks
        expect(bookmark).toEqual({
            id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            bookId: BOOK_ID,
            locator: { spineIndex: CHAPTER_2, offset },
            fraction: session.fractionOf({ spineIndex: CHAPTER_2, offset }),
            chapterTitle: 'Chapter Two',
            excerpt: 'The second chapter has a harpoon and no animals.',
            createdAt: START_TIME + 250,
        })
        expect(session.isBookmarked).toBe(true)
        expect(events).toEqual([['bookmarks', session.bookmarks]])
        expect(await storage.listBookmarks(BOOK_ID)).toEqual([bookmark])
    })

    it('makes an excerpt of 120 characters at most, cut at a word end', async () => {
        const { session, views, content } = await open()
        const model = await content.loadText(CHAPTER_1)
        views.current.relocate(page({ spineIndex: CHAPTER_1, start: 0, end: 50 }))
        await session.toggleBookmark()

        const { excerpt } = session.bookmarks[0]
        expect(excerpt.startsWith('Chapter One The white whale swam in the cold sea')).toBe(true)
        expect(excerpt.length).toBeLessThanOrEqual(120)
        expect(excerpt.length).toBeGreaterThan(90)
        expect(excerpt).not.toMatch(/\s{2}|\n/)
        const collapsed = model.text.replace(/\s+/g, ' ').trim()
        expect(collapsed.startsWith(excerpt + ' ')).toBe(true)
    })

    it('removes all bookmarks in the visible text', async () => {
        const inside = makeBookmark('inside', { locator: { spineIndex: CHAPTER_2, offset: 150 } })
        const alsoInside = makeBookmark('also', { locator: { spineIndex: CHAPTER_2, offset: 499 } })
        const atEnd = makeBookmark('end', { locator: { spineIndex: CHAPTER_2, offset: 500 } })
        const otherChapter = makeBookmark('other', {
            locator: { spineIndex: CHAPTER_1, offset: 150 },
        })
        const { session, views, storage, events } = await open({
            bookmarks: [inside, alsoInside, atEnd, otherChapter],
        })
        views.current.relocate(chapter2Page(100, 500))
        events.length = 0
        expect(session.isBookmarked).toBe(true)

        await session.toggleBookmark()

        expect(session.bookmarks.map((bookmark) => bookmark.id)).toEqual(['other', 'end'])
        expect(session.isBookmarked).toBe(false)
        expect(events).toEqual([['bookmarks', session.bookmarks]])
        expect((await storage.listBookmarks(BOOK_ID)).map((bookmark) => bookmark.id)).toEqual([
            'other',
            'end',
        ])
    })

    it('says that a page is bookmarked only for a bookmark in its visible range', async () => {
        const { session, views } = await open({
            bookmarks: [makeBookmark('b', { locator: { spineIndex: CHAPTER_2, offset: 300 } })],
        })
        const view = views.current
        view.relocate(chapter2Page(0, 300))
        expect(session.isBookmarked).toBe(false)
        view.relocate(chapter2Page(300, 600))
        expect(session.isBookmarked).toBe(true)
        view.relocate(chapter2Page(200, 301))
        expect(session.isBookmarked).toBe(true)
        view.relocate(chapter2Page(301, 600))
        expect(session.isBookmarked).toBe(false)
        view.relocate(page({ spineIndex: CHAPTER_1, start: 300, end: 600 }))
        expect(session.isBookmarked).toBe(false)
    })

    it('can bookmark a page that has no text', async () => {
        const { session, views } = await open()
        views.current.relocate(page({ spineIndex: COVER, start: 0, end: 0, chapterLength: 0 }))
        await session.toggleBookmark()
        expect(session.isBookmarked).toBe(true)
        await session.toggleBookmark()
        expect(session.bookmarks).toEqual([])
    })

    it('keeps the list sorted by position', async () => {
        const { session, views } = await open({
            bookmarks: [
                makeBookmark('a', { locator: { spineIndex: CHAPTER_1, offset: 5 } }),
                makeBookmark('c', { locator: { spineIndex: CHAPTER_3, offset: 5 } }),
            ],
        })
        views.current.relocate(chapter2Page(10, 40))
        await session.toggleBookmark()
        expect(session.bookmarks.map((bookmark) => bookmark.locator.spineIndex)).toEqual([
            CHAPTER_1,
            CHAPTER_2,
            CHAPTER_3,
        ])
    })

    it('gives a new list object for each change', async () => {
        const { session, views } = await open()
        const before = session.bookmarks
        views.current.relocate(chapter2Page(10, 40))
        await session.toggleBookmark()
        expect(session.bookmarks).not.toBe(before)
        expect(before).toEqual([])
    })

    it('removes one bookmark by its id', async () => {
        const { session, storage, events } = await open({
            bookmarks: [
                makeBookmark('a', { locator: { spineIndex: CHAPTER_1, offset: 5 } }),
                makeBookmark('b', { locator: { spineIndex: CHAPTER_2, offset: 5 } }),
            ],
        })
        await session.removeBookmark('a')
        expect(session.bookmarks.map((bookmark) => bookmark.id)).toEqual(['b'])
        expect(events).toEqual([['bookmarks', session.bookmarks]])
        expect((await storage.listBookmarks(BOOK_ID)).map((bookmark) => bookmark.id)).toEqual(['b'])

        const remove = vi.spyOn(storage, 'deleteBookmark')
        await session.removeBookmark('unknown')
        expect(remove).not.toHaveBeenCalled()
        expect(events).toHaveLength(1)
    })

    it('runs two fast toggles one after the other', async () => {
        const { session, views, storage } = await open()
        views.current.relocate(chapter2Page(10, 40))
        await Promise.all([session.toggleBookmark(), session.toggleBookmark()])
        expect(session.bookmarks).toEqual([])
        expect(await storage.listBookmarks(BOOK_ID)).toEqual([])
    })

    it('uses the position at the time of the call', async () => {
        const { session, views } = await open()
        views.current.relocate(chapter2Page(10, 40))
        const pending = session.toggleBookmark()
        views.current.relocate(chapter2Page(40, 80))
        await pending
        expect(session.bookmarks[0].locator).toEqual({ spineIndex: CHAPTER_2, offset: 10 })
    })

    it('does nothing before the first relocate', async () => {
        const { session, events } = await open()
        await session.toggleBookmark()
        expect(session.bookmarks).toEqual([])
        expect(events).toEqual([])
    })

    it('adds a bookmark with no excerpt when the chapter text does not load', async () => {
        const { session, views, content } = await open()
        vi.mocked(content.loadText).mockRejectedValueOnce(new Error('bad chapter'))
        views.current.relocate(chapter2Page(10, 40))
        await session.toggleBookmark()
        expect(session.bookmarks[0].excerpt).toBe('')
    })

    it('rejects and keeps the list when storage does not write', async () => {
        const { session, views, storage, events } = await open()
        const failure = new Error('quota')
        vi.spyOn(storage, 'putBookmark').mockRejectedValueOnce(failure)
        views.current.relocate(chapter2Page(10, 40))
        events.length = 0

        await expect(session.toggleBookmark()).rejects.toBe(failure)
        expect(session.bookmarks).toEqual([])
        expect(events).toEqual([])

        // The next change still works.
        await session.toggleBookmark()
        expect(session.bookmarks).toHaveLength(1)
    })
})

describe('highlights', () => {
    it('adds a highlight: storage, list, view, event, then the selection', async () => {
        const first = makeHighlight('first', { spineIndex: CHAPTER_3, start: 5, end: 9 })
        const { session, views, storage, events } = await open({ highlights: [first] })
        views.current.relocate(chapter2Page(0, 400, 4000))
        events.length = 0
        views.log.length = 0
        const put = vi.spyOn(storage, 'putHighlight')
        const sequence: string[] = []
        put.mockImplementation(async () => void sequence.push('storage'))
        vi.mocked(views.current.setHighlights).mockImplementation(() => void sequence.push('view'))
        vi.mocked(views.current.clearSelection).mockImplementation(
            () => void sequence.push('clearSelection'),
        )
        session.on('highlights', () => sequence.push('event'))

        vi.advanceTimersByTime(40)
        const created = await session.addHighlight({
            range: { spineIndex: CHAPTER_2, start: 1000, end: 1012 },
            text: '  a  harpoon\n and ',
            color: 'pink',
            note: 'Look at this',
        })

        expect(created).toEqual({
            id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            bookId: BOOK_ID,
            spineIndex: CHAPTER_2,
            start: 1000,
            end: 1012,
            text: 'a harpoon and',
            color: 'pink',
            note: 'Look at this',
            chapterTitle: 'Chapter Two',
            fraction: (1100 + 2000 * 0.25) / 4000,
            createdAt: START_TIME + 40,
            updatedAt: START_TIME + 40,
        })
        expect(put).toHaveBeenCalledWith(created)
        expect(session.highlights).toEqual([created, first])
        expect(views.current.setHighlights).toHaveBeenCalledWith([
            {
                id: created.id,
                spineIndex: CHAPTER_2,
                start: 1000,
                end: 1012,
                color: 'pink',
                hasNote: true,
            },
            {
                id: 'first',
                spineIndex: CHAPTER_3,
                start: 5,
                end: 9,
                color: 'yellow',
                hasNote: false,
            },
        ])
        expect(events).toEqual([['highlights', session.highlights]])
        expect(sequence).toEqual(['storage', 'view', 'event', 'clearSelection'])
    })

    it('stores a new highlight with an empty note when there is none', async () => {
        const { session, storage } = await open()
        const created = await session.addHighlight({
            range: { spineIndex: CHAPTER_2, start: 3, end: 9 },
            text: 'second',
            color: 'green',
        })
        expect(created.note).toBe('')
        expect(await storage.listHighlights(BOOK_ID)).toEqual([created])
    })

    it('changes the colour and the note of a highlight', async () => {
        const highlight = makeHighlight('h1')
        const other = makeHighlight('h2', { start: 40, end: 50 })
        const { session, views, storage, events } = await open({ highlights: [highlight, other] })

        vi.advanceTimersByTime(90)
        await session.updateHighlight('h1', { color: 'purple' })
        expect(session.highlights[0]).toEqual({
            ...highlight,
            color: 'purple',
            updatedAt: START_TIME + 90,
        })
        expect(session.highlights[1]).toBe(other)
        expect(views.current.setHighlights).toHaveBeenLastCalledWith([
            expect.objectContaining({ id: 'h1', color: 'purple', hasNote: false }),
            expect.objectContaining({ id: 'h2' }),
        ])

        await session.updateHighlight('h1', { note: 'A thought' })
        expect(session.highlights[0]).toMatchObject({ color: 'purple', note: 'A thought' })
        expect(views.current.setHighlights).toHaveBeenLastCalledWith([
            expect.objectContaining({ id: 'h1', hasNote: true }),
            expect.objectContaining({ id: 'h2' }),
        ])
        expect(events.map(([name]) => name)).toEqual(['highlights', 'highlights'])
        expect((await storage.listHighlights(BOOK_ID))[0]).toEqual(session.highlights[0])
        expect(views.current.clearSelection).not.toHaveBeenCalled()

        await session.updateHighlight('h1', { note: '' })
        expect(session.highlights[0].note).toBe('')
    })

    it('does nothing for a patch with no change and for an unknown id', async () => {
        const { session, views, storage, events } = await open({
            highlights: [makeHighlight('h1', { note: 'Same' })],
        })
        const put = vi.spyOn(storage, 'putHighlight')
        await session.updateHighlight('h1', { color: 'yellow', note: 'Same' })
        await session.updateHighlight('h1', {})
        await session.updateHighlight('unknown', { color: 'blue' })
        await session.removeHighlight('unknown')
        expect(put).not.toHaveBeenCalled()
        expect(views.current.setHighlights).not.toHaveBeenCalled()
        expect(events).toEqual([])
    })

    it('removes a highlight', async () => {
        const { session, views, storage, events } = await open({
            highlights: [makeHighlight('h1'), makeHighlight('h2', { start: 40, end: 50 })],
        })
        await session.removeHighlight('h1')
        expect(session.highlights.map((highlight) => highlight.id)).toEqual(['h2'])
        expect(views.current.setHighlights).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'h2' }),
        ])
        expect(events).toEqual([['highlights', session.highlights]])
        expect((await storage.listHighlights(BOOK_ID)).map((highlight) => highlight.id)).toEqual([
            'h2',
        ])
    })

    it('rejects and keeps the list when storage does not write', async () => {
        const { session, views, storage, events } = await open({
            highlights: [makeHighlight('h1')],
        })
        const failure = new Error('quota')
        vi.spyOn(storage, 'putHighlight').mockRejectedValue(failure)
        vi.spyOn(storage, 'deleteHighlight').mockRejectedValue(failure)
        const highlight = {
            range: { spineIndex: CHAPTER_2, start: 3, end: 9 },
            text: 'second',
            color: 'green' as const,
        }

        await expect(session.addHighlight(highlight)).rejects.toBe(failure)
        await expect(session.updateHighlight('h1', { color: 'blue' })).rejects.toBe(failure)
        await expect(session.removeHighlight('h1')).rejects.toBe(failure)

        expect(session.highlights).toEqual([makeHighlight('h1')])
        expect(views.current.setHighlights).not.toHaveBeenCalled()
        expect(views.current.clearSelection).not.toHaveBeenCalled()
        expect(events).toEqual([])
    })
})

describe('reloadAnnotations', () => {
    it('reads the bookmarks and highlights again, after a sync changed them', async () => {
        const old = makeHighlight('h1', { spineIndex: CHAPTER_2, start: 5, end: 9 })
        const { session, views, storage } = await open({ highlights: [old] })
        const changed = { ...old, note: 'From a different device', updatedAt: old.updatedAt + 1 }
        const added = makeBookmark('b1', { locator: { spineIndex: CHAPTER_2, offset: 80 } })
        await storage.putHighlight(changed)
        await storage.putBookmark(added)
        vi.mocked(views.current.setHighlights).mockClear()

        await session.reloadAnnotations()

        expect(session.highlights).toEqual([changed])
        expect(session.bookmarks).toEqual([added])
        expect(views.current.setHighlights).toHaveBeenCalledTimes(1)
    })

    it('runs after an annotation change that waits, so the change does not use an old record', async () => {
        const old = makeHighlight('h1', { spineIndex: CHAPTER_2, start: 5, end: 9 })
        const { session, storage } = await open({ highlights: [old] })
        await storage.putHighlight({ ...old, note: 'Remote note', updatedAt: old.updatedAt + 1 })

        const reload = session.reloadAnnotations()
        const update = session.updateHighlight('h1', { color: 'blue' })
        await Promise.all([reload, update])

        const [stored] = await storage.listHighlights(BOOK_ID)
        expect(stored.note).toBe('Remote note')
        expect(stored.color).toBe('blue')
    })
})

describe('search', () => {
    interface SearchRun {
        results: SearchResult[]
        batches: number[]
        progress: [number, number][]
    }

    function collect(): SearchRun & {
        onResults(results: SearchResult[]): void
        onProgress(done: number, total: number): void
    } {
        const run: SearchRun = { results: [], batches: [], progress: [] }
        return {
            ...run,
            onResults(results) {
                run.results.push(...results)
                run.batches.push(results.length)
            },
            onProgress(done, total) {
                run.progress.push([done, total])
            },
        }
    }

    it('finds the matches of the whole book, the linear chapters first', async () => {
        const { session, views, content } = await open()
        const run = collect()
        await session.search({ query: 'whale', signal: new AbortController().signal, ...run })

        expect(run.results.map((result) => result.range.spineIndex)).toEqual([
            CHAPTER_1,
            CHAPTER_1,
            CHAPTER_3,
            NOTES,
        ])
        expect(run.batches).toEqual([2, 1, 1])
        expect(run.progress).toEqual([
            [1, 5],
            [2, 5],
            [3, 5],
            [4, 5],
            [5, 5],
        ])
        expect(vi.mocked(content.loadText).mock.calls.map(([index]) => index)).toEqual([
            COVER,
            CHAPTER_1,
            CHAPTER_2,
            CHAPTER_3,
            NOTES,
        ])

        expect(views.current.setSearchRanges).toHaveBeenCalledTimes(1)
        expect(views.current.setSearchRanges).toHaveBeenCalledWith(
            run.results.map((result) => result.range),
        )
    })

    it('gives the range, the excerpt and the chapter title of each match', async () => {
        const { session, content } = await open()
        const run = collect()
        await session.search({ query: 'harpoon', signal: new AbortController().signal, ...run })

        const { text } = await content.loadText(CHAPTER_2)
        const start = text.indexOf('harpoon')
        expect(run.results).toEqual([
            {
                range: { spineIndex: CHAPTER_2, start, end: start + 7 },
                excerpt: 'Chapter Two The second chapter has a harpoon and no animals.',
                matchStart: 37,
                matchEnd: 44,
                chapterTitle: 'Chapter Two',
            },
        ])
        const [result] = run.results
        expect(result.excerpt.slice(result.matchStart, result.matchEnd)).toBe('harpoon')
    })

    it('ignores letter case and reads white space in the query as any white space', async () => {
        const { session, content } = await open()
        const { text } = await content.loadText(CHAPTER_1)
        const run = collect()
        await session.search({
            query: '  WHITE \t whale ',
            signal: new AbortController().signal,
            ...run,
        })

        expect(run.results).toHaveLength(3)
        const [first, second] = run.results
        expect(text.slice(first.range.start, first.range.end)).toBe('white whale')
        expect(text.slice(second.range.start, second.range.end)).toBe('White   Whale')
        expect(second.excerpt.slice(second.matchStart, second.matchEnd)).toBe('White Whale')
        expect(second.excerpt).not.toMatch(/\s{2}/)
    })

    it('gives the section title of each match in a chapter that was not shown', async () => {
        const { session, content } = await open()
        const signal = new AbortController().signal

        // Two matches are before the first section, one is in section one and one in section two.
        const run = collect()
        await session.search({ query: 'the', signal, ...run })
        const inChapter1 = run.results.filter((result) => result.range.spineIndex === CHAPTER_1)
        expect(inChapter1.map((result) => result.chapterTitle)).toEqual([
            'Chapter One',
            'Chapter One',
            'Section 1.1',
            'Section 1.2',
        ])
        // The search does not load a chapter with its images and styles.
        expect(content.load).not.toHaveBeenCalled()

        // The offsets stay, so the session does not read the chapter again.
        expect(session.chapterTitleAt({ spineIndex: CHAPTER_1, offset: 0 })).toBe('Chapter One')
    })

    it('reads the section offsets only for a chapter that has matches and needs them', async () => {
        const { session, content } = await open()
        // The text does not come from the book file here, so each read is a read for offsets.
        vi.mocked(content.loadText).mockImplementation(async (index) => ({
            text: index === CHAPTER_2 ? 'a harpoon' : 'the cold sea',
            blocks: [],
        }))
        const read = vi.spyOn(session.book, 'readText')
        const signal = new AbortController().signal

        // Chapter 2 has the match. Its contents entry has no fragment.
        await session.search({ query: 'harpoon', signal, onResults: () => {} })
        expect(read).not.toHaveBeenCalled()

        // All other chapters have the match. Only chapter 1 has entries with a fragment.
        await session.search({ query: 'cold sea', signal, onResults: () => {} })
        expect(read.mock.calls).toEqual([['OEBPS/c1.xhtml']])

        // The offsets are known now.
        await session.search({ query: 'cold sea', signal, onResults: () => {} })
        expect(read).toHaveBeenCalledTimes(1)
        expect(content.load).not.toHaveBeenCalled()
    })

    it('gives titles with section offsets of 0 when the second read fails', async () => {
        const { session, content } = await open()
        vi.mocked(content.loadText).mockImplementation(async () => ({
            text: 'the cold sea',
            blocks: [],
        }))
        vi.spyOn(session.book, 'readText').mockRejectedValue(new Error('gone'))
        const run = collect()
        await session.search({ query: 'cold sea', signal: new AbortController().signal, ...run })
        const inChapter1 = run.results.filter((result) => result.range.spineIndex === CHAPTER_1)
        expect(inChapter1.map((result) => result.chapterTitle)).toEqual(['Section 1.2'])
        expect(run.progress).toHaveLength(5)
    })

    it('stops when the signal aborts during the read of the section offsets', async () => {
        const { session, views } = await open()
        const controller = new AbortController()
        const read = session.book.readText.bind(session.book)
        let reads = 0
        vi.spyOn(session.book, 'readText').mockImplementation((path) => {
            // The second read of chapter 1 is the read for the offsets.
            if (path === 'OEBPS/c1.xhtml' && ++reads === 2) controller.abort()
            return read(path)
        })
        const run = collect()
        await session.search({ query: 'cold sea', signal: controller.signal, ...run })
        expect(reads).toBe(2)
        expect(run.results).toEqual([])
        expect(views.current.setSearchRanges).not.toHaveBeenCalled()
    })

    it.each(['', ' ', 'w', ' w '])('gives no result for the short query %j', async (query) => {
        const { session, views, content } = await open()
        const run = collect()
        await session.search({ query, signal: new AbortController().signal, ...run })
        expect(run.results).toEqual([])
        expect(run.progress).toEqual([])
        expect(content.loadText).not.toHaveBeenCalled()
        expect(views.current.setSearchRanges).not.toHaveBeenCalled()
    })

    it('removes the marks of the search before with an empty query', async () => {
        const { session, views } = await open()
        const signal = new AbortController().signal
        await session.search({ query: 'whale', signal, onResults: () => {} })
        await session.search({ query: '', signal, onResults: () => {} })
        expect(views.current.setSearchRanges).toHaveBeenCalledTimes(2)
        expect(views.current.setSearchRanges).toHaveBeenLastCalledWith([])
    })

    it('removes the marks at the start of a new search and on clearSearch()', async () => {
        const { session, views } = await open()
        const signal = new AbortController().signal
        const marks = vi.mocked(views.current.setSearchRanges)

        await session.search({ query: 'whale', signal, onResults: () => {} })
        await session.search({ query: 'harpoon', signal, onResults: () => {} })
        expect(marks.mock.calls.map(([ranges]) => ranges.length)).toEqual([4, 0, 1])

        session.clearSearch()
        expect(marks).toHaveBeenLastCalledWith([])
        session.clearSearch()
        expect(marks).toHaveBeenCalledTimes(4)
    })

    it('gives the view an empty list only when it has marks', async () => {
        const { session, views } = await open()
        session.clearSearch()
        await session.search({
            query: 'no such text',
            signal: new AbortController().signal,
            onResults: () => {},
        })
        expect(views.current.setSearchRanges).not.toHaveBeenCalled()
    })

    it('stops at 500 results', async () => {
        const book = makeBook({
            files: {
                'a.xhtml': chapterXhtml(`<p>${'needle '.repeat(300)}</p>`),
                'b.xhtml': chapterXhtml(`<p>${'Needle '.repeat(300)}</p>`),
                'c.xhtml': chapterXhtml('<p>needle</p>'),
            },
            spine: ['a.xhtml', 'b.xhtml', 'c.xhtml'],
            toc: [],
            nonLinear: [],
        })
        const record = makeRecord({
            spineStats: [
                { chars: 2100, words: 300 },
                { chars: 2100, words: 300 },
                { chars: 6, words: 1 },
            ],
        })
        const { session, views, content } = await open({ book, record })
        const run = collect()
        await session.search({ query: 'needle', signal: new AbortController().signal, ...run })

        expect(run.results).toHaveLength(500)
        expect(run.batches).toEqual([300, 200])
        expect(run.progress).toEqual([
            [1, 3],
            [2, 3],
        ])
        expect(content.loadText).toHaveBeenCalledTimes(2)
        expect(vi.mocked(views.current.setSearchRanges).mock.lastCall?.[0]).toHaveLength(500)
    })

    it('calls nothing more after the signal aborts', async () => {
        const { session, views, content } = await open()
        const controller = new AbortController()
        const run = collect()
        const onProgress = vi.fn((done: number) => {
            // The second chapter has the first matches.
            if (done === 2) controller.abort()
        })
        await session.search({
            query: 'whale',
            signal: controller.signal,
            onResults: run.onResults,
            onProgress,
        })

        expect(run.batches).toEqual([2])
        expect(onProgress).toHaveBeenCalledTimes(2)
        expect(vi.mocked(content.loadText).mock.calls.length).toBeLessThanOrEqual(3)
        expect(views.current.setSearchRanges).not.toHaveBeenCalled()
    })

    it('gives no marks to the view when the signal aborts after the last chapter', async () => {
        const { session, views } = await open()
        const controller = new AbortController()
        await session.search({
            query: 'whale',
            signal: controller.signal,
            onResults: () => {},
            onProgress(done, total) {
                if (done === total) controller.abort()
            },
        })
        expect(views.current.setSearchRanges).not.toHaveBeenCalled()
    })

    it('does not start when the signal is aborted already', async () => {
        const { session, content } = await open()
        const run = collect()
        await session.search({ query: 'whale', signal: AbortSignal.abort(), ...run })
        expect(run.results).toEqual([])
        expect(run.progress).toEqual([])
        expect(content.loadText).not.toHaveBeenCalled()
    })

    it('stops a search when a new one starts', async () => {
        const { session, views } = await open()
        const signal = new AbortController().signal
        const first = collect()
        const second = collect()

        const firstDone = session.search({ query: 'whale', signal, ...first })
        const secondDone = session.search({ query: 'harpoon', signal, ...second })
        await Promise.all([firstDone, secondDone])

        expect(first.results).toEqual([])
        expect(first.progress).toEqual([])
        expect(second.results).toHaveLength(1)
        expect(views.current.setSearchRanges).toHaveBeenCalledTimes(1)
        expect(views.current.setSearchRanges).toHaveBeenCalledWith([second.results[0].range])
    })

    it('stops a search on clearSearch()', async () => {
        const { session, views } = await open()
        const run = collect()
        const done = session.search({
            query: 'whale',
            signal: new AbortController().signal,
            ...run,
        })
        session.clearSearch()
        await done
        expect(run.results).toEqual([])
        expect(views.current.setSearchRanges).not.toHaveBeenCalled()
    })

    it('stops a search on destroy()', async () => {
        const { session, views } = await open()
        const run = collect()
        const done = session.search({
            query: 'whale',
            signal: new AbortController().signal,
            ...run,
        })
        await session.destroy()
        await done
        expect(run.results).toEqual([])
        expect(run.progress).toEqual([])
        expect(views.current.setSearchRanges).not.toHaveBeenCalled()
    })

    it('remembers the text length of each chapter that it reads', async () => {
        const { session, content } = await open()
        const { text } = await content.loadText(CHAPTER_2)
        // Before the search, the length is the estimate of 2000 characters.
        expect(session.fractionOf({ spineIndex: CHAPTER_2, offset: text.length })).toBeLessThan(
            (1100 + 2000) / 4000,
        )
        await session.search({
            query: 'whale',
            signal: new AbortController().signal,
            onResults: () => {},
        })
        expect(session.fractionOf({ spineIndex: CHAPTER_2, offset: text.length })).toBeCloseTo(
            (1100 + 2000) / 4000,
            12,
        )
    })
})

describe('loadNote', () => {
    it('gives a detached copy of the note with the styles of its chapter', async () => {
        const { session, content } = await open()
        const note = await session.loadNote({ spineIndex: NOTES, fragment: 'n1' })
        const chapter = await content.load(NOTES)

        expect(note).not.toBeNull()
        expect(note?.element.localName).toBe('aside')
        expect(note?.element.textContent).toBe('1. The first note about the white whale.')
        expect(note?.element.parentNode).toBeNull()
        expect(note?.element.hasAttribute('id')).toBe(false)
        expect(note?.element.querySelectorAll('[id]')).toHaveLength(0)
        expect(note?.styles).toBe(chapter.styles)
        // The chapter keeps its element and its ids.
        expect(chapter.anchors.has('n1')).toBe(true)
        expect(chapter.body.querySelectorAll('[id]')).toHaveLength(3)
        expect(chapter.body.contains(note?.element ?? null)).toBe(false)
    })

    it('gives the block around an anchor', async () => {
        const { session } = await open()
        const note = await session.loadNote({ spineIndex: NOTES, fragment: 'n2' })
        expect(note?.element.localName).toBe('p')
        expect(note?.element.textContent).toBe('2. The second note.')
    })

    it('gives null when the fragment is null or not in the chapter', async () => {
        const { session, content } = await open()
        expect(await session.loadNote({ spineIndex: NOTES, fragment: null })).toBeNull()
        expect(content.load).not.toHaveBeenCalled()
        expect(await session.loadNote({ spineIndex: NOTES, fragment: 'missing' })).toBeNull()
        expect(await session.loadNote({ spineIndex: 99, fragment: 'n1' })).toBeNull()
        expect(await session.loadNote({ spineIndex: -1, fragment: 'n1' })).toBeNull()
    })

    it('gives null when the chapter does not load', async () => {
        const { session, content } = await open()
        vi.mocked(content.load).mockRejectedValueOnce(new Error('bad chapter'))
        expect(await session.loadNote({ spineIndex: NOTES, fragment: 'n1' })).toBeNull()
    })

    it('gives null when the session is destroyed during the load', async () => {
        const { session } = await open()
        const pending = session.loadNote({ spineIndex: NOTES, fragment: 'n1' })
        await session.destroy()
        expect(await pending).toBeNull()
    })
})

describe('reading speed', () => {
    // Chapter 2 has 4000 words in 20000 characters of text: 1 word for each 5 characters.
    // The estimate of the import has fewer characters, because it does not count the white
    // space of the markup.
    function openForSpeed(options: OpenOptions = {}): Promise<Harness> {
        const record = makeRecord()
        record.spineStats[CHAPTER_2] = { chars: 11000, words: 4000 }
        return open({ record, ...options })
    }

    function turnPage(views: FakeViews, start: number): void {
        views.current.relocate(chapter2Page(start, start + 1000, 20000))
    }

    it('measures a page turn and writes the moving average to the settings', async () => {
        const { views, settings } = await openForSpeed()
        expect(settings.get().readingWpm).toBe(230)
        turnPage(views, 0)
        vi.advanceTimersByTime(60_000)
        // 200 words in one minute. 230 + 0.2 * (200 - 230) = 224.
        turnPage(views, 1000)
        expect(settings.get().readingWpm).toBe(224)
    })

    it('writes to the settings one time in 30 seconds at most, and in destroy()', async () => {
        const { session, views, settings } = await openForSpeed()
        const update = vi.spyOn(settings, 'update')
        turnPage(views, 0)
        vi.advanceTimersByTime(60_000)
        turnPage(views, 1000)
        expect(update).toHaveBeenCalledTimes(1)

        // 200 words in 20 seconds are 600. 224 + 0.2 * (600 - 224) = 299.2.
        vi.advanceTimersByTime(20_000)
        turnPage(views, 2000)
        expect(update).toHaveBeenCalledTimes(1)
        expect(settings.get().readingWpm).toBe(224)

        // 200 words in 15 seconds are 800. 299.2 + 0.2 * (800 - 299.2) = 399.36.
        vi.advanceTimersByTime(15_000)
        turnPage(views, 3000)
        expect(update).toHaveBeenCalledTimes(2)
        expect(settings.get().readingWpm).toBe(399)

        // 200 words in 24 seconds are 500. 399.36 + 0.2 * (500 - 399.36) = 419.488.
        vi.advanceTimersByTime(24_000)
        turnPage(views, 4000)
        expect(settings.get().readingWpm).toBe(399)
        await session.destroy()
        expect(update).toHaveBeenCalledTimes(3)
        expect(settings.get().readingWpm).toBe(419)
    })

    it('does not write in destroy() when there is no new sample', async () => {
        const { session, views, settings } = await openForSpeed()
        const update = vi.spyOn(settings, 'update')
        turnPage(views, 0)
        vi.advanceTimersByTime(60_000)
        turnPage(views, 1000)
        await session.destroy()
        expect(update).toHaveBeenCalledTimes(1)
    })

    it('starts from the reading speed of the settings', async () => {
        const { views, settings } = await openForSpeed({ settings: { readingWpm: 400 } })
        turnPage(views, 0)
        vi.advanceTimersByTime(60_000)
        turnPage(views, 1000)
        expect(settings.get().readingWpm).toBe(360)
    })

    it('does not send the new reading speed to the view', async () => {
        const { views } = await openForSpeed()
        turnPage(views, 0)
        vi.advanceTimersByTime(60_000)
        turnPage(views, 1000)
        expect(views.current.setAppearance).not.toHaveBeenCalled()
    })

    it.each(['speed', 'listen'] as const)('takes no sample in the mode %s', async (mode) => {
        const { session, views, settings } = await openForSpeed()
        session.setMode(mode)
        turnPage(views, 0)
        vi.advanceTimersByTime(60_000)
        turnPage(views, 1000)
        expect(settings.get().readingWpm).toBe(230)
    })

    it('takes no sample for a page that was open during a different mode', async () => {
        const { session, views, settings } = await openForSpeed()
        turnPage(views, 0)
        session.setMode('speed')
        vi.advanceTimersByTime(30_000)
        session.setMode('read')
        vi.advanceTimersByTime(30_000)
        turnPage(views, 1000)
        expect(settings.get().readingWpm).toBe(230)

        // The next page is a sample again.
        vi.advanceTimersByTime(60_000)
        turnPage(views, 2000)
        expect(settings.get().readingWpm).toBe(224)
    })

    it('takes no sample when the page was hidden in between', async () => {
        const { views, settings } = await openForSpeed()
        turnPage(views, 0)
        vi.advanceTimersByTime(20_000)
        setVisibility('hidden')
        vi.advanceTimersByTime(20_000)
        setVisibility('visible')
        vi.advanceTimersByTime(20_000)
        turnPage(views, 1000)
        expect(settings.get().readingWpm).toBe(230)

        vi.advanceTimersByTime(60_000)
        turnPage(views, 2000)
        expect(settings.get().readingWpm).toBe(224)
    })

    it('takes no sample for a jump, a move back or a different chapter', async () => {
        const { views, settings } = await openForSpeed()
        turnPage(views, 0)
        vi.advanceTimersByTime(60_000)
        turnPage(views, 5000)
        vi.advanceTimersByTime(60_000)
        turnPage(views, 4000)
        vi.advanceTimersByTime(60_000)
        views.current.relocate(page({ spineIndex: CHAPTER_3, start: 5000, end: 6000 }))
        expect(settings.get().readingWpm).toBe(230)
    })

    it('takes no sample for a page turn that is too fast or too slow', async () => {
        const { views, settings } = await openForSpeed()
        turnPage(views, 0)
        vi.advanceTimersByTime(2_000)
        turnPage(views, 1000)
        vi.advanceTimersByTime(301_000)
        turnPage(views, 2000)
        expect(settings.get().readingWpm).toBe(230)
    })

    it('keeps the start time when the layout changes at the same position', async () => {
        const { views, settings } = await openForSpeed()
        views.current.relocate(chapter2Page(0, 1000, 20000))
        vi.advanceTimersByTime(30_000)
        // A larger font: the same start, less text on the page.
        views.current.relocate(chapter2Page(0, 800, 20000))
        vi.advanceTimersByTime(30_000)
        views.current.relocate(chapter2Page(800, 1600, 20000))
        // 160 words in the full minute. 230 + 0.2 * (160 - 230) = 216.
        expect(settings.get().readingWpm).toBe(216)
    })
})

describe('mode', () => {
    it('keeps the mode and emits "mode"', async () => {
        const { session, views, events } = await open()
        session.setMode('listen')
        expect(session.mode).toBe('listen')
        session.setMode('listen')
        session.setMode('read')
        expect(events).toEqual([
            ['mode', 'listen'],
            ['mode', 'read'],
        ])
        // The mode changes nothing in the view.
        expect(views.log).toEqual(['paged.create'])
    })
})

describe('destroy', () => {
    it('destroys the view, disposes the content loader and removes the listeners', async () => {
        const { session, views, content, settings, systemTheme, storage, events } = await open()
        const view = views.current
        view.relocate(chapter2Page(0, 400))
        vi.advanceTimersByTime(800)
        const save = vi.spyOn(storage, 'saveProgress')
        events.length = 0

        await session.destroy()

        expect(view.destroy).toHaveBeenCalledTimes(1)
        expect(content.dispose).toHaveBeenCalledTimes(1)
        expect(systemTheme.stopped).toBe(true)

        // Nothing of the page reaches the session now.
        view.relocate(chapter2Page(400, 800))
        view.options.callbacks.onCenterTap()
        settings.update({ fontSize: 30 })
        settings.update({ layout: 'scroll' })
        window.dispatchEvent(new Event('pagehide'))
        setVisibility('hidden')
        vi.advanceTimersByTime(10_000)

        expect(events).toEqual([])
        expect(session.position?.locator.offset).toBe(0)
        expect(view.setAppearance).not.toHaveBeenCalled()
        expect(views.views).toHaveLength(1)
        expect(save).not.toHaveBeenCalled()
    })

    it('removes its listeners from the page and from the settings store', async () => {
        const onWindow = vi.spyOn(window, 'addEventListener')
        const onDocument = vi.spyOn(document, 'addEventListener')
        const { session, settingsListeners } = await open()
        const signals = [...onWindow.mock.calls, ...onDocument.mock.calls].map(
            ([type, , options]) => [type, (options as AddEventListenerOptions).signal] as const,
        )
        expect(signals.map(([type]) => type)).toEqual(['pagehide', 'visibilitychange'])
        expect(signals.every(([, signal]) => signal?.aborted === false)).toBe(true)
        expect(settingsListeners()).toBe(1)

        await session.destroy()

        expect(signals.every(([, signal]) => signal?.aborted === true)).toBe(true)
        expect(settingsListeners()).toBe(0)
    })

    it('destroys the view before the write of the position is complete', async () => {
        const { session, views, storage } = await open()
        let finishWrite = (): void => {}
        vi.spyOn(storage, 'saveProgress').mockReturnValue(
            new Promise<void>((resolve) => {
                finishWrite = resolve
            }),
        )
        views.current.relocate(chapter2Page(0, 400))

        let done = false
        const destroyed = session.destroy().then(() => {
            done = true
        })
        expect(views.current.isDestroyed).toBe(true)
        expect(storage.saveProgress).toHaveBeenCalledTimes(1)
        await settle()
        expect(done).toBe(false)

        finishWrite()
        await destroyed
        expect(done).toBe(true)
    })

    it('resolves when the last write fails', async () => {
        const { session, views, storage, events } = await open()
        vi.spyOn(storage, 'saveProgress').mockRejectedValue(new Error('closed'))
        views.current.relocate(chapter2Page(0, 400))
        events.length = 0
        await expect(session.destroy()).resolves.toBeUndefined()
        expect(events).toEqual([])
    })

    it('waits for a write of the position that started before', async () => {
        const { session, views, storage } = await open()
        let finishWrite = (): void => {}
        vi.spyOn(storage, 'saveProgress').mockReturnValue(
            new Promise<void>((resolve) => {
                finishWrite = resolve
            }),
        )
        views.current.relocate(chapter2Page(0, 400))
        vi.advanceTimersByTime(PROGRESS_SAVE_DELAY_MS)
        expect(storage.saveProgress).toHaveBeenCalledTimes(1)

        let done = false
        const destroyed = session.destroy().then(() => {
            done = true
        })
        await settle()
        // The position is in no second write, and the first one is not complete.
        expect(storage.saveProgress).toHaveBeenCalledTimes(1)
        expect(done).toBe(false)

        finishWrite()
        await destroyed
        expect(done).toBe(true)
    })

    it('disposes the content loader and resolves when the view throws in destroy()', async () => {
        const { session, views, content, settingsListeners } = await open()
        const failure = new Error('view failed')
        const reported = vi.fn()
        vi.stubGlobal('reportError', reported)
        vi.mocked(views.current.destroy).mockImplementationOnce(() => {
            throw failure
        })

        let result: Promise<void> | undefined
        expect(() => {
            result = session.destroy()
        }).not.toThrow()
        await expect(result).resolves.toBeUndefined()
        expect(content.dispose).toHaveBeenCalledTimes(1)
        expect(settingsListeners()).toBe(0)
        expect(reported).toHaveBeenCalledWith(failure)
    })

    it('resolves when the content loader throws in dispose()', async () => {
        const { session, views, content } = await open()
        const failure = new Error('loader failed')
        const reported = vi.fn()
        vi.stubGlobal('reportError', reported)
        vi.mocked(content.dispose).mockImplementationOnce(() => {
            throw failure
        })
        await expect(session.destroy()).resolves.toBeUndefined()
        expect(views.current.isDestroyed).toBe(true)
        expect(reported).toHaveBeenCalledWith(failure)
    })

    it('does the work one time for two calls', async () => {
        const { session, views, content } = await open()
        await Promise.all([session.destroy(), session.destroy()])
        await session.destroy()
        expect(views.current.destroy).toHaveBeenCalledTimes(1)
        expect(content.dispose).toHaveBeenCalledTimes(1)
    })

    it('does nothing in calls after destroy() and gives resolved promises', async () => {
        const { session, views, storage, content, events } = await open({
            bookmarks: [makeBookmark('b1', { locator: { spineIndex: CHAPTER_2, offset: 10 } })],
            highlights: [makeHighlight('h1')],
        })
        const view = views.current
        view.relocate(chapter2Page(0, 400))
        await session.goTo({ spineIndex: CHAPTER_3, offset: 0 }, { remember: true })
        await session.destroy()
        events.length = 0
        views.log.length = 0
        vi.mocked(content.load).mockClear()
        vi.mocked(content.loadText).mockClear()
        const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)
        const listener = vi.fn()

        expect(session.on('relocate', listener)).toBeTypeOf('function')
        session.setMode('speed')
        expect(session.mode).toBe('read')
        expect(await session.next()).toBe(false)
        expect(await session.prev()).toBe(false)
        await expect(session.goTo({ spineIndex: CHAPTER_1, offset: 0 })).resolves.toBeUndefined()
        await expect(session.goToTocEntry(session.toc[0])).resolves.toBeUndefined()
        await expect(session.goToFraction(0.5)).resolves.toBeUndefined()
        await expect(session.back()).resolves.toBeUndefined()
        await expect(
            session.followLink({ kind: 'external', url: 'https://example.com/' }),
        ).resolves.toBeUndefined()
        await expect(session.toggleBookmark()).resolves.toBeUndefined()
        await expect(session.removeBookmark('b1')).resolves.toBeUndefined()
        await expect(session.updateHighlight('h1', { color: 'blue' })).resolves.toBeUndefined()
        await expect(session.removeHighlight('h1')).resolves.toBeUndefined()
        const onResults = vi.fn()
        await expect(
            session.search({ query: 'whale', signal: new AbortController().signal, onResults }),
        ).resolves.toBeUndefined()
        session.clearSearch()
        expect(await session.loadNote({ spineIndex: NOTES, fragment: 'n1' })).toBeNull()
        await expect(session.saveProgress()).resolves.toBeUndefined()

        expect(views.log).toEqual([])
        expect(events).toEqual([])
        expect(listener).not.toHaveBeenCalled()
        expect(onResults).not.toHaveBeenCalled()
        expect(openWindow).not.toHaveBeenCalled()
        expect(content.load).not.toHaveBeenCalled()
        expect(content.loadText).not.toHaveBeenCalled()
        expect(session.bookmarks.map((bookmark) => bookmark.id)).toEqual(['b1'])
        expect(session.highlights.map((highlight) => highlight.id)).toEqual(['h1'])
        expect((await storage.listBookmarks(BOOK_ID)).map((bookmark) => bookmark.id)).toEqual([
            'b1',
        ])
        expect((await storage.listHighlights(BOOK_ID)).map((highlight) => highlight.id)).toEqual([
            'h1',
        ])
    })

    it('rejects a new highlight after destroy() and stores nothing', async () => {
        const { session, views, storage, events } = await open({
            highlights: [makeHighlight('h1')],
        })
        const put = vi.spyOn(storage, 'putHighlight')
        await session.destroy()
        events.length = 0
        views.log.length = 0

        // The Undo of a removal can come after the reader closed the book. The caller must
        // know that the highlight is not back.
        const added = session.addHighlight({
            range: { spineIndex: CHAPTER_2, start: 3, end: 9 },
            text: 'second',
            color: 'green',
        })
        await expect(added).rejects.toBeInstanceOf(Error)
        await expect(added).rejects.toThrow(HIGHLIGHT_CLOSED_MESSAGE)
        expect(HIGHLIGHT_CLOSED_MESSAGE).toBe('The book is closed, so the highlight was not saved.')

        expect(put).not.toHaveBeenCalled()
        expect(views.log).toEqual([])
        expect(events).toEqual([])
        expect(session.highlights.map((highlight) => highlight.id)).toEqual(['h1'])
        expect((await storage.listHighlights(BOOK_ID)).map((highlight) => highlight.id)).toEqual([
            'h1',
        ])
    })

    it('rejects a new highlight that waits for an earlier change at the time of destroy()', async () => {
        const { session, storage } = await open({ highlights: [makeHighlight('h1')] })
        let finishDelete = (): void => {}
        vi.spyOn(storage, 'deleteHighlight').mockReturnValue(
            new Promise<void>((resolve) => {
                finishDelete = resolve
            }),
        )
        const put = vi.spyOn(storage, 'putHighlight')
        const removed = session.removeHighlight('h1')
        const added = session.addHighlight({
            range: { spineIndex: CHAPTER_2, start: 3, end: 9 },
            text: 'second',
            color: 'green',
        })
        const result = expect(added).rejects.toThrow(HIGHLIGHT_CLOSED_MESSAGE)
        await settle()
        await session.destroy()
        finishDelete()

        await removed
        await result
        expect(put).not.toHaveBeenCalled()
    })

    it('does not touch the view when a change of annotations completes after destroy()', async () => {
        const { session, views, storage } = await open()
        let finishWrite = (): void => {}
        vi.spyOn(storage, 'putHighlight').mockReturnValue(
            new Promise<void>((resolve) => {
                finishWrite = resolve
            }),
        )
        const pending = session.addHighlight({
            range: { spineIndex: CHAPTER_2, start: 3, end: 9 },
            text: 'second',
            color: 'green',
        })
        await settle()
        await session.destroy()
        views.log.length = 0
        finishWrite()

        const created = await pending
        expect(created.color).toBe('green')
        expect(views.log).toEqual([])
    })

    it('does not add a bookmark when the session is destroyed during the text load', async () => {
        const { session, views, storage } = await open()
        const put = vi.spyOn(storage, 'putBookmark')
        views.current.relocate(chapter2Page(10, 40))
        const pending = session.toggleBookmark()
        await session.destroy()
        await pending
        expect(put).not.toHaveBeenCalled()
    })

    it('ignores the anchor offsets of a chapter that loads after destroy()', async () => {
        const { session, views, events } = await open()
        views.current.relocate(page({ spineIndex: CHAPTER_1, start: 0, end: 20 }))
        await session.destroy()
        events.length = 0
        await settle()
        expect(events).toEqual([])
    })
})
