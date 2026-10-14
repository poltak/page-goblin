import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '$lib/settings/schema'
import { createSettingsStore } from '$lib/settings/store'
import type { SettingsPatch } from '$lib/settings/store'
import { installOverlayMethods } from '../../app/testing/page'
import { clearToasts } from '../../app/toast'
import { BARS_PEEK_MS } from './bars'
import { createFrame } from './frame'
import type { ScreenFrame } from './frame'
import { PART_LOAD_MESSAGE } from './lazy-part'
import { createReaderScreen, LINE_SCROLL_PX, PANEL_CLOSE_GUARD_MS } from './screen'
import {
    makeFakeParts,
    makeFakeSession,
    RECORD,
    relocateInfo,
    tocEntry,
} from './testing/fake-session'
import type { FakeParts, FakeSessionState } from './testing/fake-session'

const cleanups: Array<() => void> = []

function setup(state: Partial<FakeSessionState> = {}, patch: SettingsPatch = {}) {
    const session = makeFakeSession(state)
    const settings = createSettingsStore({ storage: null })
    settings.update(patch)
    const frame = createFrame()
    document.body.append(frame.root)
    const parts = makeFakeParts(session)
    const onExit = vi.fn()
    const screen = createReaderScreen({ frame, session, settings, parts: parts.factories, onExit })
    // The listeners of a screen are on the window, so each test must remove its screen.
    cleanups.push(() => {
        void screen.destroy()
        settings.destroy()
    })
    return { session, settings, frame, parts, onExit, screen }
}

/** Lets the promises that are ready now run. The timers are fake, so no timer is used. */
async function flush(): Promise<void> {
    for (let round = 0; round < 20; round++) await Promise.resolve()
}

function barsVisible(frame: ScreenFrame): boolean {
    const top = !frame.topBar.hasAttribute('inert')
    const bottom = !frame.bottomBar.hasAttribute('inert')
    if (top !== bottom) throw new Error('The two bars have different states.')
    return top
}

/** Lets the time of the first moment go by, so a test starts with hidden bars. */
function hideBars(frame: ScreenFrame): void {
    vi.advanceTimersByTime(BARS_PEEK_MS)
    expect(barsVisible(frame)).toBe(false)
}

function control(frame: ScreenFrame, action: string): HTMLButtonElement {
    const button = frame.root.querySelector<HTMLButtonElement>(`[data-screen-action="${action}"]`)
    if (!button) throw new Error(`No control has the action "${action}".`)
    return button
}

function press(
    key: string,
    init: KeyboardEventInit = {},
    target: EventTarget = document.body,
): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ...init,
    })
    target.dispatchEvent(event)
    return event
}

function pointer(target: EventTarget, type: string, init: PointerEventInit = {}): void {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse', ...init }))
}

/** A tap in the page as the browser sends it, without the events of the reader view. */
function tapPage(frame: ScreenFrame, between: () => void = () => {}): void {
    pointer(frame.stage, 'pointerdown', { pointerType: 'touch' })
    pointer(frame.stage, 'pointerup', { pointerType: 'touch' })
    between()
    frame.stage.click()
}

