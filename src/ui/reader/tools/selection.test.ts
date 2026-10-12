import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SelectionInfo } from '$lib/reader/types'
import type { HighlightRecord } from '$lib/storage/types'
import { installOverlayMethods } from '../../app/testing/page'
import { TOAST_ACTION_DURATION_MS, TOAST_LEAVE_MS, clearToasts } from '../../app/toast'
import type { Part } from '../parts'
import { GHOST_CLICK_MS } from './ghost-click'
import { HIGHLIGHT_COLOR_KEY } from './last-color'
import {
    CLICK_WAIT_MS,
    HELD_SETTLE_MS,
    HIGHLIGHT_REMOVE_ERROR,
    HIGHLIGHT_SAVE_ERROR,
    HIGHLIGHT_UNDO_ERROR,
    RELEASE_SETTLE_MS,
    SELECTION_SETTLE_MS,
    createSelectionTools,
    searchQuery,
} from './selection'
import {
    createFakeSession,
    makeHighlight,
    makeRelocate,
    pointer,
    rect,
    trackListeners,
} from './testing/fake-session'
import type { FakeSession } from './testing/fake-session'

const mocks = vi.hoisted(() => ({
    copyText: vi.fn(async (_text: string) => true),
}))

vi.mock('$lib/annotations/download', () => ({ copyText: mocks.copyText }))

const BAR_WIDTH = 200
const BAR_HEIGHT = 40
const TEXT = 'A sailor saw the white whale'

let host: HTMLElement
let outside: HTMLElement
let fake: FakeSession
let tools: Part
let measures: number
let onSpeedRead: ReturnType<typeof vi.fn<(locator: { spineIndex: number; offset: number }) => void>>
let onListen: ReturnType<typeof vi.fn<(locator: { spineIndex: number; offset: number }) => void>>
let onSearch: ReturnType<typeof vi.fn<(query: string) => void>>

const sizeProperties = ['offsetWidth', 'offsetHeight'] as const
const originalSizes = sizeProperties.map((name) =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
)

function selection(changes: Partial<SelectionInfo> = {}): SelectionInfo {
    return {
        range: { spineIndex: 2, start: 100, end: 128 },
        text: TEXT,
        bounds: rect({ left: 400, top: 300, width: 100, height: 20 }),
        ...changes,
    }
}

const selectionBar = () => host.querySelector<HTMLElement>('[aria-label="Selection"]')!
const editBar = () => host.querySelector<HTMLElement>('[aria-label="Highlight"]')!
const noteDialog = () => host.querySelector<HTMLDialogElement>('dialog.note-dialog')!
const noteInput = () => noteDialog().querySelector<HTMLTextAreaElement>('textarea')!
const isOpen = (bar: HTMLElement) => bar.classList.contains('is-open')
const button = (bar: ParentNode, selector: string) =>
    bar.querySelector<HTMLButtonElement>(selector)!
const pressed = (bar: HTMLElement) =>
    Array.from(bar.querySelectorAll<HTMLElement>('[data-color][aria-pressed="true"]')).map(
        (swatch) => swatch.dataset.color,
    )
const toastText = () => document.querySelector('#toasts .toast span')?.textContent ?? null
const toast = () => document.querySelector<HTMLElement>('#toasts .toast')

/** Lets the promises of the fake session settle. */
const flush = () => vi.advanceTimersByTimeAsync(0)

function mount(highlights: HighlightRecord[] = []): void {
    fake = createFakeSession(highlights)
    tools = createSelectionTools({ session: fake.session, host, onSpeedRead, onListen, onSearch })
}

/** A selection that stays the same for the settle time, with no pointer down. */
function showSelection(value = selection()): void {
    fake.emit('selection', value)
    vi.advanceTimersByTime(SELECTION_SETTLE_MS)
}

function tapHighlight(highlight: HighlightRecord): void {
    fake.emit('highlight-tap', {
        highlight,
        bounds: rect({ left: 400, top: 300, width: 100, height: 20 }),
    })
}

/** A press and a click, as a mouse or a finger makes them. */
function click(target: HTMLElement): PointerEvent {
    const down = pointer('pointerdown')
    target.dispatchEvent(down)
    target.dispatchEvent(pointer('pointerup'))
    target.click()
    return down
}

/** The click event of a mouse or a finger. A click from the keyboard has a detail of 0. */
function pointerClick(target: HTMLElement): void {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
}

beforeEach(() => {
    vi.useFakeTimers()
    installOverlayMethods()
    localStorage.clear()
    mocks.copyText.mockClear()
    mocks.copyText.mockResolvedValue(true)
    document.body.innerHTML =
        '<div id="toasts"></div><div id="host"></div><p id="outside">Text of the book</p>'
    host = document.getElementById('host')!
    outside = document.getElementById('outside')!
    onSpeedRead = vi.fn()
    onListen = vi.fn()
    onSearch = vi.fn()

    // jsdom has no layout. Each toolbar gets a size, and the reads are counted.
    measures = 0
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
            if (this.getAttribute('aria-label') === 'Selection') measures++
            return this.classList.contains('sel-bar') ? BAR_WIDTH : 0
        },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
            return this.classList.contains('sel-bar') ? BAR_HEIGHT : 0
        },
    })
    mount()
})

