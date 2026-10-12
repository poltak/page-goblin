import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkTarget } from '$lib/reader/types'
import { DEFAULT_SETTINGS } from '$lib/settings/schema'
import type { Settings } from '$lib/settings/schema'
import { clearToasts } from '../../app/toast'
import type { Part } from '../parts'
import { GHOST_CLICK_MS } from './ghost-click'
import { createNotePopover } from './note-popover'
import { getNoteBaseSheet, noteBaseCss } from './note-style'
import {
    createFakeSession,
    makeRelocate,
    pointer,
    rect,
    trackListeners,
} from './testing/fake-session'
import type { FakeSession } from './testing/fake-session'

type NoteTarget = Extract<LinkTarget, { kind: 'internal' }>
type LoadedNote = { element: HTMLElement; styles: readonly CSSStyleSheet[] }

const mocks = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))

vi.mock('$lib/settings/store', () => ({ settings: { get: () => mocks.settings } }))

const CARD_WIDTH = 360

let host: HTMLElement
let outside: HTMLElement
let fake: FakeSession
let popover: Part
let cardHeight: number

const sizeProperties = ['offsetWidth', 'offsetHeight'] as const
const originalSizes = sizeProperties.map((name) =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
)
const originalWidth = window.innerWidth

function target(changes: Partial<NoteTarget> = {}): NoteTarget {
    return {
        kind: 'internal',
        path: 'OEBPS/notes.xhtml',
        fragment: 'n1',
        spineIndex: 3,
        noteref: true,
        bounds: rect({ left: 400, top: 300, width: 10, height: 12 }),
        ...changes,
    }
}

function note(html = '<p>1. The first note about the white whale.</p>'): LoadedNote {
    const element = document.createElement('aside')
    element.innerHTML = html
    return { element, styles: [] }
}

function setSettings(changes: Partial<Settings>): void {
    mocks.settings = { ...DEFAULT_SETTINGS, ...changes }
}

const card = () => host.querySelector<HTMLElement>('.note-pop')!
const surface = () => card().querySelector<HTMLElement>('.note-card')!
const noteHost = () => card().querySelector<HTMLElement>('.note-body')!
const shadow = () => noteHost().shadowRoot!
const isOpen = () => card().classList.contains('is-open')
const flush = () => vi.advanceTimersByTimeAsync(0)

function mount(): void {
    fake = createFakeSession()
    popover = createNotePopover({ session: fake.session, host })
}

/** A tap on a note reference whose note loads. */
async function openNote(loaded = note(), link = target()): Promise<LoadedNote> {
    fake.loadNote.mockResolvedValueOnce(loaded)
    fake.emit('note-tap', { target: link })
    await flush()
    return loaded
}

function click(element: Element): void {
    element.dispatchEvent(pointer('pointerdown'))
    element.dispatchEvent(pointer('pointerup'))
    element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
    )
}

/** The click event of a mouse or a finger. A click from the keyboard has a detail of 0. */
function pointerClick(element: Element): MouseEvent {
    const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        detail: 1,
    })
    element.dispatchEvent(event)
    return event
}

beforeEach(() => {
    vi.useFakeTimers()
    setSettings({})
    document.body.innerHTML =
        '<div id="toasts"></div><div id="host"></div><p id="outside">Text of the book</p>'
    host = document.getElementById('host')!
    outside = document.getElementById('outside')!

    // jsdom has no layout. The card gets a size.
    cardHeight = 200
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
            return this.classList.contains('note-pop') ? CARD_WIDTH : 0
        },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
            return this.classList.contains('note-pop') ? cardHeight : 0
        },
    })
    mount()
})

