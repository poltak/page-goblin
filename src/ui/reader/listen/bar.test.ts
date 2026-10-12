import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToasts } from '../../app/toast'
import { qs, qsa } from '../../dom'
import type { RelocateInfo } from '$lib/reader/types'
import {
    HAND_MOVE_MS,
    isInSight,
    LAYOUT_SETTLE_MS,
    NO_VOICES_MS,
    RATE_APPLY_MS,
    START_LIMIT_MS,
    START_WAIT_MS,
    VOICE_WAIT_MS,
} from './bar'
import { RATE_MENU_ID, SLEEP_MENU_ID } from './markup'
import { createHarness, VOICES, type Harness } from './testing/harness'

const MINUTE = 60_000
const SLEEP_TOAST = 'Sleep timer: listening is paused.'
const ERROR_TOAST = 'The voice stopped. Try a different voice.'
const NO_VOICES_TEXT = 'This browser has no speech voices.'

let harness: Harness | null = null

function make(options: Parameters<typeof createHarness>[0] = {}): Harness {
    harness = createHarness(options)
    return harness
}

/** Lets the promises that are ready run. */
function flush(): Promise<unknown> {
    return vi.advanceTimersByTimeAsync(0)
}

function click(element: Element): void {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function menuItem(menuId: string, selector: string): HTMLElement {
    return qs(selector, qs(`#${menuId}`))
}

function isOpen(menuId: string): boolean {
    return 'open' in qs(`#${menuId}`).dataset
}

/** Number of text loads of one chapter. */
function loadsOf(h: Harness, spineIndex: number): number {
    return h.session.content.loadText.mock.calls.filter(([index]) => index === spineIndex).length
}

function sheet(): HTMLDialogElement {
    return qs<HTMLDialogElement>('dialog.listen-voices')
}

function voiceRow(name: string): HTMLElement {
    const row = qsa('.listen-voice', sheet()).find(
        (item) => qs('.list-row-title', item).textContent === name,
    )
    if (!row) throw new Error(`No row for the voice ${name}`)
    return row
}

/**
 * Moves the clock while the voice sends word events. With no event for some seconds, the
 * watchdog of the controller goes to the next sentence.
 */
async function listenFor(h: Harness, milliseconds: number): Promise<void> {
    let left = milliseconds
    while (left > 0) {
        const step = Math.min(left, 4000)
        await vi.advanceTimersByTimeAsync(step)
        left -= step
        h.provider.active?.onBoundary({ charIndex: 0, charLength: 0 })
    }
}

/** A position of the book. The paged view gives a page number, the scroll view gives null. */
function positionAt(
    visible: { spineIndex?: number; start: number; end: number },
    page: number | null = 1,
): RelocateInfo {
    const spineIndex = visible.spineIndex ?? 0
    return {
        locator: { spineIndex, offset: visible.start },
        visible: { spineIndex, start: visible.start, end: visible.end },
        chapterLength: 16,
        page,
        pageCount: page === null ? null : 4,
        atBookStart: false,
        atBookEnd: false,
    }
}

/** Shows a position in the book, as the view does after a page turn or a new layout. */
function relocate(h: Harness, info: RelocateInfo): void {
    ;(h.session as { position: RelocateInfo | null }).position = info
    h.session.emit('relocate', info)
}

/** Makes the text of one chapter wait. The result lets it load. */
function holdChapter(h: Harness, spineIndex: number): () => void {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const load = h.session.content.loadText.getMockImplementation()
    h.session.content.loadText.mockImplementation(async (index) => {
        if (index === spineIndex) await gate
        return load!(index)
    })
    return release
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    harness?.bar.destroy()
    harness?.settings.destroy()
    harness = null
    clearToasts()
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('start', () => {
    it('shows the bar in the loading state at once and sets the mode', () => {
        const h = make()
        const started = h.bar.start({ spineIndex: 0, offset: 5 })

        expect(h.bar.active).toBe(true)
        expect(h.session.setMode).toHaveBeenCalledWith('listen')
        expect(h.state()).toBe('loading')
        expect(h.button('toggle').getAttribute('aria-label')).toBe('Loading')
        expect(h.button('toggle').getAttribute('aria-busy')).toBe('true')
        expect(qs('.spinner', h.dock).hidden).toBe(false)
        expect(h.provider.utterances).toHaveLength(0)
        return started
    })

    it('loads the chapter at the locator and plays', async () => {
        const h = make()
        await h.bar.start({ spineIndex: 0, offset: 5 })

        expect(h.session.content.loadText).toHaveBeenCalledWith(0)
        expect(h.spoken()).toEqual(['Two.'])
        expect(h.provider.last().lang).toBe('en')
        // No sound yet.
        expect(h.state()).toBe('loading')

        h.provider.last().onStart()
        expect(h.state()).toBe('playing')
        expect(h.button('toggle').getAttribute('aria-label')).toBe('Pause')
        expect(h.button('toggle').getAttribute('aria-busy')).toBe('false')
        expect(qs('.spinner', h.dock).hidden).toBe(true)
        expect(qs('use', h.button('toggle')).getAttribute('href')).toBe('#i-pause')
    })

    it('starts at the position of the session when no locator is given', async () => {
        const h = make({ position: { spineIndex: 1, offset: 6 } })
        await h.bar.start()
        expect(h.session.content.loadText).toHaveBeenCalledWith(1)
        expect(h.spoken()).toEqual(['Five.'])
    })

    it('uses the language of the chapter for speech', async () => {
        const h = make({ chapters: [{ text: 'Un. Deux.', lang: 'fr' }], voices: [] })
        const started = h.bar.start()
        await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS)
        await started
        expect(h.provider.last().lang).toBe('fr')
    })

    it('gives the settings to the controller', async () => {
        const h = make({ settings: { speech: { rate: 1.5, pitch: 0.8, voiceId: 'en-gb-brian' } } })
        await h.bar.start()
        const utterance = h.provider.last()
        expect(utterance.rate).toBe(1.5)
        expect(utterance.pitch).toBe(0.8)
        expect(utterance.voice).toBe('en-gb-brian')
        expect(h.button('rate').textContent).toBe('1.5×')
    })

    it('uses the voice that pickVoice gives when no voice is saved', async () => {
        const h = make()
        await h.bar.start()
        expect(h.provider.last().voice).toBe('en-us-alice')
    })

    it('ignores the result of an older start', async () => {
        const h = make()
        const release = holdChapter(h, 1)
        const first = h.bar.start({ spineIndex: 1, offset: 0 })
        await flush()
        const second = h.bar.start({ spineIndex: 0, offset: 5 })
        await second
        release()
        await first

        expect(h.spoken()).toEqual(['Two.'])
    })

    it('speaks in the task of the first tap when the bar was made at the press', async () => {
        const h = make({ position: { spineIndex: 0, offset: 5 } })
        // The time between the press and the click.
        await flush()
        expect(loadsOf(h, 0)).toBe(1)

        void h.bar.start()
        // No await: the browser call is in the task of the click.
        expect(h.spoken()).toEqual(['Two.'])
        expect(h.session.mode).toBe('listen')
        expect(loadsOf(h, 0)).toBe(1)
    })

    it('uses the load that started with the bar', async () => {
        const h = make()
        await h.bar.start({ spineIndex: 0, offset: 10 })
        expect(h.spoken()).toEqual(['Three.'])
        expect(loadsOf(h, 0)).toBe(1)
    })
})

describe('the first sound', () => {
    it('shows the play button when no start event comes in 700 ms', async () => {
        const h = make()
        await h.bar.start()
        await vi.advanceTimersByTimeAsync(START_WAIT_MS - 1)
        expect(h.state()).toBe('loading')

        await vi.advanceTimersByTimeAsync(1)
        expect(h.state()).toBe('paused')
        expect(h.button('toggle').getAttribute('aria-label')).toBe('Play')
        expect(qs('use', h.button('toggle')).getAttribute('href')).toBe('#i-play')
        expect(h.wakeLock.request).not.toHaveBeenCalled()
    })

    it('calls play in the click handler of the play button', async () => {
        const h = make()
        await h.bar.start()
        await vi.advanceTimersByTimeAsync(START_WAIT_MS)
        h.provider.calls.length = 0

        click(h.button('toggle'))
        // No await: the browser call is in the task of the click.
        expect(h.provider.calls).toEqual(['cancel', 'speak'])
        expect(h.spoken()).toEqual(['One.', 'One.'])
        expect(h.state()).toBe('playing')
        // The marker stays on the sentence.
        expect(h.log).not.toContain('marker:null')

        // The limit of the first try does not stop the second one.
        await vi.advanceTimersByTimeAsync(START_LIMIT_MS)
        expect(h.state()).toBe('playing')
    })

    it('takes a tap during the wait as a start in a user action', async () => {
        const h = make()
        await h.bar.start()
        expect(h.state()).toBe('loading')
        click(h.button('toggle'))
        expect(h.spoken()).toEqual(['One.', 'One.'])
        expect(h.state()).toBe('playing')
    })

    it('goes to playing when the sound comes after the wait', async () => {
        const h = make()
        await h.bar.start()
        await vi.advanceTimersByTimeAsync(START_WAIT_MS + 300)
        expect(h.state()).toBe('paused')

        h.provider.last().onStart()
        expect(h.state()).toBe('playing')
        await vi.advanceTimersByTimeAsync(START_LIMIT_MS)
        expect(h.state()).toBe('playing')
        expect(h.provider.utterances).toHaveLength(1)
    })

    it('stops the silent try at the limit, before the position can move', async () => {
        const h = make()
        await h.bar.start()
        h.log.length = 0
        await vi.advanceTimersByTimeAsync(START_LIMIT_MS)

        expect(h.log).toEqual(['cancel'])
        expect(h.state()).toBe('paused')
        await vi.advanceTimersByTimeAsync(5 * MINUTE)
        expect(h.provider.utterances).toHaveLength(1)
        expect(h.toast()).toBeNull()

        // The controller is idle now, so this is its play call.
        h.provider.calls.length = 0
        click(h.button('toggle'))
        expect(h.provider.calls).toEqual(['cancel', 'speak'])
        expect(h.spoken()).toEqual(['One.', 'One.'])
        expect(h.state()).toBe('playing')
        expect(h.log).not.toContain('marker:null')
    })

    it('does not wait for the sound after the browser spoke one time', async () => {
        const h = make()
        await h.play()
        void h.bar.start({ spineIndex: 0, offset: 10 })
        expect(h.state()).toBe('playing')
    })

    it('shows the play button with no message when the browser refuses the start', async () => {
        const h = make()
        await h.bar.start()
        h.provider.fail('not-allowed')
        expect(h.state()).toBe('paused')
        expect(h.toast()).toBeNull()
        // The marker stays on the sentence where the play button starts.
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 0, end: 4 },
            { follow: true },
        )

        click(h.button('toggle'))
        expect(h.spoken()).toEqual(['One.', 'One.'])
        expect(h.state()).toBe('playing')
    })
})

