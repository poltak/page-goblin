import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeTimer } from '$lib/rsvp/testing/fake-timer'
import type { FakeTimer } from '$lib/rsvp/testing/fake-timer'
import { DEFAULT_SETTINGS, RSVP_WPM_MAX, RSVP_WPM_MIN, createSettingsStore } from '$lib/settings'
import type { OwnedSettingsStore, RsvpSettings } from '$lib/settings'
import type { Locator } from '$lib/types'
import { installOverlayMethods } from '../../app/testing/page'
import type { ModeController } from '../parts'
import { EXIT_WAIT_MS, NOTICE_MS, SYNC_TICKS, TICK_MS, createSpeedController } from './controller'
import { HOLD_DELAY_MS, HOLD_INTERVAL_MS } from './hold-repeat'
import { TAP_MAX_MS } from './stage-gesture'
import {
    CHAPTER_1,
    CHAPTER_2,
    CHAPTER_3,
    COVER,
    FLAT_RSVP,
    NOTES,
    WORD_MS,
    fakeStorage,
    fakeWakeLock,
    flush,
    focusByKeyboard,
    focusByPointer,
    keyDown,
    keyUp,
    makeFakeSession,
    pointer,
    setVisibility,
} from './testing/fixtures'
import type { FakeSession, FakeSessionOptions, FakeWakeLock } from './testing/fixtures'

/** Offsets of the words of chapter 1 in the default test book. */
const ALPHA: Locator = { spineIndex: CHAPTER_1, offset: 12 }
const BETA: Locator = { spineIndex: CHAPTER_1, offset: 18 }
const GAMMA: Locator = { spineIndex: CHAPTER_1, offset: 23 }
const DELTA: Locator = { spineIndex: CHAPTER_1, offset: 30 }
const ZETA: Locator = { spineIndex: CHAPTER_1, offset: 44 }
/** The last word of the book: 'ends.' in 'The last chapter ends.'. */
const BOOK_END: Locator = { spineIndex: CHAPTER_3, offset: 17 }

/** The time of one rewind step at 600 words for each minute. */
const REWIND_MS = 75

/** One chapter with the words w0 to w299. */
const LONG_BOOK = [[Array.from({ length: 300 }, (_, index) => `w${index}`).join(' ')]]

interface RigOptions extends FakeSessionOptions {
    rsvp?: Partial<RsvpSettings>
    keepAwake?: boolean
    measure?(text: string): number
}

interface Rig {
    speed: ModeController
    book: FakeSession
    timer: FakeTimer
    settings: OwnedSettingsStore
    host: HTMLElement
    wakeLock: FakeWakeLock
    createWakeLock: ReturnType<typeof vi.fn>
    onExit: ReturnType<typeof vi.fn>
    root(): HTMLElement
    find<T extends HTMLElement = HTMLElement>(selector: string): T
    text(selector: string): string
    word(): string
    status(): string | undefined
}

const rigs: Rig[] = []
const stubs: [object, string][] = []

/** jsdom has no full screen. A test adds the members that it needs. */
function define(target: object, members: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(members)) {
        Object.defineProperty(target, name, { configurable: true, writable: true, value })
        stubs.push([target, name])
    }
}

/** The standard full screen members. The full screen element changes with the two calls. */
function stubFullscreen() {
    let current: Element | null = null
    const request = vi.fn(function (this: Element) {
        current = this
        return Promise.resolve()
    })
    const exit = vi.fn(() => {
        current = null
        return Promise.resolve()
    })
    define(HTMLElement.prototype, { requestFullscreen: request })
    define(document, { exitFullscreen: exit })
    Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => current,
    })
    stubs.push([document, 'fullscreenElement'])
    return { request, exit }
}

function setup(options: RigOptions = {}): Rig {
    installOverlayMethods()
    const book = makeFakeSession(options)
    const timer = createFakeTimer()
    const settings = createSettingsStore({ storage: fakeStorage() })
    settings.update({
        keepAwake: options.keepAwake ?? true,
        rsvp: { ...FLAT_RSVP, ...options.rsvp },
    })
    const host = document.createElement('div')
    document.body.append(host)
    const wakeLock = fakeWakeLock()
    const createWakeLock = vi.fn(() => wakeLock)
    const onExit = vi.fn(() => {
        book.log.push('exit')
    })

    const speed = createSpeedController(
        { session: book.session, host, dock: document.createElement('div'), onExit },
        {
            settings,
            createWakeLock,
            timer,
            measure: options.measure ?? ((text) => text.length * 0.5),
        },
    )

    function find<T extends HTMLElement = HTMLElement>(selector: string): T {
        const element = host.querySelector<T>(selector)
        if (!element) throw new Error(`No element matches "${selector}"`)
        return element
    }

    const rig: Rig = {
        speed,
        book,
        timer,
        settings,
        host,
        wakeLock,
        createWakeLock,
        onExit,
        root: () => find('.speed'),
        find,
        text: (selector) => find(selector).textContent ?? '',
        word: () => find('.speed-word').textContent ?? '',
        status: () => find('.speed').dataset.status,
    }
    rigs.push(rig)
    return rig
}

/** A rig with the overlay open at a locator. The book shows the page of that locator. */
async function started(locator: Locator, options: RigOptions = {}): Promise<Rig> {
    const rig = setup({ position: locator, ...options })
    await rig.speed.start(locator)
    return rig
}

/** Moves the focus to an element as the Tab key does. */
function tabTo(element: HTMLElement): void {
    keyDown(document.activeElement ?? document.body, 'Tab')
    element.focus()
}

/** Plays word by word and returns each word that comes on screen. */
function playWords(rig: Rig, count: number): string[] {
    const words: string[] = []
    for (let index = 0; index < count; index++) {
        rig.timer.advance(WORD_MS)
        words.push(rig.word())
    }
    return words
}

afterEach(() => {
    for (const rig of rigs.splice(0)) {
        rig.speed.destroy()
        rig.settings.destroy()
    }
    for (const [target, name] of stubs.splice(0)) {
        delete (target as Record<string, unknown>)[name]
    }
    setVisibility('visible')
    document.body.innerHTML = ''
})

describe('start', () => {
    it('shows the word at the locator and stays paused', async () => {
        const rig = setup({ position: { spineIndex: CHAPTER_1, offset: 0 } })
        expect(rig.speed.active).toBe(false)
        // The offset 19 is inside 'beta'.
        await rig.speed.start({ spineIndex: CHAPTER_1, offset: 19 })

        expect(rig.speed.active).toBe(true)
        expect(rig.book.setMode).toHaveBeenCalledWith('speed')
        expect(rig.root().parentElement).toBe(rig.host)
        expect(rig.word()).toBe('beta')
        expect(rig.status()).toBe('paused')
        expect(rig.find('.speed-play').getAttribute('aria-label')).toBe('Play')

        rig.timer.advance(60_000)
        expect(rig.word()).toBe('beta')
        expect(rig.timer.pending()).toEqual([])
        expect(rig.book.goTo).not.toHaveBeenCalled()
    })

    it('takes the first word whose end is above the offset', async () => {
        // The offset 22 is the end of 'beta', so the word is 'gamma.'.
        const rig = await started({ spineIndex: CHAPTER_1, offset: 22 })
        expect(rig.word()).toBe('gamma.')
    })

    it('starts at the position of the session when it gets no locator', async () => {
        const rig = setup({ position: DELTA })
        await rig.speed.start()
        expect(rig.word()).toBe('Delta')
    })

    it('goes to the next chapter with words when the chapter has none', async () => {
        const rig = await started({ spineIndex: COVER, offset: 0 })
        expect(rig.word()).toBe('Chapter')
        expect(rig.text('.speed-title')).toBe('Chapter One')
        expect(rig.status()).toBe('paused')
    })

    it('reads an item that is not linear when the user starts in it', async () => {
        const rig = await started({ spineIndex: NOTES, offset: 0 })
        expect(rig.word()).toBe('A')
    })

    it('shows a message when no text follows', async () => {
        const rig = await started({ spineIndex: 1, offset: 0 }, { chapters: [['One.'], []] })
        expect(rig.word()).toBe('')
        expect(rig.text('.speed-notice')).toBe('No text from here to the end of the book.')
        // The keys and buttons do nothing and do not throw.
        rig.find('.speed-play').click()
        keyDown(document.body, 'ArrowRight')
        expect(rig.timer.pending()).toEqual([])
    })

    it('shows a message when the chapter does not load', async () => {
        const rig = setup()
        rig.book.loadText.mockRejectedValueOnce(new Error('broken'))
        await rig.speed.start(ALPHA)
        expect(rig.text('.speed-notice')).toBe('The chapter did not load.')
        expect(rig.speed.active).toBe(true)
    })

    it('has the controls of the overlay with their names', async () => {
        const rig = await started(BETA)
        expect(rig.text('.speed-done').trim()).toBe('Back to the book')
        expect(rig.find('.speed-settings').getAttribute('aria-label')).toBe('Speed reader settings')
        expect(rig.find('.speed-rewind').getAttribute('aria-label')).toBe('Rewind')
        expect(rig.find('.speed-previous').getAttribute('aria-label')).toBe('Previous sentence')
        expect(rig.find('.speed-next').getAttribute('aria-label')).toBe('Next sentence')
        expect(rig.text('.speed-rate output')).toBe('600 wpm')

        const stage = rig.find('.speed-stage')
        expect(stage.getAttribute('role')).toBe('button')
        expect(stage.getAttribute('aria-label')).toBe('Play or pause')
        expect(stage.tabIndex).toBe(0)
        // A screen reader must not read each word.
        expect(rig.find('.speed-word').getAttribute('aria-live')).toBe('off')
        expect(rig.find('.speed-context-before').getAttribute('aria-hidden')).toBe('true')
    })

    it('puts the focus on the play button', async () => {
        const rig = await started(BETA)
        expect(document.activeElement).toBe(rig.find('.speed-play'))
    })

    it('stays paused when the user pushed play before the chapter was ready', async () => {
        const rig = setup({ rsvp: { pauseAtChapterStart: false } })
        const starting = rig.speed.start(DELTA)
        rig.find('.speed-play').click()
        await starting
        expect(rig.word()).toBe('Delta')
        expect(rig.status()).toBe('paused')

        // That push must not start the playback at a later chapter change.
        keyDown(document.body, 'ArrowRight')
        await flush()
        expect(rig.word()).toBe('Second')
        expect(rig.status()).toBe('paused')
        expect(rig.timer.pending()).toEqual([NOTICE_MS])
    })
})

