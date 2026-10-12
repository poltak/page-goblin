import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeBook } from '$lib/epub/testing/fake-book'
import { createTapTracker, dispatchTap, findTapTarget, focusedLink, linkTarget } from './pointer'
import type { ReaderViewCallbacks } from './types'

/** The path of an event from `target` up to the document, as `composedPath` gives it. */
function pathFrom(target: Element): EventTarget[] {
    const path: EventTarget[] = []
    for (let node: Node | null = target; node; node = node.parentNode) path.push(node)
    return path
}

function build(html: string): HTMLElement {
    const boundary = document.createElement('div')
    boundary.innerHTML = html
    document.body.appendChild(boundary)
    return boundary
}

function callbacks(): ReaderViewCallbacks {
    return {
        onRelocate: vi.fn(),
        onCenterTap: vi.fn(),
        onSelection: vi.fn(),
        onHighlightTap: vi.fn(),
        onLink: vi.fn(),
        onImageTap: vi.fn(),
        onError: vi.fn(),
    }
}

const book = createFakeBook({
    files: { 'text/one.xhtml': '<html/>', 'text/notes.xhtml': '<html/>' },
    spine: ['text/one.xhtml', 'text/notes.xhtml'],
})

afterEach(() => {
    document.body.innerHTML = ''
    document.getSelection()?.removeAllRanges()
})

describe('findTapTarget', () => {
    it('finds a highlight', () => {
        const boundary = build('<p>one <mark class="rd-hl" data-id="h1">two</mark></p>')
        const target = findTapTarget(pathFrom(boundary.querySelector('mark')!), boundary)
        expect(target).toMatchObject({ kind: 'highlight', id: 'h1' })
    })

    it('ignores a mark that is not a reader highlight', () => {
        const boundary = build('<p><mark>two</mark></p>')
        expect(findTapTarget(pathFrom(boundary.querySelector('mark')!), boundary).kind).toBe('none')
    })

    it('finds an internal link from an element inside it', () => {
        const boundary = build('<p><a data-rd-path="text/notes.xhtml"><em>note</em></a></p>')
        const target = findTapTarget(pathFrom(boundary.querySelector('em')!), boundary)
        expect(target.kind).toBe('link')
    })

    it('reports an external link, which the browser opens', () => {
        const boundary = build('<p><a href="https://example.com/" data-rd-external="">site</a></p>')
        expect(findTapTarget(pathFrom(boundary.querySelector('a')!), boundary).kind).toBe(
            'external',
        )
    })

    it('finds an image with its source and alt text', () => {
        const boundary = build('<p><img src="blob:x" alt="A map"></p>')
        const target = findTapTarget(pathFrom(boundary.querySelector('img')!), boundary)
        expect(target).toMatchObject({ kind: 'image', src: 'blob:x', alt: 'A map' })
    })

    it('finds an SVG image', () => {
        const boundary = build(
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="blob:cover"></image></svg>',
        )
        const target = findTapTarget(pathFrom(boundary.querySelector('image')!), boundary)
        expect(target).toMatchObject({ kind: 'image', src: 'blob:cover', alt: '' })
    })

    it('gives a highlight in a link the priority', () => {
        const boundary = build(
            '<p><a data-rd-path="text/notes.xhtml"><mark class="rd-hl" data-id="h2">1</mark></a></p>',
        )
        const target = findTapTarget(pathFrom(boundary.querySelector('mark')!), boundary)
        expect(target).toMatchObject({ kind: 'highlight', id: 'h2' })
    })

    it('gives a link around an image the priority', () => {
        const boundary = build(
            '<p><a data-rd-path="text/notes.xhtml"><img src="blob:x" alt=""></a></p>',
        )
        expect(findTapTarget(pathFrom(boundary.querySelector('img')!), boundary).kind).toBe('link')
    })

    it('gives none for plain text', () => {
        const boundary = build('<p><span>text</span></p>')
        expect(findTapTarget(pathFrom(boundary.querySelector('span')!), boundary).kind).toBe('none')
    })

    it('does not look outside the boundary', () => {
        const outer = build(
            '<a data-rd-path="text/notes.xhtml"><div id="inner"><span>text</span></div></a>',
        )
        const inner = outer.querySelector('#inner')!
        expect(findTapTarget(pathFrom(inner.querySelector('span')!), inner).kind).toBe('none')
    })
})