afterEach(() => {
    popover.destroy()
    clearToasts()
    sizeProperties.forEach((name, index) => {
        const original = originalSizes[index]
        if (original) Object.defineProperty(HTMLElement.prototype, name, original)
    })
    window.innerWidth = originalWidth
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('the note popover', () => {
    it('is a closed dialog with the label Note, a close button and a Go to note button', () => {
        expect(isOpen()).toBe(false)
        expect(card().getAttribute('role')).toBe('dialog')
        expect(card().getAttribute('aria-label')).toBe('Note')
        expect(card().querySelector('.note-title')?.textContent).toBe('Note')
        expect(card().querySelector('[data-action="close"]')?.getAttribute('aria-label')).toBe(
            'Close',
        )
        expect(card().querySelector('[data-action="go"]')?.textContent).toBe('Go to note')
    })

    it('asks the session for the note of the link', async () => {
        await openNote()

        expect(fake.loadNote).toHaveBeenCalledWith({ spineIndex: 3, fragment: 'n1' })
        expect(fake.followLink).not.toHaveBeenCalled()
        expect(isOpen()).toBe(true)
    })

    it('follows the link as a normal link when there is no note', async () => {
        const link = target()
        fake.loadNote.mockResolvedValueOnce(null)

        fake.emit('note-tap', { target: link })
        await flush()

        expect(isOpen()).toBe(false)
        expect(fake.followLink).toHaveBeenCalledTimes(1)
        expect(fake.followLink).toHaveBeenCalledWith({ ...link, noteref: false })
    })

    it('follows the link when the load rejects', async () => {
        fake.loadNote.mockRejectedValueOnce(new Error('no chapter'))

        fake.emit('note-tap', { target: target() })
        await flush()

        expect(isOpen()).toBe(false)
        expect(fake.followLink).toHaveBeenCalledWith(expect.objectContaining({ noteref: false }))
    })

    it('shows a toast when the link cannot be followed', async () => {
        fake.loadNote.mockResolvedValueOnce(null)
        fake.followLink.mockRejectedValueOnce(new Error('no chapter'))

        fake.emit('note-tap', { target: target() })
        await flush()

        expect(document.querySelector('#toasts .toast span')?.textContent).toBe(
            'The link could not be opened.',
        )
    })

    it('appends the note element itself to the shadow root, below rd-html and rd-body', async () => {
        const loaded = note('<p>Text with <em>marks</em> &amp; an entity.</p>')
        const paragraph = loaded.element.firstElementChild

        await openNote(loaded)

        const body = shadow().querySelector('rd-html > rd-body')!
        expect(body.childNodes).toHaveLength(1)
        expect(body.firstChild).toBe(loaded.element)
        // The same nodes, not a copy that was made from text.
        expect(loaded.element.firstElementChild).toBe(paragraph)
        expect(loaded.element.isConnected).toBe(true)
        // Nothing of the note is in the page outside the shadow root.
        expect(card().querySelector('aside')).toBeNull()
    })

    it('adopts its base sheet, then the stylesheets of the book', async () => {
        const bookSheets = [new CSSStyleSheet(), new CSSStyleSheet()]

        await openNote({ ...note(), styles: bookSheets })

        expect(shadow().adoptedStyleSheets).toEqual([getNoteBaseSheet(), ...bookSheets])
        expect(shadow().adoptedStyleSheets[0]).toBe(getNoteBaseSheet())
    })

    it('uses no book styles when the publisher styles are off', async () => {
        setSettings({ publisherStyles: false })
        const loaded = note('<p style="color: red">A <span style="font-size: 40px">note</span></p>')
        loaded.element.setAttribute('style', 'display: none')

        await openNote({ ...loaded, styles: [new CSSStyleSheet()] })

        expect(shadow().adoptedStyleSheets).toEqual([getNoteBaseSheet()])
        expect(loaded.element.hasAttribute('style')).toBe(false)
        expect(loaded.element.querySelector('[style]')).toBeNull()
    })

    it('gives the note the type settings of the reader', async () => {
        setSettings({ fontSize: 22, lineHeight: 1.8, fontId: 'literata', theme: 'dark' })

        await openNote()

        const style = noteHost().style
        expect(style.getPropertyValue('--note-size')).toBe('22px')
        expect(style.getPropertyValue('--rd-scale')).toBe('1.375')
        expect(style.getPropertyValue('--note-leading')).toBe('1.8')
        expect(style.getPropertyValue('--note-font')).toContain('Literata')
        expect(noteHost().hasAttribute('data-font')).toBe(true)
        expect(noteHost().hasAttribute('data-leading')).toBe(true)
        expect(noteHost().hasAttribute('data-dark')).toBe(true)
    })

    it('keeps the publisher font and line height when the reader has none', async () => {
        setSettings({ fontId: 'publisher', lineHeight: null, theme: 'sepia' })

        await openNote()

        expect(noteHost().style.getPropertyValue('--note-font')).toBe('')
        expect(noteHost().hasAttribute('data-font')).toBe(false)
        expect(noteHost().hasAttribute('data-leading')).toBe(false)
        expect(noteHost().hasAttribute('data-dark')).toBe(false)
    })

    it('keeps a positioned box of the book inside the note', async () => {
        // The containment makes the note the containing block and clips the box to it.
        expect(noteHost().style.contain).toBe('layout paint')

        await openNote(
            note('<p><a href="https://example.org" style="position: absolute">A link</a></p>'),
        )

        expect(noteHost().style.contain).toBe('layout paint')
    })

    it('takes the focus, and gives it back when the close button closes it', async () => {
        outside.tabIndex = 0
        outside.focus()

        await openNote()
        expect(document.activeElement).toBe(noteHost())

        click(card().querySelector('[data-action="close"]')!)

        expect(isOpen()).toBe(false)
        expect(document.activeElement).toBe(outside)
    })
})

describe('the focus after the popover closes', () => {
    /** A link of the book text. The reader view has the text in shadow roots. */
    function bookLink(): HTMLElement {
        const frame = document.createElement('div')
        outside.append(frame)
        const link = document.createElement('a')
        link.tabIndex = 0
        frame.attachShadow({ mode: 'open' }).append(link)
        link.focus()
        return link
    }

    const focused = () => document.activeElement?.shadowRoot?.activeElement ?? null

    it('goes back to the link of the note on Escape', async () => {
        const link = bookLink()
        await openNote()
        expect(document.activeElement).toBe(noteHost())

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

        expect(focused()).toBe(link)
    })

    it('does not go back to a link of the book when the reader goes to the note', async () => {
        const link = bookLink()
        await openNote()

        click(card().querySelector('[data-action="go"]')!)

        expect(focused()).not.toBe(link)
        expect(card().contains(document.activeElement)).toBe(false)
    })

    it('does not go back to a link of the book when the page turns', async () => {
        const link = bookLink()
        await openNote()

        fake.emit('relocate', makeRelocate(900))

        expect(focused()).not.toBe(link)
    })

    it('goes back to an element of the app when the reader goes to the note', async () => {
        outside.tabIndex = 0
        outside.focus()
        await openNote()

        click(card().querySelector('[data-action="go"]')!)

        expect(document.activeElement).toBe(outside)
    })
})

describe('the place of the popover', () => {
    it('is below the link, in the centre', async () => {
        await openNote()

        expect(card().dataset.layout).toBe('card')
        expect(card().style.transform).toBe(
            `translate3d(${405 - CARD_WIDTH / 2}px, ${312 + 8}px, 0)`,
        )
        expect(surface().style.maxHeight).toBe('')
    })

    it('is above the link when there is no room below it', async () => {
        await openNote(
            note(),
            target({ bounds: rect({ left: 400, top: 700, width: 10, height: 12 }) }),
        )

        expect(card().style.transform).toBe(`translate3d(225px, ${700 - 8 - 200}px, 0)`)
    })

    it('gets the height of the side with more room when it fits on no side', async () => {
        cardHeight = 500

        // 364 px above the link and 360 px below it, in a viewport of 768 px.
        await openNote(
            note(),
            target({ bounds: rect({ left: 400, top: 380, width: 10, height: 12 }) }),
        )

        expect(surface().style.maxHeight).toBe('364px')
        expect(card().style.transform).toBe('translate3d(225px, 8px, 0)')
    })

    it('stays inside the screen at the left edge', async () => {
        await openNote(
            note(),
            target({ bounds: rect({ left: 2, top: 300, width: 10, height: 12 }) }),
        )

        expect(card().style.transform).toBe('translate3d(8px, 320px, 0)')
    })

    it('is a sheet at the bottom on a narrow screen', async () => {
        popover.destroy()
        window.innerWidth = 599
        mount()

        await openNote()

        expect(isOpen()).toBe(true)
        expect(card().dataset.layout).toBe('sheet')
        expect(card().style.transform).toBe('')
    })

    it('applies the closed place of the sheet with no transition at the first open', async () => {
        popover.destroy()
        window.innerWidth = 599
        mount()
        // The read of the height makes the browser apply the styles.
        const applied: { layout: string | undefined; transition: string }[] = []
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            configurable: true,
            get(this: HTMLElement) {
                if (this.classList.contains('note-card')) {
                    applied.push({
                        layout: card().dataset.layout,
                        transition: this.style.transition,
                    })
                }
                return 0
            },
        })

        await openNote()

        expect(applied).toEqual([{ layout: 'sheet', transition: 'none' }])
        expect(surface().style.transition).toBe('')
        expect(isOpen()).toBe(true)
    })

    it('is a card from a width of 600 px', async () => {
        popover.destroy()
        window.innerWidth = 600
        mount()

        await openNote()

        expect(card().dataset.layout).toBe('card')
    })

    it('finds its place again when an image of the note loads', async () => {
        const loaded = await openNote(note('<p><img alt="A map"></p>'))

        cardHeight = 300
        loaded.element.querySelector('img')!.dispatchEvent(new Event('load'))

        // The same place below the link. The card is higher now and still fits.
        expect(card().style.transform).toBe('translate3d(225px, 320px, 0)')

        cardHeight = 600
        loaded.element.querySelector('img')!.dispatchEvent(new Event('load'))
        expect(surface().style.maxHeight).toBe('440px')
    })

    it('closes after a resize, because the link moved', async () => {
        await openNote()

        window.dispatchEvent(new Event('resize'))

        expect(isOpen()).toBe(false)
    })

    it('stays open as a sheet after a resize of a narrow screen', async () => {
        popover.destroy()
        window.innerWidth = 400
        mount()
        await openNote()

        window.innerWidth = 420
        window.dispatchEvent(new Event('resize'))
        expect(isOpen()).toBe(true)

        window.innerWidth = 900
        window.dispatchEvent(new Event('resize'))
        expect(isOpen()).toBe(false)
    })
})