describe('the word', () => {
    it('writes the word in three parts around the pivot letter', async () => {
        const rig = await started(BETA)
        const parts = () => [
            rig.text('.speed-word-before'),
            rig.text('.speed-word-pivot'),
            rig.text('.speed-word-after'),
        ]
        expect(parts()).toEqual(['b', 'e', 'ta'])

        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        expect(parts()).toEqual(['g', 'a', 'mma.'])
        rig.timer.advance(WORD_MS * 2)
        expect(parts()).toEqual(['ep', 's', 'ilon'])
    })

    it('keeps the same Text nodes for each word', async () => {
        const rig = await started(BETA)
        const node = rig.find('.speed-word-pivot').firstChild
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS * 3)
        expect(rig.find('.speed-word-pivot').firstChild).toBe(node)
        expect(rig.find('.speed-word').childNodes).toHaveLength(3)
    })

    it('marks the overlay when the pivot highlight is off', async () => {
        const rig = await started(BETA)
        expect(rig.root().dataset.pivot).toBe('on')
        rig.settings.update({ rsvp: { showPivot: false } })
        expect(rig.root().dataset.pivot).toBe('off')
        expect(rig.word()).toBe('beta')
    })

    it('sets the size of the word from the settings', async () => {
        const rig = await started(BETA, { rsvp: { fontSize: 64 } })
        expect(rig.root().style.getPropertyValue('--speed-word-size')).toBe('64px')
        rig.settings.update({ rsvp: { fontSize: 30 } })
        expect(rig.root().style.getPropertyValue('--speed-word-size')).toBe('30px')
    })

    it('shows the context words on each side', async () => {
        const rig = await started(BETA)
        expect(rig.text('.speed-context-before')).toBe('One Alpha')
        expect(rig.text('.speed-context-after')).toBe('gamma. Delta')

        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        expect(rig.text('.speed-context-before')).toBe('Alpha beta')
        expect(rig.text('.speed-context-after')).toBe('Delta epsilon')
    })

    it('has no context before the first word and after the last word', async () => {
        const first = await started({ spineIndex: CHAPTER_1, offset: 0 })
        expect(first.text('.speed-context-before')).toBe('')
        expect(first.text('.speed-context-after')).toBe('One Alpha')

        const last = await started(ZETA)
        expect(last.text('.speed-context-before')).toBe('Delta epsilon')
        expect(last.text('.speed-context-after')).toBe('')
    })

    it('hides the context lines for 0 context words', async () => {
        const rig = await started(BETA, { rsvp: { contextWords: 0 } })
        expect(rig.find('.speed-context-before').hidden).toBe(true)
        expect(rig.find('.speed-context-after').hidden).toBe(true)
        expect(rig.text('.speed-context-before')).toBe('')

        rig.settings.update({ rsvp: { contextWords: 1 } })
        expect(rig.find('.speed-context-before').hidden).toBe(false)
        expect(rig.text('.speed-context-before')).toBe('Alpha')
        expect(rig.text('.speed-context-after')).toBe('gamma.')

        rig.settings.update({ rsvp: { contextWords: 0 } })
        expect(rig.find('.speed-context-after').hidden).toBe(true)
        expect(rig.text('.speed-context-after')).toBe('')
    })

    it('makes a long word smaller with a transform, from the measured width', async () => {
        const measure = vi.fn((text: string) => text.length * 0.6)
        const long = 'Pneumonoultramicroscopicsilicovolcanoconiosis'
        const rig = await started(
            { spineIndex: 0, offset: 0 },
            { chapters: [[`${long} is long`]], measure, rsvp: { fontSize: 48 } },
        )
        // jsdom has a window of 1024 px, so the word line is 720 - 32 = 688 px wide. The 41
        // characters from the pivot letter are 41 * 0.6 * 48 = 1180.8 px. The room on the
        // right is 688 * 0.62 * 0.96 = 409.5 px.
        const word = rig.find('.speed-word')
        expect(rig.word()).toBe(long)
        expect(word.style.transform).toBe('scale(0.346)')
        expect(measure).toHaveBeenCalledWith('Pneu')

        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        expect(rig.word()).toBe('is')
        expect(word.style.transform).toBe('')

        // A smaller font makes the same word fit better, with no new measurement.
        const calls = measure.mock.calls.length
        keyDown(document.body, 'ArrowLeft')
        rig.settings.update({ rsvp: { fontSize: 24 } })
        expect(rig.word()).toBe(long)
        expect(word.style.transform).toBe('scale(0.693)')
        expect(measure).toHaveBeenCalledTimes(calls)
    })
})

describe('playback', () => {
    it('shows the words in order after the user pushes play', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        expect(rig.status()).toBe('playing')
        expect(rig.find('.speed-play').getAttribute('aria-label')).toBe('Pause')
        expect(rig.find('.speed-play use').getAttribute('href')).toBe('#i-pause')
        expect(playWords(rig, 4)).toEqual(['gamma.', 'Delta', 'epsilon', 'zeta.'])
    })

    it('pauses with the same button', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        rig.find('.speed-play').click()

        expect(rig.status()).toBe('paused')
        expect(rig.find('.speed-play').getAttribute('aria-label')).toBe('Play')
        expect(rig.find('.speed-play use').getAttribute('href')).toBe('#i-play')
        rig.timer.advance(10_000)
        expect(rig.word()).toBe('gamma.')
    })

    it('shows the chapter progress, the time left and the book percent', async () => {
        const rig = await started(BETA)
        // 'beta' is word 4 of 8. The fake book gives each of its 6 chapters an equal part.
        expect(rig.find('.speed-progress').style.getPropertyValue('--value')).toBe('0.4286')
        expect(rig.find('.speed-progress').getAttribute('aria-valuenow')).toBe('43')
        expect(rig.text('.speed-status')).toBe('Chapter: 1 min left · Book: 22%')
        expect(rig.text('.speed-title')).toBe('Chapter One')
    })

    it('uses the book title when the position has no chapter title', async () => {
        const rig = await started(BETA, { titles: [] })
        expect(rig.text('.speed-title')).toBe('The Test Book')
    })

    it('updates the status line one time each second during playback', async () => {
        // Each word has 150 ms, so no word change is at the same time as an update.
        const rig = await started(
            { spineIndex: 0, offset: 0 },
            { chapters: LONG_BOOK, rsvp: { wpm: 400 } },
        )
        const progress = () => rig.find('.speed-progress').style.getPropertyValue('--value')
        expect(progress()).toBe('0.0000')

        rig.find('.speed-play').click()
        rig.timer.advance(TICK_MS - 1)
        expect(rig.word()).toBe('w6')
        expect(progress()).toBe('0.0000')

        rig.timer.advance(1)
        expect(progress()).toBe((6 / 299).toFixed(4))
        rig.timer.advance(TICK_MS)
        expect(progress()).toBe((13 / 299).toFixed(4))
    })

    it('updates the status line at once when the speed changes', async () => {
        const rig = await started({ spineIndex: 0, offset: 0 }, { chapters: LONG_BOOK })
        expect(rig.text('.speed-status')).toBe('Chapter: 1 min left · Book: 0%')
        rig.settings.update({ rsvp: { wpm: 100 } })
        expect(rig.text('.speed-status')).toBe('Chapter: 3 min left · Book: 0%')
    })

    it('uses the new speed from the next word', async () => {
        const rig = await started({ spineIndex: 0, offset: 0 }, { chapters: LONG_BOOK })
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        expect(rig.word()).toBe('w1')

        rig.settings.update({ rsvp: { wpm: 300 } })
        // The word on screen keeps its time. Each word after it has 200 ms.
        rig.timer.advance(WORD_MS)
        expect(rig.word()).toBe('w2')
        rig.timer.advance(199)
        expect(rig.word()).toBe('w2')
        rig.timer.advance(1)
        expect(rig.word()).toBe('w3')
    })
})