afterEach(() => {
    tools.destroy()
    clearToasts()
    sizeProperties.forEach((name, index) => {
        const original = originalSizes[index]
        if (original) Object.defineProperty(HTMLElement.prototype, name, original)
    })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

// jsdom has no layout, so this test reads the source text. It keeps the rule in its file.
describe('the stylesheet of the note dialog', () => {
    const css = readFileSync(join(import.meta.dirname, 'selection.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')

    // The keyboard of a phone covers the buttons of a dialog in the middle of the screen.
    it('puts the note dialog near the top on a touch screen', () => {
        const touch = css.slice(css.indexOf('@media (pointer: coarse) {'))

        expect(touch).toMatch(
            /^@media \(pointer: coarse\) \{ \.note-dialog \{ margin-top: [^;]+; \} \}/,
        )
    })
})

describe('the selection toolbar', () => {
    it('is a toolbar with five colours and five actions', () => {
        const bar = selectionBar()

        expect(bar.getAttribute('role')).toBe('toolbar')
        expect(
            Array.from(bar.querySelectorAll('[data-color]')).map((item) =>
                item.getAttribute('aria-label'),
            ),
        ).toEqual([
            'Highlight yellow',
            'Highlight green',
            'Highlight blue',
            'Highlight pink',
            'Highlight purple',
        ])
        const actions = Array.from(bar.querySelectorAll<HTMLElement>('[data-action]'))
        expect(actions.map((item) => item.getAttribute('aria-label'))).toEqual([
            'Add note',
            'Copy',
            'Search',
            'Speed read from here',
            'Listen from here',
        ])
        expect(actions.map((item) => item.title)).toEqual(
            actions.map((item) => item.getAttribute('aria-label')),
        )
        expect(isOpen(bar)).toBe(false)
    })

    it('shows 300 ms after the last selection event', () => {
        fake.emit('selection', selection())
        vi.advanceTimersByTime(SELECTION_SETTLE_MS - 100)
        fake.emit('selection', selection({ range: { spineIndex: 2, start: 100, end: 140 } }))
        vi.advanceTimersByTime(SELECTION_SETTLE_MS - 1)
        expect(isOpen(selectionBar())).toBe(false)

        vi.advanceTimersByTime(1)
        expect(isOpen(selectionBar())).toBe(true)
    })

    it('hides when the selection goes away', () => {
        showSelection()

        fake.emit('selection', null)

        expect(isOpen(selectionBar())).toBe(false)
    })

    it('does not show for a selection that went away during the wait', () => {
        fake.emit('selection', selection())
        fake.emit('selection', null)
        vi.advanceTimersByTime(SELECTION_SETTLE_MS * 2)

        expect(isOpen(selectionBar())).toBe(false)
    })

    it('stays hidden during a drag and shows after the release', () => {
        outside.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', selection())
        vi.advanceTimersByTime(SELECTION_SETTLE_MS * 4)
        expect(isOpen(selectionBar())).toBe(false)

        outside.dispatchEvent(pointer('pointerup'))
        vi.advanceTimersByTime(RELEASE_SETTLE_MS - 1)
        expect(isOpen(selectionBar())).toBe(false)
        vi.advanceTimersByTime(1)
        expect(isOpen(selectionBar())).toBe(true)
    })

    it('shows after a longer time when the page gets no release of the press', () => {
        // A long press that selects a word can end with no pointer event for the page.
        outside.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', selection())
        vi.advanceTimersByTime(HELD_SETTLE_MS - 1)
        expect(isOpen(selectionBar())).toBe(false)

        vi.advanceTimersByTime(1)
        expect(isOpen(selectionBar())).toBe(true)
    })

    it('starts the longer time again for each selection event of a drag', () => {
        outside.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', selection())
        vi.advanceTimersByTime(HELD_SETTLE_MS - 1)
        fake.emit('selection', selection({ range: { spineIndex: 2, start: 100, end: 140 } }))
        vi.advanceTimersByTime(HELD_SETTLE_MS - 1)

        expect(isOpen(selectionBar())).toBe(false)
    })

    it('shows after the system took the press that made the selection', () => {
        // A long press selects a word, and the system then cancels the pointer.
        outside.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', selection())
        outside.dispatchEvent(pointer('pointercancel'))
        vi.advanceTimersByTime(SELECTION_SETTLE_MS - 1)
        expect(isOpen(selectionBar())).toBe(false)

        vi.advanceTimersByTime(1)
        expect(isOpen(selectionBar())).toBe(true)
    })

    it('shows at once for the selection event that the release made', () => {
        outside.dispatchEvent(pointer('pointerdown'))
        outside.dispatchEvent(pointer('pointerup'))

        fake.emit('selection', selection())

        expect(isOpen(selectionBar())).toBe(true)
    })

    it('goes above the selection, in the centre', () => {
        showSelection()

        expect(selectionBar().style.transform).toBe(
            `translate3d(${450 - BAR_WIDTH / 2}px, ${300 - 8 - BAR_HEIGHT}px, 0)`,
        )
    })

    it('goes below the selection when there is no room above it', () => {
        showSelection(selection({ bounds: rect({ left: 400, top: 20, width: 100, height: 20 }) }))

        expect(selectionBar().style.transform).toBe(`translate3d(350px, ${40 + 8}px, 0)`)
    })

    it('docks at the bottom edge on a device with a coarse pointer', () => {
        tools.destroy()
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
        mount()

        showSelection()

        // The system selection menu takes the space next to the selection.
        const y = window.innerHeight - 8 - BAR_HEIGHT
        expect(selectionBar().style.transform).toBe(
            `translate3d(${(window.innerWidth - BAR_WIDTH) / 2}px, ${y}px, 0)`,
        )
    })

    it('measures its size one time, and again after a resize', () => {
        showSelection()
        showSelection(selection({ bounds: rect({ left: 100, top: 500, width: 60, height: 20 }) }))
        expect(measures).toBe(1)

        window.dispatchEvent(new Event('resize'))
        expect(isOpen(selectionBar())).toBe(false)
        showSelection(selection({ bounds: rect({ left: 100, top: 400, width: 60, height: 20 }) }))
        expect(measures).toBe(2)
    })

    it('adds a highlight in the colour of the button', async () => {
        showSelection()

        click(button(selectionBar(), '[data-color="green"]'))
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledTimes(1)
        expect(fake.addHighlight).toHaveBeenCalledWith({
            range: { spineIndex: 2, start: 100, end: 128 },
            text: TEXT,
            color: 'green',
        })
        expect(isOpen(selectionBar())).toBe(false)
    })

    it('keeps the text selection during a press on a button', () => {
        showSelection()

        const down = click(button(selectionBar(), '[data-color="green"]'))
        const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        button(selectionBar(), '[data-action="copy"]').dispatchEvent(mouseDown)

        expect(down.defaultPrevented).toBe(true)
        expect(mouseDown.defaultPrevented).toBe(true)
    })

    it('does the action when the press cleared the selection before the click', async () => {
        showSelection()
        const target = button(selectionBar(), '[data-color="pink"]')

        target.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', null)
        expect(isOpen(selectionBar())).toBe(true)
        target.dispatchEvent(pointer('pointerup'))
        target.click()
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledWith(
            expect.objectContaining({ text: TEXT, color: 'pink' }),
        )
        expect(isOpen(selectionBar())).toBe(false)
    })

    it('hides after a press on the toolbar that cleared the selection and made no click', () => {
        showSelection()
        const target = button(selectionBar(), '[data-color="pink"]')

        target.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', null)
        target.dispatchEvent(pointer('pointercancel'))
        vi.advanceTimersByTime(0)

        expect(isOpen(selectionBar())).toBe(false)
        expect(fake.addHighlight).not.toHaveBeenCalled()
    })

    it('does the action when the click comes some time after the release', async () => {
        showSelection()
        const target = button(selectionBar(), '[data-color="pink"]')

        target.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', null)
        target.dispatchEvent(pointer('pointerup'))
        // On a touch screen the click comes in a later task than the release.
        vi.advanceTimersByTime(50)
        expect(isOpen(selectionBar())).toBe(true)
        pointerClick(target)
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledTimes(1)
        expect(fake.addHighlight).toHaveBeenCalledWith(
            expect.objectContaining({ text: TEXT, color: 'pink' }),
        )
        expect(isOpen(selectionBar())).toBe(false)
    })

    it('hides after a release on the toolbar that cleared the selection and made no click', () => {
        showSelection()
        const target = button(selectionBar(), '[data-color="pink"]')

        target.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', null)
        target.dispatchEvent(pointer('pointerup'))
        vi.advanceTimersByTime(CLICK_WAIT_MS - 1)
        expect(isOpen(selectionBar())).toBe(true)
        vi.advanceTimersByTime(1)

        expect(isOpen(selectionBar())).toBe(false)
        expect(fake.addHighlight).not.toHaveBeenCalled()
    })

    it('shows for a selection from a press that opened a context menu and got no release', () => {
        // The menu of the system takes the release of the pointer.
        outside.dispatchEvent(pointer('pointerdown', { button: 2 }))
        outside.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
        fake.emit('selection', selection())
        vi.advanceTimersByTime(SELECTION_SETTLE_MS)

        expect(isOpen(selectionBar())).toBe(true)
    })

    it('shows for a selection that came before the context menu of the same press', () => {
        outside.dispatchEvent(pointer('pointerdown', { button: 2 }))
        fake.emit('selection', selection())
        outside.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
        vi.advanceTimersByTime(SELECTION_SETTLE_MS)

        expect(isOpen(selectionBar())).toBe(true)
    })

    it('marks the colour that was used last and saves it', async () => {
        showSelection()
        expect(pressed(selectionBar())).toEqual(['yellow'])

        click(button(selectionBar(), '[data-color="purple"]'))
        await flush()
        showSelection(selection({ range: { spineIndex: 2, start: 300, end: 320 } }))

        expect(pressed(selectionBar())).toEqual(['purple'])
        expect(localStorage.getItem(HIGHLIGHT_COLOR_KEY)).toBe('purple')
    })

    it('starts with the saved colour', () => {
        tools.destroy()
        localStorage.setItem(HIGHLIGHT_COLOR_KEY, 'blue')
        mount()

        showSelection()

        expect(pressed(selectionBar())).toEqual(['blue'])
    })

    it('keeps the last colour in memory when storage is blocked', async () => {
        tools.destroy()
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError')
        })
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError')
        })
        mount()

        showSelection()
        expect(pressed(selectionBar())).toEqual(['yellow'])
        click(button(selectionBar(), '[data-color="blue"]'))
        await flush()
        showSelection(selection({ range: { spineIndex: 2, start: 300, end: 320 } }))
        expect(pressed(selectionBar())).toEqual(['blue'])

        click(button(selectionBar(), '[data-action="note"]'))
        await flush()
        expect(fake.addHighlight).toHaveBeenLastCalledWith(
            expect.objectContaining({ color: 'blue' }),
        )
    })

    it('adds a highlight in the last colour and opens the note dialog for it', async () => {
        localStorage.setItem(HIGHLIGHT_COLOR_KEY, 'green')
        tools.destroy()
        mount()
        showSelection()

        click(button(selectionBar(), '[data-action="note"]'))
        expect(noteDialog().open).toBe(false)
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledWith({
            range: { spineIndex: 2, start: 100, end: 128 },
            text: TEXT,
            color: 'green',
        })
        expect(noteDialog().open).toBe(true)
        expect(noteDialog().querySelector('.note-dialog-quote')?.textContent).toBe(TEXT)

        noteInput().value = 'A first note'
        click(button(noteDialog(), '[data-action="save"]'))
        await flush()
        expect(fake.updateHighlight).toHaveBeenCalledWith('new-1', { note: 'A first note' })
    })

    it('copies the text, shows a toast and clears the selection', async () => {
        showSelection()

        click(button(selectionBar(), '[data-action="copy"]'))
        expect(mocks.copyText).toHaveBeenCalledWith(TEXT)
        expect(fake.clearSelection).toHaveBeenCalledTimes(1)
        expect(isOpen(selectionBar())).toBe(false)

        await flush()
        expect(toastText()).toBe('Copied')
    })

    it('shows an error when the browser refused the copy', async () => {
        mocks.copyText.mockResolvedValue(false)
        showSelection()

        click(button(selectionBar(), '[data-action="copy"]'))
        await flush()

        expect(toastText()).toBe('The text was not copied.')
        expect(toast()?.classList.contains('toast-error')).toBe(true)
    })

    it('searches for the text, cut to 80 characters, and clears the selection', () => {
        const long = 'word '.repeat(40).trim()
        showSelection(selection({ text: long }))

        click(button(selectionBar(), '[data-action="search"]'))

        expect(onSearch).toHaveBeenCalledWith(long.slice(0, 80).trim())
        expect(onSearch.mock.calls[0][0].length).toBeLessThanOrEqual(80)
        expect(fake.clearSelection).toHaveBeenCalledTimes(1)
    })

    it('starts the speed reader at the start of the selection', () => {
        showSelection()

        click(button(selectionBar(), '[data-action="speed"]'))

        expect(onSpeedRead).toHaveBeenCalledWith({ spineIndex: 2, offset: 100 })
        expect(isOpen(selectionBar())).toBe(false)
    })

    it('starts speech at the start of the selection, inside the click', () => {
        showSelection()
        const target = button(selectionBar(), '[data-action="listen"]')
        let callsDuringClick = -1
        // This listener runs after the listener of the toolbar, in the same click.
        host.addEventListener('click', () => {
            callsDuringClick = onListen.mock.calls.length
        })

        click(target)

        expect(onListen).toHaveBeenCalledWith({ spineIndex: 2, offset: 100 })
        expect(callsDuringClick).toBe(1)
    })

    it('shows a toast when the highlight was not saved', async () => {
        fake.state.failWrites = true
        showSelection()

        click(button(selectionBar(), '[data-color="yellow"]'))
        await flush()

        expect(toastText()).toBe(HIGHLIGHT_SAVE_ERROR)
        expect(HIGHLIGHT_SAVE_ERROR).toBe('The highlight was not saved.')
        expect(toast()?.classList.contains('toast-error')).toBe(true)
    })

    it('does not open the note dialog when the highlight was not saved', async () => {
        fake.state.failWrites = true
        showSelection()

        click(button(selectionBar(), '[data-action="note"]'))
        await flush()

        expect(noteDialog().open).toBe(false)
        expect(toastText()).toBe(HIGHLIGHT_SAVE_ERROR)
    })

    it('moves the focus with the arrow keys', () => {
        showSelection()
        const buttons = Array.from(selectionBar().querySelectorAll('button'))
        buttons[0].focus()

        const key = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
        buttons[0].dispatchEvent(key)
        expect(document.activeElement).toBe(buttons[1])

        buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
        expect(document.activeElement).toBe(buttons[9])

        buttons[9].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        expect(document.activeElement).toBe(buttons[0])
    })
})

