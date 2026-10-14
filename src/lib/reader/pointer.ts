/** Taps on the book text: what was hit, and the callback for it. */

import {
    INTERNAL_LINK_FRAGMENT_ATTR,
    INTERNAL_LINK_PATH_ATTR,
    EXTERNAL_LINK_ATTR,
} from '$lib/content'
import type { EpubBook } from '$lib/epub/types'
import { isTap } from './gestures'
import { isNoteRef } from './links'
import { HIGHLIGHT_CLASS } from './marks'
import { hasTextSelection } from './selection'
import type { LinkTarget, ReaderViewCallbacks } from './types'

export type TapTarget =
    | { kind: 'highlight'; id: string; element: Element }
    | { kind: 'link'; element: Element }
    | { kind: 'external' }
    | { kind: 'image'; element: Element; src: string; alt: string }
    | { kind: 'none' }

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

function imageSource(element: Element): string | null {
    if (element.localName === 'img')
        return (element as HTMLImageElement).currentSrc || element.getAttribute('src')
    if (element.localName === 'image' && element.namespaceURI === SVG_NS) {
        return element.getAttribute('href') || element.getAttributeNS(XLINK_NS, 'href')
    }
    return null
}

/**
 * The thing that a tap hit. `path` is `event.composedPath()`, so it also has the elements
 * inside the shadow roots. The search stops at `boundary`. A highlight wins over a link, and
 * a link wins over an image.
 */
export function findTapTarget(path: readonly EventTarget[], boundary: EventTarget): TapTarget {
    let highlight: TapTarget | null = null
    let link: TapTarget | null = null
    let image: TapTarget | null = null

    for (const target of path) {
        if (target === boundary) break
        const element = target as Element
        if (element.nodeType !== 1) continue
        const name = element.localName

        if (name === 'mark' && element.classList.contains(HIGHLIGHT_CLASS)) {
            const id = element.getAttribute('data-id')
            if (id && !highlight) highlight = { kind: 'highlight', id, element }
        } else if (name === 'a') {
            if (link) continue
            if (element.hasAttribute(INTERNAL_LINK_PATH_ATTR)) link = { kind: 'link', element }
            else if (element.hasAttribute(EXTERNAL_LINK_ATTR)) link = { kind: 'external' }
        } else if (!image) {
            const src = imageSource(element)
            if (src) image = { kind: 'image', element, src, alt: element.getAttribute('alt') ?? '' }
        }
    }
    return highlight ?? link ?? image ?? { kind: 'none' }
}

/** The data of an internal link for `onLink`. */
export function linkTarget(link: Element, book: EpubBook): LinkTarget {
    const path = link.getAttribute(INTERNAL_LINK_PATH_ATTR) ?? ''
    return {
        kind: 'internal',
        path,
        fragment: link.getAttribute(INTERNAL_LINK_FRAGMENT_ATTR) || null,
        spineIndex: book.spineIndexOf(path),
        noteref: isNoteRef(link),
        bounds: link.getBoundingClientRect(),
    }
}

export interface DispatchTapOptions {
    target: TapTarget
    book: EpubBook
    callbacks: ReaderViewCallbacks
}

/** Call the callback for a tap target. Returns false when the view must decide. */
export function dispatchTap({ target, book, callbacks }: DispatchTapOptions): boolean {
    switch (target.kind) {
        case 'highlight':
            callbacks.onHighlightTap(target.id, target.element.getBoundingClientRect())
            return true
        case 'link':
            callbacks.onLink(linkTarget(target.element, book))
            return true
        case 'external':
            // The browser opens the link in a new tab.
            return true
        case 'image':
            callbacks.onImageTap({ src: target.src, alt: target.alt })
            return true
        default:
            return false
    }
}

export interface TapTrackerOptions {
    element: HTMLElement
    /** False ignores a press, for example while the content moves. */
    accept?(event: PointerEvent): boolean
    onTap(event: PointerEvent): void
}

export interface TapTracker {
    /** Forget the current press. Its release is then not a tap. */
    cancel(): void
    destroy(): void
}

/**
 * Find taps: a short press of the primary button that did not move and that did not make or
 * clear a text selection.
 */
export function createTapTracker({ element, accept, onTap }: TapTrackerOptions): TapTracker {
    let press: { id: number; x: number; y: number; time: number } | null = null

    function onDown(event: PointerEvent): void {
        press = null
        if (!event.isPrimary || event.button !== 0) return
        // A press that clears a selection must do nothing more.
        if (hasTextSelection()) return
        if (accept && !accept(event)) return
        press = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }
    }

    function onUp(event: PointerEvent): void {
        const start = press
        press = null
        if (!start || start.id !== event.pointerId) return
        const tap = isTap({
            dx: event.clientX - start.x,
            dy: event.clientY - start.y,
            elapsed: event.timeStamp - start.time,
        })
        // The second press of a double click selects a word. It is then not a tap.
        if (!tap || hasTextSelection()) return
        onTap(event)
    }

    function onCancel(): void {
        press = null
    }

    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointercancel', onCancel)

    return {
        cancel: onCancel,
        destroy() {
            press = null
            element.removeEventListener('pointerdown', onDown)
            element.removeEventListener('pointerup', onUp)
            element.removeEventListener('pointercancel', onCancel)
        },
    }
}

/**
 * Use the click of a tap on the book text, so the browser does nothing more with the tap.
 *
 * Chrome on Android selects the word below a tap for its Touch to Search function when no
 * click handler of the page used the tap. The views act on the pointer events, which come
 * before the click, so Chrome saw each tap as not used. A long press still selects a word.
 *
 * The click keeps its default action where it has one: the browser opens an external link,
 * and a summary element opens its details element.
 */
export function claimClick(event: MouseEvent, boundary: EventTarget): void {
    for (const target of event.composedPath()) {
        if (target === boundary) break
        const element = target as Element
        if (element.nodeType !== 1) continue
        const name = element.localName
        if (name === 'summary' || (name === 'a' && element.hasAttribute('href'))) return
    }
    event.preventDefault()
}

/** The internal link of a key event, for the Enter key on a link that has the focus. */
export function focusedLink(event: KeyboardEvent, boundary: EventTarget): Element | null {
    if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey) return null
    const target = findTapTarget(event.composedPath(), boundary)
    return target.kind === 'link' ? target.element : null
}
