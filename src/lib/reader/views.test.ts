/**
 * The life cycle of both views. jsdom has no layout: each chapter is one page and each box is
 * empty. These tests cover the logic that needs no layout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeBook } from '$lib/epub/testing/fake-book'
import { createPagedView, createScrollView } from './index'
import { createFakeContent, type FakeContent } from './testing/fake-content'
import type {
    Appearance,
    HighlightMark,
    ReaderView,
    ReaderViewCallbacks,
    ReaderViewOptions,
    RelocateInfo,
} from './types'

const APPEARANCE: Appearance = {
    theme: 'light',
    fontFamily: null,
    fontSize: 18,
    lineHeight: null,
    margin: 'normal',
    textAlign: 'publisher',
    hyphenate: false,
    publisherStyles: true,
    columns: 'auto',
    pageTurn: 'slide',
}

const CHAPTERS = [
    '<h1>One</h1><p>The first chapter.</p>',
    '<h1>Two</h1><p>The second chapter with <span id="mark">a target</span>.</p>',
    '<p>A note that is not in the reading order.</p>',
    '<h1>Three</h1><p>The last chapter.</p>',
]

interface Setup {
    view: ReaderView
    container: HTMLElement
    content: FakeContent
    relocates: RelocateInfo[]
    callbacks: ReaderViewCallbacks
}

type Factory = (options: ReaderViewOptions) => ReaderView

function setup(
    create: Factory,
    patch: Partial<ReaderViewOptions> & { broken?: number[]; chapters?: readonly string[] } = {},
): Setup {
    const container = document.createElement('div')
    document.body.appendChild(container)
    // A test with its own chapters has all of them in the reading order.
    const chapters = patch.chapters ?? CHAPTERS
    const book = createFakeBook({
        files: Object.fromEntries(
            chapters.map((html, index) => [`text/chapter-${index}.xhtml`, html]),
        ),
        spine: chapters.map((_, index) => `text/chapter-${index}.xhtml`),
        nonLinear: patch.chapters ? [] : ['text/chapter-2.xhtml'],
    })
    const content = createFakeContent({ chapters, broken: patch.broken })
    const relocates: RelocateInfo[] = []
    const callbacks: ReaderViewCallbacks = {
        onRelocate: vi.fn((info: RelocateInfo) => relocates.push(info)),
        onCenterTap: vi.fn(),
        onSelection: vi.fn(),
        onHighlightTap: vi.fn(),
        onLink: vi.fn(),
        onImageTap: vi.fn(),
        onError: vi.fn(),
    }
    const view = create({
        container,
        book,
        content,
        appearance: APPEARANCE,
        initial: { spineIndex: 0, offset: 0 },
        highlights: [],
        callbacks,
        ...patch,
    })
    return { view, container, content, relocates, callbacks }
}

/** A loader that keeps the chosen chapters back until `release` is called. */
function gatedContent(slow: readonly number[]): { content: FakeContent; release(): void } {
    const content = createFakeContent({ chapters: CHAPTERS })
    const load = content.load.bind(content)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    content.load = (index) => (slow.includes(index) ? gate.then(() => load(index)) : load(index))
    return { content, release }
}

function containerSize(width: number, height: number): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        () =>
            ({
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: width,
                bottom: height,
                width,
                height,
            }) as DOMRect,
    )
}

function frames(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-rd-frame]')]
}

/** The frame that shows a chapter, found by its text. */
function frameWith(container: HTMLElement, text: string): HTMLElement | undefined {
    return frames(container).find((host) => host.shadowRoot?.textContent?.includes(text))
}

/** The element with an id in the chapter text of a mounted frame. */
function inBook(container: HTMLElement, id: string): HTMLElement {
    for (const host of frames(container)) {
        const found = host.shadowRoot?.querySelector<HTMLElement>(`#${id}`)
        if (found) return found
    }
    throw new Error(`No mounted chapter has the element ${id}.`)
}

/** The element of the book text that has the focus. */
function focusedInBook(container: HTMLElement): Element | null {
    for (const host of frames(container)) {
        const focused = host.shadowRoot?.activeElement
        if (focused) return focused
    }
    return null
}

const PAGE_WIDTH = 800

/**
 * A page layout for jsdom. The text below an element with `data-page` is on that page of
 * its chapter. A chapter has one more page than its highest `data-page` value. Returns the
 * function that removes the layout.
 */
function fakePageLayout(): () => void {
    const box = (left: number) =>
        ({
            x: left,
            y: 10,
            left,
            top: 10,
            right: left + 10,
            bottom: 20,
            width: 10,
            height: 10,
        }) as DOMRect
    const pageOf = (node: Node): number => {
        const element = node.nodeType === 1 ? (node as Element) : node.parentElement
        return Number(element?.closest('[data-page]')?.getAttribute('data-page') ?? 0)
    }

    // The ranges of jsdom do not have this function.
    const ranges = Range.prototype as { getClientRects?: unknown }
    ranges.getClientRects = function (this: Range) {
        return [box(pageOf(this.startContainer) * PAGE_WIDTH + 60)]
    }
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
        const boxes: DOMRect[] = []
        if (this.localName === 'rd-body') {
            const last = Math.max(0, ...[...this.querySelectorAll('[data-page]')].map(pageOf))
            // One box for each column, as a browser gives it.
            for (let page = 0; page <= last; page++) boxes.push(box(page * PAGE_WIDTH + 60))
        }
        return boxes as unknown as DOMRectList
    })
    return () => {
        delete ranges.getClientRects
    }
}