// The toolbar is the last element in the order of the Tab key, after each link of the book.
describe('the Tab key and the selection toolbar', () => {
    function tab(init: KeyboardEventInit = {}, target: EventTarget = document.body) {
        const event = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
            ...init,
        })
        target.dispatchEvent(event)
        return event
    }

    const inBar = () => selectionBar().contains(document.activeElement)

    it('moves the focus from the page to the last colour of the open toolbar', () => {
        tools.destroy()
        localStorage.setItem(HIGHLIGHT_COLOR_KEY, 'blue')
        mount()
        showSelection()

        const event = tab()

        expect(document.activeElement).toBe(button(selectionBar(), '[data-color="blue"]'))
        expect(event.defaultPrevented).toBe(true)
        expect(isOpen(selectionBar())).toBe(true)
    })

    it('adds the highlight for the Enter key on that button, and gives the focus back', async () => {
        showSelection()
        tab()

        // Enter on a button gives a click with no press before it.
        ;(document.activeElement as HTMLElement).click()
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledTimes(1)
        expect(fake.addHighlight).toHaveBeenCalledWith({
            range: { spineIndex: 2, start: 100, end: 128 },
            text: TEXT,
            color: 'yellow',
        })
        expect(isOpen(selectionBar())).toBe(false)
        // A hidden button that keeps the focus would also keep the keys from the page.
        expect(inBar()).toBe(false)
    })

    it('leaves the key to the browser when no toolbar is open', () => {
        expect(tab().defaultPrevented).toBe(false)
        expect(inBar()).toBe(false)

        // The toolbar waits for the end of the selection.
        fake.emit('selection', selection())
        expect(tab().defaultPrevented).toBe(false)
        expect(inBar()).toBe(false)
    })

    it('leaves the key to the browser when the focus is in the toolbar', () => {
        showSelection()
        tab()
        const focused = document.activeElement!

        expect(tab({}, focused).defaultPrevented).toBe(false)
        expect(document.activeElement).toBe(focused)
    })

    it.each([{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }])(
        'leaves the key with %j to the browser',
        (init) => {
            showSelection()

            expect(tab(init).defaultPrevented).toBe(false)
            expect(inBar()).toBe(false)
        },
    )

    it('does not go to the toolbar of a highlight, which a tap opens', () => {
        tools.destroy()
        mount([makeHighlight()])
        tapHighlight(makeHighlight())

        expect(tab().defaultPrevented).toBe(false)
        expect(editBar().contains(document.activeElement)).toBe(false)
    })

    it('takes the focus out of the toolbar when Escape closes it', () => {
        showSelection()
        tab()

        document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )

        expect(isOpen(selectionBar())).toBe(false)
        expect(inBar()).toBe(false)
    })
})