describe('the end of a chapter', () => {
    it('stays paused on the first word of the next chapter and shows its title', async () => {
        const rig = await started(ZETA, { rsvp: { pauseAtChapterStart: true } })
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()

        expect(rig.word()).toBe('Second')
        expect(rig.status()).toBe('paused')
        expect(rig.text('.speed-notice')).toBe('Chapter Two')
        expect(rig.find('.speed-notice').classList.contains('is-shown')).toBe(true)
        expect(rig.text('.speed-title')).toBe('Chapter Two')
        // The book follows to the new chapter.
        expect(rig.book.locators()).toEqual([{ spineIndex: CHAPTER_2, offset: 0 }])

        rig.timer.advance(NOTICE_MS - 1)
        expect(rig.text('.speed-notice')).toBe('Chapter Two')
        rig.timer.advance(1)
        expect(rig.text('.speed-notice')).toBe('')
        expect(rig.find('.speed-notice').classList.contains('is-shown')).toBe(false)
        expect(rig.word()).toBe('Second')
    })

    it('removes the chapter title when the user pushes play', async () => {
        const rig = await started(ZETA, { rsvp: { pauseAtChapterStart: true } })
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()

        rig.find('.speed-play').click()
        expect(rig.text('.speed-notice')).toBe('')
        expect(playWords(rig, 2)).toEqual(['chapter', 'words'])
    })

    it('continues to play in the next chapter when the pause is off', async () => {
        const rig = await started(ZETA, { rsvp: { pauseAtChapterStart: false } })
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()

        expect(rig.word()).toBe('Second')
        expect(rig.status()).toBe('playing')
        expect(rig.text('.speed-notice')).toBe('')
        expect(rig.book.locators()).toEqual([{ spineIndex: CHAPTER_2, offset: 0 }])
        expect(playWords(rig, 3)).toEqual(['chapter', 'words', 'here.'])
    })

    it('goes past an item that is not linear and a chapter with no words', async () => {
        const rig = await started(
            { spineIndex: CHAPTER_2, offset: 21 },
            { rsvp: { pauseAtChapterStart: false } },
        )
        expect(rig.word()).toBe('here.')
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()

        expect(rig.word()).toBe('The')
        expect(rig.text('.speed-title')).toBe('Chapter Three')
        expect(rig.book.locators()).toEqual([{ spineIndex: CHAPTER_3, offset: 0 }])
        expect(playWords(rig, 1)).toEqual(['last'])
    })

    it('loads the next chapter one time when the user pushes play during the load', async () => {
        const rig = await started(ZETA, { rsvp: { pauseAtChapterStart: true } })
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        // The chapter end came, and the load is not complete yet.
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()

        const loads = rig.book.loadText.mock.calls.filter(([index]) => index === CHAPTER_2)
        expect(loads).toHaveLength(1)
        expect(rig.word()).toBe('Second')
    })

    it('shows a message when the next chapter does not load', async () => {
        const rig = await started(ZETA)
        rig.book.loadText.mockRejectedValueOnce(new Error('broken'))
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()

        expect(rig.text('.speed-notice')).toBe('The next chapter did not load.')
        expect(rig.word()).toBe('zeta.')
        expect(rig.status()).toBe('paused')
        expect(rig.book.locators()).toEqual([ZETA])
    })
})

describe('the end of the book', () => {
    it('pauses on the last word and shows "End of the book"', async () => {
        const rig = await started(BOOK_END, { rsvp: { pauseAtChapterStart: false } })
        expect(rig.word()).toBe('ends.')
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()

        expect(rig.status()).toBe('paused')
        expect(rig.word()).toBe('ends.')
        expect(rig.text('.speed-notice')).toBe('End of the book')
        expect(rig.text('.speed-status')).toBe('Chapter: 0 min left · Book: 100%')
        expect(rig.book.locators()).toEqual([BOOK_END])
        expect(rig.timer.pending()).toEqual([])
        expect(rig.wakeLock.release).toHaveBeenCalled()
    })

    it('keeps the message until the reader goes back', async () => {
        const rig = await started(BOOK_END)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()
        rig.timer.advance(NOTICE_MS * 2)
        expect(rig.text('.speed-notice')).toBe('End of the book')

        keyDown(document.body, 'ArrowLeft')
        expect(rig.word()).toBe('The')
        expect(rig.text('.speed-notice')).toBe('')
        expect(rig.text('.speed-status')).not.toContain('100%')
    })

    it('shows the message again when the user pushes play on the last word', async () => {
        const rig = await started(BOOK_END)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()

        rig.find('.speed-play').click()
        expect(rig.text('.speed-notice')).toBe('')
        rig.timer.advance(WORD_MS)
        await flush()
        expect(rig.text('.speed-notice')).toBe('End of the book')
        expect(rig.status()).toBe('paused')
    })
})

describe('the position of the book below the overlay', () => {
    it('follows when playback pauses', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS * 2)
        expect(rig.book.goTo).not.toHaveBeenCalled()

        rig.find('.speed-play').click()
        expect(rig.book.locators()).toEqual([DELTA])
    })

    it('follows each 10 seconds during playback, and not on each word', async () => {
        const rig = await started(
            { spineIndex: 0, offset: 0 },
            { chapters: LONG_BOOK, rsvp: { wpm: 400 } },
        )
        const period = TICK_MS * SYNC_TICKS
        expect(period).toBe(10_000)

        rig.find('.speed-play').click()
        rig.timer.advance(period - 1)
        expect(rig.book.goTo).not.toHaveBeenCalled()

        // 66 words of 150 ms are complete after 10 seconds. 'w66' starts at offset 254.
        rig.timer.advance(1)
        expect(rig.word()).toBe('w66')
        expect(rig.book.locators()).toEqual([{ spineIndex: 0, offset: 254 }])

        rig.timer.advance(period)
        expect(rig.word()).toBe('w133')
        expect(rig.book.goTo).toHaveBeenCalledTimes(2)
        expect(rig.book.locators()[1]).toEqual({ spineIndex: 0, offset: 10 * 3 + 90 * 4 + 33 * 5 })
    })

    it('starts the 10 seconds again after a pause', async () => {
        const rig = await started({ spineIndex: 0, offset: 0 }, { chapters: LONG_BOOK })
        rig.find('.speed-play').click()
        rig.timer.advance(6000)
        rig.find('.speed-play').click()
        expect(rig.book.goTo).toHaveBeenCalledTimes(1)

        rig.find('.speed-play').click()
        rig.timer.advance(6000)
        expect(rig.book.goTo).toHaveBeenCalledTimes(1)
        rig.timer.advance(4000)
        expect(rig.book.goTo).toHaveBeenCalledTimes(2)
    })

    it('does not move the book two times to the same word', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        rig.find('.speed-play').click()
        setVisibility('hidden')
        expect(rig.book.locators()).toEqual([GAMMA])
    })

    it('does not follow a sentence step during a pause, until the page is hidden', async () => {
        const rig = await started(BETA)
        keyDown(document.body, 'ArrowRight')
        expect(rig.word()).toBe('Delta')
        expect(rig.book.goTo).not.toHaveBeenCalled()

        setVisibility('hidden')
        expect(rig.book.locators()).toEqual([DELTA])
    })

    // With 20 characters on each page, the pages of chapter 1 start at 'Chapter', 'gamma.'
    // and 'zeta.'.
    it('turns the page when the word leaves the page during playback', async () => {
        const rig = await started(ALPHA, { pageChars: 20 })
        rig.find('.speed-play').click()
        expect(playWords(rig, 1)).toEqual(['beta'])
        expect(rig.book.goTo).not.toHaveBeenCalled()

        expect(playWords(rig, 1)).toEqual(['gamma.'])
        expect(rig.book.locators()).toEqual([GAMMA])

        expect(playWords(rig, 3)).toEqual(['Delta', 'epsilon', 'zeta.'])
        expect(rig.book.locators()).toEqual([GAMMA, ZETA])
        // The reader can leave the book at each moment. The page of the word is then saved.
        expect(rig.book.session.position?.visible).toMatchObject({ start: 40, end: 60 })
    })

    it('turns the page for a sentence step and a rewind that leave the page', async () => {
        const rig = await started(BETA, { pageChars: 20 })
        keyDown(document.body, 'ArrowRight')
        expect(rig.word()).toBe('Delta')
        expect(rig.book.locators()).toEqual([DELTA])

        const rewind = rig.find('.speed-rewind')
        rewind.dispatchEvent(pointer('pointerdown'))
        rig.timer.advance(REWIND_MS * 2)
        rewind.dispatchEvent(pointer('pointerup'))
        expect(rig.word()).toBe('beta')
        expect(rig.book.locators()).toEqual([DELTA, BETA])
    })

    it('asks the book one time when the book does not move', async () => {
        const rig = await started(ALPHA, { pageChars: 20 })
        // A view that cannot show the word keeps its position.
        rig.book.goTo.mockImplementation(async () => {})
        rig.find('.speed-play').click()
        expect(playWords(rig, 4)).toEqual(['beta', 'gamma.', 'Delta', 'epsilon'])
        expect(rig.book.goTo).toHaveBeenCalledTimes(1)
    })
})

