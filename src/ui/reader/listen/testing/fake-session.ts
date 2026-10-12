/**
 * Test doubles for the listen bar: a reader session with a view that records the marker calls
 * and a content loader that gives chapters from plain text.
 */

import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ChapterContent, TextModel } from '$lib/content'
import type { ReaderView, RelocateInfo } from '$lib/reader/types'
import type { Locator, TextRange } from '$lib/types'
import type { ReaderMode, ReaderSession, ReaderSessionEvents } from '../../types'

export interface FakeChapter {
    text: string
    /** False for a spine item with `linear="no"`. */
    linear?: boolean
    /** Language of the document. The default is the book language. */
    lang?: string | null
}

export interface FakeSessionOptions {
    /** One entry for each spine item. A string is a linear chapter with that text. */
    chapters: (string | FakeChapter)[]
    language?: string | null
    position?: Locator | null
    /** Calls of the view and of the session in sequence, for example 'marker:null'. */
    log?: string[]
}

export type MarkerCall = [range: TextRange | null, options?: { follow?: boolean }]

export interface FakeView extends ReaderView {
    setActiveRange: Mock<ReaderView['setActiveRange']>
}

export interface FakeSession extends ReaderSession {
    view: FakeView
    mode: ReaderMode
    setMode: Mock<ReaderSession['setMode']>
    next: Mock<ReaderSession['next']>
    prev: Mock<ReaderSession['prev']>
    content: ReaderSession['content'] & {
        loadText: Mock<(spineIndex: number) => Promise<TextModel>>
        load: Mock<(spineIndex: number) => Promise<ChapterContent>>
    }
    /** Replaces the view and sends the 'view' event, as a change of the layout mode does. */
    replaceView(): FakeView
    emit<K extends keyof ReaderSessionEvents>(event: K, payload: ReaderSessionEvents[K]): void
    /** Number of listeners of all events. */
    listenerCount(): number
}

/** One block for the full text, as a chapter with one paragraph has. */
export function textModel(text: string): TextModel {
    const start = text.search(/\S/)
    if (start < 0) return { text, blocks: [] }
    return { text, blocks: [{ start, end: text.trimEnd().length, heading: false }] }
}

export function createFakeView(log: string[] = []): FakeView {
    const view = {
        setActiveRange: vi.fn<ReaderView['setActiveRange']>((range) => {
            log.push(
                range ? `marker:${range.spineIndex}:${range.start}-${range.end}` : 'marker:null',
            )
        }),
    }
    return view as unknown as FakeView
}

export function createFakeSession({
    chapters,
    language = 'en',
    position = { spineIndex: 0, offset: 0 },
    log = [],
}: FakeSessionOptions): FakeSession {
    const items = chapters.map((chapter) =>
        typeof chapter === 'string' ? { text: chapter } : chapter,
    )
    const listeners = new Map<string, Set<(payload: never) => void>>()

    function emit<K extends keyof ReaderSessionEvents>(
        event: K,
        payload: ReaderSessionEvents[K],
    ): void {
        for (const listener of [...(listeners.get(event) ?? [])]) {
            ;(listener as (payload: ReaderSessionEvents[K]) => void)(payload)
        }
    }

    const relocate: RelocateInfo | null = position && {
        locator: position,
        visible: { spineIndex: position.spineIndex, start: position.offset, end: position.offset },
        chapterLength: items[position.spineIndex]?.text.length ?? 0,
        page: 1,
        pageCount: 1,
        atBookStart: false,
        atBookEnd: false,
    }

    const session = {
        book: {
            spine: items.map((item, index) => ({
                index,
                idref: `item-${index}`,
                path: `c${index}.xhtml`,
                mediaType: 'application/xhtml+xml',
                linear: item.linear ?? true,
                size: item.text.length,
                properties: [],
            })),
            metadata: { language },
        },
        content: {
            loadText: vi.fn(async (spineIndex: number) => {
                const item = items[spineIndex]
                if (!item) throw new RangeError(`The book has no spine item ${spineIndex}.`)
                return textModel(item.text)
            }),
            load: vi.fn(async (spineIndex: number) => {
                const item = items[spineIndex]
                if (!item) throw new RangeError(`The book has no spine item ${spineIndex}.`)
                const lang = item.lang === undefined ? language : item.lang
                return { spineIndex, lang } as ChapterContent
            }),
        },
        view: createFakeView(log),
        position: relocate,
        mode: 'read' as ReaderMode,
        setMode: vi.fn((mode: ReaderMode) => {
            log.push(`mode:${mode}`)
            if (session.mode === mode) return
            session.mode = mode
            emit('mode', mode)
        }),
        next: vi.fn(async () => true),
        prev: vi.fn(async () => true),
        on(event: string, listener: (payload: never) => void) {
            let set = listeners.get(event)
            if (!set) listeners.set(event, (set = new Set()))
            set.add(listener)
            return () => {
                set.delete(listener)
            }
        },
        replaceView() {
            session.view = createFakeView(log)
            emit('view', session.view)
            return session.view
        },
        emit,
        listenerCount() {
            let count = 0
            for (const set of listeners.values()) count += set.size
            return count
        },
    }
    return session as unknown as FakeSession
}
