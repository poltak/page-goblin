/**
 * Test helpers for the reader screen: a session that records calls and lets a test send
 * events, and parts that record how the screen uses them.
 */

import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ContentLoader } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import type { ReaderView, RelocateInfo } from '$lib/reader/types'
import type { BookRecord } from '$lib/storage/types'
import type { Locator } from '$lib/types'
import type {
    AppearancePanel,
    ContentsPanel,
    ModeController,
    ModeOptions,
    Part,
    PartOptions,
    SearchPanel,
    SelectionToolsOptions,
} from '../../parts'
import type { ReaderMode, ReaderSession, ReaderSessionEvents, TocEntry } from '../../types'
import type { PartFactories } from '../screen'
import type { ShortcutsDialog } from '../shortcuts'

export const RECORD: BookRecord = {
    id: 'book-1',
    title: 'The Test Book',
    author: 'An Author',
    language: 'en',
    identifier: null,
    publisher: null,
    description: null,
    published: null,
    subjects: [],
    series: null,
    fileName: 'test.epub',
    fileSize: 3,
    fileHash: 'hash',
    hasCover: false,
    // 1000 characters in total, so a fraction is easy to read as an offset.
    spineStats: [
        { chars: 100, words: 20 },
        { chars: 300, words: 60 },
        { chars: 600, words: 120 },
    ],
    totalChars: 1000,
    totalWords: 200,
    addedAt: 1000,
    lastOpenedAt: null,
}

export function tocEntry(title: string, spineIndex = 1): TocEntry {
    return { title, depth: 0, spineIndex, fragment: null }
}

export function relocateInfo(changes: Partial<RelocateInfo> = {}): RelocateInfo {
    return {
        locator: { spineIndex: 1, offset: 80 },
        visible: { spineIndex: 1, start: 80, end: 140 },
        chapterLength: 300,
        page: 3,
        pageCount: 12,
        atBookStart: false,
        atBookEnd: false,
        ...changes,
    }
}

/** The values that the getters of the fake session give. A test can change them. */
export interface FakeSessionState {
    record: BookRecord
    position: RelocateInfo | null
    mode: ReaderMode
    fraction: number
    canGoBack: boolean
    isBookmarked: boolean
    currentTocEntry: TocEntry | null
    wordsRemaining: { chapter: number; book: number } | null
    /** The title that `chapterTitleAt` gives for a chapter. */
    titles: Record<number, string>
}

type Mocked<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K]
}

export interface FakeSession extends Omit<Mocked<ReaderSession>, 'on'> {
    on: ReaderSession['on']
    state: FakeSessionState
    emit<K extends keyof ReaderSessionEvents>(event: K, payload: ReaderSessionEvents[K]): void
    /**
     * Changes the position and sends 'relocate'. With a locator and no visible range, the
     * visible range starts at the locator.
     */
    relocate(changes?: Partial<RelocateInfo>): void
    listenerCount(): number
}

export function makeFakeSession(changes: Partial<FakeSessionState> = {}): FakeSession {
    const listeners = new Map<string, Set<(payload: never) => void>>()
    const state: FakeSessionState = {
        record: RECORD,
        position: relocateInfo(),
        mode: 'read',
        fraction: 0.34,
        canGoBack: false,
        isBookmarked: false,
        currentTocEntry: tocEntry('Chapter One'),
        wordsRemaining: { chapter: 1300, book: 5000 },
        titles: { 0: 'Cover', 1: 'Chapter One', 2: 'Chapter Two' },
        ...changes,
    }

    function emit<K extends keyof ReaderSessionEvents>(
        event: K,
        payload: ReaderSessionEvents[K],
    ): void {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(payload as never)
    }

    const session: FakeSession = {
        state,
        emit,
        relocate(info = {}) {
            const { locator } = info
            // A page turn shows other text, so the visible text moves with the position.
            const visible = locator && {
                spineIndex: locator.spineIndex,
                start: locator.offset,
                end: locator.offset + 60,
            }
            state.position = relocateInfo({
                ...state.position,
                ...(visible ? { visible } : {}),
                ...info,
            })
            emit('relocate', state.position)
        },
        listenerCount() {
            let count = 0
            for (const set of listeners.values()) count += set.size
            return count
        },

        get record() {
            return state.record
        },
        book: {} as EpubBook,
        content: {} as ContentLoader,
        toc: [],
        view: {} as ReaderView,
        bookmarks: [],
        highlights: [],
        get position() {
            return state.position
        },
        get mode() {
            return state.mode
        },
        get fraction() {
            return state.fraction
        },
        get canGoBack() {
            return state.canGoBack
        },
        get isBookmarked() {
            return state.isBookmarked
        },
        get currentTocEntry() {
            return state.currentTocEntry
        },
        get wordsRemaining() {
            return state.wordsRemaining
        },

        on(event, listener) {
            let set = listeners.get(event)
            if (!set) listeners.set(event, (set = new Set()))
            const entry = listener as (payload: never) => void
            set.add(entry)
            return () => {
                set.delete(entry)
            }
        },
        setMode: vi.fn((mode: ReaderMode) => {
            if (state.mode === mode) return
            state.mode = mode
            emit('mode', mode)
        }),
        next: vi.fn(async () => true),
        prev: vi.fn(async () => true),
        goTo: vi.fn(async () => {}),
        goToTocEntry: vi.fn(async () => {}),
        goToFraction: vi.fn(async () => {}),
        followLink: vi.fn(async () => {}),
        back: vi.fn(async () => {}),
        fractionOf: vi.fn(() => 0),
        chapterTitleAt: vi.fn((locator: Locator) => state.titles[locator.spineIndex] ?? ''),
        toggleBookmark: vi.fn(async () => {
            state.isBookmarked = !state.isBookmarked
            emit('bookmarks', [])
        }),
        removeBookmark: vi.fn(async () => {}),
        addHighlight: vi.fn(async () => {
            throw new Error('The fake session has no highlights.')
        }),
        updateHighlight: vi.fn(async () => {}),
        removeHighlight: vi.fn(async () => {}),
        reloadAnnotations: vi.fn(async () => {}),
        search: vi.fn(async () => {}),
        clearSearch: vi.fn(),
        loadNote: vi.fn(async () => null),
        saveProgress: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
    }
    return session
}

