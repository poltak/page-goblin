/**
 * Public types of the reader views.
 *
 * A reader view shows the chapters of one open book in a container element. There are two
 * views with the same interface: the paged view (CSS columns, one screen at a time) and the
 * scroll view (one continuous column). The views are plain DOM code with no UI library.
 */

import type { ContentLoader } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import type {
    HighlightColor,
    Locator,
    PageTurnAnimation,
    ReadingTheme,
    TextRange,
} from '$lib/types'

export type MarginSize = 'narrow' | 'normal' | 'wide'

export type TextAlignChoice = 'publisher' | 'start' | 'justify'

export type ColumnChoice = 'auto' | 1 | 2

/** All settings that change how the book text looks. */
export interface Appearance {
    theme: ReadingTheme
    /** CSS `font-family` value for body text, or null to keep the publisher font. */
    fontFamily: string | null
    /** Body font size in CSS pixels. */
    fontSize: number
    /** Unitless line height, or null to keep the publisher value. */
    lineHeight: number | null
    margin: MarginSize
    textAlign: TextAlignChoice
    hyphenate: boolean
    /** False ignores all book stylesheets and inline styles. */
    publisherStyles: boolean
    /** Paged view only. 'auto' shows two columns on wide landscape screens. */
    columns: ColumnChoice
    /** Paged view only. */
    pageTurn: PageTurnAnimation
}

/** A saved highlight as the view needs it. */
export interface HighlightMark {
    id: string
    spineIndex: number
    start: number
    /** Exclusive. */
    end: number
    color: HighlightColor
    hasNote: boolean
}

export interface RelocateInfo {
    /** The first visible character. This is the position to save as progress. */
    locator: Locator
    /**
     * The text that is visible now in the chapter of `locator`. In the scroll view, when two
     * chapters are visible, the range stops at the end of the first chapter.
     */
    visible: TextRange
    /** Text length of the chapter of `locator`. */
    chapterLength: number
    /** 1-based page number in the chapter. Null in the scroll view. */
    page: number | null
    /** Number of pages in the chapter. Null in the scroll view. */
    pageCount: number | null
    atBookStart: boolean
    atBookEnd: boolean
}

export interface SelectionInfo {
    range: TextRange
    text: string
    /** Bounding box of the selection in viewport coordinates. */
    bounds: DOMRect
}

export type LinkTarget =
    | {
          kind: 'internal'
          path: string
          fragment: string | null
          /** Index into the spine, or -1 when the target is not a spine document. */
          spineIndex: number
          /**
           * True when the link looks like a note reference: `epub:type` has "noteref", or the
           * link is in a `sup` element, or its text is a short number or note mark. The reader
           * screen then shows the note in a popover and does not leave the page.
           */
          noteref: boolean
          /** Bounding box of the link in viewport coordinates. */
          bounds: DOMRect
      }
    | { kind: 'external'; url: string }

export interface ReaderViewCallbacks {
    /** Called after each change of the visible position, and after a layout change. */
    onRelocate(info: RelocateInfo): void
    /** A tap or click in the centre of the page that did not hit a link, highlight or selection. */
    onCenterTap(): void
    /** The text selection changed. Null when the selection is empty or outside the book text. */
    onSelection(selection: SelectionInfo | null): void
    /** A tap or click on a saved highlight. `bounds` is in viewport coordinates. */
    onHighlightTap(id: string, bounds: DOMRect): void
    /** A tap or click on a link. The view does not follow links itself. */
    onLink(target: LinkTarget): void
    /** A tap or click on an image. `src` is an object URL that stays valid while the chapter is shown. */
    onImageTap(image: { src: string; alt: string }): void
    /** A chapter did not load, or another error that the user must see. */
    onError(error: unknown): void
}

export interface ReaderViewOptions {
    /** The view fills this element. The element must have a size from CSS. */
    container: HTMLElement
    book: EpubBook
    content: ContentLoader
    appearance: Appearance
    initial: Locator
    highlights: readonly HighlightMark[]
    callbacks: ReaderViewCallbacks
}

export interface ReaderView {
    /** Resolves after the first chapter is shown. Rejects when the first chapter cannot load. */
    readonly ready: Promise<void>
    /** Show the page or scroll position that has this locator. */
    goTo(locator: Locator): Promise<void>
    /** Go to the element with this id. A null or unknown fragment goes to the chapter start. */
    goToAnchor(spineIndex: number, fragment: string | null): Promise<void>
    /** One page (paged view) or most of one screen (scroll view) forward. False at the book end. */
    next(): Promise<boolean>
    /** False at the book start. */
    prev(): Promise<boolean>
    /** The last position that was sent to `onRelocate`, or null before the view is ready. */
    getPosition(): RelocateInfo | null
    setAppearance(appearance: Appearance): void
    /** Replace all highlights. The view paints them again in the chapters that are mounted. */
    setHighlights(highlights: readonly HighlightMark[]): void
    /**
     * Show the moving marker for speech. When `follow` is true (the default) and the range is
     * not visible, the view turns the page or scrolls to it. Null removes the marker.
     */
    setActiveRange(range: TextRange | null, options?: { follow?: boolean }): void
    /**
     * Mark the matches of a search in the chapters that are mounted, now and later. An empty list
     * removes the marks. The view does not move; use `goTo` to show a match.
     */
    setSearchRanges(ranges: readonly TextRange[]): void
    clearSelection(): void
    /** Remove all DOM and listeners. The view cannot be used after this. */
    destroy(): void
}