describe('the marker', () => {
    it('follows each sentence', async () => {
        const h = make()
        await h.play()
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 0, end: 4 },
            { follow: true },
        )

        h.provider.end()
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )
    })

    it('shows each word when the setting is on', async () => {
        const h = make()
        await h.play({ spineIndex: 0, offset: 5 })
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 8 },
            { follow: true },
        )
    })

    it('keeps the sentence when the setting is off', async () => {
        const h = make({ settings: { speech: { highlightWords: false } } })
        await h.play({ spineIndex: 0, offset: 5 })
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(h.session.view.setActiveRange).toHaveBeenCalledTimes(1)
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )
    })

    it('goes back to the sentence when the setting goes off', async () => {
        const h = make()
        await h.play()
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        h.settings.update({ speech: { highlightWords: false } })
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 0, end: 4 },
            { follow: true },
        )
    })

    it('goes away when speech goes to idle', async () => {
        const h = make()
        await h.play()
        h.provider.fail('synthesis-failed')
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(null)
    })

    it('moves to the new view after a view event', async () => {
        const h = make()
        await h.play()
        const next = h.session.replaceView()
        expect(next.setActiveRange).toHaveBeenCalledWith(
            { spineIndex: 0, start: 0, end: 4 },
            { follow: true },
        )

        // Later ranges go to the new view.
        h.provider.end()
        expect(next.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )
    })
})

describe('a move of the reader during speech', () => {
    // The chapter is 'One. Two. Three.' and speech starts at 'One.'.
    const PAGE_ONE = positionAt({ start: 0, end: 9 })
    const PAGE_TWO = positionAt({ start: 9, end: 16 }, 2)

    async function playOnPageOne(): Promise<Harness> {
        const h = make()
        relocate(h, PAGE_ONE)
        await h.play()
        // The bar took height from the page, and the view has its new layout.
        await vi.advanceTimersByTimeAsync(LAYOUT_SETTLE_MS)
        return h
    }

    it('does not take a position as a move while the page gets room for the bar', async () => {
        const h = make()
        relocate(h, PAGE_ONE)
        await h.play()
        // The view shows a different page for a moment while it makes its pages again.
        relocate(h, PAGE_TWO)
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 0, end: 3 },
            { follow: true },
        )
    })

    it('does not pull the page back to the marker', async () => {
        const h = await playOnPageOne()
        relocate(h, PAGE_TWO)
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 0, end: 3 },
            { follow: false },
        )
        // Speech continues at its place.
        expect(h.spoken()).toEqual(['One.'])
        expect(h.state()).toBe('playing')
    })

    it('follows the marker again when the reader shows its page', async () => {
        const h = await playOnPageOne()
        relocate(h, PAGE_TWO)
        relocate(h, PAGE_ONE)
        h.provider.end()
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )
    })

    it('follows the marker when the voice turns the page', async () => {
        const h = await playOnPageOne()
        h.provider.end()
        h.provider.last().onStart()
        h.provider.end()
        // 'Three.' is on the second page, and the view turned to it.
        relocate(h, PAGE_TWO)
        h.provider.last().onBoundary({ charIndex: 0, charLength: 5 })
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 10, end: 15 },
            { follow: true },
        )
    })

    it('keeps the marker in sight after a new layout', async () => {
        const h = await playOnPageOne()
        // Larger text: the page starts at the same character and shows less text.
        h.settings.update({ fontSize: 24 })
        relocate(h, positionAt({ start: 0, end: 4 }))
        h.provider.end()
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )
    })

    it('does not take the positions of a new view or a new window size as moves', async () => {
        const h = await playOnPageOne()
        const next = h.session.replaceView()
        relocate(h, positionAt({ start: 9, end: 16 }, null))
        relocate(h, positionAt({ start: 12, end: 16 }, null))
        h.provider.end()
        expect(next.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )

        await vi.advanceTimersByTimeAsync(LAYOUT_SETTLE_MS)
        window.dispatchEvent(new Event('resize'))
        relocate(h, positionAt({ start: 0, end: 4 }, null))
        relocate(h, positionAt({ start: 12, end: 16 }, null))
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(next.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 8 },
            { follow: true },
        )
    })

    it('goes back to the marker for a sentence step', async () => {
        const h = await playOnPageOne()
        relocate(h, PAGE_TWO)
        click(h.button('next'))
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )
    })

    it('continues speech at the new place when the reader moved during a pause', async () => {
        const h = await playOnPageOne()
        click(h.button('toggle'))
        relocate(h, PAGE_TWO)
        click(h.button('toggle'))
        // No await: the chapter is in memory.
        expect(h.spoken()).toEqual(['One.', 'Three.'])
        expect(h.state()).toBe('playing')
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 10, end: 16 },
            { follow: true },
        )
    })

    it('continues the paused sentence when the reader did not move', async () => {
        const h = await playOnPageOne()
        click(h.button('toggle'))
        click(h.button('toggle'))
        expect(h.provider.utterances).toHaveLength(1)
        expect(h.state()).toBe('playing')
    })
})