const HIGHLIGHT: HighlightMark = {
    id: 'h1',
    spineIndex: 0,
    start: 3,
    end: 12,
    color: 'pink',
    hasNote: false,
}

beforeEach(() => {
    // jsdom gives each element an empty box. The paged view waits for a container size.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        () =>
            ({
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 800,
                bottom: 600,
                width: 800,
                height: 600,
            }) as DOMRect,
    )
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe.each([
    ['paged view', createPagedView],
    ['scroll view', createScrollView],
] as [string, Factory][])('%s', (name, create) => {
    const paged = name === 'paged view'

    it('shows the first chapter and sends one position before ready resolves', async () => {
        const { view, container, relocates } = setup(create)
        expect(view.getPosition()).toBeNull()
        await view.ready

        expect(relocates).toHaveLength(1)
        const info = relocates[0]
        expect(info.locator.spineIndex).toBe(0)
        expect(info.visible.spineIndex).toBe(0)
        // The scroll view finds its offset from the boxes of the text, and jsdom has none.
        if (paged) {
            expect(info.locator.offset).toBe(0)
            expect(info.visible).toEqual({ spineIndex: 0, start: 0, end: info.chapterLength })
        }
        expect(info.chapterLength).toBe('OneThe first chapter.'.length)
        expect(info.page).toBe(paged ? 1 : null)
        expect(info.pageCount).toBe(paged ? 1 : null)
        expect(view.getPosition()).toBe(info)
        expect(frameWith(container, 'The first chapter.')).toBeDefined()
        view.destroy()
    })

    it('starts at the chapter of the initial locator', async () => {
        const { view, container, relocates } = setup(create, {
            initial: { spineIndex: 3, offset: 4 },
        })
        await view.ready
        expect(relocates[0].locator.spineIndex).toBe(3)
        expect(frameWith(container, 'The last chapter.')).toBeDefined()
        view.destroy()
    })

    it('uses a valid chapter for a locator from outside the book', async () => {
        const { view, relocates } = setup(create, { initial: { spineIndex: 99, offset: 0 } })
        await view.ready
        expect(relocates[0].locator.spineIndex).toBe(3)
        view.destroy()
    })

    it('goes to a chapter that is not mounted', async () => {
        const { view, container } = setup(create)
        await view.ready
        await view.goTo({ spineIndex: 3, offset: 0 })
        expect(view.getPosition()?.locator.spineIndex).toBe(3)
        expect(frameWith(container, 'The last chapter.')).toBeDefined()
        view.destroy()
    })

    it('goes to a link target that is not in the reading order', async () => {
        const { view } = setup(create)
        await view.ready
        await view.goToAnchor(2, null)
        expect(view.getPosition()?.locator.spineIndex).toBe(2)
        if (paged) expect(view.getPosition()?.locator.offset).toBe(0)
        view.destroy()
    })

    it('goes to the chapter of a fragment, also when the fragment is not there', async () => {
        const { view } = setup(create)
        await view.ready
        await view.goToAnchor(1, 'mark')
        expect(view.getPosition()?.locator.spineIndex).toBe(1)
        await view.goToAnchor(3, 'missing')
        expect(view.getPosition()?.locator.spineIndex).toBe(3)
        if (paged) expect(view.getPosition()?.locator.offset).toBe(0)
        view.destroy()
    })

    it('rejects ready and reports the error when the first chapter does not load', async () => {
        const { view, container, callbacks, relocates } = setup(create, { broken: [0] })
        await expect(view.ready).rejects.toThrow('Chapter 0 is broken.')
        expect(callbacks.onError).toHaveBeenCalledTimes(1)
        expect(relocates).toHaveLength(0)
        expect(await view.next()).toBe(false)
        view.destroy()
        expect(container.children).toHaveLength(0)
    })

    it('reports a chapter that fails later and stays where it is', async () => {
        const { view, callbacks, relocates } = setup(create, { broken: [3] })
        await view.ready
        await view.goTo({ spineIndex: 3, offset: 0 })
        expect(callbacks.onError).toHaveBeenCalledTimes(1)
        expect(view.getPosition()?.locator.spineIndex).toBe(0)
        expect(relocates).toHaveLength(1)
        view.destroy()
    })

    it('paints the highlights of the options and of later calls', async () => {
        const { view, container } = setup(create, { highlights: [HIGHLIGHT] })
        await view.ready
        const shadow = frameWith(container, 'The first chapter.')!.shadowRoot!
        expect(shadow.querySelector('mark.rd-hl')?.textContent).toBe('The first')
        expect(shadow.querySelector('mark.rd-hl')?.getAttribute('data-color')).toBe('pink')

        view.setHighlights([{ ...HIGHLIGHT, id: 'h2', start: 0, end: 3, color: 'blue' }])
        const marks = shadow.querySelectorAll('mark.rd-hl')
        expect(marks).toHaveLength(1)
        expect(marks[0].textContent).toBe('One')

        view.setHighlights([])
        expect(shadow.querySelector('mark.rd-hl')).toBeNull()
        view.destroy()
    })

    it('marks the active range with an element when the browser has no highlight API', async () => {
        const { view, container } = setup(create)
        await view.ready
        const shadow = frameWith(container, 'The first chapter.')!.shadowRoot!

        view.setActiveRange({ spineIndex: 0, start: 3, end: 6 }, { follow: false })
        expect(shadow.querySelector('mark.rd-active')?.textContent).toBe('The')
        view.setActiveRange({ spineIndex: 0, start: 7, end: 12 }, { follow: false })
        expect(shadow.querySelectorAll('mark.rd-active')).toHaveLength(1)
        expect(shadow.querySelector('mark.rd-active')?.textContent).toBe('first')
        view.setActiveRange(null)
        expect(shadow.querySelector('mark.rd-active')).toBeNull()
        // The search marks need the highlight API. The call must still be safe.
        view.setSearchRanges([{ spineIndex: 0, start: 0, end: 3 }])
        view.setSearchRanges([])
        view.destroy()
    })

    it('accepts an active range in the chapter that is shown', async () => {
        const { view, callbacks } = setup(create)
        await view.ready
        view.setActiveRange({ spineIndex: 0, start: 3, end: 6 })
        view.setActiveRange({ spineIndex: 0, start: 7, end: 12 })
        expect(view.getPosition()?.locator.spineIndex).toBe(0)
        expect(callbacks.onError).not.toHaveBeenCalled()
        view.destroy()
    })

    it('follows the active range to a chapter that is not mounted', async () => {
        const { view } = setup(create)
        await view.ready
        view.setActiveRange({ spineIndex: 3, start: 0, end: 5 })
        await vi.waitFor(() => expect(view.getPosition()?.locator.spineIndex).toBe(3))
        view.destroy()
    })

    it('does not send the same position two times', async () => {
        const { view, relocates } = setup(create)
        await view.ready
        view.setAppearance({ ...APPEARANCE, theme: 'dark' })
        view.setAppearance({ ...APPEARANCE, theme: 'dark', pageTurn: 'none' })
        await view.goTo({ spineIndex: 0, offset: 0 })
        expect(relocates).toHaveLength(1)
        view.destroy()
    })

    it('turns the book styles off and on', async () => {
        const { view, container, content } = setup(create)
        const chapter = await content.load(0)
        chapter.body.querySelector('p')!.setAttribute('style', 'color: red')
        await view.ready
        const shadow = frameWith(container, 'The first chapter.')!.shadowRoot!

        view.setAppearance({ ...APPEARANCE, publisherStyles: false })
        expect(shadow.querySelector('p')!.hasAttribute('style')).toBe(false)
        expect(shadow.adoptedStyleSheets).toHaveLength(2)
        view.setAppearance({ ...APPEARANCE, publisherStyles: true })
        expect(shadow.querySelector('p')!.getAttribute('style')).toBe('color: red')
        view.destroy()
    })

    it('removes its DOM and gives the chapters back clean on destroy', async () => {
        const { view, container, content } = setup(create, { highlights: [HIGHLIGHT] })
        await view.ready
        view.setActiveRange({ spineIndex: 0, start: 0, end: 3 }, { follow: false })
        const chapter = await content.load(0)
        expect(chapter.root.isConnected).toBe(true)

        view.destroy()
        expect(container.children).toHaveLength(0)
        expect(chapter.root.parentNode).toBeNull()
        expect(chapter.body.innerHTML).toBe(CHAPTERS[0])
    })

    it('is safe to use after destroy', async () => {
        const { view, callbacks } = setup(create)
        await view.ready
        view.destroy()
        view.destroy()

        expect(await view.next()).toBe(false)
        expect(await view.prev()).toBe(false)
        await expect(view.goTo({ spineIndex: 1, offset: 0 })).resolves.toBeUndefined()
        await expect(view.goToAnchor(1, 'mark')).resolves.toBeUndefined()
        view.setAppearance({ ...APPEARANCE, fontSize: 30 })
        view.setHighlights([HIGHLIGHT])
        view.setActiveRange({ spineIndex: 0, start: 0, end: 3 })
        view.setSearchRanges([{ spineIndex: 0, start: 0, end: 3 }])
        view.clearSelection()
        expect(callbacks.onError).not.toHaveBeenCalled()
        expect(callbacks.onRelocate).toHaveBeenCalledTimes(1)
    })

    it('resolves ready when it is destroyed before the first chapter is shown', async () => {
        const { view, container, callbacks } = setup(create)
        view.destroy()
        await expect(view.ready).resolves.toBeUndefined()
        expect(callbacks.onRelocate).not.toHaveBeenCalled()
        expect(callbacks.onError).not.toHaveBeenCalled()
        expect(container.children).toHaveLength(0)
    })

    it('removes its listeners on destroy', async () => {
        const added = vi.spyOn(document, 'addEventListener')
        const removed = vi.spyOn(document, 'removeEventListener')
        const { view } = setup(create)
        await view.ready
        view.destroy()
        const types = (calls: unknown[][]) => calls.map((call) => call[0]).sort()
        // A listener with a signal goes away when the signal is aborted.
        const aborted = (call: unknown[]) =>
            !!(call[2] as AddEventListenerOptions | undefined)?.signal?.aborted
        const withSignal = added.mock.calls.filter(aborted)
        const withoutSignal = added.mock.calls.filter((call) => !aborted(call))
        expect(types(removed.mock.calls)).toEqual(types(withoutSignal))
        if (create === createPagedView) expect(types(withSignal)).toEqual(['visibilitychange'])
    })

    it('restores the position style of the container on destroy', async () => {
        const { view, container } = setup(create)
        await view.ready
        view.destroy()
        expect(container.style.position).toBe('')
    })

    it('takes the click of a tap on the text, so Chrome on Android selects no word', async () => {
        const { view, container } = setup(create)
        await view.ready
        const text = frameWith(container, 'The first chapter.')!.shadowRoot!.querySelector('p')!
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
        text.dispatchEvent(click)
        expect(click.defaultPrevented).toBe(true)
        view.destroy()
    })
})

describe('paged view', () => {
    it('turns to the next linear chapter and skips an item that is not linear', async () => {
        const { view, relocates } = setup(createPagedView)
        await view.ready
        expect(relocates[0].atBookStart).toBe(true)
        expect(relocates[0].atBookEnd).toBe(false)

        expect(await view.next()).toBe(true)
        expect(view.getPosition()?.locator.spineIndex).toBe(1)
        expect(await view.next()).toBe(true)
        // Chapter 2 is a note with linear="no".
        expect(view.getPosition()?.locator.spineIndex).toBe(3)
        expect(view.getPosition()?.atBookEnd).toBe(true)
        expect(relocates).toHaveLength(3)
        view.destroy()
    })

    it('gives false at the end and at the start of the book', async () => {
        const { view, relocates } = setup(createPagedView, {
            initial: { spineIndex: 3, offset: 0 },
        })
        await view.ready
        expect(await view.next()).toBe(false)
        expect(await view.prev()).toBe(true)
        expect(await view.prev()).toBe(true)
        expect(view.getPosition()?.locator.spineIndex).toBe(0)
        expect(await view.prev()).toBe(false)
        expect(relocates.map((info) => info.locator.spineIndex)).toEqual([3, 1, 0])
        view.destroy()
    })

    it('turns from a non-linear chapter to the linear chapters around it', async () => {
        const { view } = setup(createPagedView, { initial: { spineIndex: 2, offset: 0 } })
        await view.ready
        expect(await view.next()).toBe(true)
        expect(view.getPosition()?.locator.spineIndex).toBe(3)
        await view.goTo({ spineIndex: 2, offset: 0 })
        expect(await view.prev()).toBe(true)
        expect(view.getPosition()?.locator.spineIndex).toBe(1)
        view.destroy()
    })

    it('keeps at most three chapters mounted', async () => {
        const { view, container } = setup(createPagedView)
        await view.ready
        await view.next()
        await view.next()
        await vi.waitFor(() => expect(frames(container).length).toBeGreaterThan(1))
        expect(frames(container).length).toBeLessThanOrEqual(3)
        // The chapter that is two turns back is not mounted now.
        expect(frameWith(container, 'The first chapter.')).toBeUndefined()
        view.destroy()
    })

    it('loads a mounted chapter again, so that the loader cache keeps it', async () => {
        const { view, content } = setup(createPagedView)
        await view.ready
        await view.next()
        expect(content.loads.get(1)).toBeGreaterThan(1)
        view.destroy()
    })

    it('reports a neighbour chapter that does not load and stays on the page', async () => {
        const { view, callbacks } = setup(createPagedView, { broken: [1] })
        await view.ready
        expect(await view.next()).toBe(false)
        expect(callbacks.onError).toHaveBeenCalled()
        expect(view.getPosition()?.locator.spineIndex).toBe(0)
        view.destroy()
    })

    it('calls the centre tap callback for a tap in the middle of the page', async () => {
        const { view, container, callbacks } = setup(createPagedView)
        await view.ready
        const clip = container.firstElementChild!
        const press = (type: string, x: number, time: number) => {
            const event = new MouseEvent(type, {
                bubbles: true,
                clientX: x,
                clientY: 300,
                button: 0,
            })
            Object.defineProperties(event, {
                pointerId: { value: 1 },
                isPrimary: { value: true },
                pointerType: { value: 'touch' },
                timeStamp: { value: time },
            })
            clip.dispatchEvent(event)
        }
        press('pointerdown', 400, 1000)
        press('pointerup', 400, 1080)
        expect(callbacks.onCenterTap).toHaveBeenCalledTimes(1)

        // The right 28 percent of the page turns forward.
        press('pointerdown', 780, 2000)
        press('pointerup', 780, 2080)
        expect(callbacks.onCenterTap).toHaveBeenCalledTimes(1)
        await vi.waitFor(() => expect(view.getPosition()?.locator.spineIndex).toBe(1))

        // The left 28 percent turns back.
        press('pointerdown', 20, 3000)
        press('pointerup', 20, 3080)
        await vi.waitFor(() => expect(view.getPosition()?.locator.spineIndex).toBe(0))
        view.destroy()
    })

    it('uses a container size that changes while the first chapter loads', async () => {
        const { content, release } = gatedContent([0])
        const { view, container } = setup(createPagedView, { content })
        containerSize(400, 700)
        window.dispatchEvent(new Event('resize'))
        await new Promise((resolve) => setTimeout(resolve, 150))
        release()
        await view.ready

        const host = frames(container)[0]
        expect(host.style.width).toBe('400px')
        expect(host.style.height).toBe('700px')
        view.destroy()
    })

    it('ends a page turn that is in motion when the page is hidden', async () => {
        // jsdom has no animations. This one never ends, as in a page that draws no frames.
        const animation = { cancel: vi.fn(), onfinish: null }
        Object.defineProperty(Element.prototype, 'animate', {
            configurable: true,
            value: vi.fn(() => animation),
        })
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        try {
            const { view, relocates } = setup(createPagedView)
            await view.ready
            let turned: boolean | null = null
            void view.next().then((result) => (turned = result))
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(turned).toBeNull()
            expect(relocates).toHaveLength(1)

            visibility.mockReturnValue('hidden')
            document.dispatchEvent(new Event('visibilitychange'))
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(turned).toBe(true)
            expect(relocates).toHaveLength(2)
            expect(view.getPosition()?.locator.spineIndex).toBe(1)
            view.destroy()
        } finally {
            delete (Element.prototype as { animate?: unknown }).animate
        }
    })

    it('turns one page for a wheel gesture', async () => {
        const { view, container } = setup(createPagedView)
        await view.ready
        const clip = container.firstElementChild!
        const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
        clip.dispatchEvent(wheel)
        expect(wheel.defaultPrevented).toBe(true)
        await vi.waitFor(() => expect(view.getPosition()?.locator.spineIndex).toBe(1))
        view.destroy()
    })
})

describe('scroll view', () => {
    it('calls the centre tap callback for a tap on the text', async () => {
        const { view, container, callbacks } = setup(createScrollView)
        await view.ready
        const scroller = container.firstElementChild!
        const press = (type: string, time: number) => {
            const event = new MouseEvent(type, {
                bubbles: true,
                clientX: 30,
                clientY: 300,
                button: 0,
            })
            Object.defineProperties(event, {
                pointerId: { value: 1 },
                isPrimary: { value: true },
                timeStamp: { value: time },
            })
            frames(container)[0].dispatchEvent(event)
        }
        press('pointerdown', performance.now() + 5000)
        press('pointerup', performance.now() + 5080)
        expect(callbacks.onCenterTap).toHaveBeenCalledTimes(1)
        expect(scroller.contains(frames(container)[0])).toBe(true)
        view.destroy()
    })

    it('jumps at once while the fill waits for a chapter', async () => {
        // jsdom has no layout. The fill needs a viewport height before it adds a chapter.
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
        const { content, release } = gatedContent([1])
        const { view, container } = setup(createScrollView, { content })
        await view.ready
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(frames(container)).toHaveLength(1)

        let done = false
        void view.goTo({ spineIndex: 0, offset: 4 }).then(() => (done = true))
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(done).toBe(true)

        release()
        await vi.waitFor(() => expect(frames(container).length).toBeGreaterThan(1))
        view.destroy()
    })

    it('stops its smooth scroll when the user scrolls', async () => {
        // jsdom has no layout and no scrollTo. The view gets a tall page that can scroll.
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
        vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(5000)
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        const scrollTo = vi.fn()
        Object.defineProperty(Element.prototype, 'scrollTo', {
            configurable: true,
            value: scrollTo,
        })
        try {
            // The chapter above waits, so the view adds it after the user input.
            const { content, release } = gatedContent([0])
            const { view, container } = setup(createScrollView, {
                content,
                initial: { spineIndex: 1, offset: 0 },
            })
            await view.ready
            const scroller = container.firstElementChild!
            void view.next()
            await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1))
            expect(scrollTo).toHaveBeenLastCalledWith({ top: 510, behavior: 'smooth' })

            scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
            release()
            await vi.waitFor(() => expect(frames(container).length).toBeGreaterThan(1))
            // The correction for the new chapter must not start the old smooth scroll again.
            expect(scrollTo).toHaveBeenCalledTimes(1)
            view.destroy()
        } finally {
            delete (Element.prototype as { scrollTo?: unknown }).scrollTo
        }
    })

    it('gives false for a step when the content does not scroll', async () => {
        const { view } = setup(createScrollView)
        await view.ready
        expect(await view.next()).toBe(false)
        expect(await view.prev()).toBe(false)
        view.destroy()
    })
})

