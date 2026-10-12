/**
 * Test helpers for the speed reader: a fake reader session with small chapters, fake storage
 * for a real settings store, a fake wake lock and events that jsdom does not make by itself.
 */

import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { TextModel } from '$lib/content'
import type { ScreenWakeLock } from '$lib/pwa/wake-lock'
import { makeChapter } from '$lib/rsvp/testing/chapter'
import type { RsvpSettings, SettingsStorage } from '$lib/settings'
import type { Locator, TextRange } from '$lib/types'
import type { ReaderMode, ReaderSession } from '../../types'

/** Spine indexes of the default test book. */
export const COVER = 0
export const CHAPTER_1 = 1
export const CHAPTER_2 = 2
/** A non-linear spine item. */
export const NOTES = 3
/** An image page: a linear item with no words. */
export const PLATE = 4
export const CHAPTER_3 = 5

/**
 * Chapter 1 has the words Chapter, One, Alpha, beta, gamma., Delta, epsilon, zeta. at the
 * offsets 0, 8, 12, 18, 23, 30, 36 and 44.
 */
export const DEFAULT_CHAPTERS: readonly (readonly string[])[] = [
    [],
    ['# Chapter One', 'Alpha beta gamma. Delta epsilon zeta.'],
    ['Second chapter words here.'],
    ['A note.'],
    [],
    ['The last chapter ends.'],
]

export const DEFAULT_TITLES: readonly string[] = [
    '',
    'Chapter One',
    'Chapter Two',
    'Notes',
    '',
    'Chapter Three',
]

/**
 * Settings that give each word the same time: 100 ms at 600 words for each minute, with no
 * pauses for punctuation, long words or the start of playback.
 */
export const FLAT_RSVP: Partial<RsvpSettings> = {
    wpm: 600,
    contextWords: 2,
    periodMultiplier: 1,
    commaMultiplier: 1,
    semicolonMultiplier: 1,
    exclamationMultiplier: 1,
    paragraphMultiplier: 1,
    headingMultiplier: 1,
    longWordDelay: false,
    rampUp: false,
}

export const WORD_MS = 100

export interface FakeSessionOptions {
    /** The blocks of each spine item. An entry that starts with '# ' is a heading. */
    chapters?: readonly (readonly string[])[]
    titles?: readonly string[]
    /** Spine indexes with linear false. */
    nonLinear?: readonly number[]
    /** The position of the book when the mode starts. */
    position?: Locator
    /**
     * Number of characters on each page of the book. Without it, one page shows the full text
     * of a chapter.
     */
    pageChars?: number
}

export interface FakeSession {
    session: ReaderSession
    /** The calls of goTo and setMode in their order, for example 'goTo 1:18' and 'mode read'. */
    log: string[]
    goTo: Mock<(locator: Locator) => Promise<void>>
    setMode: Mock<(mode: ReaderMode) => void>
    loadText: Mock<(spineIndex: number) => Promise<TextModel>>
    /** The locators of all goTo calls. */
    locators(): Locator[]
    /** Sets the text range that the book shows now. */
    setVisible(range: TextRange): void
}