describe('a move of the view to the marker', () => {
    const PAGE_ONE = positionAt({ start: 0, end: 9 })
    const PAGE_TWO = positionAt({ start: 9, end: 16 }, 2)

    it('is not a move of the reader, also when its position comes late', async () => {
        const h = make()
        relocate(h, PAGE_TWO)
        // 'One.' is on the first page, so the view turns back to it.
        await h.play({ spineIndex: 0, offset: 0 })
        await vi.advanceTimersByTimeAsync(LAYOUT_SETTLE_MS)
        h.provider.end()
        h.provider.last().onStart()
        h.provider.end()
        // The voice is at 'Three.' on the second page when the first page shows.
        relocate(h, PAGE_ONE)
        h.provider.last().onBoundary({ charIndex: 0, charLength: 5 })
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 10, end: 15 },
            { follow: true },
        )

        // The view shows the marker. From here a page turn is a move of the reader.
        relocate(h, PAGE_TWO)
        relocate(h, PAGE_ONE)
        h.provider.last().onBoundary({ charIndex: 0, charLength: 5 })
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 10, end: 15 },
            { follow: false },
        )
    })
})

describe('a move of the page by hand', () => {
    function lastFollow(h: Harness): boolean | undefined {
        return h.session.view.setActiveRange.mock.lastCall?.[1]?.follow
    }

    it.each(['wheel', 'touchmove'])(
        'stops the follow for a moment after a %s event',
        async (type) => {
            const h = make()
            await h.play()
            document.body.dispatchEvent(new Event(type, { bubbles: true }))
            // The scroll view did not send its new position yet.
            h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
            expect(lastFollow(h)).toBe(false)

            await vi.advanceTimersByTimeAsync(HAND_MOVE_MS)
            h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
            expect(lastFollow(h)).toBe(true)
        },
    )

    it('stops the follow for a scroll while a pointer is down, and not for other scrolls', async () => {
        const h = make()
        await h.play()
        // The view scrolls to the marker.
        document.body.dispatchEvent(new Event('scroll'))
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(lastFollow(h)).toBe(true)

        // The reader drags the scroll bar.
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        document.body.dispatchEvent(new Event('scroll'))
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(lastFollow(h)).toBe(false)
    })

    it('stops the follow for a key that moves the page', async () => {
        const h = make()
        await h.play()
        h.press('ArrowDown')
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(lastFollow(h)).toBe(false)
    })

    it('does not stop the follow for a scroll in the bar or in a panel', async () => {
        const h = make()
        await h.play()
        h.button('toggle').dispatchEvent(new Event('wheel', { bubbles: true }))
        h.host.dispatchEvent(new Event('touchmove', { bubbles: true }))
        h.provider.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(lastFollow(h)).toBe(true)
    })

    it('follows again at once for a sentence step', async () => {
        const h = make()
        await h.play()
        document.body.dispatchEvent(new Event('wheel', { bubbles: true }))
        click(h.button('next'))
        expect(lastFollow(h)).toBe(true)
    })
})

describe('a start inside a sentence', () => {
    const CHAPTER = 'One two three. Four five six.'

    it('speaks from the first word of the page', async () => {
        const h = make({ chapters: [CHAPTER], position: { spineIndex: 0, offset: 4 } })
        await h.play()
        expect(h.spoken()).toEqual(['two three.'])
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 4, end: 14 },
            { follow: true },
        )
    })

    it('speaks from the start of the selected word', async () => {
        const h = make({ chapters: [CHAPTER] })
        // The offset 21 is inside 'five'.
        await h.play({ spineIndex: 0, offset: 21 })
        expect(h.spoken()).toEqual(['five six.'])
    })

    it('speaks the full sentence after a step back', async () => {
        const h = make({ chapters: [CHAPTER], position: { spineIndex: 0, offset: 20 } })
        await h.play()
        expect(h.spoken()).toEqual(['five six.'])
        click(h.button('previous'))
        expect(h.spoken()).toEqual(['five six.', 'One two three.'])
        click(h.button('next'))
        expect(h.spoken()).toEqual(['five six.', 'One two three.', 'five six.'])
    })
})

describe('isInSight', () => {
    const range = { spineIndex: 0, start: 5, end: 9 }

    it('is true when a part of the range is in the visible text', () => {
        expect(isInSight(range, positionAt({ start: 0, end: 6 }))).toBe(true)
        expect(isInSight(range, positionAt({ start: 8, end: 16 }))).toBe(true)
        expect(isInSight(range, positionAt({ start: 9, end: 16 }))).toBe(false)
        expect(isInSight(range, positionAt({ start: 0, end: 5 }))).toBe(false)
        expect(isInSight(range, positionAt({ spineIndex: 1, start: 0, end: 16 }))).toBe(false)
    })

    it('takes the start of the next chapter as in sight below a chapter end in the scroll view', () => {
        const next = { spineIndex: 1, start: 0, end: 4 }
        expect(isInSight(next, positionAt({ start: 9, end: 16 }, null))).toBe(true)
        // The end of the chapter is not on screen.
        expect(isInSight(next, positionAt({ start: 9, end: 12 }, null))).toBe(false)
        // A page of the paged view has text of one chapter only.
        expect(isInSight(next, positionAt({ start: 9, end: 16 }))).toBe(false)
        expect(
            isInSight(
                { spineIndex: 1, start: 5000, end: 5004 },
                positionAt({ start: 9, end: 16 }, null),
            ),
        ).toBe(false)
    })
})