describe('stop', () => {
    it('moves the book, removes the overlay, sets the mode and reports the exit', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)

        let finishGoTo = () => {}
        rig.book.goTo.mockImplementationOnce((locator) => {
            rig.book.log.push(`goTo ${locator.spineIndex}:${locator.offset}`)
            return new Promise<void>((resolve) => {
                finishGoTo = resolve
            })
        })

        const stopped = rig.speed.stop()
        // The engine is paused and the lock is free before the page moves. The only timer
        // is the time limit of the exit.
        expect(rig.status()).toBe('paused')
        expect(rig.timer.pending()).toEqual([EXIT_WAIT_MS])
        expect(rig.wakeLock.release).toHaveBeenCalledTimes(1)
        expect(rig.book.log).toEqual(['mode speed', 'goTo 1:23'])
        // The overlay covers the book until the page with the word is ready.
        expect(rig.host.querySelector('.speed')).not.toBeNull()
        expect(rig.speed.active).toBe(true)
        expect(rig.onExit).not.toHaveBeenCalled()

        finishGoTo()
        await stopped
        expect(rig.book.log).toEqual(['mode speed', 'goTo 1:23', 'mode read', 'exit'])
        expect(rig.host.querySelector('.speed')).toBeNull()
        expect(rig.speed.active).toBe(false)
        expect(rig.onExit).toHaveBeenCalledTimes(1)
    })

    it('does not wait without end for a book that does not move', async () => {
        const rig = await started(BETA)
        rig.book.goTo.mockImplementationOnce(() => new Promise<void>(() => {}))
        const stopped = rig.speed.stop()
        rig.timer.advance(EXIT_WAIT_MS - 1)
        expect(rig.speed.active).toBe(true)

        rig.timer.advance(1)
        await stopped
        expect(rig.speed.active).toBe(false)
        expect(rig.host.querySelector('.speed')).toBeNull()
        expect(rig.onExit).toHaveBeenCalledTimes(1)
    })

    it('moves the book also when it is at that word already', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        rig.find('.speed-play').click()
        await rig.speed.stop()
        expect(rig.book.locators()).toEqual([GAMMA, GAMMA])
    })

    it('does one exit for two calls', async () => {
        const rig = await started(BETA)
        await Promise.all([rig.speed.stop(), rig.speed.stop()])
        expect(rig.onExit).toHaveBeenCalledTimes(1)
        expect(rig.book.goTo).toHaveBeenCalledTimes(1)
        await rig.speed.stop()
        expect(rig.onExit).toHaveBeenCalledTimes(1)
    })

    it('does nothing before the first start', async () => {
        const rig = setup()
        await rig.speed.stop()
        expect(rig.onExit).not.toHaveBeenCalled()
        expect(rig.book.setMode).not.toHaveBeenCalled()
    })

    it('runs from the "Back to the book" button', async () => {
        const rig = await started(BETA)
        rig.find('.speed-done').click()
        await flush()
        expect(rig.onExit).toHaveBeenCalledTimes(1)
        expect(rig.book.locators()).toEqual([BETA])
    })

    it('does not use the keys and the timers after the exit', async () => {
        const rig = await started(BETA)
        await rig.speed.stop()
        const event = keyDown(document.body, ' ')
        expect(event.defaultPrevented).toBe(false)
        setVisibility('hidden')
        rig.timer.advance(60_000)
        expect(rig.book.goTo).toHaveBeenCalledTimes(1)
        expect(rig.timer.pending()).toEqual([])
    })

    it('starts again after an exit', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        await rig.speed.stop()

        await rig.speed.start(ALPHA)
        expect(rig.speed.active).toBe(true)
        expect(rig.host.querySelectorAll('.speed')).toHaveLength(1)
        expect(rig.word()).toBe('Alpha')
        expect(rig.status()).toBe('paused')
        rig.find('.speed-play').click()
        expect(playWords(rig, 1)).toEqual(['beta'])
    })

    it('continues at the word of the last exit while the page still shows it', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS * 2)
        await rig.speed.stop()

        // The page starts at 'Alpha' and has the word 'Delta'.
        rig.book.setVisible({ spineIndex: CHAPTER_1, start: 12, end: 49 })
        await rig.speed.start()
        expect(rig.word()).toBe('Delta')
        await rig.speed.stop()

        // The user turned the page. The mode then starts at the top of the new page.
        rig.book.setVisible({ spineIndex: CHAPTER_2, start: 0, end: 26 })
        await rig.speed.start()
        expect(rig.word()).toBe('Second')
    })

    it('stops a start that is not complete', async () => {
        const rig = setup()
        const starting = rig.speed.start(BETA)
        await rig.speed.stop()
        await starting
        expect(rig.speed.active).toBe(false)
        expect(rig.host.querySelector('.speed')).toBeNull()
        expect(rig.onExit).toHaveBeenCalledTimes(1)
        expect(rig.book.goTo).not.toHaveBeenCalled()
    })

    it('gives the focus back to the control that started the mode', async () => {
        const rig = setup()
        const opener = document.createElement('button')
        document.body.append(opener)
        focusByKeyboard(opener)
        // The reader screen hides its bars while a mode is on. A control in a hidden bar
        // loses the focus and cannot get it. jsdom has no inert attribute, so the control
        // leaves the page for that time.
        rig.book.setMode.mockImplementation((mode) => {
            if (mode === 'read') document.body.append(opener)
            else opener.remove()
        })

        await rig.speed.start(BETA)
        expect(document.activeElement).toBe(rig.find('.speed-play'))
        await rig.speed.stop()
        expect(document.activeElement).toBe(opener)
    })

    it('does not give the focus back after a start with a pointer', async () => {
        const rig = setup()
        const opener = document.createElement('button')
        document.body.append(opener)
        focusByPointer(opener)

        await rig.speed.start(BETA)
        await rig.speed.stop()
        // The bars of the reader screen stay while a bar has the focus. They must hide again.
        expect(document.activeElement).toBe(document.body)
    })

    it('shows no text of the last run at the next start', async () => {
        const rig = await started(BETA)
        expect(rig.text('.speed-context-before')).toBe('One Alpha')
        await rig.speed.stop()

        // The chapter of the next start does not load at once.
        rig.book.loadText.mockImplementationOnce(() => new Promise(() => {}))
        void rig.speed.start({ spineIndex: CHAPTER_2, offset: 0 })
        expect(rig.word()).toBe('')
        expect(rig.text('.speed-context-before')).toBe('')
        expect(rig.text('.speed-context-after')).toBe('')
        expect(rig.text('.speed-title')).toBe('The Test Book')
        expect(rig.text('.speed-status')).toBe('')
    })

    it('stops a hold on the speed control', async () => {
        const rig = await started(BETA)
        rig.find('.speed-faster').dispatchEvent(pointer('pointerdown'))
        await rig.speed.stop()
        rig.timer.advance(HOLD_DELAY_MS + HOLD_INTERVAL_MS * 5)
        expect(rig.settings.get().rsvp.wpm).toBe(600)
        expect(rig.timer.pending()).toEqual([])
    })
})