export function makeFakeSession(options: FakeSessionOptions = {}): FakeSession {
    const chapters = options.chapters ?? DEFAULT_CHAPTERS
    const titles = options.titles ?? DEFAULT_TITLES
    const nonLinear = options.nonLinear ?? [NOTES]
    const models: TextModel[] = chapters.map((blocks) => {
        const { text, blocks: textBlocks } = makeChapter([...blocks])
        return { text, blocks: textBlocks }
    })
    const log: string[] = []
    let mode: ReaderMode = 'read'
    const { pageChars } = options

    /** The page that has a locator. */
    function pageOf({ spineIndex, offset }: Locator): TextRange {
        if (!pageChars) return { spineIndex, start: 0, end: Number.MAX_SAFE_INTEGER }
        const start = Math.floor(offset / pageChars) * pageChars
        return { spineIndex, start, end: start + pageChars }
    }

    /** The session gives the same object until the book moves, as the real session does. */
    let position = at(options.position ?? { spineIndex: COVER, offset: 0 })

    function at(locator: Locator, visible = pageOf(locator)) {
        return { locator, visible }
    }

    const goTo = vi.fn(async (target: Locator) => {
        log.push(`goTo ${target.spineIndex}:${target.offset}`)
        position = at(target)
    })
    const setMode = vi.fn((next: ReaderMode) => {
        log.push(`mode ${next}`)
        mode = next
    })
    const loadText = vi.fn(async (spineIndex: number) => {
        const model = models[spineIndex]
        if (!model) throw new RangeError(`No spine item ${spineIndex}`)
        return model
    })

    const session = {
        record: { title: 'The Test Book' },
        book: {
            spine: chapters.map((_, index) => ({ index, linear: !nonLinear.includes(index) })),
        },
        content: { loadText },
        get mode() {
            return mode
        },
        get position() {
            return position
        },
        setMode,
        goTo,
        /** Each chapter is an equal part of the book. */
        fractionOf: (target: Locator) => {
            const length = models[target.spineIndex]?.text.length ?? 0
            const inChapter = length > 0 ? Math.min(1, target.offset / length) : 0
            return (target.spineIndex + inChapter) / chapters.length
        },
        chapterTitleAt: (target: Locator) => titles[target.spineIndex] ?? '',
    }

    return {
        session: session as unknown as ReaderSession,
        log,
        goTo,
        setMode,
        loadText,
        locators: () => goTo.mock.calls.map(([target]) => target),
        setVisible(range) {
            position = at({ spineIndex: range.spineIndex, offset: range.start }, range)
        },
    }
}

/** A storage object for a real settings store. */
export function fakeStorage(): SettingsStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value)
        },
    }
}

export interface FakeWakeLock extends ScreenWakeLock {
    request: Mock<() => Promise<void>>
    release: Mock<() => Promise<void>>
}

export function fakeWakeLock(): FakeWakeLock {
    return {
        request: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
    }
}

export interface PointerInit {
    button?: number
    pointerId?: number
    pointerType?: string
}

/** A pointer event. Older jsdom versions have no PointerEvent, so a MouseEvent gets the fields. */
export function pointer(type: string, init: PointerInit = {}): Event {
    const { button = 0, pointerId = 1, pointerType = 'touch' } = init
    const base = { bubbles: true, cancelable: true, button }
    if (typeof PointerEvent === 'function') {
        return new PointerEvent(type, { ...base, pointerId, pointerType })
    }
    const event = new MouseEvent(type, base)
    Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: pointerType },
    })
    return event
}

export interface KeyInit {
    key: string
    repeat?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
}

function keyEvent(type: string, init: string | KeyInit): KeyboardEvent {
    const fields = typeof init === 'string' ? { key: init } : init
    return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...fields })
}

/** Sends a keydown event to an element and returns the event. */
export function keyDown(target: EventTarget, init: string | KeyInit): KeyboardEvent {
    const event = keyEvent('keydown', init)
    target.dispatchEvent(event)
    return event
}

/** Sends a keyup event to an element and returns the event. */
export function keyUp(target: EventTarget, init: string | KeyInit): KeyboardEvent {
    const event = keyEvent('keyup', init)
    target.dispatchEvent(event)
    return event
}

function focusWithRing(element: HTMLElement, ring: boolean): void {
    element.focus()
    const matches = Element.prototype.matches
    Object.defineProperty(element, 'matches', {
        configurable: true,
        value: (selector: string) =>
            selector === ':focus-visible' ? ring : matches.call(element, selector),
    })
}

/**
 * Gives an element the focus as the Tab key does. The element then has a focus ring
 * (:focus-visible). jsdom guesses the ring from the events of earlier tests, so the helper
 * sets the answer.
 */
export function focusByKeyboard(element: HTMLElement): void {
    focusWithRing(element, true)
}

/** Gives an element the focus as a press with a pointer does: with no focus ring. */
export function focusByPointer(element: HTMLElement): void {
    focusWithRing(element, false)
}

/** Lets the promises that are ready now run, for example a chapter load. */
export async function flush(rounds = 3): Promise<void> {
    for (let round = 0; round < rounds; round++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
}

/** Sets `document.visibilityState` and sends the event. */
export function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
}