describe('the end of a chapter', () => {
    it('continues with the next chapter in the same call chain', async () => {
        const h = make({ chapters: ['One.', 'Two.'] })
        await h.play()
        // The text of the next chapter loads before the end.
        await flush()
        h.provider.calls.length = 0

        h.provider.end()
        expect(h.provider.calls).toEqual(['speak'])
        expect(h.spoken()).toEqual(['One.', 'Two.'])
        expect(h.state()).toBe('playing')
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 1, start: 0, end: 4 },
            { follow: true },
        )
    })

    it('does not show a stopped state while the next chapter loads', async () => {
        const h = make({ chapters: ['One.', 'Two.'] })
        const release = holdChapter(h, 1)
        await h.play()

        h.provider.end()
        await flush()
        expect(h.spoken()).toEqual(['One.'])
        expect(h.state()).toBe('playing')
        expect(h.wakeLock.release).not.toHaveBeenCalled()

        release()
        await flush()
        expect(h.spoken()).toEqual(['One.', 'Two.'])
        expect(h.state()).toBe('playing')
        // The screen lock stays for the full change of the chapter.
        expect(h.wakeLock.release).not.toHaveBeenCalled()
        expect(h.wakeLock.request).toHaveBeenCalledTimes(1)
    })

    it('does not start the next chapter when the user paused while it loaded', async () => {
        const h = make({ chapters: ['One.', 'Two.'] })
        const release = holdChapter(h, 1)
        await h.play()
        h.provider.end()
        await flush()

        click(h.button('toggle'))
        expect(h.state()).toBe('paused')
        release()
        await flush()
        expect(h.spoken()).toEqual(['One.'])

        click(h.button('toggle'))
        expect(h.spoken()).toEqual(['One.', 'Two.'])
    })

    it('skips a chapter with no sentences and a chapter that is not linear', async () => {
        const h = make({
            chapters: ['One.', '   ', { text: 'A note.', linear: false }, '', 'Five.'],
        })
        await h.play()
        await flush()
        h.provider.end()

        expect(h.spoken()).toEqual(['One.', 'Five.'])
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 4, start: 0, end: 5 },
            { follow: true },
        )
        // A chapter with no text gets no full load.
        const loaded = h.session.content.load.mock.calls.map(([index]) => index)
        expect(loaded).toEqual([0, 4])
    })

    it('skips a chapter that has no text to speak', async () => {
        const h = make({ chapters: ['One.', '***', 'Three.'] })
        await h.play()
        await flush()
        h.provider.end()
        await flush()
        expect(h.spoken()).toEqual(['One.', 'Three.'])
        expect(h.state()).toBe('playing')
    })

    it('skips a chapter that does not load', async () => {
        const h = make({ chapters: ['One.', 'Two.', 'Three.'] })
        const load = h.session.content.loadText.getMockImplementation()
        h.session.content.loadText.mockImplementation(async (index) => {
            if (index === 1) throw new Error('The chapter is damaged.')
            return load!(index)
        })
        await h.play()
        await flush()
        h.provider.end()
        expect(h.spoken()).toEqual(['One.', 'Three.'])
    })

    it('starts in the next chapter when the start chapter has no text after the locator', async () => {
        const h = make({ chapters: ['', 'Two.'] })
        await h.bar.start({ spineIndex: 0, offset: 0 })
        expect(h.spoken()).toEqual(['Two.'])
    })

    it('stops with a message at the end of the book', async () => {
        const h = make({ chapters: ['One.'] })
        await h.play()
        h.provider.end()

        expect(h.toast()).toBe('End of the book')
        expect(h.bar.active).toBe(false)
        expect(h.element()).toBeNull()
        expect(h.session.mode).toBe('read')
        expect(h.onExit).toHaveBeenCalledTimes(1)
    })

    it('stops with a message when the book has nothing to speak from the start position', async () => {
        const h = make({ chapters: ['One.', ''] })
        await h.bar.start({ spineIndex: 0, offset: 4 })
        expect(h.toast()).toBe('End of the book')
        expect(h.bar.active).toBe(false)
        expect(h.provider.utterances).toHaveLength(0)
    })
})

describe('stop', () => {
    it('does the steps in order', async () => {
        const h = make()
        await h.play()
        h.log.length = 0
        let barAtModeChange: Element | null = h.element()
        h.session.setMode.mockImplementationOnce((mode) => {
            barAtModeChange = h.element()
            h.log.push(`mode:${mode}`)
            h.session.mode = mode
        })

        await h.bar.stop()
        expect(h.log).toEqual(['cancel', 'marker:null', 'wake:release', 'mode:read', 'exit'])
        expect(barAtModeChange).toBeNull()
        expect(h.bar.active).toBe(false)
    })

    it('removes the bar, the menus, the listeners and the timers', async () => {
        const h = make()
        await h.play()
        click(h.button('voices'))
        click(h.button('sleep'))
        click(menuItem(SLEEP_MENU_ID, '[data-sleep="5"]'))
        const listeners = h.session.listenerCount()
        expect(listeners).toBeGreaterThan(0)

        await h.bar.stop()
        expect(h.element()).toBeNull()
        expect(document.getElementById(RATE_MENU_ID)).toBeNull()
        expect(document.getElementById(SLEEP_MENU_ID)).toBeNull()
        expect(sheet().open).toBe(false)
        expect(h.session.listenerCount()).toBe(0)

        // The sleep timer, the keys and the settings do nothing now.
        h.provider.calls.length = 0
        await vi.advanceTimersByTimeAsync(10 * MINUTE)
        h.press(' ')
        h.settings.update({ speech: { rate: 2, pitch: 2 } })
        h.provider.emitVoicesChanged()
        // This also runs the save timer of the settings store.
        await vi.advanceTimersByTimeAsync(MINUTE)
        expect(h.provider.calls).toEqual([])
        expect(h.toast()).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does nothing when the mode is not active', async () => {
        const h = make()
        await h.bar.stop()
        expect(h.onExit).not.toHaveBeenCalled()
        expect(h.session.setMode).not.toHaveBeenCalled()
    })

    it('ignores a load that ends after the stop', async () => {
        const h = make()
        const started = h.bar.start()
        await h.bar.stop()
        await started
        expect(h.provider.utterances).toHaveLength(0)
        expect(h.element()).toBeNull()
    })

    it('starts again in the task of the caller when the chapter is in memory', async () => {
        const h = make()
        await h.play({ spineIndex: 0, offset: 0 })
        await h.bar.stop()

        void h.bar.start({ spineIndex: 0, offset: 10 })
        expect(h.spoken()).toEqual(['One.', 'Three.'])
        expect(h.state()).toBe('playing')
        expect(loadsOf(h, 0)).toBe(1)
    })

    // The stylesheet lifts the toasts above the bar. An inline value would win over the rule
    // of the reader screen for its own bars after the mode ends.
    it('sets no inline style on the toast container', async () => {
        const h = make()
        await h.play()
        expect(qs('#toasts').getAttribute('style')).toBeNull()
        await h.bar.stop()
        expect(qs('#toasts').getAttribute('style')).toBeNull()
    })
})

describe('the focus', () => {
    it('goes to the play button when the mode starts', async () => {
        const h = make()
        const opener = document.body.appendChild(document.createElement('button'))
        opener.focus()
        void h.bar.start()
        expect(document.activeElement).toBe(h.button('toggle'))
    })

    it('stays where it is when a new place starts while the mode is active', async () => {
        const h = make()
        await h.play()
        h.button('sleep').focus()
        void h.bar.start({ spineIndex: 0, offset: 10 })
        expect(document.activeElement).toBe(h.button('sleep'))
    })

    it('goes to the close button when the controls go away', async () => {
        const h = make({ voices: [] })
        const started = h.bar.start()
        await vi.advanceTimersByTimeAsync(NO_VOICES_MS)
        await started
        expect(h.state()).toBe('unavailable')
        expect(document.activeElement).toBe(h.button('close'))
    })

    it('goes to the close button in a browser with no speech', async () => {
        const h = make({ supported: false })
        await h.bar.start()
        expect(document.activeElement).toBe(h.button('close'))
    })
})

describe('the rate', () => {
    it('shows the rate of the settings', async () => {
        const h = make()
        await h.play()
        expect(h.button('rate').textContent).toBe('1.0×')
        expect(h.button('rate').getAttribute('aria-label')).toBe('Speed, 1.0×')
    })

    it('writes a quick value to the settings and gives it to the controller', async () => {
        const h = make()
        await h.play()
        click(h.button('rate'))
        expect(isOpen(RATE_MENU_ID)).toBe(true)
        expect(menuItem(RATE_MENU_ID, '[data-rate="1"]').getAttribute('aria-checked')).toBe('true')

        click(menuItem(RATE_MENU_ID, '[data-rate="1.5"]'))
        expect(isOpen(RATE_MENU_ID)).toBe(false)
        expect(h.settings.get().speech.rate).toBe(1.5)
        expect(h.button('rate').textContent).toBe('1.5×')
        expect(menuItem(RATE_MENU_ID, '[data-rate="1.5"]').getAttribute('aria-checked')).toBe(
            'true',
        )

        await vi.advanceTimersByTimeAsync(RATE_APPLY_MS)
        expect(h.provider.last().rate).toBe(1.5)
        expect(h.spoken()).toEqual(['One.', 'One.'])
    })

    it('steps by 0.1 and starts the sentence again one time', async () => {
        const h = make()
        await h.play()
        click(h.button('rate'))
        const menu = qs(`#${RATE_MENU_ID}`)
        const faster = qs('[data-step="1"]', menu)
        click(faster)
        click(faster)
        click(qs('[data-step="-1"]', menu))

        // A step keeps the menu open.
        expect(isOpen(RATE_MENU_ID)).toBe(true)
        expect(h.settings.get().speech.rate).toBe(1.1)
        expect(qs('.stepper-value', menu).textContent).toBe('1.1×')
        expect(h.provider.utterances).toHaveLength(1)

        await vi.advanceTimersByTimeAsync(RATE_APPLY_MS)
        expect(h.provider.utterances).toHaveLength(2)
        expect(h.provider.last().rate).toBe(1.1)
    })

    it('stops at the limits', async () => {
        const h = make({ settings: { speech: { rate: 2 } } })
        await h.play()
        click(h.button('rate'))
        const menu = qs(`#${RATE_MENU_ID}`)
        expect(qs('[data-step="1"]', menu).getAttribute('aria-disabled')).toBe('true')
        expect(qs('[data-step="-1"]', menu).getAttribute('aria-disabled')).toBe('false')
        click(qs('[data-step="1"]', menu))
        expect(h.settings.get().speech.rate).toBe(2)

        h.settings.update({ speech: { rate: 0.5 } })
        expect(qs('[data-step="-1"]', menu).getAttribute('aria-disabled')).toBe('true')
        click(qs('[data-step="-1"]', menu))
        expect(h.settings.get().speech.rate).toBe(0.5)
    })
})

