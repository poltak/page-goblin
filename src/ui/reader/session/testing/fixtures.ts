/**
 * Test helpers for the reader session: a small book, its library record and a fake reader view.
 */

import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { EpubBook, TocItem } from '$lib/epub/types'
import { createFakeBook } from '$lib/epub/testing/fake-book'
import type { ReaderView, ReaderViewOptions, RelocateInfo } from '$lib/reader/types'
import type { BookmarkRecord, BookRecord, HighlightRecord } from '$lib/storage/types'
import type { LayoutMode } from '$lib/types'

export const BOOK_ID = 'book-1'

export function chapterXhtml(body: string): string {
    return (
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
        `<head><title>T</title></head><body>${body}</body></html>`
    )
}

/** Spine indexes of the test book. */
export const COVER = 0
export const CHAPTER_1 = 1
export const CHAPTER_2 = 2
/** A non-linear spine item. */
export const NOTES = 3
export const CHAPTER_3 = 4

const FILES: Record<string, string> = {
    'OEBPS/cover.xhtml': chapterXhtml('<p>A cover page with a few words.</p>'),
    'OEBPS/c1.xhtml': chapterXhtml(
        '\n<h1>Chapter One</h1>\n' +
            '<p>The white whale swam in the cold sea for many days and many nights.</p>\n' +
            '<h2 id="s1">Section one</h2>\n' +
            '<p>A sailor saw the White   Whale<sup><a epub:type="noteref" href="notes.xhtml#n1">1</a></sup> at dawn.</p>\n' +
            '<h2 id="s2">Section two</h2>\n' +
            '<p>Nothing more happened that day, and the ship sailed on.</p>\n',
    ),
    'OEBPS/c2.xhtml': chapterXhtml(
        '<h1>Chapter Two</h1><p>The second chapter has a harpoon and no animals.</p>',
    ),
    'OEBPS/notes.xhtml': chapterXhtml(
        '<aside id="n1"><p id="n1p">1. The first note about the white whale.</p></aside>' +
            '<p><a id="n2"></a>2. The second note.</p>',
    ),
    'OEBPS/c3.xhtml': chapterXhtml(
        '<h1>Chapter Three</h1><p>The whale came back in the last chapter.</p>',
    ),
}

function tocItem(
    title: string,
    target: { path: string; fragment?: string; spineIndex: number } | null,
    children: TocItem[] = [],
): TocItem {
    return {
        title,
        path: target?.path ?? null,
        fragment: target?.fragment ?? null,
        spineIndex: target?.spineIndex ?? -1,
        children,
    }
}

const TOC: TocItem[] = [
    tocItem('Chapter One', { path: 'OEBPS/c1.xhtml', spineIndex: CHAPTER_1 }, [
        tocItem('Section 1.1', { path: 'OEBPS/c1.xhtml', fragment: 's1', spineIndex: CHAPTER_1 }),
        tocItem('Section 1.2', { path: 'OEBPS/c1.xhtml', fragment: 's2', spineIndex: CHAPTER_1 }),
    ]),
    tocItem('Part two', null, [
        tocItem('Chapter Two', { path: 'OEBPS/c2.xhtml', spineIndex: CHAPTER_2 }),
        tocItem('Chapter Three', { path: 'OEBPS/c3.xhtml', spineIndex: CHAPTER_3 }),
    ]),
    tocItem('Lost', { path: 'OEBPS/lost.xhtml', spineIndex: -1 }),
]

export interface TestBookOptions {
    files?: Record<string, string>
    spine?: string[]
    toc?: TocItem[]
    nonLinear?: string[]
}

/** A book with a cover, three chapters and a non-linear notes file before the last chapter. */
export function makeBook(options: TestBookOptions = {}): EpubBook {
    return createFakeBook({
        files: options.files ?? FILES,
        spine: options.spine ?? [
            'OEBPS/cover.xhtml',
            'OEBPS/c1.xhtml',
            'OEBPS/c2.xhtml',
            'OEBPS/notes.xhtml',
            'OEBPS/c3.xhtml',
        ],
        toc: options.toc ?? TOC,
        nonLinear: options.nonLinear ?? ['OEBPS/notes.xhtml'],
    })
}