describe('linkTarget', () => {
    it('gives the path, the fragment and the spine index', () => {
        const boundary = build(
            '<a data-rd-path="text/notes.xhtml" data-rd-fragment="n3" data-epub-type="noteref">3</a>',
        )
        const target = linkTarget(boundary.querySelector('a')!, book)
        expect(target).toMatchObject({
            kind: 'internal',
            path: 'text/notes.xhtml',
            fragment: 'n3',
            spineIndex: 1,
            noteref: true,
        })
    })

    it('gives -1 for a file that is not in the spine and null for no fragment', () => {
        const boundary = build('<a data-rd-path="text/missing.xhtml">Go to the appendix</a>')
        const target = linkTarget(boundary.querySelector('a')!, book)
        expect(target).toMatchObject({ fragment: null, spineIndex: -1, noteref: false })
    })
})

describe('dispatchTap', () => {
    it('calls the callback of the target', () => {
        const boundary = build(
            '<mark class="rd-hl" data-id="h1">x</mark><a data-rd-path="text/one.xhtml">Start</a>',
        )
        const calls = callbacks()

        const mark = boundary.querySelector('mark')!
        expect(
            dispatchTap({
                target: { kind: 'highlight', id: 'h1', element: mark },
                book,
                callbacks: calls,
            }),
        ).toBe(true)
        expect(calls.onHighlightTap).toHaveBeenCalledWith('h1', expect.anything())

        const link = boundary.querySelector('a')!
        expect(
            dispatchTap({ target: { kind: 'link', element: link }, book, callbacks: calls }),
        ).toBe(true)
        expect(calls.onLink).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'internal', path: 'text/one.xhtml', spineIndex: 0 }),
        )

        const image = { kind: 'image' as const, element: mark, src: 'blob:x', alt: 'Map' }
        expect(dispatchTap({ target: image, book, callbacks: calls })).toBe(true)
        expect(calls.onImageTap).toHaveBeenCalledWith({ src: 'blob:x', alt: 'Map' })
    })

    it('does nothing for an external link and leaves a plain tap to the view', () => {
        const calls = callbacks()
        expect(dispatchTap({ target: { kind: 'external' }, book, callbacks: calls })).toBe(true)
        expect(dispatchTap({ target: { kind: 'none' }, book, callbacks: calls })).toBe(false)
        expect(calls.onLink).not.toHaveBeenCalled()
        expect(calls.onCenterTap).not.toHaveBeenCalled()
    })
})

interface PointerInit {
    x?: number
    y?: number
    time?: number
    id?: number
    button?: number
    primary?: boolean
}

/** jsdom has no PointerEvent constructor, so the tests send a MouseEvent with the fields. */
function pointer(type: string, init: PointerInit = {}): Event {
    const event = new MouseEvent(type, {
        bubbles: true,
        clientX: init.x ?? 0,
        clientY: init.y ?? 0,
        button: init.button ?? 0,
    })
    Object.defineProperties(event, {
        pointerId: { value: init.id ?? 1 },
        isPrimary: { value: init.primary ?? true },
        timeStamp: { value: init.time ?? 0 },
    })
    return event
}