describe('hiding the toolbars', () => {
    it('hides on Escape and keeps the key from the rest of the page', () => {
        const onKey = vi.fn()
        document.body.addEventListener('keydown', onKey)
        showSelection()

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

        expect(isOpen(selectionBar())).toBe(false)
        expect(onKey).not.toHaveBeenCalled()
    })

    it('lets Escape through when no toolbar is open', () => {
        const onKey = vi.fn()
        document.body.addEventListener('keydown', onKey)

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

        expect(onKey).toHaveBeenCalledTimes(1)
    })

    it('hides when the page turns', () => {
        showSelection()

        fake.emit('relocate', makeRelocate(900))

        expect(isOpen(selectionBar())).toBe(false)
    })

    it('stays for a relocate event with the same position', () => {
        fake.emit('relocate', makeRelocate(900))
        showSelection()

        fake.emit('relocate', makeRelocate(900))

        expect(isOpen(selectionBar())).toBe(true)
    })

    it('hides on a scroll', () => {
        showSelection()

        outside.dispatchEvent(new Event('scroll'))

        expect(isOpen(selectionBar())).toBe(false)
    })

    it('does not show for a selection that scrolled away during the wait', () => {
        fake.emit('selection', selection())
        window.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(SELECTION_SETTLE_MS * 2)

        expect(isOpen(selectionBar())).toBe(false)
    })

    it('keeps the selection of a drag that scrolls the page, and shows after the release', () => {
        outside.dispatchEvent(pointer('pointerdown'))
        fake.emit('selection', selection())
        window.dispatchEvent(new Event('scroll'))
        outside.dispatchEvent(pointer('pointerup'))
        vi.advanceTimersByTime(RELEASE_SETTLE_MS)

        expect(isOpen(selectionBar())).toBe(true)
    })

    it('hides on a press outside it', () => {
        showSelection()

        outside.dispatchEvent(pointer('pointerdown'))

        expect(isOpen(selectionBar())).toBe(false)
    })

    it('does not come back after a press outside it that kept the selection', () => {
        showSelection()

        outside.dispatchEvent(pointer('pointerdown'))
        outside.dispatchEvent(pointer('pointerup'))
        vi.advanceTimersByTime(SELECTION_SETTLE_MS * 2)

        expect(isOpen(selectionBar())).toBe(false)
    })

    it('hides when the mode changes', () => {
        showSelection()

        fake.emit('mode', 'speed')

        expect(isOpen(selectionBar())).toBe(false)
    })
})