describe('the voice sheet', () => {
    it('shows the voices of the book language first and the others in a closed group', async () => {
        const h = make()
        await h.play()
        click(h.button('voices'))

        const dialog = sheet()
        expect(dialog.open).toBe(true)
        expect(qs('.sheet-title', dialog).textContent).toBe('Voice')
        const names = (group: string): (string | null)[] =>
            qsa(`[data-group="${group}"] .list-row-title`, dialog).map((item) => item.textContent)
        expect(names('book')).toEqual(['Brian', 'Alice'])
        expect(names('other')).toEqual(['Chloe'])
        expect(qs<HTMLDetailsElement>('details', dialog).open).toBe(false)
        expect(qs('summary', dialog).textContent?.trim()).toBe('Other languages')

        expect(qs('.list-row-meta', voiceRow('Alice')).textContent).toBe('en-US · On this device')
        expect(qs('.list-row-meta', voiceRow('Brian')).textContent).toBe('en-GB')
    })

    it('marks the voice that pickVoice gives', async () => {
        const h = make()
        await h.play()
        click(h.button('voices'))

        expect(voiceRow('Alice').getAttribute('role')).toBe('radio')
        expect(voiceRow('Alice').getAttribute('aria-checked')).toBe('true')
        expect(voiceRow('Brian').getAttribute('aria-checked')).toBe('false')
        expect(voiceRow('Alice').tabIndex).toBe(0)
        expect(voiceRow('Brian').tabIndex).toBe(-1)
        expect(document.activeElement).toBe(voiceRow('Alice'))
    })

    it('opens the group of the other languages when the saved voice is in it', async () => {
        const h = make({ settings: { speech: { voiceId: 'fr-fr-chloe' } } })
        await h.play()
        click(h.button('voices'))
        expect(qs<HTMLDetailsElement>('details', sheet()).open).toBe(true)
        expect(voiceRow('Chloe').getAttribute('aria-checked')).toBe('true')
    })

    it('shows all voices when the book language has none', async () => {
        const h = make({ language: 'de' })
        await h.play()
        click(h.button('voices'))
        const dialog = sheet()
        expect(qs('[data-group="book"]', dialog).hidden).toBe(true)
        expect(qs<HTMLDetailsElement>('details', dialog).open).toBe(true)
        expect(qsa('[data-group="other"] .listen-voice', dialog)).toHaveLength(3)
    })

    it('puts a voice name in the page as text', async () => {
        const h = make({
            voices: [
                { id: 'x', name: '<img src=x>', lang: 'en-US', local: false, isDefault: true },
            ],
        })
        await h.play()
        click(h.button('voices'))
        expect(sheet().querySelector('img')).toBeNull()
        expect(qs('.list-row-title', sheet()).textContent).toBe('<img src=x>')
    })

    it('selects a voice, writes it and speaks the sentence again', async () => {
        const h = make()
        await h.play({ spineIndex: 0, offset: 5 })
        click(h.button('voices'))
        click(voiceRow('Brian'))

        expect(h.settings.get().speech.voiceId).toBe('en-gb-brian')
        expect(h.spoken()).toEqual(['Two.', 'Two.'])
        expect(h.provider.last().voice).toBe('en-gb-brian')
        expect(voiceRow('Brian').getAttribute('aria-checked')).toBe('true')
        expect(voiceRow('Alice').getAttribute('aria-checked')).toBe('false')
        expect(voiceRow('Brian').tabIndex).toBe(0)
    })

    it('speaks the sentence again for the voice that is selected already', async () => {
        const h = make()
        await h.play({ spineIndex: 0, offset: 5 })
        click(h.button('voices'))
        click(voiceRow('Alice'))
        expect(h.settings.get().speech.voiceId).toBe('en-us-alice')
        expect(h.spoken()).toEqual(['Two.', 'Two.'])
        expect(h.provider.last().voice).toBe('en-us-alice')
    })

    it('speaks with the new voice when speech is paused', async () => {
        const h = make()
        await h.play()
        click(h.button('toggle'))
        expect(h.state()).toBe('paused')
        click(h.button('voices'))
        click(voiceRow('Brian'))
        expect(h.spoken()).toEqual(['One.', 'One.'])
        expect(h.provider.last().voice).toBe('en-gb-brian')
        expect(h.state()).toBe('playing')
    })

    it('moves the focus with the arrow keys and does not select', async () => {
        const h = make()
        await h.play()
        click(h.button('voices'))
        const down = h.press('ArrowUp', {}, voiceRow('Alice'))
        expect(down.defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(voiceRow('Brian'))
        h.press('End', {}, voiceRow('Brian'))
        // The closed group is not in reach.
        expect(document.activeElement).toBe(voiceRow('Alice'))
        expect(h.settings.get().speech.voiceId).toBeNull()
        expect(h.provider.utterances).toHaveLength(1)
    })

    it('writes the pitch at the end of a drag', async () => {
        const h = make()
        await h.play()
        click(h.button('voices'))
        const slider = qs<HTMLInputElement>('[data-setting="pitch"]', sheet())
        expect(slider.min).toBe('0.5')
        expect(slider.max).toBe('2')
        expect(slider.value).toBe('1')

        slider.value = '1.4'
        slider.dispatchEvent(new Event('input', { bubbles: true }))
        expect(qs('.slider-value', sheet()).textContent).toBe('1.4')
        expect(h.settings.get().speech.pitch).toBe(1)
        expect(h.provider.utterances).toHaveLength(1)

        slider.dispatchEvent(new Event('change', { bubbles: true }))
        expect(h.settings.get().speech.pitch).toBe(1.4)
        expect(h.provider.last().pitch).toBe(1.4)
        expect(h.provider.utterances).toHaveLength(2)
    })

    it('writes the word highlight switch', async () => {
        const h = make()
        await h.play()
        click(h.button('voices'))
        const input = qs<HTMLInputElement>('[data-setting="highlight-words"]', sheet())
        expect(input.checked).toBe(true)
        expect(sheet().textContent).toContain(
            'Some voices do not report words. Then the sentence is highlighted.',
        )
        input.checked = false
        input.dispatchEvent(new Event('change', { bubbles: true }))
        expect(h.settings.get().speech.highlightWords).toBe(false)
    })

    it('gives the focus back to the voice button when it closes', async () => {
        const h = make()
        await h.play()
        h.button('voices').focus()
        click(h.button('voices'))
        click(qs('[data-close]', sheet()))
        expect(sheet().open).toBe(false)
        expect(document.activeElement).toBe(h.button('voices'))
    })
})

describe('late voices', () => {
    it('waits a short time for the voice list before the first start', async () => {
        const h = make({ voices: [] })
        const started = h.bar.start()
        await flush()
        expect(h.provider.utterances).toHaveLength(0)

        h.provider.voices = VOICES
        h.provider.emitVoicesChanged()
        await started
        expect(h.provider.utterances).toHaveLength(1)
        expect(h.provider.last().voice).toBe('en-us-alice')
    })

    it('starts with the default voice after the wait and changes to the voice that comes', async () => {
        const h = make({ voices: [] })
        const started = h.bar.start()
        await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS)
        await started
        expect(h.provider.last().voice).toBeNull()
        h.provider.last().onStart()

        h.provider.voices = VOICES
        h.provider.emitVoicesChanged()
        expect(h.provider.utterances).toHaveLength(2)
        expect(h.provider.last().voice).toBe('en-us-alice')
        // The check for no voices has no use now.
        await vi.advanceTimersByTimeAsync(NO_VOICES_MS)
        expect(h.state()).toBe('playing')
    })

    it('draws the list of the open sheet again', async () => {
        const h = make({ voices: [VOICES[0]] })
        await h.play()
        click(h.button('voices'))
        expect(qsa('.listen-voice', sheet())).toHaveLength(1)

        h.provider.voices = VOICES
        h.provider.emitVoicesChanged()
        expect(qsa('.listen-voice', sheet())).toHaveLength(3)
        expect(voiceRow('Alice').getAttribute('aria-checked')).toBe('true')
    })
})