describe('the stage', () => {
    it('starts playback after a short tap while paused', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        stage.dispatchEvent(pointer('pointerdown'))
        expect(rig.status()).toBe('paused')
        rig.timer.advance(TAP_MAX_MS - 1)
        stage.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('playing')
    })

    it('pauses after a short tap during playback', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        rig.find('.speed-play').click()
        stage.dispatchEvent(pointer('pointerdown'))
        expect(rig.status()).toBe('paused')
        rig.timer.advance(TAP_MAX_MS - 1)
        stage.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('paused')
        expect(rig.book.locators()).toEqual([BETA])
    })

    it('pauses for the time of a hold and continues on release', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)

        stage.dispatchEvent(pointer('pointerdown'))
        expect(rig.status()).toBe('paused')
        rig.timer.advance(3000)
        expect(rig.word()).toBe('gamma.')

        stage.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('playing')
        expect(playWords(rig, 1)).toEqual(['Delta'])
    })

    it('does nothing for a hold while paused', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        stage.dispatchEvent(pointer('pointerdown'))
        rig.timer.advance(TAP_MAX_MS)
        stage.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('paused')
    })

    it('continues when the browser cancels a press that paused the playback', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        rig.find('.speed-play').click()
        stage.dispatchEvent(pointer('pointerdown'))
        stage.dispatchEvent(pointer('pointercancel'))
        expect(rig.status()).toBe('playing')

        stage.dispatchEvent(pointer('pointerdown'))
        stage.dispatchEvent(pointer('lostpointercapture'))
        expect(rig.status()).toBe('playing')
    })

    it('ends a press when a pointer with no capture leaves the stage', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        rig.find('.speed-play').click()
        stage.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }))
        expect(rig.status()).toBe('paused')
        // The release then comes to a different element, and not to the stage.
        stage.dispatchEvent(pointer('pointerleave', { pointerType: 'mouse' }))
        expect(rig.status()).toBe('playing')

        // The stage is not stuck in the old press.
        stage.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }))
        stage.dispatchEvent(pointer('pointerup', { pointerType: 'mouse' }))
        expect(rig.status()).toBe('paused')
    })

    it('ignores a secondary mouse button and the release of a different pointer', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        stage.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse', button: 2 }))
        stage.dispatchEvent(pointer('pointerup', { pointerType: 'mouse', button: 2 }))
        expect(rig.status()).toBe('paused')

        stage.dispatchEvent(pointer('pointerdown', { pointerId: 1 }))
        stage.dispatchEvent(pointer('pointerup', { pointerId: 2 }))
        expect(rig.status()).toBe('paused')
        stage.dispatchEvent(pointer('pointerup', { pointerId: 1 }))
        expect(rig.status()).toBe('playing')
    })

    it('opens no menu for a long press, and keeps the menu of the secondary button', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        const menu = () => {
            const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
            stage.dispatchEvent(event)
            return event.defaultPrevented
        }
        expect(menu()).toBe(false)

        stage.dispatchEvent(pointer('pointerdown'))
        expect(menu()).toBe(true)
        stage.dispatchEvent(pointer('pointerup'))
        expect(menu()).toBe(false)
    })

    it('toggles the playback for a click with no pointer, as a screen reader sends it', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        stage.click()
        expect(rig.status()).toBe('playing')
        stage.click()
        expect(rig.status()).toBe('paused')

        // The click that follows a tap has a pointer. The tap did the toggle already.
        stage.dispatchEvent(pointer('pointerdown'))
        stage.dispatchEvent(pointer('pointerup'))
        stage.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
        expect(rig.status()).toBe('playing')
    })

    it('does not continue after a hold that ends while the page is hidden', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        rig.find('.speed-play').click()
        stage.dispatchEvent(pointer('pointerdown'))
        setVisibility('hidden')

        stage.dispatchEvent(pointer('pointercancel'))
        expect(rig.status()).toBe('paused')
        setVisibility('visible')
        stage.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('paused')

        // The next tap is a new press.
        stage.dispatchEvent(pointer('pointerdown'))
        stage.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('playing')
    })
})

describe('the rewind button', () => {
    it('goes back word by word while the pointer is down', async () => {
        const rig = await started(DELTA)
        const rewind = rig.find('.speed-rewind')
        rewind.dispatchEvent(pointer('pointerdown'))
        expect(rig.status()).toBe('rewinding')
        expect(rewind.getAttribute('aria-pressed')).toBe('true')

        rig.timer.advance(REWIND_MS)
        expect(rig.word()).toBe('gamma.')
        rig.timer.advance(REWIND_MS)
        expect(rig.word()).toBe('beta')

        rewind.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('paused')
        expect(rewind.getAttribute('aria-pressed')).toBe('false')
        rig.timer.advance(10_000)
        expect(rig.word()).toBe('beta')
        // The end of a rewind is a pause, so the book follows.
        expect(rig.book.locators()).toEqual([BETA])
    })

    it.each(['pointercancel', 'pointerleave', 'lostpointercapture', 'blur'])(
        'stops on %s',
        async (type) => {
            const rig = await started(DELTA)
            const rewind = rig.find('.speed-rewind')
            rewind.dispatchEvent(pointer('pointerdown'))
            rig.timer.advance(REWIND_MS)
            rewind.dispatchEvent(type === 'blur' ? new FocusEvent('blur') : pointer(type))
            expect(rig.status()).toBe('paused')
            expect(rig.timer.pending()).toEqual([])
        },
    )

    it('ignores a secondary mouse button', async () => {
        const rig = await started(DELTA)
        rig.find('.speed-rewind').dispatchEvent(
            pointer('pointerdown', { pointerType: 'mouse', button: 2 }),
        )
        expect(rig.status()).toBe('paused')
    })

    it('continues the playback after a rewind that started during playback', async () => {
        const rig = await started(DELTA)
        const rewind = rig.find('.speed-rewind')
        rig.find('.speed-play').click()
        rewind.dispatchEvent(pointer('pointerdown'))
        rig.timer.advance(REWIND_MS)
        expect(rig.word()).toBe('gamma.')

        rewind.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('playing')
        expect(rig.book.goTo).not.toHaveBeenCalled()
        expect(playWords(rig, 1)).toEqual(['Delta'])
    })

    it.each([' ', 'Enter'])('goes back while the key "%s" is down', async (key) => {
        const rig = await started(DELTA)
        const rewind = rig.find('.speed-rewind')
        tabTo(rewind)

        const down = keyDown(rewind, key)
        expect(down.defaultPrevented).toBe(true)
        expect(rig.status()).toBe('rewinding')
        rig.timer.advance(REWIND_MS)
        expect(rig.word()).toBe('gamma.')

        // A key that stays down sends more events. They do not start the rewind again.
        const repeat = keyDown(rewind, { key, repeat: true })
        expect(repeat.defaultPrevented).toBe(true)
        expect(rig.timer.pending()).toHaveLength(2)

        const up = keyUp(rewind, key)
        expect(up.defaultPrevented).toBe(true)
        expect(rig.status()).toBe('paused')
        expect(rig.word()).toBe('gamma.')
        // The key did not also toggle the playback.
        rig.timer.advance(10_000)
        expect(rig.word()).toBe('gamma.')
    })

    it('stays on at the first word until the release', async () => {
        const rig = await started(ALPHA)
        const rewind = rig.find('.speed-rewind')
        expect(rewind.hasAttribute('aria-disabled')).toBe(false)
        rewind.dispatchEvent(pointer('pointerdown'))
        rig.timer.advance(REWIND_MS * 10)

        expect(rig.word()).toBe('Chapter')
        expect(rig.status()).toBe('rewinding')
        expect(rewind.hasAttribute('aria-disabled')).toBe(false)

        rewind.dispatchEvent(pointer('pointerup'))
        expect(rig.status()).toBe('paused')
        expect(rewind.getAttribute('aria-disabled')).toBe('true')
        // The button keeps the focus, because it has no disabled attribute.
        expect((rewind as HTMLButtonElement).disabled).toBe(false)
    })

    it('stops when the window loses the focus', async () => {
        const rig = await started(DELTA)
        keyDown(document.body, 'r')
        expect(rig.status()).toBe('rewinding')
        window.dispatchEvent(new Event('blur'))
        expect(rig.status()).toBe('paused')
    })
})