describe('paged view, focus on a link of the book text', () => {
    const link = (id: string) => `<a id="${id}" role="link" tabindex="0">${id}</a>`
    const LINKED = [
        `<p data-page="0">Before ${link('a0')}.</p><p data-page="1">Then ${link('a1')}.</p>`,
        `<p data-page="0">A first page with no link.</p>` +
            `<p data-page="1">Two links, ${link('b1')} and ${link('b2')}.</p>` +
            `<p data-page="2">The last page with ${link('b3')}.</p>`,
        `<p data-page="0">After ${link('c0')}.</p>`,
    ]
    let removeLayout: () => void = () => {}
    let outside: HTMLButtonElement

    beforeEach(() => {
        removeLayout = fakePageLayout()
        outside = document.createElement('button')
        document.body.appendChild(outside)
    })

    afterEach(() => removeLayout())

    /** The view at a page of the middle chapter, with both neighbour chapters mounted. */
    async function atPage(page: number): Promise<Setup> {
        const made = setup(createPagedView, {
            chapters: LINKED,
            initial: { spineIndex: 1, offset: 0 },
        })
        await made.view.ready
        expect(made.view.getPosition()?.pageCount).toBe(3)
        for (let turned = 1; turned < page; turned++) await made.view.next()
        expect(made.view.getPosition()?.page).toBe(page)
        await vi.waitFor(() => expect(frames(made.container)).toHaveLength(3))
        return made
    }

    it('shows the page of the next link of the same chapter', async () => {
        const { view, container } = await atPage(2)
        inBook(container, 'b1').focus()
        inBook(container, 'b2').focus()
        expect(view.getPosition()?.page).toBe(2)

        // This event does not go out of the shadow root of the chapter.
        inBook(container, 'b3').focus()
        expect(view.getPosition()?.page).toBe(3)
        expect(focusedInBook(container)).toBe(inBook(container, 'b3'))

        inBook(container, 'b2').focus()
        expect(view.getPosition()?.page).toBe(2)
        expect(focusedInBook(container)).toBe(inBook(container, 'b2'))
        view.destroy()
    })

    it('shows the chapter of a link that follows a link of the chapter before', async () => {
        const { view, container } = await atPage(3)
        inBook(container, 'b3').focus()
        inBook(container, 'c0').focus()
        expect(view.getPosition()?.locator.spineIndex).toBe(2)
        expect(focusedInBook(container)).toBe(inBook(container, 'c0'))
        view.destroy()
    })

    it('keeps the page when the focus comes from outside the book text', async () => {
        const { view, container, relocates } = await atPage(2)
        const events = relocates.length
        outside.focus()
        // The Tab key from a bar goes to the first link of the chapter before.
        inBook(container, 'a0').focus()
        expect(view.getPosition()?.locator.spineIndex).toBe(1)
        expect(view.getPosition()?.page).toBe(2)
        expect(focusedInBook(container)).toBe(inBook(container, 'b1'))

        // A dialog that closes gives the focus back to a link that is on a different page.
        outside.focus()
        inBook(container, 'b3').focus()
        expect(view.getPosition()?.page).toBe(2)
        expect(focusedInBook(container)).toBe(inBook(container, 'b1'))
        expect(relocates).toHaveLength(events)
        view.destroy()
    })

    it('keeps the page when the focus comes from no element', async () => {
        const { view, container } = await atPage(2)
        // The window is active again, and the browser gives the focus back to a link.
        inBook(container, 'c0').focus()
        expect(view.getPosition()?.locator.spineIndex).toBe(1)
        expect(view.getPosition()?.page).toBe(2)
        expect(focusedInBook(container)).toBe(inBook(container, 'b1'))
        view.destroy()
    })

    it('removes the focus when the page has no element for it', async () => {
        const { view, container } = await atPage(1)
        outside.focus()
        inBook(container, 'b1').focus()
        expect(view.getPosition()?.page).toBe(1)
        expect(focusedInBook(container)).toBeNull()
        expect(document.activeElement).toBe(document.body)
        view.destroy()
    })

    it('removes the focus from a link that leaves the page', async () => {
        const { view, container } = await atPage(2)
        inBook(container, 'b1').focus()
        expect(await view.next()).toBe(true)
        expect(focusedInBook(container)).toBeNull()

        // The next link in the Tab order is on the page that the user left.
        inBook(container, 'b2').focus()
        expect(view.getPosition()?.page).toBe(3)
        expect(focusedInBook(container)).toBe(inBook(container, 'b3'))
        view.destroy()
    })

    it('removes the focus from a link that a new layout moves to a different page', async () => {
        const chapters = [
            '<p data-page="0">One.</p>',
            '<p data-page="0">The first lines of the page.</p>' +
                `<p id="moves" data-page="0">Then ${link('m0')}.</p>`,
        ]
        const { view, container } = setup(createPagedView, {
            chapters,
            initial: { spineIndex: 1, offset: 0 },
        })
        await view.ready
        inBook(container, 'm0').focus()
        expect(focusedInBook(container)).toBe(inBook(container, 'm0'))

        // The larger text needs more room, and the paragraph of the link goes to the next page.
        inBook(container, 'moves').setAttribute('data-page', '1')
        view.setAppearance({ ...APPEARANCE, fontSize: 30 })
        expect(view.getPosition()?.page).toBe(1)
        expect(view.getPosition()?.pageCount).toBe(2)
        expect(focusedInBook(container)).toBeNull()
        view.destroy()
    })

    it('removes the focus when the element of the page cannot take it', async () => {
        // A `summary` with no `details` parent is in the list of the view, and it cannot have
        // the focus. A link in a hidden part of a book is the same in a browser.
        const chapters = [
            '<p data-page="0">One.</p>',
            '<summary data-page="0">A part that does not open.</summary>' +
                `<p data-page="1">The next page with ${link('b1')} and ${link('b2')}.</p>`,
        ]
        const { view, container } = setup(createPagedView, {
            chapters,
            initial: { spineIndex: 1, offset: 0 },
        })
        await view.ready
        outside.focus()
        inBook(container, 'b1').focus()
        expect(view.getPosition()?.page).toBe(1)
        // With the focus on the link, the next press of the Tab key would move the book.
        expect(focusedInBook(container)).toBeNull()
        view.destroy()
    })

    it('does not move the page for a link that a pointer press gave the focus', async () => {
        const { view, container } = await atPage(2)
        const clip = container.firstElementChild!
        const down = new MouseEvent('pointerdown', { bubbles: true, button: 0 })
        Object.defineProperties(down, { pointerId: { value: 1 }, isPrimary: { value: true } })
        clip.dispatchEvent(down)
        inBook(container, 'b1').focus()
        inBook(container, 'b3').focus()
        expect(view.getPosition()?.page).toBe(2)
        view.destroy()
    })
})

