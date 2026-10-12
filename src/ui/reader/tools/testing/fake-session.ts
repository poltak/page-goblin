/**
 * Test helpers for the reader tools: a reader session that emits events and records calls,
 * and a record of the listeners on the document and the window.
 */

import { vi } from 'vitest'
import type { RelocateInfo } from '$lib/reader/types'
import type { HighlightRecord } from '$lib/storage/types'
import { createEmitter } from '../../session/emitter'
import type { NewHighlight, ReaderSession, ReaderSessionEvents } from '../../types'

export function makeHighlight(changes: Partial<HighlightRecord> = {}): HighlightRecord {
    return {
        id: 'h1',
        bookId: 'book-1',
        spineIndex: 2,
        start: 10,
        end: 25,
        text: 'the white whale',
        color: 'yellow',
        note: '',
        chapterTitle: 'Chapter One',
        fraction: 0.2,
        createdAt: 1,
        updatedAt: 1,
        ...changes,
    }
}

export function makeRelocate(offset: number): RelocateInfo {
    return {
        locator: { spineIndex: 2, offset },
        visible: { spineIndex: 2, start: offset, end: offset + 500 },
        chapterLength: 5000,
        page: null,
        pageCount: null,
        atBookStart: false,
        atBookEnd: false,
    }
}

export type FakeSession = ReturnType<typeof createFakeSession>

export function createFakeSession(initial: readonly HighlightRecord[] = []) {
    const emitter = createEmitter<ReaderSessionEvents>((error) => {
        throw error
    })
    let highlights = [...initial]
    let listeners = 0
    let nextId = 1
    let position: RelocateInfo | null = makeRelocate(0)

    function setHighlights(next: HighlightRecord[]): void {
        highlights = next
        emitter.emit('highlights', next)
    }

    const state = {
        /** True makes the annotation methods reject, as when storage does not write. */
        failWrites: false,
    }

    function write(): void {
        if (state.failWrites) throw new Error('storage did not write')
    }

    const clearSelection = vi.fn()

    const addHighlight = vi.fn(async (highlight: NewHighlight): Promise<HighlightRecord> => {
        write()
        const record = makeHighlight({
            id: `new-${nextId++}`,
            spineIndex: highlight.range.spineIndex,
            start: highlight.range.start,
            end: highlight.range.end,
            text: highlight.text,
            color: highlight.color,
            note: highlight.note ?? '',
        })
        setHighlights([...highlights, record])
        clearSelection()
        return record
    })

    const updateHighlight = vi.fn(
        async (id: string, patch: { color?: HighlightRecord['color']; note?: string }) => {
            write()
            setHighlights(highlights.map((item) => (item.id === id ? { ...item, ...patch } : item)))
        },
    )

    const removeHighlight = vi.fn(async (id: string) => {
        write()
        setHighlights(highlights.filter((item) => item.id !== id))
    })

    const loadNote = vi.fn<ReaderSession['loadNote']>(async () => null)
    const followLink = vi.fn<ReaderSession['followLink']>(async () => {})
    const spineIndexOf = vi.fn((path: string) => (path === 'OEBPS/notes.xhtml' ? 3 : -1))

    const on: ReaderSession['on'] = (event, listener) => {
        listeners++
        const stop = emitter.on(event, listener)
        let stopped = false
        return () => {
            if (stopped) return
            stopped = true
            listeners--
            stop()
        }
    }

    const session = {
        get highlights() {
            return highlights
        },
        get position() {
            return position
        },
        view: { clearSelection },
        book: { spineIndexOf },
        content: { bookFonts: [] },
        on,
        addHighlight,
        updateHighlight,
        removeHighlight,
        loadNote,
        followLink,
    } as unknown as ReaderSession

    return {
        session,
        state,
        addHighlight,
        updateHighlight,
        removeHighlight,
        loadNote,
        followLink,
        clearSelection,
        spineIndexOf,
        /** The number of session listeners that are not removed. */
        listenerCount: () => listeners,
        emit<K extends keyof ReaderSessionEvents>(event: K, payload: ReaderSessionEvents[K]): void {
            if (event === 'relocate') position = payload as RelocateInfo
            emitter.emit(event, payload)
        },
    }
}

type Options = boolean | AddEventListenerOptions

/**
 * Records `addEventListener` and `removeEventListener` on a target. `active()` gives the
 * event types of the listeners that were added after the call and are not removed.
 */
export function trackListeners(target: EventTarget): { active(): string[]; restore(): void } {
    const added: { key: string; type: string }[] = []
    const ids = new WeakMap<object, number>()
    let nextId = 1

    function keyOf(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: Options,
    ): string {
        const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
        let id = 0
        if (listener) {
            id = ids.get(listener) ?? nextId++
            ids.set(listener, id)
        }
        return `${type}:${id}:${capture}`
    }

    // In the test environment the window has its two functions as own properties.
    const names = ['addEventListener', 'removeEventListener'] as const
    const own = names.map((name) => Object.getOwnPropertyDescriptor(target, name))
    const add = target.addEventListener
    const remove = target.removeEventListener

    target.addEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: Options,
    ): void => {
        added.push({ key: keyOf(type, listener, options), type })
        add.call(target, type, listener, options)
    }
    target.removeEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: Options,
    ): void => {
        const key = keyOf(type, listener, options)
        const index = added.findIndex((item) => item.key === key)
        if (index >= 0) added.splice(index, 1)
        remove.call(target, type, listener, options)
    }

    return {
        active: () => added.map((item) => item.type),
        restore() {
            names.forEach((name, index) => {
                const descriptor = own[index]
                if (descriptor) Object.defineProperty(target, name, descriptor)
                else Reflect.deleteProperty(target, name)
            })
        },
    }
}

/** A rectangle as the reader view gives it. jsdom has no layout, so the values are free. */
export function rect({
    left,
    top,
    width,
    height,
}: {
    left: number
    top: number
    width: number
    height: number
}): DOMRect {
    return new DOMRect(left, top, width, height)
}

/** A pointer event with the given fields. jsdom has the constructor but no pointer device. */
export function pointer(
    type: string,
    init: PointerEventInit & { timeStamp?: number } = {},
): PointerEvent {
    const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        isPrimary: true,
        pointerId: 1,
        button: 0,
        ...init,
    })
    if (init.timeStamp !== undefined) {
        Object.defineProperty(event, 'timeStamp', { value: init.timeStamp })
    }
    return event
}