describe('the keyboard', () => {
    it.each([' ', 'k', 'K'])('toggles the playback with the key "%s"', async (key) => {
        const rig = await started(BETA)
        const down = keyDown(document.body, key)
        expect(down.defaultPrevented).toBe(true)
        expect(rig.status()).toBe('playing')

        // A key that stays down does not toggle again.
        keyDown(document.body, { key, repeat: true })
        expect(rig.status()).toBe('playing')

        keyDown(document.body, key)
        expect(rig.status()).toBe('paused')
    })

    it('leaves Space and Enter to a button that has the keyboard focus', async () => {
        const rig = await started(BETA)
        const next = rig.find('.speed-next')
        tabTo(next)
        for (const key of [' ', 'Enter']) {
            expect(keyDown(next, key).defaultPrevented).toBe(false)
            expect(keyUp(next, key).defaultPrevented).toBe(false)
        }
        expect(rig.status()).toBe('paused')
        // K has no meaning for a button, so it works there.
        keyDown(next, 'k')
        expect(rig.status()).toBe('playing')
    })

    it('uses Space for the playback after a pointer press on a button', async () => {
        const rig = await started(BETA)
        const faster = rig.find('.speed-faster')
        // In Chrome and Firefox a press with a mouse leaves the focus on the button.
        tabTo(rig.find('.speed-next'))
        faster.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }))
        faster.focus()
        faster.dispatchEvent(pointer('pointerup', { pointerType: 'mouse' }))

        expect(keyDown(faster, ' ').defaultPrevented).toBe(true)
        expect(rig.status()).toBe('playing')
        // Firefox sends the click of the button for the release of the key.
        expect(keyUp(faster, ' ').defaultPrevented).toBe(true)
        expect(keyDown(faster, ' ').defaultPrevented).toBe(true)
        expect(rig.status()).toBe('paused')
        expect(rig.settings.get().rsvp.wpm).toBe(600)

        // Enter is not a key of the speed reader, so it stays with the button.
        expect(keyDown(faster, 'Enter').defaultPrevented).toBe(false)

        // The Tab key starts keyboard use again. The release is stopped only for a press
        // that the speed reader used.
        tabTo(faster)
        expect(keyDown(faster, ' ').defaultPrevented).toBe(false)
        expect(keyUp(faster, ' ').defaultPrevented).toBe(false)
        expect(rig.status()).toBe('paused')
    })

    it('uses Space for the playback after a pointer press in the settings sheet', async () => {
        const rig = await started(BETA)
        const settings = rig.find('.speed-settings')
        tabTo(settings)
        settings.click()
        await vi.waitFor(() =>
            expect(rig.host.querySelector('dialog.speed-sheet[open]')).not.toBeNull(),
        )
        // The close button gives the focus back to the settings button.
        const close = rig.find('.speed-sheet [data-close]')
        close.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }))
        close.click()
        expect(document.activeElement).toBe(settings)

        expect(keyDown(settings, ' ').defaultPrevented).toBe(true)
        expect(rig.status()).toBe('playing')
    })

    it('toggles the playback with Enter and Space on the stage', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        expect(keyDown(stage, 'Enter').defaultPrevented).toBe(true)
        expect(rig.status()).toBe('playing')
        expect(keyDown(stage, ' ').defaultPrevented).toBe(true)
        expect(rig.status()).toBe('paused')
        // Enter in a different place is not a key of the speed reader.
        expect(keyDown(document.body, 'Enter').defaultPrevented).toBe(false)
        expect(rig.status()).toBe('paused')
    })

    it('goes to the next and the previous sentence with the arrow keys', async () => {
        const rig = await started(BETA)
        expect(keyDown(document.body, 'ArrowRight').defaultPrevented).toBe(true)
        expect(rig.word()).toBe('Delta')
        expect(keyDown(document.body, 'ArrowLeft').defaultPrevented).toBe(true)
        expect(rig.word()).toBe('Alpha')
        expect(rig.status()).toBe('paused')
    })

    it('has the same sentence steps on the two buttons', async () => {
        const rig = await started(BETA)
        rig.find('.speed-next').click()
        expect(rig.word()).toBe('Delta')
        rig.find('.speed-previous').click()
        expect(rig.word()).toBe('Alpha')
    })

    it('goes to the next chapter from the last sentence', async () => {
        const rig = await started(DELTA)
        keyDown(document.body, 'ArrowRight')
        await flush()
        expect(rig.word()).toBe('Second')
        expect(rig.status()).toBe('paused')
        expect(rig.text('.speed-notice')).toBe('Chapter Two')
        expect(rig.book.locators()).toEqual([{ spineIndex: CHAPTER_2, offset: 0 }])
    })

    it('goes to the last sentence of the chapter before from the first word', async () => {
        const rig = await started({ spineIndex: CHAPTER_2, offset: 0 })
        keyDown(document.body, 'ArrowLeft')
        await flush()
        expect(rig.word()).toBe('Delta')
        expect(rig.text('.speed-title')).toBe('Chapter One')
        expect(rig.book.locators()).toEqual([DELTA])

        // The first chapter with words has no chapter before it.
        keyDown(document.body, 'ArrowLeft')
        keyDown(document.body, 'ArrowLeft')
        keyDown(document.body, 'ArrowLeft')
        expect(rig.word()).toBe('Chapter')
        keyDown(document.body, 'ArrowLeft')
        await flush()
        expect(rig.word()).toBe('Chapter')
    })

    it('shows "End of the book" for a next sentence step in the last sentence', async () => {
        const rig = await started({ spineIndex: CHAPTER_3, offset: 0 })
        keyDown(document.body, 'ArrowRight')
        await flush()
        expect(rig.word()).toBe('The')
        expect(rig.text('.speed-notice')).toBe('End of the book')
        // The word on screen is not the last one, so the book is not complete.
        expect(rig.text('.speed-status')).not.toContain('100%')

        // The message is then only a short hint. It must not stay above a different word.
        rig.timer.advance(NOTICE_MS)
        expect(rig.text('.speed-notice')).toBe('')
    })

    it('changes the speed by 10 with the up and down arrow keys', async () => {
        const rig = await started(BETA)
        expect(keyDown(document.body, 'ArrowUp').defaultPrevented).toBe(true)
        expect(rig.settings.get().rsvp.wpm).toBe(610)
        expect(rig.text('.speed-rate output')).toBe('610 wpm')

        expect(keyDown(document.body, 'ArrowDown').defaultPrevented).toBe(true)
        keyDown(document.body, 'ArrowDown')
        expect(rig.settings.get().rsvp.wpm).toBe(590)
        expect(rig.text('.speed-rate output')).toBe('590 wpm')
    })

    it('goes back while R is down', async () => {
        const rig = await started(DELTA)
        expect(keyDown(document.body, 'r').defaultPrevented).toBe(true)
        expect(rig.status()).toBe('rewinding')
        keyDown(document.body, { key: 'r', repeat: true })
        rig.timer.advance(REWIND_MS)
        expect(rig.word()).toBe('gamma.')

        keyUp(document.body, 'r')
        expect(rig.status()).toBe('paused')
        expect(rig.book.locators()).toEqual([GAMMA])

        keyDown(document.body, 'R')
        expect(rig.status()).toBe('rewinding')
        keyUp(document.body, 'R')
        expect(rig.status()).toBe('paused')
    })

    it('toggles full screen with F', async () => {
        const { request, exit } = stubFullscreen()
        const rig = await started(BETA)
        expect(keyDown(document.body, 'f').defaultPrevented).toBe(true)
        expect(request).toHaveBeenCalledTimes(1)
        // The request goes to the root element, as the full screen of the reader screen does.
        expect(request.mock.contexts[0]).toBe(document.documentElement)
        expect(rig.status()).toBe('paused')

        document.dispatchEvent(new Event('fullscreenchange'))
        keyDown(document.body, 'F')
        expect(exit).toHaveBeenCalledTimes(1)
        // A key that stays down does not toggle again.
        keyDown(document.body, { key: 'f', repeat: true })
        expect(exit).toHaveBeenCalledTimes(1)
    })

    it('goes back to the book with Escape', async () => {
        const rig = await started(BETA)
        expect(keyDown(document.body, 'Escape').defaultPrevented).toBe(true)
        await flush()
        expect(rig.speed.active).toBe(false)
        expect(rig.onExit).toHaveBeenCalledTimes(1)
    })

    it('keeps its keys from the listeners of the reader screen', async () => {
        const rig = await started(BETA)
        const screen = vi.fn()
        document.addEventListener('keydown', screen)
        keyDown(document.body, 'ArrowRight')
        keyDown(document.body, 'Escape')
        keyDown(document.body, 'x')
        document.removeEventListener('keydown', screen)

        expect(screen).toHaveBeenCalledTimes(1)
        expect(screen.mock.calls[0][0].key).toBe('x')
        await rig.speed.stop()
    })

    it('ignores a key with Ctrl or Command, for example the reload shortcut', async () => {
        const rig = await started(DELTA)
        expect(keyDown(document.body, { key: 'r', ctrlKey: true }).defaultPrevented).toBe(false)
        expect(keyDown(document.body, { key: 'r', metaKey: true }).defaultPrevented).toBe(false)
        expect(keyDown(document.body, { key: 'f', ctrlKey: true }).defaultPrevented).toBe(false)
        expect(rig.status()).toBe('paused')
    })

    it('ignores a key in an input', async () => {
        const rig = await started(BETA)
        const input = document.createElement('input')
        rig.root().append(input)
        expect(keyDown(input, ' ').defaultPrevented).toBe(false)
        expect(keyDown(input, 'ArrowRight').defaultPrevented).toBe(false)
        expect(rig.status()).toBe('paused')
        expect(rig.word()).toBe('beta')
    })

    it('ignores the keys while the settings sheet is open', async () => {
        const rig = await started(BETA)
        rig.find('.speed-settings').click()
        await vi.waitFor(() =>
            expect(rig.host.querySelector('dialog.speed-sheet[open]')).not.toBeNull(),
        )

        expect(keyDown(document.body, ' ').defaultPrevented).toBe(false)
        expect(keyDown(document.body, 'Escape').defaultPrevented).toBe(false)
        expect(rig.status()).toBe('paused')
        expect(rig.speed.active).toBe(true)
    })
})

