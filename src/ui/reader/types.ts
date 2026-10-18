/**
 * Contract of the reader screen.
 *
 * `ReaderSession` is the model of one open book. It owns the EPUB book, the content loader, the
 * reader view, the saved position and the annotations. The parts of the reader screen (bars,
 * panels, selection toolbar, speed reader, listen bar) use the session and its events. They do
 * not talk to storage or to the view constructors directly.
 */

import type { ContentLoader } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import type { UserFonts } from '$lib/fonts/user-fonts'
import type { LinkTarget, ReaderView, RelocateInfo, SelectionInfo } from '$lib/reader/types'
import type {
    BookmarkRecord,
    BookRecord,
    HighlightRecord,
    LibraryStorage,
    ProgressRecord,
} from '$lib/storage/types'
import type { HighlightColor, Locator, TextRange } from '$lib/types'

/** 'read' is the normal book view. The other two modes run on top of it. */
export type ReaderMode = 'read' | 'speed' | 'listen'

/** One row of the contents list. The nested table of contents is flattened in reading order. */
export interface TocEntry {
    title: string
    /** 0 for a top-level entry. */
    depth: number
    spineIndex: number
    /** Fragment identifier without '#', or null. */
    fragment: string | null
}

export interface ReaderSessionEvents {
    /**
     * The visible position changed. The event also comes a second time with the same data when
     * the contents entry of the position changes after the chapter anchors load.
     */
    relocate: RelocateInfo
    bookmarks: readonly BookmarkRecord[]
    highlights: readonly HighlightRecord[]
    /** The text selection in the book changed. Null when there is no selection. */
    selection: SelectionInfo | null
    mode: ReaderMode
    /** A new view replaced the old one, because the layout mode changed. */
    view: ReaderView
    /** A tap in the centre of the page. The screen shows or hides its bars. */
    'center-tap': undefined
    'highlight-tap': { highlight: HighlightRecord; bounds: DOMRect }
    'image-tap': { src: string; alt: string }
    /**
     * A tap on a note reference link. The session does not follow such a link. The screen shows
     * the note in a popover (see `loadNote`) and can go to it with `followLink`.
     */
    'note-tap': { target: Extract<LinkTarget, { kind: 'internal' }> }
    /** An error that the user must see, for example a chapter that did not load. */
    error: unknown
}

export interface SearchResult {
    range: TextRange
    /** Text around the match with white space collapsed. */
    excerpt: string
    /** Start and end of the match inside `excerpt`. */
    matchStart: number
    matchEnd: number
    chapterTitle: string
}

export interface SearchOptions {
    query: string
    /** Stops the search. */
    signal: AbortSignal
    /** Called with the new results of each chapter, in reading order. */
    onResults(results: SearchResult[]): void
    /**
     * Called after each chapter with the number of chapters that are done. A search stops at
     * 500 results.
     */
    onProgress?(done: number, total: number): void
}

export interface NewHighlight {
    range: TextRange
    text: string
    color: HighlightColor
    note?: string
}

export interface ReaderSession {
    readonly record: BookRecord
    readonly book: EpubBook
    readonly content: ContentLoader
    /** The fonts that the user added. The registry is the same for each book of the page. */
    readonly fonts: UserFonts
    /** The table of contents, or one entry for each linear spine item when the book has none. */
    readonly toc: readonly TocEntry[]
    /** The view that is mounted now. Read it again after a 'view' event. */
    readonly view: ReaderView
    /** The last position of the view, or null before the first chapter is shown. */
    readonly position: RelocateInfo | null
    readonly mode: ReaderMode
    /** Sorted by position. */
    readonly bookmarks: readonly BookmarkRecord[]
    /** Sorted by position. */
    readonly highlights: readonly HighlightRecord[]

    /** Returns a function that removes the listener. */
    on<K extends keyof ReaderSessionEvents>(
        event: K,
        listener: (payload: ReaderSessionEvents[K]) => void,
    ): () => void