function moveSlider(frame: ScreenFrame, value: number): void {
    frame.slider.value = String(value)
    frame.slider.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Makes the module of a mode load only when the test calls the function that comes back. */
function holdLoad(parts: FakeParts, name: 'speed' | 'listen'): () => void {
    const make = parts.factories[name].getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    parts.factories[name].mockImplementation(async (options) => {
        await gate
        return make(options)
    })
    return release
}

function toastText(): string | null {
    return document.querySelector('#toasts .toast')?.textContent ?? null
}

function iconOf(button: Element): string | null {
    return button.querySelector('use')?.getAttribute('href') ?? null
}

beforeAll(installOverlayMethods)

beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    clearToasts()
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('the top bar', () => {
    it('shows the title and the author of the book as text', () => {
        const { frame } = setup()
        expect(frame.bookTitle.textContent).toBe('The Test Book')
        expect(frame.bookAuthor.textContent).toBe('An Author')
        expect(frame.bookAuthor.hidden).toBe(false)
    })

    it('puts a title with markup into the page as text', () => {
        const { frame } = setup({
            record: { ...RECORD, title: '<img src=x onerror=alert(1)>', author: ' ' },
        })
        expect(frame.bookTitle.textContent).toBe('<img src=x onerror=alert(1)>')
        expect(frame.root.querySelector('img')).toBeNull()
        expect(frame.headText.textContent).toBe('Chapter One')
        expect(frame.bookAuthor.hidden).toBe(true)
    })

    it('has a label on each icon button', () => {
        const { frame } = setup()
        const labels = Array.from(frame.topBar.querySelectorAll('.icon-btn'), (button) =>
            button.getAttribute('aria-label'),
        )
        expect(labels).toEqual([
            'Back to the library',
            'Search',
            'Bookmark this page',
            'Contents',
            'Reading settings',
            'More',
        ])
    })

    it('calls onExit for the button back to the library', () => {
        const { frame, onExit } = setup()
        control(frame, 'exit').click()
        expect(onExit).toHaveBeenCalledTimes(1)
    })
})

describe('the bars', () => {
    it('shows the bars for 3 seconds when the book opens', () => {
        const { frame } = setup()
        expect(barsVisible(frame)).toBe(true)
        expect(frame.showBars.hidden).toBe(true)

        vi.advanceTimersByTime(BARS_PEEK_MS - 1)
        expect(barsVisible(frame)).toBe(true)
        vi.advanceTimersByTime(1)
        expect(barsVisible(frame)).toBe(false)
        expect(frame.showBars.hidden).toBe(false)
    })

    it('toggles the bars on a centre tap, and keeps them after 3 seconds', () => {
        const { frame, session } = setup()
        hideBars(frame)

        session.emit('center-tap', undefined)
        expect(barsVisible(frame)).toBe(true)
        vi.advanceTimersByTime(BARS_PEEK_MS * 2)
        expect(barsVisible(frame)).toBe(true)

        session.emit('center-tap', undefined)
        expect(barsVisible(frame)).toBe(false)
    })

    it('hides the bars on a page turn', () => {
        const { frame, session } = setup()
        session.relocate({ locator: { spineIndex: 1, offset: 200 } })
        expect(barsVisible(frame)).toBe(false)
    })

    it('keeps the bars for a relocate event with the same position', () => {
        const { frame, session } = setup()
        // The session sends the event again when the contents entry of the position changes.
        session.relocate()
        session.relocate({ page: 4, pageCount: 14 })
        expect(barsVisible(frame)).toBe(true)
    })

    it('keeps the bars when a new layout moves the start of the page', () => {
        const { frame, session } = setup()
        // Larger text. The page starts later, but it still shows text of the page before.
        session.relocate({
            locator: { spineIndex: 1, offset: 100 },
            visible: { spineIndex: 1, start: 100, end: 130 },
        })
        expect(barsVisible(frame)).toBe(true)

        // The next page turn hides them.
        session.relocate({ locator: { spineIndex: 1, offset: 130 } })
        expect(barsVisible(frame)).toBe(false)
    })

    it('keeps the bars for a move that the slider made', async () => {
        const { frame, session } = setup()
        // The view can send the event before the call returns, and also later.
        session.goToFraction.mockImplementation(async () => {
            session.relocate({ locator: { spineIndex: 2, offset: 10 } })
            await Promise.resolve()
            session.relocate({ locator: { spineIndex: 2, offset: 12 } })
        })
        moveSlider(frame, 700)
        frame.slider.dispatchEvent(new Event('change', { bubbles: true }))
        await flush()
        expect(barsVisible(frame)).toBe(true)

        // The next page turn of the user hides them.
        session.relocate({ locator: { spineIndex: 2, offset: 90 } })
        expect(barsVisible(frame)).toBe(false)
    })

    it('keeps the bars for a move that the Back button made', async () => {
        const { frame, session } = setup({ canGoBack: true })
        session.back.mockImplementation(async () => {
            session.relocate({ locator: { spineIndex: 0, offset: 0 } })
        })
        control(frame, 'back').click()
        await flush()
        expect(session.back).toHaveBeenCalledTimes(1)
        expect(barsVisible(frame)).toBe(true)
    })

    it('hides the bars on a tap in the page', () => {
        const { frame } = setup()
        tapPage(frame)
        expect(barsVisible(frame)).toBe(false)
    })

    it('does not show hidden bars on a tap in the page that is not in the centre', () => {
        const { frame } = setup()
        hideBars(frame)
        tapPage(frame)
        expect(barsVisible(frame)).toBe(false)
    })

    it('hides the bars one time for a tap in the centre of the page', () => {
        const { frame, session } = setup()
        // The reader view sends the centre tap before the click event.
        tapPage(frame, () => session.emit('center-tap', undefined))
        expect(barsVisible(frame)).toBe(false)
    })

    it('does not show the bars again when the centre tap comes after the click', () => {
        const { frame, session } = setup()
        tapPage(frame)
        session.emit('center-tap', undefined)
        expect(barsVisible(frame)).toBe(false)
    })

    it('shows hidden bars for a tap in the centre of the page', () => {
        const { frame, session } = setup()
        hideBars(frame)
        tapPage(frame, () => session.emit('center-tap', undefined))
        expect(barsVisible(frame)).toBe(true)

        tapPage(frame, () => session.emit('center-tap', undefined))
        expect(barsVisible(frame)).toBe(false)
    })

    it('hides the bars on Escape and does not stop the key', () => {
        const { frame, onExit } = setup()
        const event = press('Escape')
        expect(barsVisible(frame)).toBe(false)
        expect(event.defaultPrevented).toBe(false)
        expect(onExit).not.toHaveBeenCalled()
    })

    it('does nothing on Escape when the bars are hidden', () => {
        const { frame, onExit, session } = setup()
        hideBars(frame)
        const event = press('Escape')
        expect(barsVisible(frame)).toBe(false)
        expect(event.defaultPrevented).toBe(false)
        expect(onExit).not.toHaveBeenCalled()
        expect(session.destroy).not.toHaveBeenCalled()
    })

    it('keeps the bars while the focus is in them', () => {
        const { frame } = setup()
        control(frame, 'contents').focus()
        vi.advanceTimersByTime(BARS_PEEK_MS * 2)
        expect(barsVisible(frame)).toBe(true)
    })

    it('takes the focus out of a bar that hides', () => {
        const { frame, session } = setup()
        const button = control(frame, 'contents')
        button.focus()
        expect(document.activeElement).toBe(button)
        session.relocate({ locator: { spineIndex: 1, offset: 200 } })
        expect(barsVisible(frame)).toBe(false)
        expect(document.activeElement).not.toBe(button)
    })

    it('keeps the bars while the mouse pointer is on a bar', () => {
        const { frame } = setup()
        pointer(frame.bottomBar, 'pointerenter', { bubbles: false })
        vi.advanceTimersByTime(BARS_PEEK_MS)
        expect(barsVisible(frame)).toBe(true)
    })

    it('keeps the bars after a click on a control of a bar', async () => {
        const { frame } = setup()
        control(frame, 'bookmark').click()
        await flush()
        vi.advanceTimersByTime(BARS_PEEK_MS * 2)
        expect(barsVisible(frame)).toBe(true)
    })

    it('keeps the bars after a use of the slider', async () => {
        const { frame } = setup()
        // A touch gives the slider no focus in some browsers, and it has no pointer at rest.
        moveSlider(frame, 700)
        frame.slider.dispatchEvent(new Event('change', { bubbles: true }))
        await flush()
        vi.advanceTimersByTime(BARS_PEEK_MS * 2)
        expect(barsVisible(frame)).toBe(true)
    })

    it('shows the bars when the mouse pointer goes to the top 56 px', () => {
        const { frame } = setup()
        hideBars(frame)
        pointer(frame.stage, 'pointermove', { clientY: 300 })
        expect(barsVisible(frame)).toBe(false)
        pointer(frame.stage, 'pointermove', { clientY: 57 })
        expect(barsVisible(frame)).toBe(false)
        pointer(frame.stage, 'pointermove', { clientY: 56 })
        expect(barsVisible(frame)).toBe(true)
    })

    it('shows the bars one time for each visit of the pointer to the top', () => {
        const { frame, session } = setup()
        hideBars(frame)
        pointer(frame.stage, 'pointermove', { clientY: 10 })
        session.emit('center-tap', undefined)
        expect(barsVisible(frame)).toBe(false)

        // The pointer is still at the top. Only a new visit shows the bars again.
        pointer(frame.stage, 'pointermove', { clientY: 12 })
        expect(barsVisible(frame)).toBe(false)
        pointer(frame.stage, 'pointermove', { clientY: 200 })
        pointer(frame.stage, 'pointermove', { clientY: 12 })
        expect(barsVisible(frame)).toBe(true)
    })

    it('shows the bars when the pointer comes back to the top from outside the window', () => {
        const { frame } = setup()
        hideBars(frame)
        pointer(frame.stage, 'pointermove', { clientY: 10 })
        press('Escape')
        expect(barsVisible(frame)).toBe(false)

        // The pointer went up to the tabs of the browser. No move event came for that.
        pointer(frame.root, 'pointerleave', { bubbles: false })
        pointer(frame.stage, 'pointermove', { clientY: 12 })
        expect(barsVisible(frame)).toBe(true)
    })

    it('ignores a touch and a drag at the top of the screen', () => {
        const { frame } = setup()
        hideBars(frame)
        pointer(frame.stage, 'pointermove', { clientY: 10, pointerType: 'touch' })
        pointer(frame.stage, 'pointermove', { clientY: 10, pointerType: 'pen' })
        pointer(frame.stage, 'pointermove', { clientY: 10, buttons: 1 })
        expect(barsVisible(frame)).toBe(false)
    })

    it('does not show the bars for a pointer at the top of an open panel', () => {
        const { frame } = setup()
        hideBars(frame)
        const dialog = document.createElement('dialog')
        dialog.innerHTML = '<p>Contents</p>'
        frame.overlay.append(dialog)
        pointer(dialog.firstElementChild!, 'pointermove', { clientY: 10 })
        expect(barsVisible(frame)).toBe(false)
    })

    it('hides the bars on a tap in the page also when a part stops the press event', () => {
        const { frame } = setup()
        const stop = (event: Event): void => event.stopPropagation()
        document.addEventListener('pointerdown', stop, true)
        tapPage(frame)
        document.removeEventListener('pointerdown', stop, true)
        expect(barsVisible(frame)).toBe(false)
    })

    it('does not use the state of an old press for a tap outside the page', () => {
        const { frame, session } = setup()
        // A press in the page that ends as a drag, with no click.
        pointer(frame.stage, 'pointerdown')
        hideBars(frame)
        pointer(frame.bottomBar, 'pointerdown')
        session.emit('center-tap', undefined)
        expect(barsVisible(frame)).toBe(true)
    })

    it('puts the two bars before the page in the order of the Tab key', () => {
        const { frame } = setup()
        // The Tab key then goes from one bar to the other with no stop at each link of the book.
        const following = Node.DOCUMENT_POSITION_FOLLOWING
        expect(frame.topBar.compareDocumentPosition(frame.bottomBar) & following).toBeTruthy()
        expect(frame.bottomBar.compareDocumentPosition(frame.stage) & following).toBeTruthy()
        expect(frame.showBars.compareDocumentPosition(frame.topBar) & following).toBeTruthy()
    })

    it('makes hidden bars inert and visible bars not', () => {
        const { frame } = setup()
        expect(frame.topBar.hasAttribute('inert')).toBe(false)
        expect(frame.bottomBar.hasAttribute('inert')).toBe(false)
        hideBars(frame)
        expect(frame.topBar.hasAttribute('inert')).toBe(true)
        expect(frame.bottomBar.hasAttribute('inert')).toBe(true)
    })

    it('gives the keyboard a way to the hidden bars', () => {
        const { frame } = setup()
        hideBars(frame)
        expect(frame.showBars.hidden).toBe(false)
        expect(frame.showBars.textContent?.trim()).toBe('Show the toolbars')

        frame.showBars.focus()
        frame.showBars.click()
        expect(barsVisible(frame)).toBe(true)
        expect(frame.showBars.hidden).toBe(true)
        expect(document.activeElement).toBe(control(frame, 'exit'))

        vi.advanceTimersByTime(BARS_PEEK_MS * 2)
        expect(barsVisible(frame)).toBe(true)
    })

    it('hides the bars in a mode and keeps them hidden', () => {
        const { frame, session } = setup()
        session.setMode('speed')
        expect(barsVisible(frame)).toBe(false)
        // The mode has its own controls, so the way to the bars is also gone.
        expect(frame.showBars.hidden).toBe(true)
        frame.showBars.click()
        expect(barsVisible(frame)).toBe(false)

        session.emit('center-tap', undefined)
        pointer(frame.stage, 'pointermove', { clientY: 10 })
        expect(barsVisible(frame)).toBe(false)
    })

    it('shows the bars for a moment when a mode ends', () => {
        const { frame, session } = setup()
        hideBars(frame)
        session.setMode('speed')
        expect(frame.showBars.hidden).toBe(true)
        session.setMode('read')
        expect(barsVisible(frame)).toBe(true)
        vi.advanceTimersByTime(BARS_PEEK_MS)
        expect(barsVisible(frame)).toBe(false)
        expect(frame.showBars.hidden).toBe(false)
    })

    it('hides the bars when the listen mode starts', () => {
        const { frame, session } = setup()
        expect(barsVisible(frame)).toBe(true)
        session.setMode('listen')
        expect(barsVisible(frame)).toBe(false)
        // The keyboard can still get to the top bar.
        expect(frame.showBars.hidden).toBe(false)
    })

    it('shows only the top bar in the listen mode', () => {
        const { frame, session } = setup()
        hideBars(frame)
        session.setMode('listen')
        session.emit('center-tap', undefined)
        expect(frame.topBar.hasAttribute('inert')).toBe(false)
        // The listen bar is in the place of the bottom bar.
        expect(frame.bottomBar.hasAttribute('inert')).toBe(true)

        session.setMode('read')
        expect(barsVisible(frame)).toBe(true)
    })

    it('makes the page inert below the speed reader', () => {
        const { frame, session } = setup()
        session.setMode('speed')
        expect(frame.stage.hasAttribute('inert')).toBe(true)
        session.setMode('read')
        expect(frame.stage.hasAttribute('inert')).toBe(false)
        session.setMode('listen')
        expect(frame.stage.hasAttribute('inert')).toBe(false)
    })
})

// A closed panel stays on screen for its close transition and takes no press in that time.
describe('a press in the page after a panel closed', () => {
    function closePanel(frame: ScreenFrame, tag = 'dialog'): void {
        const panel = document.createElement(tag)
        frame.overlay.append(panel)
        // The close event of a dialog does not bubble.
        panel.dispatchEvent(new Event('close'))
    }

    /** An element of the reader view, and the presses that it gets. */
    function viewText(frame: ScreenFrame) {
        const text = document.createElement('p')
        frame.stage.append(text)
        const onDown = vi.fn()
        // The reader view turns the page for a press and a release in a turn zone.
        text.addEventListener('pointerdown', onDown)
        return { text, onDown }
    }

    it('does not go to the reader view, so a double tap on a contents entry turns no page', () => {
        const { frame } = setup()
        const { text, onDown } = viewText(frame)

        closePanel(frame)
        vi.advanceTimersByTime(PANEL_CLOSE_GUARD_MS - 1)
        pointer(text, 'pointerdown', { pointerType: 'touch' })
        expect(onDown).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        pointer(text, 'pointerdown', { pointerType: 'touch' })
        expect(onDown).toHaveBeenCalledTimes(1)
    })

    it('does not hide the bars', () => {
        const { frame } = setup()

        closePanel(frame)
        tapPage(frame)
        expect(barsVisible(frame)).toBe(true)

        vi.advanceTimersByTime(PANEL_CLOSE_GUARD_MS)
        tapPage(frame)
        expect(barsVisible(frame)).toBe(false)
    })

    it('goes to the reader view after the close event of an element that is not a dialog', () => {
        const { frame } = setup()
        const { text, onDown } = viewText(frame)

        closePanel(frame, 'div')
        pointer(text, 'pointerdown', { pointerType: 'touch' })

        expect(onDown).toHaveBeenCalledTimes(1)
    })
})

describe('the page buttons for a screen reader', () => {
    it('are not there before the book is open', () => {
        const frame = createFrame()

        expect(frame.prevPage.hidden).toBe(true)
        expect(frame.nextPage.hidden).toBe(true)
    })

    it('are two buttons with a text, between the bars and the page in the order of the Tab key', () => {
        const { frame } = setup()
        const following = Node.DOCUMENT_POSITION_FOLLOWING

        expect(frame.prevPage.hidden).toBe(false)
        expect(frame.nextPage.hidden).toBe(false)
        expect(frame.prevPage.textContent?.trim()).toBe('Previous page')
        expect(frame.nextPage.textContent?.trim()).toBe('Next page')
        expect(frame.prevPage.type).toBe('button')
        expect(frame.nextPage.type).toBe('button')
        expect(frame.bottomBar.compareDocumentPosition(frame.prevPage) & following).toBeTruthy()
        expect(frame.prevPage.compareDocumentPosition(frame.nextPage) & following).toBeTruthy()
        // The text of the new page is the next stop after the button.
        expect(frame.nextPage.compareDocumentPosition(frame.stage) & following).toBeTruthy()
    })

    // A screen reader on a touch screen sends a click with no pointer events.
    it('turn the page for a click', () => {
        const { frame, session } = setup()

        frame.nextPage.click()
        expect(session.next).toHaveBeenCalledTimes(1)
        expect(session.prev).not.toHaveBeenCalled()

        frame.prevPage.click()
        expect(session.prev).toHaveBeenCalledTimes(1)
        expect(session.next).toHaveBeenCalledTimes(1)
    })

    it('stay when the bars hide', () => {
        const { frame } = setup()
        hideBars(frame)

        expect(frame.prevPage.hidden).toBe(false)
        expect(frame.nextPage.hidden).toBe(false)
    })

    it('are gone below the speed reader, and stay in the listen mode', () => {
        const { frame, session } = setup()

        session.setMode('speed')
        expect(frame.prevPage.hidden).toBe(true)
        expect(frame.nextPage.hidden).toBe(true)

        session.setMode('listen')
        expect(frame.prevPage.hidden).toBe(false)
        expect(frame.nextPage.hidden).toBe(false)

        session.setMode('read')
        expect(frame.prevPage.hidden).toBe(false)
        expect(frame.nextPage.hidden).toBe(false)
    })

    it('do not turn the page after the screen is destroyed', async () => {
        const { frame, session, screen } = setup()
        await screen.destroy()

        frame.nextPage.click()

        expect(session.next).not.toHaveBeenCalled()
    })
})

// jsdom has no layout, so these tests read the source text. They keep a rule in its file
// when the reason for the rule is not visible in jsdom.
describe('the stylesheet of the screen', () => {
    const css = readFileSync(join(import.meta.dirname, 'screen.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')

    // Older Chromium browsers read the value for the viewport from the body element.
    it('stops the pull to refresh on the root element and on the body', () => {
        expect(css).toContain(
            ':root:has(.reader-screen), :root:has(.reader-screen) body { overscroll-behavior: none; }',
        )
    })

    it('shows the buttons for the keyboard only while they have the focus', () => {
        expect(css).toMatch(
            /\.reader-show-bars, \.reader-page-turn \{[^}]*&:not\(:focus-visible\) \{[^}]*clip-path: inset\(50%\);/,
        )
    })

    // A hidden bar is outside the screen. A box with hidden overflow can still scroll to it.
    it('gives the screen no scroll range, with hidden overflow for older browsers', () => {
        expect(css).toMatch(/\.reader-screen \{[^}]*overflow: hidden; overflow: clip;/)
    })
})

describe('the scroll position of the screen', () => {
    it('goes back to 0 in a browser without overflow: clip', () => {
        const { frame } = setup()
        hideBars(frame)
        // jsdom has no layout. The two values are what a focus move to a hidden bar can give.
        for (const [name, value] of [
            ['scrollTop', 109],
            ['scrollLeft', 4],
        ] as const) {
            Object.defineProperty(frame.root, name, { value, writable: true, configurable: true })
        }

        frame.root.dispatchEvent(new Event('scroll'))
        expect(frame.root.scrollTop).toBe(0)
        expect(frame.root.scrollLeft).toBe(0)
    })
})

describe('the running head', () => {
    it('shows the title of the current contents entry', () => {
        const { frame } = setup()
        expect(frame.headText.textContent).toBe('Chapter One')
    })

    it('shows the book title when the position has no contents entry', () => {
        const { frame } = setup({ currentTocEntry: null })
        expect(frame.headText.textContent).toBe('The Test Book')
    })

    it('shows the book title for an entry with an empty title', () => {
        const { frame } = setup({ currentTocEntry: tocEntry('  ') })
        expect(frame.headText.textContent).toBe('The Test Book')
    })

    it('follows the position', () => {
        const { frame, session } = setup()
        session.state.currentTocEntry = tocEntry('<b>Chapter Two</b>', 2)
        session.relocate({ locator: { spineIndex: 2, offset: 0 } })
        expect(frame.headText.textContent).toBe('<b>Chapter Two</b>')
        expect(frame.headText.querySelector('b')).toBeNull()
    })

    it('changes when the same position gets a different contents entry', () => {
        const { frame, session } = setup()
        session.state.currentTocEntry = tocEntry('Section 1.2')
        session.relocate()
        expect(frame.headText.textContent).toBe('Section 1.2')
    })
})

describe('the running foot', () => {
    it('shows the page, the percent and the time that is left in the paged view', () => {
        const { frame } = setup({}, { readingWpm: 230 })
        expect(frame.footPage.textContent).toBe('Page 3 of 12')
        expect(frame.footProgress.textContent).toBe('34% · 6 min left in chapter')
    })

    it('shows no page in the scroll view', () => {
        const { frame } = setup(
            { position: relocateInfo({ page: null, pageCount: null }) },
            { layout: 'scroll', readingWpm: 230 },
        )
        expect(frame.footPage.textContent).toBe('')
        expect(frame.footProgress.textContent).toBe('34% · 6 min left in chapter')
    })

    it('follows the position', () => {
        const { frame, session } = setup({}, { readingWpm: 200 })
        session.state.fraction = 0.5
        session.state.wordsRemaining = { chapter: 150, book: 900 }
        session.relocate({ locator: { spineIndex: 1, offset: 250 }, page: 9 })
        expect(frame.footPage.textContent).toBe('Page 9 of 12')
        expect(frame.footProgress.textContent).toBe('50% · less than 1 min left in chapter')
    })

    it('shows 100 percent at the end of the book', () => {
        const { frame } = setup({ fraction: 1, wordsRemaining: { chapter: 0, book: 0 } })
        expect(frame.footProgress.textContent).toBe('100% · less than 1 min left in chapter')
    })

    it('shows only the percent when the words that are left are not known', () => {
        const { frame } = setup({ position: null, wordsRemaining: null, fraction: 0 })
        expect(frame.footPage.textContent).toBe('')
        expect(frame.footProgress.textContent).toBe('0%')
    })

    it('uses the new reading speed when the session measures it', () => {
        const { frame, settings } = setup({}, { readingWpm: 230 })
        settings.update({ readingWpm: 130 })
        expect(frame.footProgress.textContent).toBe('34% · 10 min left in chapter')
    })
})

describe('the settings for the running head and foot', () => {
    const head = (frame: ScreenFrame) => frame.root.querySelector<HTMLElement>('.reader-head')!
    const foot = (frame: ScreenFrame) => frame.root.querySelector<HTMLElement>('.reader-foot')!

    it('shows the two lines by default', () => {
        const { frame } = setup()
        expect(frame.headText.hidden).toBe(false)
        expect(frame.footPage.hidden).toBe(false)
        expect(frame.footProgress.hidden).toBe(false)
        expect(frame.footToggle.getAttribute('aria-pressed')).toBe('true')
    })

    it('hides the text of a line that is off, and keeps the line', () => {
        const { frame } = setup({}, { runningHead: false, runningFoot: false })
        expect(frame.headText.hidden).toBe(true)
        expect(frame.footPage.hidden).toBe(true)
        expect(frame.footProgress.hidden).toBe(true)
        // The page text must not move, so the two lines stay in the layout.
        expect(head(frame).hidden).toBe(false)
        expect(foot(frame).hidden).toBe(false)
        expect(frame.footToggle.getAttribute('aria-pressed')).toBe('false')
    })

    it('follows a change of the settings', () => {
        const { frame, settings } = setup()
        settings.update({ runningHead: false })
        expect(frame.headText.hidden).toBe(true)
        expect(frame.footProgress.hidden).toBe(false)

        settings.update({ runningHead: true, runningFoot: false })
        expect(frame.headText.hidden).toBe(false)
        expect(frame.footPage.hidden).toBe(true)
        expect(frame.footProgress.hidden).toBe(true)
    })

    it('keeps the hidden text up to date', () => {
        const { frame, session, settings } = setup({}, { runningFoot: false, readingWpm: 200 })
        session.state.fraction = 0.5
        session.state.wordsRemaining = { chapter: 150, book: 900 }
        session.relocate({ locator: { spineIndex: 1, offset: 250 }, page: 9 })

        settings.update({ runningFoot: true })
        expect(frame.footPage.textContent).toBe('Page 9 of 12')
        expect(frame.footProgress.textContent).toBe('50% · less than 1 min left in chapter')
    })

    it('has a button over the foot that shows and hides the text of the foot', () => {
        const { frame, settings } = setup()
        hideBars(frame)
        expect(frame.footToggle.type).toBe('button')
        expect(frame.footToggle.getAttribute('aria-label')).toBe('Show the progress')
        expect(foot(frame).nextElementSibling).toBe(frame.footToggle)

        frame.footToggle.click()
        expect(settings.get().runningFoot).toBe(false)
        expect(frame.footProgress.hidden).toBe(true)
        expect(frame.footToggle.getAttribute('aria-pressed')).toBe('false')
        // The chapter title has its own setting.
        expect(settings.get().runningHead).toBe(true)
        expect(frame.headText.hidden).toBe(false)

        frame.footToggle.click()
        expect(settings.get().runningFoot).toBe(true)
        expect(frame.footProgress.hidden).toBe(false)
        expect(frame.footToggle.getAttribute('aria-pressed')).toBe('true')
    })

    it('does not show the bars for a tap on the button', () => {
        const { frame, session } = setup()
        hideBars(frame)
        pointer(frame.footToggle, 'pointerdown', { pointerType: 'touch' })
        pointer(frame.footToggle, 'pointerup', { pointerType: 'touch' })
        frame.footToggle.click()

        expect(barsVisible(frame)).toBe(false)
        expect(session.next).not.toHaveBeenCalled()
    })

    it('gives the focus back to the page after a tap, and keeps it for the keyboard', () => {
        const { frame, settings } = setup()
        hideBars(frame)

        frame.footToggle.focus()
        frame.footToggle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
        expect(settings.get().runningFoot).toBe(false)
        expect(document.activeElement).not.toBe(frame.footToggle)

        // The Enter key and the Space key send a click with a detail of 0.
        frame.footToggle.focus()
        frame.footToggle.click()
        expect(settings.get().runningFoot).toBe(true)
        expect(document.activeElement).toBe(frame.footToggle)
    })

    it('has no button below the speed reader', () => {
        const { frame, session } = setup()
        session.setMode('speed')
        expect(frame.footToggle.hidden).toBe(true)

        session.setMode('listen')
        expect(frame.footToggle.hidden).toBe(false)

        session.setMode('read')
        expect(frame.footToggle.hidden).toBe(false)
    })
})

describe('the progress slider', () => {
    it('shows the position in the book', () => {
        const { frame } = setup()
        expect(frame.slider.min).toBe('0')
        expect(frame.slider.max).toBe('1000')
        expect(frame.slider.value).toBe('340')
        expect(frame.slider.style.getPropertyValue('--value')).toBe('0.34')
        expect(frame.slider.getAttribute('aria-valuetext')).toBe('Chapter One · 34%')
        expect(frame.percent.textContent).toBe('34%')
        expect(frame.sliderLabel.hidden).toBe(true)
    })

    it('follows the position', () => {
        const { frame, session } = setup()
        session.state.fraction = 0.612
        session.relocate({ locator: { spineIndex: 2, offset: 40 } })
        expect(frame.slider.value).toBe('612')
        expect(frame.slider.style.getPropertyValue('--value')).toBe('0.612')
        expect(frame.percent.textContent).toBe('61%')
    })

    it('shows the contents entry and the percent of the thumb during a drag', () => {
        const { frame, session } = setup()
        moveSlider(frame, 700)

        // 700 of 1000 characters is 300 characters into the third chapter.
        expect(session.chapterTitleAt).toHaveBeenLastCalledWith({ spineIndex: 2, offset: 300 })
        expect(frame.sliderLabel.hidden).toBe(false)
        expect(frame.sliderLabelTitle.textContent).toBe('Chapter Two')
        expect(frame.sliderLabelTitle.hidden).toBe(false)
        expect(frame.sliderLabelPercent.textContent).toBe('70%')
        expect(frame.sliderLabel.style.getPropertyValue('--value')).toBe('0.7')
        expect(frame.slider.style.getPropertyValue('--value')).toBe('0.7')
        expect(frame.slider.getAttribute('aria-valuetext')).toBe('Chapter Two · 70%')

        moveSlider(frame, 50)
        expect(frame.sliderLabelTitle.textContent).toBe('Cover')
        expect(frame.sliderLabelPercent.textContent).toBe('5%')
    })

    it('keeps the percent in its own element, so a long title cannot push it out', () => {
        const { frame, session } = setup()
        session.state.titles = { 2: 'Chapter the Second, in Which the Title Has No End' }
        moveSlider(frame, 700)
        expect(frame.sliderLabelTitle.textContent).toBe(
            'Chapter the Second, in Which the Title Has No End',
        )
        expect(frame.sliderLabelPercent.textContent).toBe('70%')
        expect(frame.sliderLabelPercent.parentElement).toBe(frame.sliderLabel)
        expect(frame.sliderLabel.querySelector('img, b')).toBeNull()
    })

    it('shows only the percent for a position with no contents entry', () => {
        const { frame, session } = setup()
        session.state.titles = {}
        moveSlider(frame, 250)
        expect(frame.sliderLabelTitle.hidden).toBe(true)
        expect(frame.sliderLabelPercent.textContent).toBe('25%')
        expect(frame.slider.getAttribute('aria-valuetext')).toBe('25%')
    })

    it('does not move the book during a drag', () => {
        const { frame, session } = setup()
        moveSlider(frame, 700)
        moveSlider(frame, 800)
        expect(session.goToFraction).not.toHaveBeenCalled()
        expect(session.goTo).not.toHaveBeenCalled()
    })

    it('keeps the thumb during a drag when the position changes', () => {
        const { frame, session } = setup()
        moveSlider(frame, 700)
        session.state.fraction = 0.35
        session.relocate({ locator: { spineIndex: 1, offset: 90 } })
        expect(frame.slider.value).toBe('700')
        expect(frame.slider.getAttribute('aria-valuetext')).toBe('Chapter Two · 70%')
    })

    it('goes to the fraction when the drag ends', () => {
        const { frame, session } = setup()
        moveSlider(frame, 700)
        frame.slider.dispatchEvent(new Event('change', { bubbles: true }))
        expect(session.goToFraction).toHaveBeenCalledTimes(1)
        expect(session.goToFraction).toHaveBeenCalledWith(0.7)
        expect(frame.sliderLabel.hidden).toBe(true)

        // The slider follows the book again.
        session.state.fraction = 0.702
        session.relocate({ locator: { spineIndex: 2, offset: 301 } })
        expect(frame.slider.value).toBe('702')
    })

    it('hides the label when a drag ends at its start value', () => {
        const { frame, session } = setup()
        moveSlider(frame, 700)
        moveSlider(frame, 340)
        pointer(frame.slider, 'pointerup')
        expect(frame.sliderLabel.hidden).toBe(true)
        expect(session.goToFraction).not.toHaveBeenCalled()

        session.state.fraction = 0.4
        session.relocate({ locator: { spineIndex: 1, offset: 120 } })
        expect(frame.slider.value).toBe('400')
    })

    it('ends a drag when the pointer goes up outside the slider at the start value', () => {
        const { frame, session } = setup()
        moveSlider(frame, 700)
        moveSlider(frame, 340)
        // No change event comes, and the slider does not get the pointerup event.
        pointer(document.body, 'pointerup')
        expect(frame.sliderLabel.hidden).toBe(true)

        session.state.fraction = 0.4
        session.relocate({ locator: { spineIndex: 1, offset: 120 } })
        expect(frame.slider.value).toBe('400')
    })

    it('moves the focus to the slider when the Back button goes away', async () => {
        const { frame, session } = setup({ canGoBack: true })
        session.back.mockImplementation(async () => {
            session.state.canGoBack = false
            session.relocate({ locator: { spineIndex: 0, offset: 0 } })
        })
        frame.backButton.focus()
        frame.backButton.click()
        await flush()
        expect(frame.backButton.hidden).toBe(true)
        expect(document.activeElement).toBe(frame.slider)
        expect(barsVisible(frame)).toBe(true)
    })

    it('reads the back stack again when the bars show', () => {
        const { frame, session } = setup()
        hideBars(frame)
        // The session sends no event for this change.
        session.state.canGoBack = true
        session.emit('center-tap', undefined)
        expect(frame.backButton.hidden).toBe(false)
    })

    it('shows the Back button only when the session can go back', () => {
        const { frame, session } = setup()
        expect(frame.backButton.hidden).toBe(true)

        session.state.canGoBack = true
        session.relocate({ locator: { spineIndex: 2, offset: 0 } })
        expect(frame.backButton.hidden).toBe(false)

        session.state.canGoBack = false
        session.relocate({ locator: { spineIndex: 1, offset: 80 } })
        expect(frame.backButton.hidden).toBe(true)
    })
})

describe('the bookmark button', () => {
    it('shows no bookmark on a page that has none', () => {
        const { frame } = setup()
        expect(frame.bookmarkButton.getAttribute('aria-pressed')).toBe('false')
        expect(iconOf(frame.bookmarkButton)).toBe('#i-bookmark')
    })

    it('shows a bookmark on a page that has one', () => {
        const { frame } = setup({ isBookmarked: true })
        expect(frame.bookmarkButton.getAttribute('aria-pressed')).toBe('true')
        expect(iconOf(frame.bookmarkButton)).toBe('#i-bookmark-filled')
    })

    it('adds a bookmark and says so', async () => {
        const { frame, session } = setup()
        frame.bookmarkButton.click()
        await flush()
        expect(session.toggleBookmark).toHaveBeenCalledTimes(1)
        expect(frame.bookmarkButton.getAttribute('aria-pressed')).toBe('true')
        expect(iconOf(frame.bookmarkButton)).toBe('#i-bookmark-filled')
        expect(toastText()).toBe('Bookmark added')
    })

    it('removes a bookmark and says so', async () => {
        const { frame, session } = setup({ isBookmarked: true })
        frame.bookmarkButton.click()
        await flush()
        expect(session.toggleBookmark).toHaveBeenCalledTimes(1)
        expect(frame.bookmarkButton.getAttribute('aria-pressed')).toBe('false')
        expect(iconOf(frame.bookmarkButton)).toBe('#i-bookmark')
        expect(toastText()).toBe('Bookmark removed')
    })

    it('changes on a bookmarks event', () => {
        const { frame, session } = setup()
        session.state.isBookmarked = true
        session.emit('bookmarks', [])
        expect(frame.bookmarkButton.getAttribute('aria-pressed')).toBe('true')
    })

    it('changes when a page turn shows a page with a bookmark', () => {
        const { frame, session } = setup()
        session.state.isBookmarked = true
        session.relocate({ locator: { spineIndex: 1, offset: 200 } })
        expect(frame.bookmarkButton.getAttribute('aria-pressed')).toBe('true')
        expect(iconOf(frame.bookmarkButton)).toBe('#i-bookmark-filled')

        session.state.isBookmarked = false
        session.relocate({ locator: { spineIndex: 1, offset: 260 } })
        expect(frame.bookmarkButton.getAttribute('aria-pressed')).toBe('false')
    })

    it('says that the bookmark was not saved when storage fails', async () => {
        const { frame, session } = setup()
        session.toggleBookmark.mockRejectedValueOnce(new Error('QuotaExceededError'))
        frame.bookmarkButton.click()
        await flush()
        expect(frame.bookmarkButton.getAttribute('aria-pressed')).toBe('false')
        expect(toastText()).toBe('The bookmark was not saved.')
    })

    it('says nothing when the bookmark did not change', async () => {
        const { frame, session } = setup()
        session.toggleBookmark.mockResolvedValueOnce(undefined)
        frame.bookmarkButton.click()
        await flush()
        expect(toastText()).toBeNull()
    })
})

describe('the keyboard', () => {
    it.each([
        ['ArrowRight', {}],
        ['PageDown', {}],
        [' ', {}],
    ])('turns to the next page for %j', (key, init) => {
        const { session } = setup()
        const event = press(key, init)
        expect(session.next).toHaveBeenCalledTimes(1)
        expect(session.prev).not.toHaveBeenCalled()
        expect(event.defaultPrevented).toBe(true)
    })

    it.each([
        ['ArrowLeft', {}],
        ['PageUp', {}],
        [' ', { shiftKey: true }],
    ])('turns to the previous page for %j with %j', (key, init) => {
        const { session } = setup()
        const event = press(key, init)
        expect(session.prev).toHaveBeenCalledTimes(1)
        expect(session.next).not.toHaveBeenCalled()
        expect(event.defaultPrevented).toBe(true)
    })

    it('leaves the scroll keys to the browser when the focus is in the text of the scroll view', () => {
        const { session, frame } = setup({}, { layout: 'scroll' })
        const link = document.createElement('a')
        link.href = '#note-1'
        frame.stage.append(link)
        link.focus()
        for (const key of [' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp']) {
            expect(press(key, {}, link).defaultPrevented).toBe(false)
        }
        expect(press(' ', { shiftKey: true }, link).defaultPrevented).toBe(false)
        expect(session.next).not.toHaveBeenCalled()
        expect(session.prev).not.toHaveBeenCalled()

        press('ArrowRight', {}, link)
        press('ArrowLeft', {}, link)
        expect(session.next).toHaveBeenCalledTimes(1)
        expect(session.prev).toHaveBeenCalledTimes(1)
    })

    it('moves the scroll view itself when the focus is not in the text', () => {
        // The browser then has nothing to scroll: the page of the reader has no scroll.
        const { session } = setup({}, { layout: 'scroll' })
        expect(press(' ').defaultPrevented).toBe(true)
        expect(press('PageDown').defaultPrevented).toBe(true)
        expect(session.next).toHaveBeenCalledTimes(2)
        expect(press(' ', { shiftKey: true }).defaultPrevented).toBe(true)
        expect(press('PageUp').defaultPrevented).toBe(true)
        expect(session.prev).toHaveBeenCalledTimes(2)

        expect(session.next).toHaveBeenCalledTimes(2)
        expect(session.prev).toHaveBeenCalledTimes(2)
    })

    it('scrolls the text by a small step for the up and down arrows in the scroll view', () => {
        const { session, frame } = setup({}, { layout: 'scroll' })
        // The scroll view puts the element that scrolls into the stage.
        const scroller = document.createElement('div')
        frame.stage.append(scroller)
        scroller.scrollTop = 500

        expect(press('ArrowDown').defaultPrevented).toBe(true)
        expect(scroller.scrollTop).toBe(500 + LINE_SCROLL_PX)
        // A held key repeats the step.
        expect(press('ArrowDown', { repeat: true }).defaultPrevented).toBe(true)
        expect(scroller.scrollTop).toBe(500 + 2 * LINE_SCROLL_PX)
        expect(press('ArrowUp').defaultPrevented).toBe(true)
        expect(scroller.scrollTop).toBe(500 + LINE_SCROLL_PX)

        // Also with the focus on a button of a bar, which does not use these keys.
        const button = frame.topBar.querySelector('button')!
        expect(press('ArrowDown', {}, button).defaultPrevented).toBe(true)
        expect(scroller.scrollTop).toBe(500 + 2 * LINE_SCROLL_PX)
        expect(session.next).not.toHaveBeenCalled()
        expect(session.prev).not.toHaveBeenCalled()
    })

    it('leaves the up and down arrows to the browser when no view is in the stage', () => {
        setup({}, { layout: 'scroll' })
        expect(press('ArrowDown').defaultPrevented).toBe(false)
        expect(press('ArrowUp').defaultPrevented).toBe(false)
    })

    it('does not use the up and down arrows in the paged view', () => {
        const { frame } = setup()
        const clip = document.createElement('div')
        frame.stage.append(clip)
        expect(press('ArrowDown').defaultPrevented).toBe(false)
        expect(press('ArrowUp').defaultPrevented).toBe(false)
        expect(clip.scrollTop).toBe(0)
    })

    it('waits for the end of a step before a held key moves the scroll view again', async () => {
        const { session } = setup({}, { layout: 'scroll' })
        let end!: (moved: boolean) => void
        session.next.mockImplementationOnce(() => new Promise((resolve) => (end = resolve)))
        press('ArrowRight')
        // The scroll view adds each step to the target of the scroll that runs.
        expect(press('ArrowRight', { repeat: true }).defaultPrevented).toBe(true)
        press('ArrowRight', { repeat: true })
        expect(session.next).toHaveBeenCalledTimes(1)

        end(true)
        await flush()
        press('ArrowRight', { repeat: true })
        expect(session.next).toHaveBeenCalledTimes(2)
    })

    it('does not make a second press wait for the step of the first press', () => {
        const { session } = setup({}, { layout: 'scroll' })
        session.next.mockImplementation(() => new Promise(() => {}))
        press('ArrowRight')
        press('ArrowRight')
        expect(session.next).toHaveBeenCalledTimes(2)
    })

    it('turns the page for Space on a link of the book, because Space does not use a link', () => {
        const { session, frame } = setup()
        const link = document.createElement('a')
        link.href = '#note-1'
        frame.stage.append(link)
        link.focus()
        expect(press(' ', {}, link).defaultPrevented).toBe(true)
        expect(session.next).toHaveBeenCalledTimes(1)
    })

    it('leaves Shift with an arrow key to the browser', () => {
        const { session } = setup()
        expect(press('ArrowRight', { shiftKey: true }).defaultPrevented).toBe(false)
        expect(press('ArrowLeft', { shiftKey: true }).defaultPrevented).toBe(false)
        expect(session.next).not.toHaveBeenCalled()
        expect(session.prev).not.toHaveBeenCalled()
    })

    it('opens the contents panel for t', async () => {
        const { parts } = setup()
        const event = press('t')
        await flush()
        expect(parts.made.contents?.open).toHaveBeenCalledWith(undefined)
        expect(event.defaultPrevented).toBe(true)
    })

    it('opens the reading settings for a', async () => {
        const { parts } = setup()
        press('a')
        await flush()
        expect(parts.made.appearance?.open).toHaveBeenCalledTimes(1)
    })

    it('opens the search panel for the slash key', async () => {
        const { parts } = setup()
        const event = press('/')
        await flush()
        expect(parts.made.search?.open).toHaveBeenCalledWith(undefined)
        expect(event.defaultPrevented).toBe(true)
    })

    it.each([{ ctrlKey: true }, { metaKey: true }])(
        'opens the search panel for f with %j, not the search of the browser',
        async (init) => {
            const { parts } = setup()
            const event = press('f', init)
            await flush()
            expect(parts.made.search?.open).toHaveBeenCalledTimes(1)
            expect(event.defaultPrevented).toBe(true)
        },
    )

    it('toggles the bookmark for b', async () => {
        const { session } = setup()
        press('b')
        await flush()
        expect(session.toggleBookmark).toHaveBeenCalledTimes(1)
        expect(toastText()).toBe('Bookmark added')
    })

    it('starts the speed reader for s', async () => {
        const { parts } = setup()
        expect(press('s').defaultPrevented).toBe(true)
        await flush()
        expect(parts.made.speed?.start).toHaveBeenCalledWith(undefined)
    })

    it('starts the listen bar for l', async () => {
        const { parts } = setup()
        expect(press('l').defaultPrevented).toBe(true)
        await flush()
        expect(parts.made.listen?.start).toHaveBeenCalledWith(undefined)
    })

    it('opens the shortcuts dialog for the question mark', async () => {
        const { parts } = setup()
        press('?', { shiftKey: true })
        await flush()
        expect(parts.made.shortcuts?.open).toHaveBeenCalledTimes(1)
    })

    it('changes the font size by 1 for the plus, equals and minus keys', () => {
        const { settings } = setup({}, { fontSize: 20 })
        expect(press('+', { shiftKey: true }).defaultPrevented).toBe(true)
        expect(settings.get().fontSize).toBe(21)
        press('=')
        expect(settings.get().fontSize).toBe(22)
        press('-')
        press('-')
        press('-')
        expect(settings.get().fontSize).toBe(19)
    })

    it('does not make the font larger than the upper limit', () => {
        const { settings } = setup({}, { fontSize: FONT_SIZE_MAX })
        press('+')
        expect(settings.get().fontSize).toBe(FONT_SIZE_MAX)
        press('-')
        expect(settings.get().fontSize).toBe(FONT_SIZE_MAX - 1)
    })

    it('does not make the font smaller than the lower limit', () => {
        const { settings } = setup({}, { fontSize: FONT_SIZE_MIN })
        press('-')
        expect(settings.get().fontSize).toBe(FONT_SIZE_MIN)
        press('=')
        expect(settings.get().fontSize).toBe(FONT_SIZE_MIN + 1)
    })

    it('goes back for Backspace only when the session can go back', () => {
        const { session } = setup()
        expect(press('Backspace').defaultPrevented).toBe(false)
        expect(session.back).not.toHaveBeenCalled()

        session.state.canGoBack = true
        expect(press('Backspace').defaultPrevented).toBe(true)
        expect(session.back).toHaveBeenCalledTimes(1)
    })

    it('does not use f in a browser with no full screen for elements', () => {
        setup()
        expect(press('f').defaultPrevented).toBe(false)
    })

    it('does nothing when the target is a form field or editable text', () => {
        const { session, frame } = setup()
        const holder = document.createElement('div')
        holder.innerHTML =
            '<input type="text" /><textarea></textarea><select></select>' +
            '<div contenteditable="true"></div>'
        document.body.append(holder)

        for (const target of [...holder.children, frame.slider]) {
            for (const key of ['ArrowRight', ' ', 'b', 'Backspace', '/']) {
                expect(press(key, {}, target).defaultPrevented).toBe(false)
            }
            expect(press('f', { ctrlKey: true }, target).defaultPrevented).toBe(false)
        }
        expect(session.next).not.toHaveBeenCalled()
        expect(session.toggleBookmark).not.toHaveBeenCalled()
        // Escape in a text field does nothing.
        press('Escape', {}, holder.children[0])
        expect(barsVisible(frame)).toBe(true)
    })

    it('hides the bars for Escape in the progress slider, which does not use that key', () => {
        const { frame } = setup()
        frame.slider.focus()
        expect(barsVisible(frame)).toBe(true)
        press('Escape', {}, frame.slider)
        expect(barsVisible(frame)).toBe(false)
        // The focus is not in a bar that is inert.
        expect(document.activeElement).not.toBe(frame.slider)
    })

    it('does nothing while a dialog is open', () => {
        const { session, frame, parts } = setup()
        const dialog = document.createElement('dialog')
        frame.overlay.append(dialog)
        dialog.showModal()

        for (const key of ['ArrowRight', ' ', 'b', 't', 's', 'Escape']) {
            expect(press(key).defaultPrevented).toBe(false)
        }
        expect(press('f', { metaKey: true }).defaultPrevented).toBe(false)
        expect(session.next).not.toHaveBeenCalled()
        expect(session.toggleBookmark).not.toHaveBeenCalled()
        expect(parts.factories.contents).not.toHaveBeenCalled()
        expect(barsVisible(frame)).toBe(true)

        dialog.close()
        press('ArrowRight')
        expect(session.next).toHaveBeenCalledTimes(1)
    })

    it('does nothing with a modifier key other than Shift', () => {
        const { session, parts } = setup()
        for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
            for (const key of ['ArrowRight', ' ', 'b', 't', 's', 'l', '-', 'Backspace']) {
                expect(press(key, init).defaultPrevented).toBe(false)
            }
        }
        expect(session.next).not.toHaveBeenCalled()
        expect(session.toggleBookmark).not.toHaveBeenCalled()
        expect(parts.factories.contents).not.toHaveBeenCalled()
        expect(parts.factories.speed).not.toHaveBeenCalled()
    })

    it('does nothing in the speed mode', () => {
        const { session, parts } = setup()
        session.setMode('speed')
        for (const key of ['ArrowRight', ' ', 'b', 't', 's', 'l', 'Escape', '?']) {
            expect(press(key).defaultPrevented).toBe(false)
        }
        expect(press('f', { ctrlKey: true }).defaultPrevented).toBe(false)
        expect(session.next).not.toHaveBeenCalled()
        expect(session.toggleBookmark).not.toHaveBeenCalled()
        expect(parts.factories.contents).not.toHaveBeenCalled()
        expect(parts.factories.search).not.toHaveBeenCalled()
    })

    it('keeps its keys in the listen mode', async () => {
        const { session, parts } = setup()
        session.setMode('listen')
        expect(press('b').defaultPrevented).toBe(true)
        expect(session.toggleBookmark).toHaveBeenCalledTimes(1)
        expect(press('t').defaultPrevented).toBe(true)
        await flush()
        expect(parts.factories.contents).toHaveBeenCalledTimes(1)
    })

    it('does not use a key in the listen mode that the listen bar used', () => {
        const { session } = setup()
        session.setMode('listen')
        // The listen bar gets the key at the document, before the screen.
        const stop = (event: KeyboardEvent): void => event.preventDefault()
        document.addEventListener('keydown', stop)
        press('ArrowRight')
        document.removeEventListener('keydown', stop)
        expect(session.next).not.toHaveBeenCalled()
    })

    it('stops the listen bar before the speed reader starts for s', async () => {
        const { frame, parts, session } = setup()
        control(frame, 'listen').click()
        await flush()
        expect(session.mode).toBe('listen')
        press('s')
        await flush()
        expect(parts.made.listen?.stop).toHaveBeenCalledTimes(1)
        expect(parts.made.speed?.start).toHaveBeenCalledTimes(1)
        expect(session.mode).toBe('speed')
    })

    it('leaves a key that a part used already', () => {
        const { session } = setup()
        const stop = (event: Event): void => event.preventDefault()
        document.body.addEventListener('keydown', stop)
        press('ArrowRight')
        document.body.removeEventListener('keydown', stop)
        expect(session.next).not.toHaveBeenCalled()
    })

    it('leaves Space to a button that has the focus', () => {
        const { session, frame } = setup()
        const event = press(' ', {}, control(frame, 'contents'))
        expect(event.defaultPrevented).toBe(false)
        expect(session.next).not.toHaveBeenCalled()
    })

    it('leaves the keys to an open menu', () => {
        const { session, frame } = setup()
        const item = control(frame, 'shortcuts')
        press('ArrowRight', {}, item)
        press('Escape', {}, item)
        expect(session.next).not.toHaveBeenCalled()
        expect(barsVisible(frame)).toBe(true)
    })

    it('turns pages for a key that the user holds down', () => {
        const { session } = setup()
        press('ArrowRight')
        press('ArrowRight', { repeat: true })
        press('ArrowRight', { repeat: true })
        expect(session.next).toHaveBeenCalledTimes(3)
    })

    it('runs each other command one time for a key that the user holds down', async () => {
        const { session } = setup()
        press('b')
        const repeat = press('b', { repeat: true })
        await flush()
        expect(session.toggleBookmark).toHaveBeenCalledTimes(1)
        expect(repeat.defaultPrevented).toBe(true)
    })
})

describe('full screen', () => {
    const added: Array<[object, string]> = []

    function define(target: object, name: string, value: unknown): void {
        Object.defineProperty(target, name, { value, configurable: true, writable: true })
        added.push([target, name])
    }

    function setFullscreenElement(element: Element | null): void {
        define(document, 'fullscreenElement', element)
        document.dispatchEvent(new Event('fullscreenchange'))
    }

    function installFullscreen() {
        const request = vi.fn(async () => setFullscreenElement(document.documentElement))
        const exit = vi.fn(async () => setFullscreenElement(null))
        define(document.documentElement, 'requestFullscreen', request)
        define(document, 'exitFullscreen', exit)
        define(document, 'fullscreenElement', null)
        define(document, 'fullscreenEnabled', true)
        return { request, exit }
    }

    afterEach(() => {
        for (const [target, name] of added.splice(0)) Reflect.deleteProperty(target, name)
        vi.unstubAllGlobals()
    })

    it('has no menu item in a browser with no full screen for elements', () => {
        const { frame } = setup()
        expect(frame.fullscreenItem.hidden).toBe(true)
    })

    it('has no menu item and no key in the installed app that fills the screen', () => {
        const { request } = installFullscreen()
        vi.stubGlobal(
            'matchMedia',
            vi.fn((query: string) => ({ matches: query === '(display-mode: fullscreen)' })),
        )
        const { frame } = setup()
        expect(frame.fullscreenItem.hidden).toBe(true)
        expect(press('f').defaultPrevented).toBe(false)
        expect(request).not.toHaveBeenCalled()
    })

    it('enters full screen from the More menu', async () => {
        const { request } = installFullscreen()
        const { frame } = setup()
        expect(frame.fullscreenItem.hidden).toBe(false)
        expect(frame.fullscreenItem.textContent?.trim()).toBe('Full screen')

        frame.moreButton.click()
        frame.fullscreenItem.click()
        await flush()
        expect(request).toHaveBeenCalledTimes(1)
        expect(frame.fullscreenItem.textContent?.trim()).toBe('Exit full screen')
        expect(iconOf(frame.fullscreenItem)).toBe('#i-minimize')
    })

    it('keeps the label right when the browser leaves full screen', async () => {
        installFullscreen()
        const { frame } = setup()
        press('f')
        await flush()
        expect(frame.fullscreenItem.textContent?.trim()).toBe('Exit full screen')

        // The user pressed Escape. The browser handles that key.
        setFullscreenElement(null)
        expect(frame.fullscreenItem.textContent?.trim()).toBe('Full screen')
        expect(iconOf(frame.fullscreenItem)).toBe('#i-maximize')
    })

    it('toggles full screen for f', async () => {
        const { request, exit } = installFullscreen()
        setup()
        expect(press('f').defaultPrevented).toBe(true)
        await flush()
        expect(request).toHaveBeenCalledTimes(1)

        press('f')
        await flush()
        expect(exit).toHaveBeenCalledTimes(1)
    })

    it('says so when the browser refuses full screen', async () => {
        installFullscreen()
        define(
            document.documentElement,
            'requestFullscreen',
            vi.fn(async () => {
                throw new TypeError('Permissions check failed')
            }),
        )
        setup()
        press('f')
        await flush()
        expect(toastText()).toBe('Full screen is not available.')
    })

    it('leaves full screen in destroy() when the screen entered it', async () => {
        const { exit } = installFullscreen()
        const { screen } = setup()
        press('f')
        await flush()
        await screen.destroy()
        expect(exit).toHaveBeenCalledTimes(1)
        expect(document.fullscreenElement).toBeNull()
    })

    it('does not leave full screen in destroy() when the screen did not enter it', async () => {
        const { exit } = installFullscreen()
        const { screen } = setup()
        setFullscreenElement(document.body)
        await screen.destroy()
        expect(exit).not.toHaveBeenCalled()
    })
})

describe('the More menu', () => {
    it('opens at its button', () => {
        const { frame } = setup()
        frame.moreButton.click()
        expect(frame.moreMenu.dataset.open).toBe('')
        expect(frame.moreButton.getAttribute('aria-expanded')).toBe('true')
    })

    it('opens the shortcuts dialog', async () => {
        const { frame, parts } = setup()
        frame.moreButton.click()
        control(frame, 'shortcuts').click()
        await flush()
        expect('open' in frame.moreMenu.dataset).toBe(false)
        expect(parts.options.shortcuts).toEqual({ host: frame.overlay })
        expect(parts.made.shortcuts?.open).toHaveBeenCalledTimes(1)
    })

    it('opens the contents panel on the highlights tab for the export', async () => {
        const { frame, parts } = setup()
        frame.moreButton.click()
        control(frame, 'export').click()
        await flush()
        expect(parts.made.contents?.open).toHaveBeenCalledWith('highlights')
    })

    it('only closes the menu for a tap in the centre of the page', () => {
        const { frame, session } = setup()
        frame.moreButton.click()
        pointer(frame.stage, 'pointerdown', { pointerType: 'touch' })
        // The browser closes the menu for the press. The menu script stops the click.
        frame.moreMenu.hidePopover()
        session.emit('center-tap', undefined)
        expect('open' in frame.moreMenu.dataset).toBe(false)
        expect(barsVisible(frame)).toBe(true)

        // The next tap hides the bars.
        tapPage(frame, () => session.emit('center-tap', undefined))
        expect(barsVisible(frame)).toBe(false)
    })

    it('does not give a press in the page to the reader view while the menu is open', () => {
        const { frame } = setup()
        const text = document.createElement('p')
        frame.stage.append(text)
        const onDown = vi.fn()
        // The reader view turns the page for a press and a release in a turn zone.
        text.addEventListener('pointerdown', onDown)

        frame.moreButton.click()
        pointer(text, 'pointerdown', { pointerType: 'touch' })
        expect(onDown).not.toHaveBeenCalled()

        frame.moreMenu.hidePopover()
        pointer(text, 'pointerdown', { pointerType: 'touch' })
        expect(onDown).toHaveBeenCalledTimes(1)
    })

    it('keeps the bars while the menu is open, and closes with the bars', () => {
        const { frame, session } = setup()
        frame.moreButton.click()
        vi.advanceTimersByTime(BARS_PEEK_MS * 2)
        expect(barsVisible(frame)).toBe(true)

        session.relocate({ locator: { spineIndex: 1, offset: 200 } })
        expect(barsVisible(frame)).toBe(false)
        expect('open' in frame.moreMenu.dataset).toBe(false)
    })

    // Safari 16 has no Popover API. The menu script closes the menu itself there.
    describe('in a browser with no Popover API', () => {
        const isOpen = (frame: ScreenFrame) => frame.moreMenu.classList.contains('is-open')

        beforeEach(() => {
            const prototype = HTMLElement.prototype as Partial<HTMLElement>
            delete prototype.showPopover
            delete prototype.hidePopover
        })

        afterEach(installOverlayMethods)

        it('does not give the press that closes the menu to the reader view', () => {
            const { frame } = setup()
            const text = document.createElement('p')
            frame.stage.append(text)
            const onDown = vi.fn()
            // The reader view turns the page for a press and a release in a turn zone.
            text.addEventListener('pointerdown', onDown)

            frame.moreButton.click()
            expect(isOpen(frame)).toBe(true)

            pointer(text, 'pointerdown', { pointerType: 'touch' })
            pointer(text, 'pointerup', { pointerType: 'touch' })
            expect(isOpen(frame)).toBe(false)
            expect(onDown).not.toHaveBeenCalled()

            pointer(text, 'pointerdown', { pointerType: 'touch' })
            expect(onDown).toHaveBeenCalledTimes(1)
        })
    })
})

describe('the parts', () => {
    it('loads no part when the book opens', () => {
        const { parts } = setup()
        for (const factory of Object.values(parts.factories)) {
            expect(factory).not.toHaveBeenCalled()
        }
    })

    it('loads a panel at the first use of its button and keeps the instance', async () => {
        const { frame, session, parts } = setup()
        control(frame, 'contents').click()
        await flush()
        expect(parts.factories.contents).toHaveBeenCalledTimes(1)
        expect(parts.options.contents).toEqual({ session, host: frame.overlay })
        expect(parts.made.contents?.open).toHaveBeenCalledTimes(1)

        control(frame, 'contents').click()
        await flush()
        expect(parts.factories.contents).toHaveBeenCalledTimes(1)
        expect(parts.made.contents?.open).toHaveBeenCalledTimes(2)
    })

    it.each([
        ['search', 'search'],
        ['appearance', 'appearance'],
    ] as const)('opens the %s panel from its button', async (action, name) => {
        const { frame, session, parts } = setup()
        control(frame, action).click()
        await flush()
        expect(parts.options[name]).toEqual({ session, host: frame.overlay })
        expect(parts.made[name]?.open).toHaveBeenCalledTimes(1)
    })

    it('shows a message when a part does not load, and tries again at the next use', async () => {
        const { frame, parts } = setup()
        parts.factories.contents.mockRejectedValueOnce(
            new TypeError('Failed to fetch dynamically imported module'),
        )
        control(frame, 'contents').click()
        await flush()
        expect(toastText()).toBe(PART_LOAD_MESSAGE)
        expect(PART_LOAD_MESSAGE).toBe(
            'This part did not load. Check the connection and try again.',
        )
        expect(parts.made.contents).toBeUndefined()

        control(frame, 'contents').click()
        await flush()
        expect(parts.factories.contents).toHaveBeenCalledTimes(2)
        expect(parts.made.contents?.open).toHaveBeenCalledTimes(1)
    })

    it('shows the same message for a mode that does not load', async () => {
        const { frame, parts } = setup()
        parts.factories.listen.mockRejectedValueOnce(new Error('offline'))
        control(frame, 'listen').click()
        await flush()
        expect(toastText()).toBe(PART_LOAD_MESSAGE)

        control(frame, 'listen').click()
        await flush()
        expect(parts.made.listen?.start).toHaveBeenCalledTimes(1)
    })

    it('loads the selection tools, the note popover and the image viewer in idle time', async () => {
        const { frame, session, parts } = setup()
        vi.advanceTimersByTime(1000)
        await flush()
        expect(parts.factories.selection).toHaveBeenCalledTimes(1)
        expect(parts.factories.notePopover).toHaveBeenCalledTimes(1)
        expect(parts.factories.imageViewer).toHaveBeenCalledTimes(1)
        expect(parts.options.notePopover).toEqual({ session, host: frame.overlay })
        expect(parts.options.imageViewer).toEqual({ session, host: frame.overlay })
        expect(parts.made.selection?.options).toMatchObject({ session, host: frame.overlay })
    })

    it('shows no message when a tool does not load in idle time', async () => {
        const { parts } = setup()
        parts.factories.selection.mockRejectedValueOnce(new Error('offline'))
        vi.advanceTimersByTime(1000)
        await flush()
        expect(toastText()).toBeNull()
    })

    it('loads a tool again when the user needs it, and then shows the message', async () => {
        const { session, parts } = setup()
        parts.factories.selection.mockRejectedValue(new Error('offline'))
        parts.factories.imageViewer.mockRejectedValue(new Error('offline'))
        vi.advanceTimersByTime(1000)
        await flush()

        session.emit('selection', {
            range: { spineIndex: 1, start: 4, end: 9 },
            text: 'whale',
            bounds: new DOMRect(),
        })
        await flush()
        expect(parts.factories.selection).toHaveBeenCalledTimes(2)
        expect(toastText()).toBe(PART_LOAD_MESSAGE)

        session.emit('selection', null)
        await flush()
        expect(parts.factories.selection).toHaveBeenCalledTimes(2)

        session.emit('image-tap', { src: 'blob:x', alt: '' })
        await flush()
        expect(parts.factories.imageViewer).toHaveBeenCalledTimes(2)
    })

    it('follows a note link while the note popover is not there', async () => {
        const { session, parts } = setup()
        const target = {
            kind: 'internal' as const,
            path: 'OEBPS/notes.xhtml',
            fragment: 'n1',
            spineIndex: 2,
            noteref: true,
            bounds: new DOMRect(),
        }
        session.emit('note-tap', { target })
        await flush()
        expect(session.followLink).toHaveBeenCalledWith(target)
        expect(parts.factories.notePopover).toHaveBeenCalledTimes(1)

        // The popover shows the next note itself.
        session.emit('note-tap', { target })
        expect(session.followLink).toHaveBeenCalledTimes(1)
    })

    it('connects the selection tools to the search panel', async () => {
        const { parts } = setup()
        vi.advanceTimersByTime(1000)
        await flush()
        parts.made.selection?.options.onSearch('white whale')
        await flush()
        expect(parts.made.search?.open).toHaveBeenCalledWith('white whale')
    })

    it('starts the speed reader at the place that the selection tools give', async () => {
        const { parts } = setup()
        vi.advanceTimersByTime(1000)
        await flush()
        parts.made.selection?.options.onSpeedRead({ spineIndex: 1, offset: 40 })
        await flush()
        expect(parts.made.speed?.start).toHaveBeenCalledWith({ spineIndex: 1, offset: 40 })
    })

    it('starts the listen bar at the place that the selection tools give', async () => {
        const { parts } = setup()
        vi.advanceTimersByTime(1000)
        await flush()
        parts.made.selection?.options.onListen({ spineIndex: 2, offset: 7 })
        await flush()
        expect(parts.made.listen?.start).toHaveBeenCalledWith({ spineIndex: 2, offset: 7 })
    })
})

describe('the modes', () => {
    it('loads the speed reader at the first use of its button', async () => {
        const { frame, session, parts } = setup()
        control(frame, 'speed').click()
        await flush()
        expect(parts.factories.speed).toHaveBeenCalledTimes(1)
        expect(parts.options.speed).toMatchObject({
            session,
            host: frame.overlay,
            dock: frame.dock,
        })
        expect(parts.made.speed?.start).toHaveBeenCalledWith(undefined)
        expect(session.mode).toBe('speed')
        expect(barsVisible(frame)).toBe(false)
    })

    it('loads the listen bar at the first use of its button', async () => {
        const { frame, session, parts } = setup()
        control(frame, 'listen').click()
        await flush()
        expect(parts.options.listen).toMatchObject({
            session,
            host: frame.overlay,
            dock: frame.dock,
        })
        expect(parts.made.listen?.start).toHaveBeenCalledWith(undefined)
        expect(session.mode).toBe('listen')
    })

    it('starts the load of a mode with the press on its button', async () => {
        const { frame, parts } = setup()
        const button = control(frame, 'listen')
        pointer(button, 'pointerdown', { pointerType: 'touch' })
        await flush()
        expect(parts.factories.listen).toHaveBeenCalledTimes(1)
        expect(parts.made.listen?.start).not.toHaveBeenCalled()

        // The module is there, so start() runs inside the click handler.
        button.click()
        expect(parts.made.listen?.start).toHaveBeenCalledTimes(1)
    })

    it.each(['search', 'contents', 'appearance'] as const)(
        'starts the load of the %s panel with the press on its button',
        async (name) => {
            const { frame, parts } = setup()
            const button = control(frame, name)
            pointer(button, 'pointerdown', { pointerType: 'touch' })
            await flush()
            expect(parts.factories[name]).toHaveBeenCalledTimes(1)
            expect(parts.made[name]?.open).not.toHaveBeenCalled()

            // The panel is there, so it opens inside the click handler.
            button.click()
            expect(parts.made[name]?.open).toHaveBeenCalledTimes(1)
            expect(parts.factories[name]).toHaveBeenCalledTimes(1)
        },
    )

    it('starts a loaded mode inside the click handler', async () => {
        const { frame, session, parts } = setup()
        control(frame, 'listen').click()
        await flush()
        await parts.made.listen?.stop()

        control(frame, 'listen').click()
        expect(parts.made.listen?.start).toHaveBeenCalledTimes(2)
        expect(session.mode).toBe('listen')
    })

    it('shows the bars for a moment when the mode calls onExit', async () => {
        const { frame, parts } = setup()
        control(frame, 'speed').click()
        await flush()
        expect(barsVisible(frame)).toBe(false)

        await parts.made.speed?.stop()
        expect(barsVisible(frame)).toBe(true)
        vi.advanceTimersByTime(BARS_PEEK_MS)
        expect(barsVisible(frame)).toBe(false)
    })

    it('stops the other mode before a mode starts, and keeps the bars hidden', async () => {
        const { frame, session, parts } = setup()
        vi.advanceTimersByTime(1000)
        await flush()
        control(frame, 'speed').click()
        await flush()
        const shown: boolean[] = []
        session.on('mode', () => shown.push(barsVisible(frame)))

        parts.made.selection?.options.onListen({ spineIndex: 2, offset: 7 })
        await flush()
        const speed = parts.made.speed!
        const listen = parts.made.listen!
        expect(speed.stop).toHaveBeenCalledTimes(1)
        expect(listen.start).toHaveBeenCalledWith({ spineIndex: 2, offset: 7 })
        expect(speed.stop.mock.invocationCallOrder[0]).toBeLessThan(
            listen.start.mock.invocationCallOrder[0],
        )
        expect(session.mode).toBe('listen')
        expect(shown).toEqual([false, false])
        expect(barsVisible(frame)).toBe(false)
    })

    it.each([
        ['speed', 'listen'],
        ['listen', 'speed'],
    ] as const)(
        'starts only the last mode when the %s reader loads first and the user then asks for the other mode',
        async (firstLoaded, secondLoaded) => {
            const { session, parts } = setup()
            const release = { speed: holdLoad(parts, 'speed'), listen: holdLoad(parts, 'listen') }
            // The two modules load. The mode is 'read' in that time, so the keys work.
            press('s')
            press('l')
            release[firstLoaded]()
            await flush()
            release[secondLoaded]()
            await flush()

            expect(parts.made.speed?.start).not.toHaveBeenCalled()
            expect(parts.made.listen?.start).toHaveBeenCalledTimes(1)
            expect(parts.made.speed?.active).toBe(false)
            expect(session.mode).toBe('listen')
        },
    )

    it('keeps the bars of a mode exit when the page gets a new layout after it', async () => {
        const { frame, session, parts } = setup()
        control(frame, 'listen').click()
        await flush()
        await parts.made.listen?.stop()
        expect(barsVisible(frame)).toBe(true)

        // The listen bar left the dock, so the page is higher and starts at an earlier word.
        session.relocate({
            locator: { spineIndex: 1, offset: 60 },
            visible: { spineIndex: 1, start: 60, end: 170 },
        })
        expect(barsVisible(frame)).toBe(true)
    })

    it('starts a mode that runs again at a new place', async () => {
        const { frame, parts } = setup()
        vi.advanceTimersByTime(1000)
        await flush()
        control(frame, 'listen').click()
        await flush()

        // The mode moves to the new place itself, so the call is in the task of the caller.
        parts.made.selection?.options.onListen({ spineIndex: 2, offset: 7 })
        const listen = parts.made.listen!
        expect(listen.start).toHaveBeenCalledTimes(2)
        expect(listen.start).toHaveBeenLastCalledWith({ spineIndex: 2, offset: 7 })
        expect(listen.stop).not.toHaveBeenCalled()
        expect(barsVisible(frame)).toBe(false)
    })

    it('does not start a mode again that runs already, with no new place', async () => {
        const { frame, parts } = setup()
        control(frame, 'speed').click()
        await flush()
        control(frame, 'speed').click()
        await flush()
        expect(parts.made.speed?.start).toHaveBeenCalledTimes(1)
        expect(parts.made.speed?.stop).not.toHaveBeenCalled()
    })

    it('says so when a mode does not start', async () => {
        const { frame, parts } = setup()
        parts.factories.speed.mockImplementationOnce(async (options) => ({
            active: false,
            start: vi.fn(async () => {
                throw new Error('no text')
            }),
            stop: vi.fn(async () => options.onExit()),
            destroy: vi.fn(),
        }))
        control(frame, 'speed').click()
        await flush()
        expect(toastText()).toBe('Something went wrong.')
    })
})

describe('errors of the session', () => {
    it.each([
        'The reading position could not be saved.',
        'This link cannot be opened.',
        'This link points to a file that is not in the book.',
    ])('shows the message "%s"', (message) => {
        const { session } = setup()
        session.emit('error', new Error(message))
        expect(toastText()).toBe(message)
    })

    it('shows a plain message for each other error', () => {
        const { session } = setup()
        session.emit('error', new Error('File not found in the book: OEBPS/c9.xhtml'))
        expect(toastText()).toBe('Something went wrong.')
    })
})

describe('destroy', () => {
    it('removes each listener of the session, then closes the session', async () => {
        const { session, screen } = setup()
        expect(session.listenerCount()).toBeGreaterThan(0)
        await screen.destroy()
        expect(session.listenerCount()).toBe(0)
        expect(session.destroy).toHaveBeenCalledTimes(1)
    })

    it('destroys each part that is loaded, before the session closes', async () => {
        const { frame, session, parts, screen } = setup()
        vi.advanceTimersByTime(1000)
        control(frame, 'contents').click()
        control(frame, 'search').click()
        control(frame, 'appearance').click()
        press('?')
        await flush()
        control(frame, 'speed').click()
        await flush()
        await parts.made.speed?.stop()
        control(frame, 'listen').click()
        await flush()

        await screen.destroy()
        const made = Object.values(parts.made)
        expect(made).toHaveLength(9)
        for (const part of made) {
            expect(part.destroy).toHaveBeenCalledTimes(1)
            expect(part.destroy.mock.invocationCallOrder[0]).toBeLessThan(
                session.destroy.mock.invocationCallOrder[0],
            )
        }
    })

    it('closes the session also when a part fails in its destroy()', async () => {
        const { frame, session, parts, screen } = setup()
        control(frame, 'contents').click()
        await flush()
        parts.made.contents?.destroy.mockImplementation(() => {
            throw new Error('broken part')
        })
        await expect(screen.destroy()).resolves.toBeUndefined()
        expect(session.destroy).toHaveBeenCalledTimes(1)
    })

    it('does not load the tools after destroy()', async () => {
        const { parts, screen } = setup()
        await screen.destroy()
        vi.advanceTimersByTime(5000)
        await flush()
        expect(parts.factories.selection).not.toHaveBeenCalled()
    })

    it('destroys a part that loads after destroy()', async () => {
        const { frame, parts, screen } = setup()
        control(frame, 'contents').click()
        await screen.destroy()
        await flush()
        expect(parts.made.contents?.destroy).toHaveBeenCalledTimes(1)
        expect(parts.made.contents?.open).not.toHaveBeenCalled()
    })

    it('stops the keyboard, the bars and the timers', async () => {
        const { frame, session, screen } = setup()
        await screen.destroy()
        const before = barsVisible(frame)

        expect(press('ArrowRight').defaultPrevented).toBe(false)
        expect(session.next).not.toHaveBeenCalled()
        vi.advanceTimersByTime(BARS_PEEK_MS * 2)
        session.emit('center-tap', undefined)
        expect(barsVisible(frame)).toBe(before)
        control(frame, 'bookmark').click()
        expect(session.toggleBookmark).not.toHaveBeenCalled()
    })

    it('closes the session one time for two calls', async () => {
        const { session, screen } = setup()
        const first = screen.destroy()
        const second = screen.destroy()
        expect(second).toBe(first)
        await first
        expect(session.destroy).toHaveBeenCalledTimes(1)
    })
})