describe('more than one tap', () => {
    function deferNotes(): ((value: LoadedNote | null) => void)[] {
        const resolvers: ((value: LoadedNote | null) => void)[] = []
        fake.loadNote.mockImplementation(
            () => new Promise<LoadedNote | null>((resolve) => resolvers.push(resolve)),
        )
        return resolvers
    }

    it('ignores the result of an older tap', async () => {
        const resolvers = deferNotes()
        const first = note('<p>First</p>')
        const second = note('<p>Second</p>')

        fake.emit('note-tap', { target: target({ fragment: 'n1' }) })
        fake.emit('note-tap', { target: target({ fragment: 'n2' }) })
        resolvers[1](second)
        await flush()
        resolvers[0](first)
        await flush()

        expect(shadow().querySelector('rd-body')!.firstChild).toBe(second.element)
        expect(first.element.isConnected).toBe(false)
    })

    it('does not follow the link of an older tap that has no note', async () => {
        const resolvers = deferNotes()

        fake.emit('note-tap', { target: target({ fragment: 'n1' }) })
        fake.emit('note-tap', { target: target({ fragment: 'n2' }) })
        resolvers[0](null)
        resolvers[1](note())
        await flush()

        expect(fake.followLink).not.toHaveBeenCalled()
        expect(isOpen()).toBe(true)
    })

    it('replaces the open note with the note of the second tap', async () => {
        const first = await openNote(note('<p>First</p>'))
        const resolvers = deferNotes()

        fake.emit('note-tap', { target: target({ fragment: 'n2' }) })
        expect(isOpen()).toBe(false)
        const second = note('<p>Second</p>')
        resolvers[0](second)
        await flush()

        expect(isOpen()).toBe(true)
        expect(shadow().querySelector('rd-body')!.firstChild).toBe(second.element)
        expect(first.element.isConnected).toBe(false)
    })

    it('shows nothing when the page turned during the load', async () => {
        const resolvers = deferNotes()

        fake.emit('note-tap', { target: target() })
        fake.emit('relocate', makeRelocate(900))
        resolvers[0](note())
        await flush()

        expect(isOpen()).toBe(false)
        expect(fake.followLink).not.toHaveBeenCalled()
    })
})