describe('the toolbar of a highlight', () => {
    const plain = makeHighlight()
    const noted = makeHighlight({ id: 'h2', color: 'blue', note: 'See <b>chapter</b> 4' })

    beforeEach(() => {
        tools.destroy()
        mount([plain, noted])
    })

    it('shows at the highlight with the colour of the highlight marked', () => {
        tapHighlight(plain)

        expect(isOpen(editBar())).toBe(true)
        expect(editBar().style.transform).toBe(
            `translate3d(${450 - BAR_WIDTH / 2}px, ${300 - 8 - BAR_HEIGHT}px, 0)`,
        )
        expect(pressed(editBar())).toEqual(['yellow'])
        expect(
            Array.from(editBar().querySelectorAll('[data-action]')).map((item) =>
                item.getAttribute('aria-label'),
            ),
        ).toEqual(['Add note', 'Copy', 'Remove highlight'])
    })

    it('has no note text for a highlight without a note', () => {
        tapHighlight(plain)

        const note = editBar().querySelector<HTMLElement>('.sel-note')!
        expect(note.hidden).toBe(true)
        expect(note.textContent).toBe('')
        expect(button(editBar(), '[data-action="note"]').title).toBe('Add note')
    })

    it('shows the note as text above the buttons', () => {
        tapHighlight(noted)

        const note = editBar().querySelector<HTMLElement>('.sel-note')!
        expect(note.hidden).toBe(false)
        expect(note.textContent).toBe('See <b>chapter</b> 4')
        expect(note.querySelector('b')).toBeNull()
        expect(note.nextElementSibling?.classList.contains('sel-bar-body')).toBe(true)
        expect(pressed(editBar())).toEqual(['blue'])
        expect(button(editBar(), '[data-action="note"]').getAttribute('aria-label')).toBe(
            'Edit note',
        )
    })

    it('replaces the selection toolbar', () => {
        showSelection()

        tapHighlight(plain)

        expect(isOpen(selectionBar())).toBe(false)
        expect(isOpen(editBar())).toBe(true)
    })

    it('closes for a new selection', () => {
        tapHighlight(plain)

        showSelection()

        expect(isOpen(editBar())).toBe(false)
        expect(isOpen(selectionBar())).toBe(true)
    })

    it('changes the colour and stays open', async () => {
        tapHighlight(plain)

        click(button(editBar(), '[data-color="pink"]'))
        expect(pressed(editBar())).toEqual(['pink'])
        await flush()

        expect(fake.updateHighlight).toHaveBeenCalledWith('h1', { color: 'pink' })
        expect(isOpen(editBar())).toBe(true)
        expect(pressed(editBar())).toEqual(['pink'])
        expect(localStorage.getItem(HIGHLIGHT_COLOR_KEY)).toBe('pink')
    })

    it('puts the old colour back when the change was not saved', async () => {
        fake.state.failWrites = true
        tapHighlight(plain)

        click(button(editBar(), '[data-color="pink"]'))
        await flush()

        expect(pressed(editBar())).toEqual(['yellow'])
        expect(toastText()).toBe(HIGHLIGHT_SAVE_ERROR)
    })

    it('copies the text of the highlight', async () => {
        tapHighlight(plain)

        click(button(editBar(), '[data-action="copy"]'))
        await flush()

        expect(mocks.copyText).toHaveBeenCalledWith('the white whale')
        expect(toastText()).toBe('Copied')
        expect(isOpen(editBar())).toBe(false)
    })

    it('removes the highlight and can add it again from the toast', async () => {
        tapHighlight(noted)

        click(button(editBar(), '[data-action="remove"]'))
        await flush()

        expect(fake.removeHighlight).toHaveBeenCalledWith('h2')
        expect(isOpen(editBar())).toBe(false)
        expect(toastText()).toBe('Highlight removed')
        const undo = toast()!.querySelector('button')!
        expect(undo.textContent).toBe('Undo')

        undo.click()
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledWith({
            range: { spineIndex: 2, start: 10, end: 25 },
            text: 'the white whale',
            color: 'blue',
            note: 'See <b>chapter</b> 4',
        })
    })

    it('shows an error and no Undo when the highlight was not removed', async () => {
        fake.state.failWrites = true
        tapHighlight(plain)

        click(button(editBar(), '[data-action="remove"]'))
        await flush()

        expect(toastText()).toBe(HIGHLIGHT_REMOVE_ERROR)
        expect(toast()!.querySelector('button')).toBeNull()
    })

    it('shows no error after an Undo that put the highlight back', async () => {
        tapHighlight(plain)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()

        toast()!.querySelector('button')!.click()
        await flush()
        vi.advanceTimersByTime(TOAST_LEAVE_MS)

        expect(fake.session.highlights.map((item) => item.id)).toEqual(['h2', 'new-1'])
        expect(toast()).toBeNull()
    })

    it('says when the Undo did not put the highlight back, because storage did not write', async () => {
        tapHighlight(plain)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()
        fake.state.failWrites = true

        toast()!.querySelector('button')!.click()
        await flush()
        vi.advanceTimersByTime(TOAST_LEAVE_MS)

        expect(toastText()).toBe(HIGHLIGHT_UNDO_ERROR)
        expect(HIGHLIGHT_UNDO_ERROR).toBe('The highlight was not put back.')
        expect(toast()!.classList.contains('toast-error')).toBe(true)
        expect(toast()!.querySelector('button')).toBeNull()
    })

    // The toast is in the app shell, so it stays on screen when the reader closes the book.
    it('says when the Undo comes after the reader closed the book', async () => {
        tapHighlight(noted)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()
        tools.destroy()
        // The session of a closed book stores nothing and rejects.
        fake.addHighlight.mockImplementationOnce(async () => {
            throw new Error('The book is closed, so the highlight was not saved.')
        })

        toast()!.querySelector('button')!.click()
        await flush()
        vi.advanceTimersByTime(TOAST_LEAVE_MS)

        expect(fake.addHighlight).toHaveBeenCalledTimes(1)
        expect(fake.session.highlights.map((item) => item.id)).toEqual(['h1'])
        expect(toastText()).toBe(HIGHLIGHT_UNDO_ERROR)
        expect(toast()!.classList.contains('toast-error')).toBe(true)
    })

    it('says when the Undo gives a record that the session did not store', async () => {
        tapHighlight(noted)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()
        fake.addHighlight.mockImplementationOnce(async () => makeHighlight({ id: 'not-stored' }))

        toast()!.querySelector('button')!.click()
        await flush()
        vi.advanceTimersByTime(TOAST_LEAVE_MS)

        expect(fake.session.highlights.map((item) => item.id)).toEqual(['h1'])
        expect(toastText()).toBe(HIGHLIGHT_UNDO_ERROR)
    })

    it('shows one message when the Undo put no highlight of two back', async () => {
        tapHighlight(plain)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()
        tapHighlight(noted)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()
        fake.state.failWrites = true

        toast()!.querySelector('button')!.click()
        await flush()
        vi.advanceTimersByTime(TOAST_LEAVE_MS)

        expect(fake.addHighlight).toHaveBeenCalledTimes(2)
        expect(document.querySelectorAll('#toasts .toast')).toHaveLength(1)
        expect(toastText()).toBe(HIGHLIGHT_UNDO_ERROR)
    })

    it('adds two highlights again when both were removed in the time of one toast', async () => {
        tapHighlight(plain)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()
        tapHighlight(noted)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()

        // The toast module shows one toast for one message.
        expect(document.querySelectorAll('#toasts .toast')).toHaveLength(1)
        toast()!.querySelector('button')!.click()
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledTimes(2)
        expect(fake.addHighlight).toHaveBeenCalledWith(
            expect.objectContaining({
                range: { spineIndex: 2, start: 10, end: 25 },
                color: 'yellow',
            }),
        )
        expect(fake.addHighlight).toHaveBeenCalledWith(
            expect.objectContaining({ color: 'blue', note: 'See <b>chapter</b> 4' }),
        )
    })

    it('adds only the last highlight again when the toast of the first one is gone', async () => {
        tapHighlight(plain)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()
        vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS + TOAST_LEAVE_MS)
        expect(toast()).toBeNull()

        tapHighlight(noted)
        click(button(editBar(), '[data-action="remove"]'))
        await flush()
        toast()!.querySelector('button')!.click()
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledTimes(1)
        expect(fake.addHighlight).toHaveBeenCalledWith(expect.objectContaining({ color: 'blue' }))
    })

    it('gives a new toast its full time after the Undo of the toast before it', async () => {
        const remove = async (highlight: HighlightRecord) => {
            tapHighlight(highlight)
            click(button(editBar(), '[data-action="remove"]'))
            await flush()
        }
        await remove(plain)
        toast()!.querySelector('button')!.click()
        await flush()
        const again = fake.session.highlights.find((item) => item.id === 'new-1')!

        // The second toast starts late in the time of the first one.
        vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS - 2000)
        await remove(again)
        vi.advanceTimersByTime(3000)
        await remove(noted)
        expect(document.querySelectorAll('#toasts .toast')).toHaveLength(1)
        fake.addHighlight.mockClear()
        toast()!.querySelector('button')!.click()
        await flush()

        expect(fake.addHighlight).toHaveBeenCalledTimes(2)
    })

    it('ignores the click of the tap that opened it', () => {
        tapHighlight(plain)
        const remove = button(editBar(), '[data-action="remove"]')

        // On a touch screen the click of the tap comes after the toolbar opened below the finger.
        pointerClick(remove)
        expect(fake.removeHighlight).not.toHaveBeenCalled()
        expect(isOpen(editBar())).toBe(true)

        // A press on the button is a new tap.
        remove.dispatchEvent(pointer('pointerdown'))
        remove.dispatchEvent(pointer('pointerup'))
        pointerClick(remove)
        expect(fake.removeHighlight).toHaveBeenCalledWith('h1')
    })

    it('takes a click with no press before it after a moment', () => {
        tapHighlight(plain)
        vi.advanceTimersByTime(GHOST_CLICK_MS)

        // A screen reader can send a click with no pointer events.
        pointerClick(button(editBar(), '[data-action="remove"]'))

        expect(fake.removeHighlight).toHaveBeenCalledWith('h1')
    })

    it('closes when the highlight is removed from a different place', async () => {
        tapHighlight(plain)

        await fake.session.removeHighlight('h1')

        expect(isOpen(editBar())).toBe(false)
    })

    it('closes on Escape, on a scroll and when the page turns', () => {
        tapHighlight(plain)
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(isOpen(editBar())).toBe(false)

        tapHighlight(plain)
        window.dispatchEvent(new Event('scroll'))
        expect(isOpen(editBar())).toBe(false)

        tapHighlight(plain)
        fake.emit('relocate', makeRelocate(1200))
        expect(isOpen(editBar())).toBe(false)
    })

    it('closes on a press outside it, and the press goes no further', () => {
        const onPress = vi.fn()
        outside.addEventListener('pointerdown', onPress)
        tapHighlight(plain)

        outside.dispatchEvent(pointer('pointerdown'))

        expect(isOpen(editBar())).toBe(false)
        expect(onPress).not.toHaveBeenCalled()

        // With no toolbar open, the page gets the press.
        outside.dispatchEvent(pointer('pointerdown'))
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('stays open for a press on its own buttons', () => {
        tapHighlight(plain)

        button(editBar(), '[data-color="green"]').dispatchEvent(pointer('pointerdown'))

        expect(isOpen(editBar())).toBe(true)
    })

    it('lets a press on a highlight through, and the second tap on the same one closes', () => {
        outside.innerHTML = '<mark class="rd-hl" data-id="h1">the white whale</mark>'
        const mark = outside.querySelector('mark')!
        const onPress = vi.fn()
        outside.addEventListener('pointerdown', onPress)
        tapHighlight(plain)

        mark.dispatchEvent(pointer('pointerdown'))
        expect(onPress).toHaveBeenCalledTimes(1)
        expect(isOpen(editBar())).toBe(false)
        tapHighlight(plain)
        expect(isOpen(editBar())).toBe(false)

        mark.dispatchEvent(pointer('pointerdown'))
        tapHighlight(plain)
        expect(isOpen(editBar())).toBe(true)
    })

    it('goes to a different highlight with one tap', () => {
        outside.innerHTML = '<mark class="rd-hl" data-id="h2">the white whale</mark>'
        tapHighlight(plain)

        outside.querySelector('mark')!.dispatchEvent(pointer('pointerdown'))
        tapHighlight(noted)

        expect(isOpen(editBar())).toBe(true)
        expect(pressed(editBar())).toEqual(['blue'])
    })
})

