/** Test helpers for the panels: a reader session with no book behind it, and a page to mount in. */

import { vi } from 'vitest'
import type { ContentLoader } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import { createFakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import type { FakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import type { ReaderView } from '$lib/reader/types'
import type { BookmarkRecord, BookRecord, HighlightRecord } from '$lib/storage/types'
import type { Locator } from '$lib/types'
import { installOverlayMethods } from '../../../app/testing/page'
import type {
    ReaderMode,
    ReaderSession,
    ReaderSessionEvents,
    SearchOptions,
    SearchResult,
    TocEntry,
} from '../../types'

/** Text that would run a script or add an element, if a panel put it into the page as HTML. */
export const HOSTILE = '<img src=x onerror="window.hacked = true"><b>bold</b>'

export const BOOK_ID = 'book-1'

export function makeRecord(changes: Partial<BookRecord> = {}): BookRecord {
    return {
        id: BOOK_ID,
        title: 'A Wizard of Earthsea',
        author: 'Ursula K. Le Guin',
        language: 'en',
        identifier: null,
        publisher: null,
        description: null,
        published: null,
        subjects: [],
        series: null,
        fileName: 'earthsea.epub',
        fileSize: 1000,
        fileHash: 'hash',
        hasCover: false,
        spineStats: [],
        totalChars: 0,
        totalWords: 0,
        addedAt: 0,
        lastOpenedAt: null,
        ...changes,
    }
}

export function makeBookmark(changes: Partial<BookmarkRecord> = {}): BookmarkRecord {
    return {
        id: 'm1',
        bookId: BOOK_ID,
        locator: { spineIndex: 2, offset: 40 },
        fraction: 0.41,
        chapterTitle: 'The Shadow',
        excerpt: 'The island of Gont, a single mountain',
        createdAt: 1,
        ...changes,
    }
}

export function makeHighlight(changes: Partial<HighlightRecord> = {}): HighlightRecord {
    return {
        id: 'h1',
        bookId: BOOK_ID,
        spineIndex: 3,
        start: 120,
        end: 160,
        text: 'To light a candle is to cast a shadow',
        color: 'yellow',
        note: '',
        chapterTitle: 'The School for Wizards',
        fraction: 0.52,
        createdAt: 1,
        updatedAt: 1,
        ...changes,
    }
}

export function makeResult(changes: Partial<SearchResult> = {}): SearchResult {
    return {
        range: { spineIndex: 1, start: 10, end: 15 },
        excerpt: 'The white whale swam in the cold sea',
        matchStart: 10,
        matchEnd: 15,
        chapterTitle: 'Chapter One',
        ...changes,
    }
}

export const TOC: readonly TocEntry[] = [
    { title: 'Part one', depth: 0, spineIndex: 1, fragment: null },
    { title: 'Warriors in the Mist', depth: 1, spineIndex: 1, fragment: 'c1' },
    { title: 'The Shadow', depth: 1, spineIndex: 2, fragment: null },
    { title: 'A note', depth: 2, spineIndex: 2, fragment: 'n1' },
    { title: 'Part two', depth: 0, spineIndex: 5, fragment: null },
]

/** The position that the fake session gives for a locator: 10 percent for each spine item. */
export function fakeFraction({ spineIndex, offset }: Locator): number {
    return Math.min(1, spineIndex / 10 + Math.min(offset, 999) / 10_000)
}

/** One call of `search` of the fake session. The test sends the results and ends the search. */
export interface FakeSearch {
    options: SearchOptions
    resolve(): void
    reject(error: unknown): void
}

export interface FakeSessionOptions {
    record?: Partial<BookRecord>
    toc?: readonly TocEntry[]
    currentTocEntry?: TocEntry | null
    bookmarks?: BookmarkRecord[]
    highlights?: HighlightRecord[]
    bookFonts?: string[]
    fonts?: FakeUserFonts
}

type Listener = (payload: never) => void

/**
 * A session that keeps its lists in memory. The methods that change a list send the event of
 * that list, as the real session does. Each method is a mock, so a test can make it fail.
 */
export function createFakeSession(options: FakeSessionOptions = {}) {
    const listeners = new Map<string, Set<Listener>>()
    const toc = options.toc ?? TOC
    let bookmarks: readonly BookmarkRecord[] = options.bookmarks ?? []
    let highlights: readonly HighlightRecord[] = options.highlights ?? []
    let currentTocEntry: TocEntry | null = options.currentTocEntry ?? null
    let added = 0
    const searches: FakeSearch[] = []

    function emit<K extends keyof ReaderSessionEvents>(
        event: K,
        payload: ReaderSessionEvents[K],
    ): void {
        for (const listener of [...(listeners.get(event) ?? [])]) {
            ;(listener as (payload: ReaderSessionEvents[K]) => void)(payload)
        }
    }

    function setBookmarks(next: readonly BookmarkRecord[]): void {
        bookmarks = next
        emit('bookmarks', bookmarks)
    }

    function setHighlights(next: readonly HighlightRecord[]): void {
        highlights = next
        emit('highlights', highlights)
    }

    const session = {
        record: makeRecord(options.record),
        book: {} as EpubBook,
        content: { bookFonts: options.bookFonts ?? [] } as unknown as ContentLoader,
        fonts: options.fonts ?? createFakeUserFonts(),
        toc,
        view: {} as ReaderView,
        position: null,
        mode: 'read' as ReaderMode,
        get bookmarks() {
            return bookmarks
        },
        get highlights() {
            return highlights
        },

        on<K extends keyof ReaderSessionEvents>(
            event: K,
            listener: (payload: ReaderSessionEvents[K]) => void,
        ): () => void {
            const set = listeners.get(event) ?? new Set<Listener>()
            listeners.set(event, set)
            set.add(listener as Listener)
            return () => {
                set.delete(listener as Listener)
            }
        },

        setMode: vi.fn<ReaderSession['setMode']>(),
        next: vi.fn<ReaderSession['next']>(async () => true),
        prev: vi.fn<ReaderSession['prev']>(async () => true),
        goTo: vi.fn<ReaderSession['goTo']>(async () => {}),
        goToTocEntry: vi.fn<ReaderSession['goToTocEntry']>(async () => {}),
        goToFraction: vi.fn<ReaderSession['goToFraction']>(async () => {}),
        followLink: vi.fn<ReaderSession['followLink']>(async () => {}),
        canGoBack: false,
        back: vi.fn<ReaderSession['back']>(async () => {}),

        fractionOf: fakeFraction,
        fraction: 0,
        get currentTocEntry() {
            return currentTocEntry
        },
        chapterTitleAt: () => '',
        wordsRemaining: null,

        isBookmarked: false,
        toggleBookmark: vi.fn<ReaderSession['toggleBookmark']>(async () => {}),
        removeBookmark: vi.fn<ReaderSession['removeBookmark']>(async (id) => {
            setBookmarks(bookmarks.filter((bookmark) => bookmark.id !== id))
        }),

        addHighlight: vi.fn<ReaderSession['addHighlight']>(async (highlight) => {
            const record = makeHighlight({
                id: `added-${++added}`,
                spineIndex: highlight.range.spineIndex,
                start: highlight.range.start,
                end: highlight.range.end,
                text: highlight.text,
                color: highlight.color,
                note: highlight.note ?? '',
            })
            setHighlights(
                [...highlights, record].sort(
                    (a, b) => a.spineIndex - b.spineIndex || a.start - b.start,
                ),
            )
            return record
        }),
        updateHighlight: vi.fn<ReaderSession['updateHighlight']>(async (id, patch) => {
            setHighlights(
                highlights.map((highlight) =>
                    highlight.id === id ? { ...highlight, ...patch } : highlight,
                ),
            )
        }),
        removeHighlight: vi.fn<ReaderSession['removeHighlight']>(async (id) => {
            setHighlights(highlights.filter((highlight) => highlight.id !== id))
        }),
        reloadAnnotations: vi.fn<ReaderSession['reloadAnnotations']>(async () => {}),

        search: vi.fn<ReaderSession['search']>(
            (searchOptions) =>
                new Promise<void>((resolve, reject) => {
                    searches.push({ options: searchOptions, resolve, reject })
                }),
        ),
        clearSearch: vi.fn<ReaderSession['clearSearch']>(),

        loadNote: vi.fn<ReaderSession['loadNote']>(async () => null),
        saveProgress: vi.fn<ReaderSession['saveProgress']>(async () => {}),
        destroy: vi.fn<ReaderSession['destroy']>(async () => {}),
    } satisfies ReaderSession

    return Object.assign(session, {
        emit,
        setBookmarks,
        setHighlights,
        /** The calls of `search`, the oldest first. */
        searches,
        setCurrentTocEntry(entry: TocEntry | null): void {
            currentTocEntry = entry
        },
        /** The number of listeners that the panels did not remove. */
        listenerCount(): number {
            let count = 0
            for (const set of listeners.values()) count += set.size
            return count
        },
    })
}

export type FakeSession = ReturnType<typeof createFakeSession>

/**
 * An empty page with the overlay layer of the reader screen, and the dialog and popover methods
 * that jsdom does not have. Returns the overlay layer.
 */
export function mountHost(): HTMLElement {
    installOverlayMethods()
    document.body.replaceChildren()
    const host = document.createElement('div')
    host.className = 'reader-overlays'
    document.body.append(host)
    return host
}

/** A button of the page that has the focus, as the control that opens a panel. */
export function focusOpener(): HTMLButtonElement {
    const opener = document.createElement('button')
    opener.type = 'button'
    document.body.append(opener)
    opener.focus()
    return opener
}