describe('links', () => {
    const LINK =
        '<p>See note <a data-rd-path="OEBPS/notes.xhtml" data-rd-fragment="n7" role="link" tabindex="0"><sup>7</sup></a>.</p>'

    it('closes and follows a click on a link inside the note', async () => {
        const loaded = await openNote(note(LINK))

        click(loaded.element.querySelector('sup')!)

        expect(isOpen()).toBe(false)
        expect(fake.spineIndexOf).toHaveBeenCalledWith('OEBPS/notes.xhtml')
        expect(fake.followLink).toHaveBeenCalledTimes(1)
        expect(fake.followLink).toHaveBeenCalledWith({
            kind: 'internal',
            path: 'OEBPS/notes.xhtml',
            fragment: 'n7',
            spineIndex: 3,
            noteref: false,
            bounds: expect.anything(),
        })
    })

    it('follows a link inside the note with the Enter key', async () => {
        const loaded = await openNote(note(LINK))
        const link = loaded.element.querySelector('a')!

        link.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
        expect(fake.followLink).not.toHaveBeenCalled()
        link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

        expect(fake.followLink).toHaveBeenCalledWith(
            expect.objectContaining({ fragment: 'n7', spineIndex: 3 }),
        )
    })

    it('gives a link with no fragment a null fragment, and an unknown file the index -1', async () => {
        const loaded = await openNote(note('<p><a data-rd-path="OEBPS/lost.xhtml">There</a></p>'))

        click(loaded.element.querySelector('a')!)

        expect(fake.followLink).toHaveBeenCalledWith(
            expect.objectContaining({ path: 'OEBPS/lost.xhtml', fragment: null, spineIndex: -1 }),
        )
    })

    it('does nothing for a click on the text of the note', async () => {
        const loaded = await openNote(note(LINK))

        click(loaded.element.querySelector('p')!)

        expect(isOpen()).toBe(true)
        expect(fake.followLink).not.toHaveBeenCalled()
    })

    it('goes to the note with the footer button, as a link that is not a note reference', async () => {
        const link = target()
        await openNote(note(), link)

        click(card().querySelector('[data-action="go"]')!)

        expect(isOpen()).toBe(false)
        expect(fake.followLink).toHaveBeenCalledTimes(1)
        expect(fake.followLink).toHaveBeenCalledWith({ ...link, noteref: false })
    })
})