describe('the note dialog', () => {
    const plain = makeHighlight()
    const noted = makeHighlight({ id: 'h2', note: 'An old note' })

    beforeEach(() => {
        tools.destroy()
        mount([plain, noted])
    })

    function openNote(highlight: HighlightRecord): void {
        tapHighlight(highlight)
        click(button(editBar(), '[data-action="note"]'))
    }

    it('opens with the quote, the note and a labelled text field', () => {
        openNote(noted)

        const dialog = noteDialog()
        expect(dialog.open).toBe(true)
        expect(isOpen(editBar())).toBe(false)
        expect(dialog.classList.contains('modal')).toBe(true)
        expect(dialog.querySelector('.modal-title')?.textContent).toBe('Edit note')
        expect(dialog.getAttribute('aria-labelledby')).toBe(
            dialog.querySelector('.modal-title')?.id,
        )
        expect(dialog.querySelector('.note-dialog-quote')?.textContent).toBe('the white whale')
        expect(noteInput().value).toBe('An old note')
        expect(noteInput().getAttribute('aria-label')).toBe('Note')
        expect(noteInput().maxLength).toBe(5000)
        expect(document.activeElement).toBe(noteInput())
        expect(button(dialog, '[data-action="remove"]').hidden).toBe(false)
    })

    it('has no Remove note button for a highlight without a note', () => {
        openNote(plain)

        expect(noteDialog().querySelector('.modal-title')?.textContent).toBe('Add note')
        expect(noteInput().value).toBe('')
        expect(button(noteDialog(), '[data-action="remove"]').hidden).toBe(true)
    })

    it('saves the note and closes', async () => {
        openNote(plain)
        noteInput().value = '  A new note\nwith two lines  '

        click(button(noteDialog(), '[data-action="save"]'))
        await flush()

        expect(fake.updateHighlight).toHaveBeenCalledWith('h1', {
            note: 'A new note\nwith two lines',
        })
        expect(noteDialog().open).toBe(false)
    })

    it('saves with Control and Enter', async () => {
        openNote(plain)
        noteInput().value = 'Fast'

        noteInput().dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
        )
        await flush()

        expect(fake.updateHighlight).toHaveBeenCalledWith('h1', { note: 'Fast' })
    })

    it('cuts a note to 5000 characters', async () => {
        openNote(plain)
        noteInput().value = 'x'.repeat(6000)

        click(button(noteDialog(), '[data-action="save"]'))
        await flush()

        const [, patch] = fake.updateHighlight.mock.calls[0]
        expect(patch.note).toHaveLength(5000)
    })

    it('removes the note', async () => {
        openNote(noted)

        click(button(noteDialog(), '[data-action="remove"]'))
        await flush()

        expect(fake.updateHighlight).toHaveBeenCalledWith('h2', { note: '' })
        expect(noteDialog().open).toBe(false)
    })

    it('changes nothing on Cancel', async () => {
        openNote(noted)
        noteInput().value = 'Not this'

        click(button(noteDialog(), '[data-action="cancel"]'))
        await flush()

        expect(fake.updateHighlight).not.toHaveBeenCalled()
        expect(noteDialog().open).toBe(false)
    })

    it('stays open with the text and an error when the note was not saved', async () => {
        fake.state.failWrites = true
        openNote(plain)
        noteInput().value = 'Do not lose this'

        click(button(noteDialog(), '[data-action="save"]'))
        await flush()

        const error = noteDialog().querySelector<HTMLElement>('.note-dialog-error')!
        expect(noteDialog().open).toBe(true)
        expect(noteInput().value).toBe('Do not lose this')
        expect(error.hidden).toBe(false)
        expect(error.textContent).toBe('The note was not saved.')

        fake.state.failWrites = false
        click(button(noteDialog(), '[data-action="save"]'))
        await flush()
        expect(noteDialog().open).toBe(false)
    })

    it('keeps the keys of the text field away from the page', () => {
        const onKey = vi.fn()
        document.addEventListener('keydown', onKey)
        openNote(plain)

        noteInput().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))

        document.removeEventListener('keydown', onKey)
        expect(onKey).not.toHaveBeenCalled()
    })
})