describe('the speed control', () => {
    it('changes the speed by 10 for a tap', async () => {
        const rig = await started(BETA)
        rig.find('.speed-faster').click()
        expect(rig.settings.get().rsvp.wpm).toBe(610)
        expect(rig.text('.speed-rate output')).toBe('610 wpm')
        rig.find('.speed-slower').click()
        rig.find('.speed-slower').click()
        expect(rig.settings.get().rsvp.wpm).toBe(590)
    })

    it('repeats during a hold', async () => {
        const rig = await started(BETA)
        const faster = rig.find('.speed-faster')
        faster.dispatchEvent(pointer('pointerdown'))
        rig.timer.advance(HOLD_DELAY_MS + HOLD_INTERVAL_MS * 9)
        faster.dispatchEvent(pointer('pointerup'))
        expect(rig.settings.get().rsvp.wpm).toBe(700)
        rig.timer.advance(5000)
        expect(rig.settings.get().rsvp.wpm).toBe(700)
    })

    it('stops at the limits', async () => {
        const rig = await started(BETA, { rsvp: { wpm: RSVP_WPM_MAX - 10 } })
        const faster = rig.find('.speed-faster')
        faster.click()
        faster.click()
        expect(rig.settings.get().rsvp.wpm).toBe(RSVP_WPM_MAX)
        expect(faster.getAttribute('aria-disabled')).toBe('true')

        rig.settings.update({ rsvp: { wpm: RSVP_WPM_MIN } })
        expect(faster.hasAttribute('aria-disabled')).toBe(false)
        expect(rig.find('.speed-slower').getAttribute('aria-disabled')).toBe('true')
        keyDown(document.body, 'ArrowDown')
        expect(rig.settings.get().rsvp.wpm).toBe(RSVP_WPM_MIN)
    })
})

describe('the settings sheet', () => {
    async function openSheet(rig: Rig): Promise<HTMLDialogElement> {
        rig.find('.speed-settings').click()
        await vi.waitFor(() =>
            expect(rig.host.querySelector('dialog.speed-sheet[open]')).not.toBeNull(),
        )
        return rig.find<HTMLDialogElement>('dialog.speed-sheet')
    }

    it('opens inside the overlay and pauses the playback', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)

        const sheet = await openSheet(rig)
        expect(sheet.closest('.speed')).toBe(rig.root())
        expect(rig.status()).toBe('paused')
        expect(rig.book.locators()).toEqual([GAMMA])

        // The playback stays paused after the sheet closes.
        sheet.close()
        rig.timer.advance(10_000)
        expect(rig.status()).toBe('paused')
        expect(document.activeElement).toBe(rig.find('.speed-settings'))
    })

    it('pauses a playback that started while the sheet loaded', async () => {
        const rig = await started(BETA)
        rig.find('.speed-settings').click()
        rig.find('.speed-play').click()
        expect(rig.status()).toBe('playing')

        await vi.waitFor(() =>
            expect(rig.host.querySelector('dialog.speed-sheet[open]')).not.toBeNull(),
        )
        expect(rig.status()).toBe('paused')
        expect(rig.book.locators()).toEqual([BETA])
    })

    it('stays paused when a hold on the stage ends behind the sheet', async () => {
        const rig = await started(BETA)
        const stage = rig.find('.speed-stage')
        rig.find('.speed-play').click()
        stage.dispatchEvent(pointer('pointerdown'))
        await openSheet(rig)

        rig.timer.advance(TAP_MAX_MS)
        stage.dispatchEvent(pointer('pointercancel'))
        expect(rig.status()).toBe('paused')
    })

    it('writes a control to the settings, and the overlay follows', async () => {
        const rig = await started(BETA)
        const sheet = await openSheet(rig)
        sheet.querySelector<HTMLButtonElement>('[data-wpm="300"]')?.click()
        expect(rig.settings.get().rsvp.wpm).toBe(300)
        expect(rig.text('.speed-rate output')).toBe('300 wpm')

        sheet.querySelector<HTMLInputElement>('.switch[data-setting="showPivot"]')?.click()
        expect(rig.root().dataset.pivot).toBe('off')
    })

    it('resets the speed reader settings', async () => {
        const rig = await started(BETA)
        const sheet = await openSheet(rig)
        sheet.querySelector<HTMLButtonElement>('[data-action="reset"]')?.click()
        expect(rig.settings.get().rsvp).toEqual(DEFAULT_SETTINGS.rsvp)
        expect(rig.text('.speed-rate output')).toBe(`${DEFAULT_SETTINGS.rsvp.wpm} wpm`)
        expect(rig.text('.speed-context-before')).toBe('Chapter One Alpha')
    })

    it('starts the book again after the confirmation', async () => {
        const rig = await started({ spineIndex: CHAPTER_2, offset: 7 })
        expect(rig.word()).toBe('chapter')
        const sheet = await openSheet(rig)
        sheet.querySelector<HTMLButtonElement>('[data-action="restart"]')?.click()

        const confirm = rig.find<HTMLDialogElement>('dialog.speed-confirm')
        expect(confirm.open).toBe(true)
        expect(rig.word()).toBe('chapter')

        confirm.querySelector<HTMLButtonElement>('[value="confirm"]')?.click()
        await flush()
        // The cover has no words, so the first word is in chapter 1.
        expect(rig.word()).toBe('Chapter')
        expect(rig.status()).toBe('paused')
        expect(sheet.open).toBe(false)
        expect(rig.book.locators()).toEqual([{ spineIndex: CHAPTER_1, offset: 0 }])
        expect(rig.text('.speed-title')).toBe('Chapter One')
    })

    it('keeps the position when the user cancels', async () => {
        const rig = await started({ spineIndex: CHAPTER_2, offset: 7 })
        const sheet = await openSheet(rig)
        sheet.querySelector<HTMLButtonElement>('[data-action="restart"]')?.click()
        const confirm = rig.find<HTMLDialogElement>('dialog.speed-confirm')

        // The Escape key closes the dialog with no return value.
        confirm.close()
        await flush()
        expect(rig.word()).toBe('chapter')
        expect(sheet.open).toBe(true)

        sheet.querySelector<HTMLButtonElement>('[data-action="restart"]')?.click()
        confirm.querySelector<HTMLButtonElement>('[value="cancel"]')?.click()
        await flush()
        expect(rig.word()).toBe('chapter')
        expect(rig.book.goTo).not.toHaveBeenCalled()
    })

    it('closes with the mode', async () => {
        const rig = await started(BETA)
        const sheet = await openSheet(rig)
        await rig.speed.stop()
        expect(sheet.open).toBe(false)
    })
})

describe('a hidden document', () => {
    it('pauses the playback and does not continue by itself', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)

        setVisibility('hidden')
        expect(rig.status()).toBe('paused')
        expect(rig.book.locators()).toEqual([GAMMA])

        setVisibility('visible')
        rig.timer.advance(10_000)
        expect(rig.status()).toBe('paused')
        expect(rig.word()).toBe('gamma.')
    })

    it('stops a rewind', async () => {
        const rig = await started(DELTA)
        rig.find('.speed-rewind').dispatchEvent(pointer('pointerdown'))
        setVisibility('hidden')
        expect(rig.status()).toBe('paused')
    })
})

