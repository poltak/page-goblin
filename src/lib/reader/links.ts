/** What a link in the book text is. */

import { EPUB_TYPE_ATTR } from '$lib/content'

// 1, 12, [3], (4), *, a dagger. A dot can follow.
const NOTE_MARK = /^[[(]?(?:\d{1,4}|[*†‡§¶‖#]{1,3})[\])]?\.?$/

function hasToken(value: string | null, token: string): boolean {
    return !!value && value.toLowerCase().split(/\s+/).includes(token)
}

/**
 * True when a link looks like a reference to a note. The reader screen then shows the note
 * in a popover and does not leave the page.
 */
export function isNoteRef(link: Element): boolean {
    if (hasToken(link.getAttribute(EPUB_TYPE_ATTR), 'noteref')) return true
    if (hasToken(link.getAttribute('role'), 'doc-noteref')) return true
    if (link.closest('sup')) return true
    const text = (link.textContent ?? '').trim()
    return text.length > 0 && NOTE_MARK.test(text)
}