describe('no voices', () => {
    it('shows the text and only the close button when the browser has no speech', async () => {
        const h = make({ supported: false })
        await h.bar.start()

        expect(h.state()).toBe('unavailable')
        expect(qs('.listen-message', h.dock).hidden).toBe(false)
        expect(qs('.listen-message', h.dock).textContent).toBe(NO_VOICES_TEXT)
        expect(qs('.listen-controls', h.dock).hidden).toBe(true)
        expect(h.button('close').closest('[hidden]')).toBeNull()
        expect(h.session.content.loadText).not.toHaveBeenCalled()
        expect(h.provider.utterances).toHaveLength(0)

        click(h.button('close'))
        expect(h.bar.active).toBe(false)
        expect(h.onExit).toHaveBeenCalledTimes(1)
    })

    it('shows the text when the voice list is empty after 2 seconds', async () => {
        const h = make({ voices: [] })
        const started = h.bar.start()
        await vi.advanceTimersByTimeAsync(NO_VOICES_MS - 1)
        await started
        expect(h.state()).not.toBe('unavailable')

        h.log.length = 0
        await vi.advanceTimersByTimeAsync(1)
        expect(h.state()).toBe('unavailable')
        expect(qs('.listen-message', h.dock).hidden).toBe(false)
        expect(qs('.listen-controls', h.dock).hidden).toBe(true)
        expect(h.log).toContain('cancel')
        // The keys do not start speech.
        h.press(' ')
        expect(h.provider.utterances).toHaveLength(1)
    })

    it('reads the voice list again after 2 seconds, with no event from the browser', async () => {
        const h = make({ voices: [] })
        const started = h.bar.start()
        await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS)
        await started
        // Some browsers fill the list and do not tell.
        h.provider.voices = VOICES
        await vi.advanceTimersByTimeAsync(NO_VOICES_MS)

        expect(h.state()).not.toBe('unavailable')
        expect(qs('.listen-controls', h.dock).hidden).toBe(false)
        expect(h.provider.last().voice).toBe('en-us-alice')
        click(h.button('voices'))
        expect(qsa('.listen-voice', sheet())).toHaveLength(3)
    })

    it('keeps the controls when the browser speaks with no voice list', async () => {
        const h = make({ voices: [] })
        const started = h.bar.start()
        await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS)
        await started
        h.provider.last().onStart()
        await vi.advanceTimersByTimeAsync(NO_VOICES_MS)
        expect(h.state()).toBe('playing')
    })

    it('shows the controls again when the voices come after the limit', async () => {
        const h = make({ voices: [] })
        const started = h.bar.start()
        await vi.advanceTimersByTimeAsync(NO_VOICES_MS)
        await started
        expect(h.state()).toBe('unavailable')

        h.provider.voices = VOICES
        h.provider.emitVoicesChanged()
        expect(h.state()).toBe('paused')
        expect(qs('.listen-controls', h.dock).hidden).toBe(false)
        expect(qs('.listen-message', h.dock).hidden).toBe(true)

        click(h.button('toggle'))
        expect(h.provider.last().voice).toBe('en-us-alice')
        expect(h.state()).toBe('playing')
    })
})

describe('the sleep timer', () => {
    function choose(h: Harness, value: string): void {
        click(h.button('sleep'))
        click(menuItem(SLEEP_MENU_ID, `[data-sleep="${value}"]`))
    }

    function checked(): string | undefined {
        return qsa(`#${SLEEP_MENU_ID} [data-sleep]`).find(
            (item) => item.getAttribute('aria-checked') === 'true',
        )?.dataset.sleep
    }

    it('has the times and the end of the chapter', async () => {
        const h = make()
        await h.play()
        click(h.button('sleep'))
        expect(isOpen(SLEEP_MENU_ID)).toBe(true)
        const labels = qsa(`#${SLEEP_MENU_ID} .menu-item`).map((item) => item.textContent)
        expect(labels).toEqual([
            'Off',
            '5 minutes',
            '10 minutes',
            '15 minutes',
            '30 minutes',
            '45 minutes',
            '60 minutes',
            'End of the chapter',
        ])
        expect(checked()).toBe('off')
    })

    it('shows the minutes that are left', async () => {
        const h = make()
        await h.play()
        choose(h, '15')
        const left = qs('.listen-sleep-left', h.dock)
        expect(left.hidden).toBe(false)
        expect(left.textContent).toBe('15')
        expect(h.button('sleep').getAttribute('aria-label')).toBe('Sleep timer, 15 minutes left')
        expect(h.button('sleep').classList.contains('is-on')).toBe(true)

        await listenFor(h, MINUTE)
        expect(left.textContent).toBe('14')
        await listenFor(h, 13 * MINUTE)
        expect(left.textContent).toBe('1')
        expect(h.button('sleep').getAttribute('aria-label')).toBe('Sleep timer, 1 minute left')

        click(h.button('sleep'))
        expect(checked()).toBe('15')
    })

    it.each(['5', '10', '15', '30', '45', '60'])(
        'pauses speech after %s minutes and shows a message',
        async (minutes) => {
            const h = make()
            await h.play()
            choose(h, minutes)
            h.provider.calls.length = 0

            await listenFor(h, Number(minutes) * MINUTE - 1)
            expect(h.state()).toBe('playing')
            await vi.advanceTimersByTimeAsync(1)

            expect(h.provider.calls).toEqual(['pause'])
            expect(h.state()).toBe('paused')
            expect(h.toast()).toBe(SLEEP_TOAST)
            expect(qs('.listen-sleep-left', h.dock).hidden).toBe(true)
            expect(h.button('sleep').getAttribute('aria-label')).toBe('Sleep timer')
            expect(h.button('sleep').classList.contains('is-on')).toBe(false)
        },
    )

    it('shows no message when speech is paused at the end of the time', async () => {
        const h = make()
        await h.play()
        choose(h, '5')
        click(h.button('toggle'))
        await vi.advanceTimersByTimeAsync(5 * MINUTE)
        expect(h.toast()).toBeNull()
        expect(h.button('sleep').classList.contains('is-on')).toBe(false)
    })

    it('stops at the end of the chapter and does not load the next chapter', async () => {
        const h = make({ chapters: ['One.', 'Two.'] })
        await h.play()
        choose(h, 'chapter')
        expect(h.button('sleep').getAttribute('aria-label')).toBe(
            'Sleep timer, to the end of the chapter',
        )
        expect(qs('.listen-sleep-left', h.dock).hidden).toBe(true)
        await flush()

        h.provider.end()
        await flush()
        expect(h.spoken()).toEqual(['One.'])
        expect(h.state()).toBe('paused')
        expect(h.toast()).toBe(SLEEP_TOAST)
        expect(h.button('sleep').classList.contains('is-on')).toBe(false)

        // The play button continues with the next chapter, in the task of the click.
        click(h.button('toggle'))
        expect(h.spoken()).toEqual(['One.', 'Two.'])
        expect(h.state()).toBe('playing')
    })

    it('clears the timer with the Off item', async () => {
        const h = make()
        await h.play()
        choose(h, '5')
        choose(h, 'off')
        expect(qs('.listen-sleep-left', h.dock).hidden).toBe(true)
        await listenFor(h, 5 * MINUTE)
        expect(h.state()).toBe('playing')
        expect(h.toast()).toBeNull()
    })

    it('clears the timer at a new start', async () => {
        const h = make({ chapters: ['One. Two.', 'Three.'] })
        await h.play()
        choose(h, 'chapter')
        void h.bar.start({ spineIndex: 0, offset: 5 })
        expect(h.button('sleep').classList.contains('is-on')).toBe(false)

        choose(h, '5')
        void h.bar.start({ spineIndex: 0, offset: 0 })
        expect(qs('.listen-sleep-left', h.dock).hidden).toBe(true)
        await listenFor(h, 5 * MINUTE)
        expect(h.state()).toBe('playing')
    })
})