describe('paged view, a change of the text layout', () => {
    /** The view at the second chapter, with both neighbour chapters mounted. */
    async function withNeighbours(): Promise<Setup> {
        const made = setup(createPagedView, { initial: { spineIndex: 1, offset: 0 } })
        await made.view.ready
        await vi.waitFor(() => expect(frames(made.container)).toHaveLength(3))
        return made
    }

    /** The chapters that the view reads the layout of. In a browser, a read is a layout. */
    function watchMeasures(): Set<string> {
        const measured = new Set<string>()
        vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
            if (this.localName === 'rd-body') measured.add(this.textContent ?? '')
            return [] as unknown as DOMRectList
        })
        return measured
    }

    it('lays out only the chapter on screen for a new font size', async () => {
        const { view, container } = await withNeighbours()
        const measured = watchMeasures()
        view.setAppearance({ ...APPEARANCE, fontSize: 19 })
        expect([...measured]).toEqual(['TwoThe second chapter with a target.'])
        expect(frames(container)).toHaveLength(1)
        expect(frameWith(container, 'The second chapter')).toBeDefined()

        await vi.waitFor(() => expect(frames(container)).toHaveLength(3))
        expect(measured.size).toBe(3)
        view.destroy()
    })

    it('loads the neighbour chapters one time, after the last step of a slider', async () => {
        const { view, container, content } = await withNeighbours()
        const loads = content.loads.get(3)
        vi.useFakeTimers()
        for (const fontSize of [19, 20, 21, 22]) {
            view.setAppearance({ ...APPEARANCE, fontSize })
            await vi.advanceTimersByTimeAsync(120)
            expect(frames(container)).toHaveLength(1)
        }
        expect(content.loads.get(3)).toBe(loads)

        await vi.advanceTimersByTimeAsync(1000)
        expect(frames(container)).toHaveLength(3)
        view.destroy()
    })

    it('keeps the wait when an older load of a neighbour chapter ends', async () => {
        const { content, release } = gatedContent([3])
        const asked = vi.spyOn(content, 'load')
        const { view, container } = setup(createPagedView, {
            content,
            initial: { spineIndex: 1, offset: 0 },
        })
        await view.ready
        // The view waits for the next chapter now. The chapter before comes after it.
        await vi.waitFor(() => expect(asked).toHaveBeenCalledWith(3))
        vi.useFakeTimers()
        view.setAppearance({ ...APPEARANCE, fontSize: 19 })
        release()
        // The older load ends here. It must not start the load of the chapter before.
        await vi.advanceTimersByTimeAsync(120)
        expect(frames(container)).toHaveLength(1)

        await vi.advanceTimersByTimeAsync(1000)
        expect(frames(container)).toHaveLength(3)
        view.destroy()
    })

    it('turns to the next chapter right after a new font size', async () => {
        const { view, container } = await withNeighbours()
        view.setAppearance({ ...APPEARANCE, fontSize: 19 })
        expect(frames(container)).toHaveLength(1)
        expect(await view.next()).toBe(true)
        expect(view.getPosition()?.locator.spineIndex).toBe(3)
        expect(await view.prev()).toBe(true)
        expect(await view.prev()).toBe(true)
        expect(view.getPosition()?.locator.spineIndex).toBe(0)
        view.destroy()
    })

    it('keeps the neighbour chapters for a new theme or page turn', async () => {
        const { view, container } = await withNeighbours()
        const mounted = frames(container)
        view.setAppearance({ ...APPEARANCE, theme: 'dark', pageTurn: 'fade' })
        expect(frames(container)).toEqual(mounted)
        view.destroy()
    })

    it('keeps the anchor of the page for a new margin', async () => {
        const removeLayout = fakePageLayout()
        try {
            const chapters = [
                '<p data-page="0">One.</p>',
                '<p data-page="0">First.</p><p data-page="1">Second.</p><p data-page="2">Third.</p>',
                '<p data-page="0">Three.</p>',
            ]
            const { view, container } = setup(createPagedView, {
                chapters,
                initial: { spineIndex: 1, offset: 'First.'.length },
            })
            await view.ready
            await vi.waitFor(() => expect(frames(container)).toHaveLength(3))
            const before = view.getPosition()
            expect(before?.page).toBe(2)

            view.setAppearance({ ...APPEARANCE, margin: 'wide' })
            expect(frames(container)).toHaveLength(1)
            expect(view.getPosition()?.page).toBe(2)
            expect(view.getPosition()?.locator).toEqual(before?.locator)
            view.destroy()
        } finally {
            removeLayout()
        }
    })
})

