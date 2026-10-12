import { ACTIVE_CLASS, HIGHLIGHT_CLASS } from '$lib/reader/marks'

/** Elements that hold one note. */
const NOTE_BLOCKS = new Set(['aside', 'li', 'p', 'div', 'section', 'dd', 'td', 'blockquote'])

/**
 * A block with more text than this is not shown as a note. In real books 1 to 2 of each 100
 * note links point to a marker whose nearest block is the section of a full chapter (20,000
 * to 260,000 characters). A copy of that block would stop the page for a long time.
 */
export const NOTE_MAX_CHARS = 10_000

/** Content that makes a note worth showing when it has no text. */
const MEDIA_SELECTOR = 'img, svg, math, video, audio, table'

/**
 * The wrappers that a reader view puts around highlights and the speech marker while it shows
 * a chapter. Each wrapper has only text and other wrappers in it.
 */
const READER_MARKS = `mark.${HIGHLIGHT_CLASS}, mark.${ACTIVE_CLASS}`

/** Puts the text of each reader mark back in its place. Outside the view a mark has no style. */
function unwrapReaderMarks(copy: HTMLElement): void {
    const marks = copy.querySelectorAll(READER_MARKS)
    if (marks.length === 0) return
    for (const mark of marks) mark.replaceWith(...mark.childNodes)
    copy.normalize()
}

/** The element that a fragment identifier points to: an `id`, or the `name` of an anchor. */
export function findFragmentTarget(body: Element, fragment: string): Element | null {
    if (!fragment) return null
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        const escaped = CSS.escape(fragment)
        return body.querySelector(`#${escaped}`) ?? body.querySelector(`a[name="${escaped}"]`)
    }
    // jsdom has no CSS.escape.
    let named: Element | null = null
    for (const element of body.querySelectorAll('[id], a[name]')) {
        if (element.id === fragment) return element
        if (!named && element.localName === 'a' && element.getAttribute('name') === fragment) {
            named = element
        }
    }
    return named
}

/**
 * The element that holds the note of a target: the nearest block around the target, or the
 * child of the body that has it. The target must be below the body. Null for the body itself.
 */
export function noteBlockOf(body: Element, target: Element): Element | null {
    for (
        let element: Element | null = target;
        element && element !== body;
        element = element.parentElement
    ) {
        if (NOTE_BLOCKS.has(element.localName) || element.parentElement === body) return element
    }
    return null
}

/** True when the element has more than `limit` characters of text. Stops at the limit. */
function hasMoreTextThan(element: Element, limit: number): boolean {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let length = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        length += (node as Text).data.length
        if (length > limit) return true
    }
    return false
}

/**
 * A detached copy of the note that a fragment identifier points to, with no `id` attributes,
 * so that the copy can be in the page together with the chapter. Null when the target is not
 * there, when the note is empty (an anchor with its text in the next element) or when the
 * block has more than `NOTE_MAX_CHARS` characters.
 */
export function extractNote(body: Element, fragment: string): HTMLElement | null {
    const target = findFragmentTarget(body, fragment)
    const block = target && noteBlockOf(body, target)
    if (!block || hasMoreTextThan(block, NOTE_MAX_CHARS)) return null
    const hasContent =
        Boolean(block.textContent?.trim()) ||
        block.matches(MEDIA_SELECTOR) ||
        block.querySelector(MEDIA_SELECTOR) !== null
    if (!hasContent) return null

    const copy = block.cloneNode(true) as HTMLElement
    copy.removeAttribute('id')
    for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id')
    unwrapReaderMarks(copy)
    return copy
}