describe('the keyboard', () => {
    it.each([' ', 'k', 'K'])('pauses and plays with the key "%s"', async (key) => {
        const h = make()
        await h.play()
        h.provider.calls.length = 0

        const event = h.press(key)
        expect(event.defaultPrevented).toBe(true)
        expect(h.provider.calls).toEqual(['pause'])
        expect(h.state()).toBe('paused')

        h.press(key)
        expect(h.provider.calls).toEqual(['pause', 'resume'])
        expect(h.state()).toBe('playing')
    })

    it('goes to the next and the previous sentence with the arrow keys', async () => {
        const h = make()
        await h.play()
        h.press('ArrowRight')
        expect(h.spoken()).toEqual(['One.', 'Two.'])
        h.press('ArrowRight')
        expect(h.spoken()).toEqual(['One.', 'Two.', 'Three.'])
        h.press('ArrowLeft')
        expect(h.spoken()).toEqual(['One.', 'Two.', 'Three.', 'Two.'])
    })

    it('turns the page with PageDown and PageUp', async () => {
        const h = make()
        await h.play()
        expect(h.press('PageDown').defaultPrevented).toBe(true)
        expect(h.session.next).toHaveBeenCalledTimes(1)
        h.press('PageUp')
        expect(h.session.prev).toHaveBeenCalledTimes(1)
        // Speech continues.
        expect(h.provider.utterances).toHaveLength(1)
        expect(h.state()).toBe('playing')
    })

    it('stops the mode with Escape', async () => {
        const h = make()
        await h.play()
        h.press('Escape')
        expect(h.bar.active).toBe(false)
        expect(h.onExit).toHaveBeenCalledTimes(1)
    })

    it('ignores a key in an input', async () => {
        const h = make()
        await h.play()
        const input = document.body.appendChild(document.createElement('input'))
        for (const key of [' ', 'k', 'ArrowRight', 'Escape', 'PageDown']) {
            expect(h.press(key, {}, input).defaultPrevented).toBe(false)
        }
        expect(h.state()).toBe('playing')
        expect(h.provider.utterances).toHaveLength(1)
        expect(h.session.next).not.toHaveBeenCalled()
    })

    it('ignores a key while a dialog is open', async () => {
        const h = make()
        await h.play()
        click(h.button('voices'))
        h.press('Escape')
        h.press(' ')
        h.press('ArrowRight', {}, voiceRow('Alice'))
        expect(h.bar.active).toBe(true)
        expect(h.state()).toBe('playing')
        expect(h.provider.utterances).toHaveLength(1)
    })

    it('ignores a key while a menu is open', async () => {
        const h = make()
        await h.play()
        click(h.button('sleep'))
        h.press('Escape', {}, menuItem(SLEEP_MENU_ID, '[data-sleep="off"]'))
        h.press('ArrowRight')
        expect(h.bar.active).toBe(true)
        expect(h.provider.utterances).toHaveLength(1)
    })

    it('leaves Space on a button to the button', async () => {
        const h = make()
        await h.play()
        expect(h.press(' ', {}, h.button('next')).defaultPrevented).toBe(false)
        expect(h.state()).toBe('playing')
        // A letter key on a button is a key of the mode.
        h.press('k', {}, h.button('next'))
        expect(h.state()).toBe('paused')
    })

    it('ignores a key with a modifier, a held key and a handled key', async () => {
        const h = make()
        await h.play()
        h.press('k', { ctrlKey: true })
        h.press('k', { metaKey: true })
        h.press('ArrowRight', { altKey: true })
        h.press('k', { repeat: true })
        h.press('ArrowRight', { repeat: true })
        const handled = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true })
        handled.preventDefault()
        document.body.dispatchEvent(handled)

        expect(h.state()).toBe('playing')
        expect(h.provider.utterances).toHaveLength(1)
        // A held page key turns more pages.
        h.press('PageDown', { repeat: true })
        expect(h.session.next).toHaveBeenCalledTimes(1)
    })

    it('does not use the keys of the book in other keys', async () => {
        const h = make()
        await h.play()
        expect(h.press('ArrowDown').defaultPrevented).toBe(false)
        expect(h.press('l').defaultPrevented).toBe(false)
    })
})

describe('the buttons', () => {
    it('go to the previous and the next sentence', async () => {
        const h = make()
        await h.play()
        click(h.button('next'))
        expect(h.spoken()).toEqual(['One.', 'Two.'])
        click(h.button('previous'))
        expect(h.spoken()).toEqual(['One.', 'Two.', 'One.'])
    })

    it('move the marker while speech is paused', async () => {
        const h = make()
        await h.play()
        click(h.button('toggle'))
        click(h.button('next'))
        expect(h.provider.utterances).toHaveLength(1)
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )
        click(h.button('toggle'))
        expect(h.spoken()).toEqual(['One.', 'Two.'])
    })

    it('show where speech starts again after an error', async () => {
        const h = make()
        await h.play()
        h.provider.fail('synthesis-failed')
        click(h.button('next'))
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 0, start: 5, end: 9 },
            { follow: true },
        )
        click(h.button('toggle'))
        expect(h.spoken()).toEqual(['One.', 'Two.'])
    })

    it('load the next chapter at the last sentence while speech is paused', async () => {
        const h = make({ chapters: ['One.', 'Two.'] })
        await h.play()
        click(h.button('toggle'))
        click(h.button('next'))
        await flush()

        expect(h.provider.utterances).toHaveLength(1)
        expect(h.state()).toBe('paused')
        expect(h.session.view.setActiveRange).toHaveBeenLastCalledWith(
            { spineIndex: 1, start: 0, end: 4 },
            { follow: true },
        )
        click(h.button('toggle'))
        expect(h.spoken()).toEqual(['One.', 'Two.'])
    })

    it('keep the mode at the last sentence of the book while speech is paused', async () => {
        const h = make({ chapters: ['One.'] })
        await h.play()
        click(h.button('toggle'))
        click(h.button('next'))
        await flush()
        expect(h.bar.active).toBe(true)
        expect(h.state()).toBe('paused')
        expect(h.toast()).toBeNull()
    })

    it('do nothing while a chapter loads', async () => {
        const h = make()
        const started = h.bar.start()
        click(h.button('toggle'))
        click(h.button('next'))
        click(h.button('previous'))
        await started
        expect(h.spoken()).toEqual(['One.'])
        expect(h.state()).toBe('loading')
    })

    it('stop the mode with the close button', async () => {
        const h = make()
        await h.play()
        expect(h.button('close').getAttribute('aria-label')).toBe('Stop listening')
        click(h.button('close'))
        expect(h.bar.active).toBe(false)
        expect(h.element()).toBeNull()
    })

    it('have a label each', async () => {
        const h = make()
        await h.play()
        for (const button of qsa('button', h.dock)) {
            expect(button.getAttribute('aria-label')).toBeTruthy()
        }
    })
})