describe('the click of the tap that opened the note', () => {
    const LINKS =
        '<p><a data-rd-path="OEBPS/notes.xhtml" data-rd-fragment="n7" role="link" tabindex="0">7</a> ' +
        '<a href="https://example.org/" target="_blank" rel="noopener noreferrer" data-rd-external="">Site</a></p>'

    it('does not press a button of the note', async () => {
        await openNote()

        // On a touch screen the click of the tap comes after the note opened below the finger.
        pointerClick(card().querySelector('[data-action="go"]')!)
        pointerClick(card().querySelector('[data-action="close"]')!)

        expect(isOpen()).toBe(true)
        expect(fake.followLink).not.toHaveBeenCalled()
    })

    it('does not follow a link inside the note', async () => {
        const loaded = await openNote(note(LINKS))
        const [inside, external] = Array.from(loaded.element.querySelectorAll('a'))

        pointerClick(inside)
        const click = pointerClick(external)

        expect(isOpen()).toBe(true)
        expect(fake.followLink).not.toHaveBeenCalled()
        // The browser must not open the address of the link.
        expect(click.defaultPrevented).toBe(true)
    })

    it('takes a click after a press inside the note', async () => {
        const loaded = await openNote(note(LINKS))
        const external = loaded.element.querySelectorAll('a')[1]

        external.dispatchEvent(pointer('pointerdown'))
        external.dispatchEvent(pointer('pointerup'))
        expect(pointerClick(external).defaultPrevented).toBe(false)

        const go = card().querySelector('[data-action="go"]')!
        go.dispatchEvent(pointer('pointerdown'))
        go.dispatchEvent(pointer('pointerup'))
        pointerClick(go)
        expect(fake.followLink).toHaveBeenCalledTimes(1)
    })

    it('takes a click with no press before it after a moment', async () => {
        await openNote()
        vi.advanceTimersByTime(GHOST_CLICK_MS)

        pointerClick(card().querySelector('[data-action="close"]')!)

        expect(isOpen()).toBe(false)
    })
})

describe('the keys', () => {
    it('keeps a key in the note from the rest of the page', async () => {
        const onKey = vi.fn()
        document.addEventListener('keydown', onKey)
        await openNote()

        noteHost().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        card()
            .querySelector('[data-action="go"]')!
            .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))

        document.removeEventListener('keydown', onKey)
        expect(onKey).not.toHaveBeenCalled()
    })
})

