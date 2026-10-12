/**
 * Contract between the reader screen and its parts.
 *
 * The reader screen (`src/ui/reader/screen`) owns the layout, the bars and the keyboard. Each
 * part below is a separate module that the screen loads at its first use. A part makes its own
 * elements, appends them to the `host` layer, and talks to the book only through the session.
 *
 * Module paths and exports (the screen imports exactly these):
 * - `./panels/contents`    createContentsPanel(options: PartOptions): ContentsPanel
 * - `./panels/appearance`  createAppearancePanel(options: PartOptions): AppearancePanel
 * - `./panels/search`      createSearchPanel(options: PartOptions): SearchPanel
 * - `./tools/selection`    createSelectionTools(options: SelectionToolsOptions): Part
 * - `./tools/note-popover` createNotePopover(options: PartOptions): Part
 * - `./tools/image-viewer` createImageViewer(options: PartOptions): Part
 * - `./speed`              createSpeedReader(options: ModeOptions): ModeController
 * - `./listen`             createListenBar(options: ModeOptions): ModeController
 */

import type { Locator } from '$lib/types'
import type { ReaderSession } from './types'

export interface PartOptions {
    session: ReaderSession
    /**
     * The overlay layer of the reader screen: a positioned element that covers the whole screen
     * and takes no pointer events itself. A part appends its dialogs, popovers and overlays here.
     */
    host: HTMLElement
}

export interface Part {
    /** Remove all elements, listeners and timers of the part. */
    destroy(): void
}

export type ContentsTab = 'contents' | 'bookmarks' | 'highlights'

export interface ContentsPanel extends Part {
    open(tab?: ContentsTab): void
    close(): void
}

export interface AppearancePanel extends Part {
    open(): void
    close(): void
}

export interface SearchPanel extends Part {
    /** Open the panel. With a query, start that search at once. */
    open(query?: string): void
    close(): void
}

export interface SelectionToolsOptions extends PartOptions {
    /** The user selected "Speed read from here". */
    onSpeedRead(locator: Locator): void
    /** The user selected "Listen from here". */
    onListen(locator: Locator): void
    /** The user selected "Search" for the selected text. */
    onSearch(query: string): void
}

export interface ModeOptions extends PartOptions {
    /**
     * An element in the layout of the screen between the page and the bottom edge. The listen
     * bar goes here, so the page gets smaller and the bar never covers text.
     */
    dock: HTMLElement
    /** The mode ended by itself or the user closed it. The screen shows its bars again. */
    onExit(): void
}

/** The speed reader and the listen bar. Only one mode is active at a time. */
export interface ModeController extends Part {
    /** True from `start` to the end of `stop`. */
    readonly active: boolean
    /**
     * Start the mode at a locator, or at the current position of the session. Sets the session
     * mode. The call comes from a click handler; see the note about speech and user gestures.
     */
    start(locator?: Locator): Promise<void>
    /** Leave the mode, show the page of the last word or sentence, and set the mode to 'read'. */
    stop(): Promise<void>
}