export interface FakeMode extends ModeController {
    active: boolean
    start: Mock<ModeController['start']>
    stop: Mock<ModeController['stop']>
    destroy: Mock<() => void>
    options: ModeOptions
}

export interface FakeParts {
    factories: { [K in keyof PartFactories]: Mock<PartFactories[K]> }
    /** The parts that the screen made, by name. */
    made: {
        contents?: Mocked<ContentsPanel>
        appearance?: Mocked<AppearancePanel>
        search?: Mocked<SearchPanel>
        selection?: Mocked<Part> & { options: SelectionToolsOptions }
        notePopover?: Mocked<Part>
        imageViewer?: Mocked<Part>
        speed?: FakeMode
        listen?: FakeMode
        shortcuts?: Mocked<ShortcutsDialog>
    }
    /** The options that each factory got at its last call. */
    options: Partial<Record<keyof PartFactories, PartOptions | { host: HTMLElement }>>
}

function fakeMode(session: FakeSession, mode: ReaderMode, options: ModeOptions): FakeMode {
    const controller: FakeMode = {
        active: false,
        options,
        start: vi.fn(async () => {
            controller.active = true
            session.setMode(mode)
        }),
        stop: vi.fn(async () => {
            controller.active = false
            session.setMode('read')
            options.onExit()
        }),
        destroy: vi.fn(),
    }
    return controller
}

/** Parts that record their calls. A mode sets the mode of the session as a real mode does. */
export function makeFakeParts(session: FakeSession): FakeParts {
    const made: FakeParts['made'] = {}
    const options: FakeParts['options'] = {}
    const panel = () => ({ open: vi.fn(), close: vi.fn(), destroy: vi.fn() })

    const factories: FakeParts['factories'] = {
        contents: vi.fn(async (given) => {
            options.contents = given
            return (made.contents = panel())
        }),
        appearance: vi.fn(async (given) => {
            options.appearance = given
            return (made.appearance = panel())
        }),
        search: vi.fn(async (given) => {
            options.search = given
            return (made.search = panel())
        }),
        selection: vi.fn(async (given) => {
            options.selection = given
            return (made.selection = { destroy: vi.fn(), options: given })
        }),
        notePopover: vi.fn(async (given) => {
            options.notePopover = given
            return (made.notePopover = { destroy: vi.fn() })
        }),
        imageViewer: vi.fn(async (given) => {
            options.imageViewer = given
            return (made.imageViewer = { destroy: vi.fn() })
        }),
        speed: vi.fn(async (given) => {
            options.speed = given
            return (made.speed = fakeMode(session, 'speed', given))
        }),
        listen: vi.fn(async (given) => {
            options.listen = given
            return (made.listen = fakeMode(session, 'listen', given))
        }),
        shortcuts: vi.fn(async (given) => {
            options.shortcuts = given
            return (made.shortcuts = { open: vi.fn(), destroy: vi.fn() })
        }),
    }
    return { factories, made, options }
}