describe('closing', () => {
    it('closes on Escape and keeps the key from the rest of the page', async () => {
        const onKey = vi.fn()
        document.body.addEventListener('keydown', onKey)
        await openNote()

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

        expect(isOpen()).toBe(false)
        expect(onKey).not.toHaveBeenCalled()

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(onKey).toHaveBeenCalledTimes(1)
    })

    it('closes on a press outside it, and the press goes no further', async () => {
        const onPress = vi.fn()
        outside.addEventListener('pointerdown', onPress)
        await openNote()

        outside.dispatchEvent(pointer('pointerdown'))

        expect(isOpen()).toBe(false)
        expect(onPress).not.toHaveBeenCalled()
    })

    it('lets a press on a link of the book through', async () => {
        outside.innerHTML = '<a data-rd-path="OEBPS/notes.xhtml" data-rd-fragment="n2">2</a>'
        const onPress = vi.fn()
        outside.addEventListener('pointerdown', onPress)
        await openNote()

        outside.querySelector('a')!.dispatchEvent(pointer('pointerdown'))

        expect(isOpen()).toBe(false)
        expect(onPress).toHaveBeenCalledTimes(1)
    })

    it('stays open for a press inside it', async () => {
        const loaded = await openNote()

        loaded.element.dispatchEvent(pointer('pointerdown'))
        card().querySelector('.note-head')!.dispatchEvent(pointer('pointerdown'))

        expect(isOpen()).toBe(true)
    })

    it('closes when the page turns', async () => {
        await openNote()

        fake.emit('relocate', makeRelocate(900))

        expect(isOpen()).toBe(false)
    })

    it('stays open for a relocate event with the same position', async () => {
        fake.emit('relocate', makeRelocate(900))
        await openNote()

        fake.emit('relocate', makeRelocate(900))

        expect(isOpen()).toBe(true)
    })

    it('closes when the mode changes', async () => {
        await openNote()

        fake.emit('mode', 'listen')

        expect(isOpen()).toBe(false)
    })
})

describe('destroy', () => {
    it('removes its elements and its listeners', async () => {
        popover.destroy()
        const onDocument = trackListeners(document)
        const onWindow = trackListeners(window)
        try {
            mount()
            expect(onDocument.active().sort()).toEqual(['keydown', 'pointerdown'])
            expect(onWindow.active()).toEqual(['resize'])
            expect(fake.listenerCount()).toBe(3)
            const loaded = await openNote()

            popover.destroy()

            expect(host.childElementCount).toBe(0)
            expect(loaded.element.isConnected).toBe(false)
            expect(onDocument.active()).toEqual([])
            expect(onWindow.active()).toEqual([])
            expect(fake.listenerCount()).toBe(0)
        } finally {
            onDocument.restore()
            onWindow.restore()
        }
    })

    it('ignores a note that loads after the end', async () => {
        let resolve: (value: LoadedNote | null) => void = () => {}
        fake.loadNote.mockImplementation(
            () => new Promise<LoadedNote | null>((done) => (resolve = done)),
        )
        fake.emit('note-tap', { target: target() })

        popover.destroy()
        resolve(null)
        await flush()

        expect(fake.followLink).not.toHaveBeenCalled()
    })
})

describe('the base sheet of the note', () => {
    it('declares the override layer first, so the book cannot beat it', () => {
        expect(noteBaseCss().startsWith('@layer rd-override;\n@layer rd-base;')).toBe(true)
    })

    it('takes its colours from the reading tokens', () => {
        const css = noteBaseCss()

        expect(css).toContain('color: var(--rd-fg)')
        expect(css).toContain('color: var(--rd-link)')
        expect(css).toContain('font-size: var(--note-size, 1rem) !important')
    })

    it('contains the layout and the paint of the note in the override layer', () => {
        const css = noteBaseCss()
        const override = css.slice(css.indexOf('@layer rd-override {'))

        expect(override).toMatch(/:host \{\s*contain: layout paint !important;\s*\}/)
    })

    it('is one sheet for all popovers', () => {
        expect(getNoteBaseSheet()).toBe(getNoteBaseSheet())
        expect(getNoteBaseSheet().cssRules.length).toBeGreaterThan(0)
    })
})