describe('the wake lock', () => {
    it('is on during playback and off at a pause', async () => {
        const rig = await started(BETA)
        expect(rig.wakeLock.request).not.toHaveBeenCalled()

        rig.find('.speed-play').click()
        expect(rig.wakeLock.request).toHaveBeenCalledTimes(1)
        rig.timer.advance(WORD_MS * 2)
        expect(rig.wakeLock.request).toHaveBeenCalledTimes(1)
        expect(rig.wakeLock.release).not.toHaveBeenCalled()

        rig.find('.speed-play').click()
        expect(rig.wakeLock.release).toHaveBeenCalledTimes(1)
        expect(rig.createWakeLock).toHaveBeenCalledTimes(1)
    })

    it('stays on during a rewind that started during playback', async () => {
        const rig = await started(DELTA)
        rig.find('.speed-play').click()
        keyDown(document.body, 'r')
        keyUp(document.body, 'r')
        expect(rig.wakeLock.request).toHaveBeenCalledTimes(1)
        expect(rig.wakeLock.release).not.toHaveBeenCalled()
    })

    it('is not used when the setting is off', async () => {
        const rig = await started(BETA, { keepAwake: false })
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        rig.find('.speed-play').click()
        expect(rig.createWakeLock).not.toHaveBeenCalled()
        expect(rig.wakeLock.request).not.toHaveBeenCalled()
    })

    it('follows a change of the setting during playback', async () => {
        const rig = await started(BETA, { keepAwake: false })
        rig.find('.speed-play').click()
        rig.settings.update({ keepAwake: true })
        expect(rig.wakeLock.request).toHaveBeenCalledTimes(1)
        rig.settings.update({ keepAwake: false })
        expect(rig.wakeLock.release).toHaveBeenCalledTimes(1)
    })

    it('is off after the exit', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        await rig.speed.stop()
        expect(rig.wakeLock.release).toHaveBeenCalledTimes(1)
    })
})

describe('full screen', () => {
    it('has no button in a browser with no full screen for elements', async () => {
        const rig = await started(BETA)
        expect(rig.find('.speed-fullscreen').hidden).toBe(true)
        // The key does nothing and does not throw.
        keyDown(document.body, 'f')
    })

    it('enters and leaves full screen with the button, and keeps the icon right', async () => {
        const { request, exit } = stubFullscreen()
        const rig = await started(BETA)
        const button = rig.find('.speed-fullscreen')
        expect(button.hidden).toBe(false)
        expect(button.getAttribute('aria-label')).toBe('Full screen')
        expect(button.getAttribute('aria-pressed')).toBe('false')

        button.click()
        expect(request).toHaveBeenCalledTimes(1)
        document.dispatchEvent(new Event('fullscreenchange'))
        expect(button.getAttribute('aria-pressed')).toBe('true')
        expect(button.querySelector('use')?.getAttribute('href')).toBe('#i-minimize')

        button.click()
        expect(exit).toHaveBeenCalledTimes(1)
        document.dispatchEvent(new Event('fullscreenchange'))
        expect(button.getAttribute('aria-pressed')).toBe('false')
        expect(button.querySelector('use')?.getAttribute('href')).toBe('#i-maximize')
    })

    it('follows a change that the browser makes, for example for the Escape key', async () => {
        const { exit } = stubFullscreen()
        const rig = await started(BETA)
        const button = rig.find('.speed-fullscreen')
        button.click()
        document.dispatchEvent(new Event('fullscreenchange'))

        exit()
        document.dispatchEvent(new Event('fullscreenchange'))
        expect(button.getAttribute('aria-pressed')).toBe('false')
    })

    it('leaves full screen at the exit', async () => {
        const { exit } = stubFullscreen()
        const rig = await started(BETA)
        rig.find('.speed-fullscreen').click()
        await rig.speed.stop()
        expect(exit).toHaveBeenCalledTimes(1)
    })

    it('leaves full screen on destroy', async () => {
        const { exit } = stubFullscreen()
        const rig = await started(BETA)
        rig.find('.speed-fullscreen').click()
        rig.speed.destroy()
        expect(exit).toHaveBeenCalledTimes(1)
    })

    it('does not leave a full screen that the reader screen entered', async () => {
        const { request, exit } = stubFullscreen()
        request.call(document.documentElement)
        const rig = await started(BETA)
        expect(rig.find('.speed-fullscreen').getAttribute('aria-pressed')).toBe('true')
        await rig.speed.stop()
        expect(exit).not.toHaveBeenCalled()
    })
})

describe('destroy', () => {
    /** Nothing of the part is left, and the later calls do nothing. */
    async function expectGone(rig: Rig): Promise<void> {
        expect(rig.host.childElementCount).toBe(0)
        expect(rig.timer.pending()).toEqual([])
        expect(rig.speed.active).toBe(false)

        const goToCalls = rig.book.goTo.mock.calls.length
        const modeCalls = rig.book.setMode.mock.calls.length
        expect(keyDown(document.body, ' ').defaultPrevented).toBe(false)
        setVisibility('hidden')
        rig.settings.update({ rsvp: { wpm: 440 }, keepAwake: false })
        rig.timer.advance(60_000)
        await rig.speed.start(BETA)
        await rig.speed.stop()
        rig.speed.destroy()
        await flush()

        expect(rig.host.childElementCount).toBe(0)
        expect(rig.book.goTo).toHaveBeenCalledTimes(goToCalls)
        expect(rig.book.setMode).toHaveBeenCalledTimes(modeCalls)
        expect(rig.onExit).not.toHaveBeenCalled()
    }

    it('works before the first start', async () => {
        const rig = setup()
        rig.speed.destroy()
        await expectGone(rig)
    })

    it('works while the first chapter loads', async () => {
        const rig = setup()
        const starting = rig.speed.start(BETA)
        rig.speed.destroy()
        await starting
        await expectGone(rig)
    })

    it('works while paused', async () => {
        const rig = await started(BETA)
        rig.speed.destroy()
        await expectGone(rig)
        expect(rig.wakeLock.release).not.toHaveBeenCalled()
    })

    it('works during playback and releases the wake lock', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        rig.speed.destroy()
        expect(rig.wakeLock.release).toHaveBeenCalledTimes(1)
        await expectGone(rig)
        expect(rig.wakeLock.release).toHaveBeenCalledTimes(1)
    })

    it('works during a rewind', async () => {
        const rig = await started(DELTA)
        const rewind = rig.find('.speed-rewind')
        rewind.dispatchEvent(pointer('pointerdown'))
        rig.speed.destroy()
        // The release comes to a button that is not in the page.
        rewind.dispatchEvent(pointer('pointerup'))
        await expectGone(rig)
    })

    it('works during a hold on the stage and on the speed control', async () => {
        const rig = await started(BETA)
        rig.find('.speed-play').click()
        const stage = rig.find('.speed-stage')
        const faster = rig.find('.speed-faster')
        stage.dispatchEvent(pointer('pointerdown'))
        faster.dispatchEvent(pointer('pointerdown', { pointerId: 2 }))
        rig.speed.destroy()
        stage.dispatchEvent(pointer('pointerup'))
        await expectGone(rig)
        expect(rig.settings.get().rsvp.wpm).toBe(440)
    })

    it('works while the next chapter loads', async () => {
        const rig = await started(ZETA, { rsvp: { pauseAtChapterStart: false } })
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        rig.speed.destroy()
        await flush()
        await expectGone(rig)
    })

    it('works while the chapter title is on screen', async () => {
        const rig = await started(ZETA, { rsvp: { pauseAtChapterStart: true } })
        rig.find('.speed-play').click()
        rig.timer.advance(WORD_MS)
        await flush()
        expect(rig.timer.pending()).toEqual([NOTICE_MS])
        rig.speed.destroy()
        await expectGone(rig)
    })

    it('works with the settings sheet and the confirmation dialog open', async () => {
        const rig = await started(BETA)
        rig.find('.speed-settings').click()
        await vi.waitFor(() =>
            expect(rig.host.querySelector('dialog.speed-sheet[open]')).not.toBeNull(),
        )
        rig.find<HTMLButtonElement>('[data-action="restart"]').click()
        rig.speed.destroy()
        expect(document.querySelector('dialog')).toBeNull()
        await expectGone(rig)
    })

    it('works while the settings sheet loads', async () => {
        const rig = await started(BETA)
        rig.find('.speed-settings').click()
        rig.speed.destroy()
        await flush(10)
        expect(document.querySelector('dialog')).toBeNull()
        await expectGone(rig)
    })

    it('works during the exit, and the exit then reports nothing', async () => {
        const rig = await started(BETA)
        let finishGoTo = () => {}
        rig.book.goTo.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishGoTo = resolve
                }),
        )
        const stopped = rig.speed.stop()
        rig.speed.destroy()
        // The exit does not wait for the book after destroy.
        await stopped
        finishGoTo()
        await flush()
        expect(rig.book.setMode).not.toHaveBeenCalledWith('read')
        await expectGone(rig)
    })

    it('works after the exit', async () => {
        const rig = await started(BETA)
        await rig.speed.stop()
        rig.onExit.mockClear()
        rig.speed.destroy()
        await expectGone(rig)
    })

    it('works two times', async () => {
        const rig = await started(BETA)
        rig.speed.destroy()
        rig.speed.destroy()
        await expectGone(rig)
    })
})