describe('scroll view, chapters above the viewport', () => {
    const PARTS = Array.from({ length: 16 }, (_, index) => `<p>Text of part ${index}.</p>`)
    const CHAPTER_HEIGHT = 1000
    /** The time that the view reads. A test moves it by hand. */
    let clock = 0

    beforeEach(() => {
        clock = 50_000
        vi.spyOn(performance, 'now').mockImplementation(() => clock)
        // jsdom has no layout. Each chapter is 1000 pixels high in a viewport of 600 pixels.
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
        vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (
            this: Element,
        ) {
            return this.childElementCount * CHAPTER_HEIGHT
        })
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: Element,
        ) {
            const height = this.hasAttribute('data-rd-frame') ? CHAPTER_HEIGHT : 600
            return {
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 800,
                bottom: height,
                width: 800,
                height,
            } as DOMRect
        })
    })

    function part(container: HTMLElement, index: number): HTMLElement | undefined {
        return frameWith(container, `Text of part ${index}.`)
    }

    /** One scroll event of the user, at a position near the end of the mounted chapters. */
    function scrollNearEnd(container: HTMLElement): number {
        const scroller = container.firstElementChild!
        scroller.scrollTop = frames(container).length * CHAPTER_HEIGHT - 700
        scroller.dispatchEvent(new Event('scroll'))
        return scroller.scrollTop
    }

    async function start(): Promise<Setup> {
        const made = setup(createScrollView, { chapters: PARTS })
        await made.view.ready
        await vi.waitFor(() => expect(part(made.container, 1)).toBeDefined())
        return made
    }

    it('keeps them while the page scrolls and removes them when the scroll is at rest', async () => {
        const { view, container } = await start()
        const scroller = container.firstElementChild!
        let scrollTop = 0
        // The fifth chapter is at the viewport top. Without the wait, the first one goes.
        for (let last = 2; last <= 5; last++) {
            scrollTop = scrollNearEnd(container)
            await vi.waitFor(() => expect(part(container, last)).toBeDefined())
        }
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(part(container, 0)).toBeDefined()
        expect(frames(container)).toHaveLength(6)
        // No write of the scroll position: it would stop a momentum scroll.
        expect(scroller.scrollTop).toBe(scrollTop)

        clock += 1000
        await vi.waitFor(() => expect(part(container, 0)).toBeUndefined())
        expect(part(container, 1)).toBeUndefined()
        expect(part(container, 2)).toBeDefined()
        expect(scroller.scrollTop).toBe(scrollTop - 2 * CHAPTER_HEIGHT)
        view.destroy()
    })

    it('removes them during a scroll when 12 chapters are mounted', async () => {
        const { view, container } = await start()
        let most = 0
        for (let last = 2; last <= 14; last++) {
            scrollNearEnd(container)
            await vi.waitFor(() => expect(part(container, last)).toBeDefined())
            await new Promise((resolve) => setTimeout(resolve, 20))
            most = Math.max(most, frames(container).length)
            if (last === 10) expect(part(container, 0)).toBeDefined()
        }
        // The view removes chapters in the same task in which chapter 12 gets its place.
        expect(most).toBe(11)
        expect(part(container, 0)).toBeUndefined()
        view.destroy()
    })
})