/** The statistics are round numbers and differ from the real text lengths, as estimates do. */
export function makeRecord(changes: Partial<BookRecord> = {}): BookRecord {
    return {
        id: BOOK_ID,
        title: 'The Test Book',
        author: 'An Author',
        language: 'en',
        identifier: 'urn:test:book-1',
        publisher: null,
        description: null,
        published: null,
        subjects: [],
        series: null,
        fileName: 'test.epub',
        fileSize: 3,
        fileHash: 'hash-book-1',
        hasCover: false,
        spineStats: [
            { chars: 100, words: 20 },
            { chars: 1000, words: 200 },
            { chars: 2000, words: 400 },
            { chars: 500, words: 100 },
            { chars: 400, words: 80 },
        ],
        totalChars: 4000,
        totalWords: 800,
        addedAt: 1000,
        lastOpenedAt: null,
        ...changes,
    }
}

export function makeBookmark(id: string, changes: Partial<BookmarkRecord> = {}): BookmarkRecord {
    return {
        id,
        bookId: BOOK_ID,
        locator: { spineIndex: CHAPTER_1, offset: 0 },
        fraction: 0.1,
        chapterTitle: 'Chapter One',
        excerpt: 'Some words',
        createdAt: 5000,
        ...changes,
    }
}

export function makeHighlight(id: string, changes: Partial<HighlightRecord> = {}): HighlightRecord {
    return {
        id,
        bookId: BOOK_ID,
        spineIndex: CHAPTER_1,
        start: 10,
        end: 20,
        text: 'some text',
        color: 'yellow',
        note: '',
        chapterTitle: 'Chapter One',
        fraction: 0.1,
        createdAt: 5000,
        updatedAt: 5000,
        ...changes,
    }
}

export interface PageOptions {
    spineIndex: number
    start: number
    end: number
    chapterLength?: number
    atBookStart?: boolean
    atBookEnd?: boolean
}

/** The relocate data of a page that shows [start, end) of a chapter. */
export function page({
    spineIndex,
    start,
    end,
    chapterLength = 1000,
    atBookStart = false,
    atBookEnd = false,
}: PageOptions): RelocateInfo {
    return {
        locator: { spineIndex, offset: start },
        visible: { spineIndex, start, end },
        chapterLength,
        page: 1,
        pageCount: 1,
        atBookStart,
        atBookEnd,
    }
}

export interface FakeView extends ReaderView {
    readonly mode: LayoutMode
    readonly options: ReaderViewOptions
    readonly isDestroyed: boolean
    /** Sends the data to `onRelocate`, as a real view does after a page turn. */
    relocate(info: RelocateInfo): void
    resolveReady(): void
    rejectReady(error: unknown): void
}

export interface FakeViews {
    readonly views: FakeView[]
    /** The view that was made last. */
    readonly current: FakeView
    /** Method calls of all views in sequence, for example 'paged.destroy'. */
    readonly log: string[]
    createView: Mock<(mode: LayoutMode, options: ReaderViewOptions) => ReaderView>
}

/**
 * A factory of reader views that record their calls. The `ready` promise of a view is resolved
 * at creation, or stays open until the test settles it when `manualReady` is true.
 */
export function createFakeViews({ manualReady = false } = {}): FakeViews {
    const views: FakeView[] = []
    const log: string[] = []

    const createView = vi.fn((mode: LayoutMode, options: ReaderViewOptions): ReaderView => {
        let position: RelocateInfo | null = null
        let isDestroyed = false
        let resolveReady = (): void => {}
        let rejectReady = (_error: unknown): void => {}
        const ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve
            rejectReady = reject
        })
        if (!manualReady) resolveReady()
        const note = (name: string): void => {
            log.push(`${mode}.${name}`)
        }

        const view: FakeView = {
            mode,
            options,
            get isDestroyed() {
                return isDestroyed
            },
            ready,
            goTo: vi.fn(async () => note('goTo')),
            goToAnchor: vi.fn(async () => note('goToAnchor')),
            next: vi.fn(async () => {
                note('next')
                return true
            }),
            prev: vi.fn(async () => {
                note('prev')
                return true
            }),
            getPosition: () => position,
            setAppearance: vi.fn(() => note('setAppearance')),
            setHighlights: vi.fn(() => note('setHighlights')),
            setActiveRange: vi.fn(() => note('setActiveRange')),
            setSearchRanges: vi.fn(() => note('setSearchRanges')),
            clearSelection: vi.fn(() => note('clearSelection')),
            destroy: vi.fn(() => {
                isDestroyed = true
                note('destroy')
            }),
            relocate(info) {
                position = info
                options.callbacks.onRelocate(info)
            },
            resolveReady,
            rejectReady,
        }
        log.push(`${mode}.create`)
        views.push(view)
        return view
    })

    return {
        views,
        log,
        createView,
        get current() {
            return views[views.length - 1]
        },
    }
}