describe('errors', () => {
    it('shows a message and the play button when the voice stops', async () => {
        const h = make()
        await h.play()
        h.provider.fail('synthesis-failed')
        expect(h.toast()).toBe(ERROR_TOAST)
        expect(h.state()).toBe('paused')
        expect(h.button('toggle').getAttribute('aria-label')).toBe('Play')

        click(h.button('toggle'))
        expect(h.spoken()).toEqual(['One.', 'One.'])
        expect(h.state()).toBe('playing')
    })

    it('shows the message when the browser refuses a start from a user action', async () => {
        const h = make()
        await h.play()
        click(h.button('next'))
        h.provider.fail('not-allowed')
        expect(h.toast()).toBe(ERROR_TOAST)
    })

    it('stops speech when the page goes away', async () => {
        const h = make()
        await h.play()
        h.log.length = 0
        window.dispatchEvent(new Event('pagehide'))
        expect(h.log).toEqual(['cancel', 'wake:release'])
        expect(h.state()).toBe('paused')
        expect(h.bar.active).toBe(true)
    })

    it('ends with no exit call when a different mode starts', async () => {
        const h = make()
        await h.play()
        h.session.setMode.mockClear()
        h.session.mode = 'speed'
        h.session.emit('mode', 'speed')

        expect(h.bar.active).toBe(false)
        expect(h.element()).toBeNull()
        expect(h.log).toContain('cancel')
        expect(h.session.setMode).not.toHaveBeenCalled()
        expect(h.onExit).not.toHaveBeenCalled()
    })
})

describe('listen from here while the mode is active', () => {
    it('speaks from the new place in the same chapter with no load', async () => {
        const h = make()
        await h.play()
        const element = h.element()
        h.session.setMode.mockClear()

        void h.bar.start({ spineIndex: 0, offset: 10 })
        // No await: the chapter is in memory.
        expect(h.spoken()).toEqual(['One.', 'Three.'])
        expect(h.state()).toBe('playing')
        expect(h.element()).toBe(element)
        expect(h.session.setMode).not.toHaveBeenCalled()
        expect(loadsOf(h, 0)).toBe(1)
    })

    it('starts speech from the new place when speech is paused', async () => {
        const h = make()
        await h.play()
        click(h.button('toggle'))
        void h.bar.start({ spineIndex: 0, offset: 5 })
        expect(h.spoken()).toEqual(['One.', 'Two.'])
        expect(h.state()).toBe('playing')
    })

    it('loads a different chapter and continues', async () => {
        const h = make()
        await h.play()
        const element = h.element()
        h.log.length = 0

        const started = h.bar.start({ spineIndex: 1, offset: 6 })
        expect(h.state()).toBe('loading')
        // Speech at the old place stops at once.
        expect(h.log).toEqual(['cancel', 'wake:release', 'marker:null'])
        await started
        expect(h.spoken()).toEqual(['One.', 'Five.'])
        expect(h.state()).toBe('playing')
        expect(h.element()).toBe(element)
    })
})

describe('the wake lock', () => {
    it('keeps the screen on while speech plays', async () => {
        const h = make()
        await h.bar.start()
        expect(h.wakeLock.request).not.toHaveBeenCalled()
        h.provider.last().onStart()
        expect(h.wakeLock.request).toHaveBeenCalledTimes(1)

        click(h.button('toggle'))
        expect(h.wakeLock.release).toHaveBeenCalledTimes(1)
        click(h.button('toggle'))
        expect(h.wakeLock.request).toHaveBeenCalledTimes(2)

        // Each sentence does not ask again.
        h.provider.end()
        expect(h.wakeLock.request).toHaveBeenCalledTimes(2)
    })

    it('does not keep the screen on when the setting is off', async () => {
        const h = make({ settings: { keepAwake: false } })
        await h.play()
        expect(h.wakeLock.request).not.toHaveBeenCalled()
    })

    it('follows a change of the setting', async () => {
        const h = make()
        await h.play()
        h.settings.update({ keepAwake: false })
        expect(h.wakeLock.release).toHaveBeenCalledTimes(1)
        h.settings.update({ keepAwake: true })
        expect(h.wakeLock.request).toHaveBeenCalledTimes(2)
    })

    it('releases the lock at the stop', async () => {
        const h = make()
        await h.play()
        await h.bar.stop()
        expect(h.wakeLock.release).toHaveBeenCalledTimes(1)
    })
})

describe('destroy', () => {
    it('does nothing more before the first start', async () => {
        const h = make()
        h.bar.destroy()
        await h.bar.start()
        expect(h.bar.active).toBe(false)
        expect(h.element()).toBeNull()
        expect(h.session.setMode).not.toHaveBeenCalled()
    })

    it('ends a start that loads', async () => {
        const h = make()
        const started = h.bar.start()
        h.bar.destroy()
        await started

        expect(h.bar.active).toBe(false)
        expect(h.element()).toBeNull()
        expect(h.provider.utterances).toHaveLength(0)
        expect(h.session.mode).toBe('read')
        expect(h.onExit).not.toHaveBeenCalled()
    })

    it('ends speech that plays', async () => {
        const h = make()
        await h.play()
        click(h.button('voices'))
        h.log.length = 0
        h.bar.destroy()

        expect(h.log).toEqual(['cancel', 'marker:null', 'wake:release', 'mode:read'])
        expect(h.element()).toBeNull()
        expect(document.querySelector('dialog.listen-voices')).toBeNull()
        expect(document.getElementById(RATE_MENU_ID)).toBeNull()
        expect(h.session.listenerCount()).toBe(0)
        expect(h.onExit).not.toHaveBeenCalled()

        h.provider.calls.length = 0
        h.press(' ')
        h.settings.update({ speech: { pitch: 2 } })
        await vi.advanceTimersByTimeAsync(10 * MINUTE)
        expect(h.provider.calls).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
    })

    it('ends paused speech', async () => {
        const h = make()
        await h.play()
        click(h.button('toggle'))
        h.bar.destroy()
        expect(h.element()).toBeNull()
        expect(h.session.mode).toBe('read')
        await vi.advanceTimersByTimeAsync(MINUTE)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('ends the wait for the first sound', async () => {
        const h = make()
        await h.bar.start()
        // jsdom sends the selectionchange event of a focus change in a later task.
        await flush()
        expect(vi.getTimerCount()).toBeGreaterThan(0)
        h.bar.destroy()
        expect(vi.getTimerCount()).toBe(0)
        expect(h.element()).toBeNull()
    })

    it('ends the state with no voices', async () => {
        const h = make({ supported: false })
        await h.bar.start()
        h.bar.destroy()
        expect(h.element()).toBeNull()
        expect(h.session.mode).toBe('read')
    })

    it('does nothing after a stop and at a second call', async () => {
        const h = make()
        await h.play()
        await h.bar.stop()
        h.session.setMode.mockClear()
        h.bar.destroy()
        h.bar.destroy()
        expect(h.session.setMode).not.toHaveBeenCalled()
        await h.bar.start()
        expect(h.bar.active).toBe(false)
    })
})