    setMode(mode: ReaderMode): void

    next(): Promise<boolean>
    prev(): Promise<boolean>
    /** Go to a position. With `remember`, the position before the jump goes on the back stack. */
    goTo(locator: Locator, options?: { remember?: boolean }): Promise<void>
    goToTocEntry(entry: TocEntry): Promise<void>
    /** Go to a position in the whole book from 0 to 1 (the progress slider). */
    goToFraction(fraction: number): Promise<void>
    /** Follow a link from the book text. Internal links push the current position on the back stack. */
    followLink(target: LinkTarget): Promise<void>
    /** True when `back()` has a position to return to. */
    readonly canGoBack: boolean
    back(): Promise<void>

    /** Position of a locator in the whole book from 0 to 1. */
    fractionOf(locator: Locator): number
    /** Position of the current page in the whole book from 0 to 1. It is 1 on the last page. */
    readonly fraction: number
    /** The contents entry that the current position is in, or null. */
    readonly currentTocEntry: TocEntry | null
    /** Title of the contents entry for a locator, or '' when there is none. */
    chapterTitleAt(locator: Locator): string
    /** Estimated words to the end of the chapter and of the book, or null before the first relocate. */
    readonly wordsRemaining: { chapter: number; book: number } | null

    /** True when a bookmark is in the visible text. */
    readonly isBookmarked: boolean
    /**
     * Add a bookmark at the current position, or remove the bookmarks in the visible text.
     * The annotation methods reject when storage does not write. The lists then stay the same.
     */
    toggleBookmark(): Promise<void>
    removeBookmark(id: string): Promise<void>

    /** Rejects after `destroy()`. A resolved promise always has a record that is in storage. */
    addHighlight(highlight: NewHighlight): Promise<HighlightRecord>
    updateHighlight(id: string, patch: { color?: HighlightColor; note?: string }): Promise<void>
    removeHighlight(id: string): Promise<void>
    /**
     * Reads the bookmarks and highlights from storage again, after a sync changed them. It runs
     * after the annotation changes that wait, so a later edit starts from the new records.
     */
    reloadAnnotations(): Promise<void>

    /**
     * Search the text of the whole book, chapter by chapter, with no difference between upper
     * and lower case. Resolves when all chapters are done or the signal aborts. The session also
     * gives the matches to the view with `setSearchRanges`. An empty query removes the marks.
     */
    search(options: SearchOptions): Promise<void>
    clearSearch(): void

    /**
     * The content of a note for a note reference link: a detached copy of the target element (or
     * of its nearest block ancestor) with its book stylesheets. Null when the target is not there,
     * the chapter does not load or the note has no content.
     */
    loadNote(target: {
        spineIndex: number
        fragment: string | null
    }): Promise<{ element: HTMLElement; styles: readonly CSSStyleSheet[] } | null>

    /** Write the current position now. The session also saves by itself after each relocate. */
    saveProgress(): Promise<void>
    /** Save the position, remove the view and release the book. */
    destroy(): Promise<void>
}

export interface OpenReaderSessionOptions {
    bookId: string
    storage: LibraryStorage
    /** The element that the reader view fills. */
    container: HTMLElement
}

export interface ReaderMountOptions {
    /** The `#reader-view` element. The reader screen puts its markup into it. */
    root: HTMLElement
    bookId: string
    storage: LibraryStorage
    /** The user closed the book. The app shell goes back to the library. */
    onExit(): void
}

export interface MountedReader {
    destroy(): Promise<void>
    /**
     * A sync brought a newer reading position from a different device. When the position is
     * not on screen, the reader offers to go there. It does not move by itself.
     */
    offerPosition?(progress: ProgressRecord): void
    /** A sync changed the bookmarks or the highlights of this book. */
    annotationsChanged?(): void
    /** A sync changed the fonts that the user added. */
    fontsChanged?(): void
}