describe('createTapTracker', () => {
    function setup(accept?: () => boolean) {
        const element = build('<p>Some text to select.</p>')
        const onTap = vi.fn()
        const tracker = createTapTracker({ element, accept, onTap })
        return { element, onTap, tracker }
    }

    it('reports a short press that did not move', () => {
        const { element, onTap } = setup()
        element.dispatchEvent(pointer('pointerdown', { x: 100, y: 100, time: 1000 }))
        element.dispatchEvent(pointer('pointerup', { x: 103, y: 98, time: 1120 }))
        expect(onTap).toHaveBeenCalledTimes(1)
    })

    it('ignores a press that moved', () => {
        const { element, onTap } = setup()
        element.dispatchEvent(pointer('pointerdown', { x: 100, y: 100, time: 1000 }))
        element.dispatchEvent(pointer('pointerup', { x: 130, y: 100, time: 1120 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('ignores a long press', () => {
        const { element, onTap } = setup()
        element.dispatchEvent(pointer('pointerdown', { time: 1000 }))
        element.dispatchEvent(pointer('pointerup', { time: 1700 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('ignores the right mouse button and a second finger', () => {
        const { element, onTap } = setup()
        element.dispatchEvent(pointer('pointerdown', { button: 2, time: 0 }))
        element.dispatchEvent(pointer('pointerup', { button: 2, time: 50 }))
        element.dispatchEvent(pointer('pointerdown', { primary: false, id: 2, time: 100 }))
        element.dispatchEvent(pointer('pointerup', { primary: false, id: 2, time: 150 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('ignores a release of a different pointer', () => {
        const { element, onTap } = setup()
        element.dispatchEvent(pointer('pointerdown', { id: 1, time: 0 }))
        element.dispatchEvent(pointer('pointerup', { id: 7, time: 50 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('ignores a press after pointercancel', () => {
        const { element, onTap } = setup()
        element.dispatchEvent(pointer('pointerdown', { time: 0 }))
        element.dispatchEvent(pointer('pointercancel', { time: 20 }))
        element.dispatchEvent(pointer('pointerup', { time: 50 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('ignores a press that clears a text selection', () => {
        const { element, onTap } = setup()
        const range = document.createRange()
        range.selectNodeContents(element.querySelector('p')!)
        document.getSelection()?.addRange(range)

        element.dispatchEvent(pointer('pointerdown', { time: 0 }))
        document.getSelection()?.removeAllRanges()
        element.dispatchEvent(pointer('pointerup', { time: 50 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('ignores a press that makes a text selection', () => {
        const { element, onTap } = setup()
        element.dispatchEvent(pointer('pointerdown', { time: 0 }))
        const range = document.createRange()
        range.selectNodeContents(element.querySelector('p')!)
        document.getSelection()?.addRange(range)
        element.dispatchEvent(pointer('pointerup', { time: 50 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('asks the view if a press counts', () => {
        const { element, onTap } = setup(() => false)
        element.dispatchEvent(pointer('pointerdown', { time: 0 }))
        element.dispatchEvent(pointer('pointerup', { time: 50 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('can forget a press', () => {
        const { element, onTap, tracker } = setup()
        element.dispatchEvent(pointer('pointerdown', { time: 0 }))
        tracker.cancel()
        element.dispatchEvent(pointer('pointerup', { time: 50 }))
        expect(onTap).not.toHaveBeenCalled()
    })

    it('removes its listeners', () => {
        const { element, onTap, tracker } = setup()
        tracker.destroy()
        element.dispatchEvent(pointer('pointerdown', { time: 0 }))
        element.dispatchEvent(pointer('pointerup', { time: 50 }))
        expect(onTap).not.toHaveBeenCalled()
    })
})

describe('focusedLink', () => {
    function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
        const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, ...init })
        target.dispatchEvent(event)
        // After the dispatch the path is empty, so the test gives the path of the target.
        Object.defineProperty(event, 'composedPath', { value: () => pathFrom(target) })
        return event
    }

    it('gives the internal link for the Enter key', () => {
        const boundary = build('<p><a data-rd-path="text/notes.xhtml" tabindex="0">3</a></p>')
        const link = boundary.querySelector('a')!
        expect(focusedLink(key(link, { key: 'Enter' }), boundary)).toBe(link)
    })

    it('gives null for other keys, for a modifier key and for other elements', () => {
        const boundary = build(
            '<p><a data-rd-path="text/notes.xhtml" tabindex="0">3</a><span>x</span></p>',
        )
        const link = boundary.querySelector('a')!
        expect(focusedLink(key(link, { key: ' ' }), boundary)).toBeNull()
        expect(focusedLink(key(link, { key: 'Enter', metaKey: true }), boundary)).toBeNull()
        expect(
            focusedLink(key(boundary.querySelector('span')!, { key: 'Enter' }), boundary),
        ).toBeNull()
    })
})