describe('destroy', () => {
    it('removes its elements, its listeners and its timer', () => {
        tools.destroy()
        const onDocument = trackListeners(document)
        const onWindow = trackListeners(window)
        try {
            mount()
            expect(onDocument.active().sort()).toEqual([
                'contextmenu',
                'keydown',
                'pointercancel',
                'pointerdown',
                'pointerup',
            ])
            expect(onWindow.active().sort()).toEqual(['blur', 'resize', 'scroll'])
            expect(fake.listenerCount()).toBe(5)

            fake.emit('selection', selection())
            tools.destroy()
            vi.advanceTimersByTime(SELECTION_SETTLE_MS * 2)

            expect(host.childElementCount).toBe(0)
            expect(onDocument.active()).toEqual([])
            expect(onWindow.active()).toEqual([])
            expect(fake.listenerCount()).toBe(0)
        } finally {
            onDocument.restore()
            onWindow.restore()
        }

        // Events after the end do nothing.
        fake.emit('selection', selection())
        outside.dispatchEvent(pointer('pointerdown'))
        tools.destroy()
    })
})

describe('searchQuery', () => {
    it('keeps a short text', () => {
        expect(searchQuery('white whale')).toBe('white whale')
    })

    it('cuts a long text to 80 characters with no space at the end', () => {
        const text = `${'a'.repeat(79)} ${'b'.repeat(40)}`

        expect(searchQuery(text)).toBe('a'.repeat(79))
    })

    it('does not cut a character in two', () => {
        const text = `${'a'.repeat(79)}\u{1F40B}${'b'.repeat(10)}`

        expect(searchQuery(text)).toBe('a'.repeat(79))
    })
})
