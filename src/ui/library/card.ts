/**
 * One book card of the library grid, made from `template#book-card-template`.
 *
 * Book metadata is text from a file that the app does not trust. It goes into the page only
 * through textContent and setAttribute, never as HTML.
 */

import type { BookRecord } from '$lib/storage/types'
import { bookHash } from '../app/router'
import { cloneTemplate, qs } from '../dom'
import { isFinished, progressPercent, progressText } from './format'

export type CardBook = Pick<BookRecord, 'id' | 'title' | 'author' | 'hasCover' | 'remoteOnly'>

/**
 * `data-cover` of a card:
 * - 'none'    the fallback tile with the title shows
 * - 'pending' the book has a cover that is not loaded. The tile is empty, so the title does
 *             not flash before the image.
 * - 'shown'   the image shows
 */
type CoverState = 'none' | 'pending' | 'shown'

function setCoverState(card: HTMLElement, state: CoverState): void {
    card.dataset.cover = state
}

/** Writes the text of a book into its card. */
export function setCardBook(card: HTMLElement, book: CardBook): void {
    card.dataset.bookId = book.id
    qs('.book-card-open', card).setAttribute('href', bookHash(book.id))
    qs('.book-card-title', card).textContent = book.title
    qs('.book-card-author', card).textContent = book.author
    qs('.book-cover-fallback', card).textContent = book.title
    qs('.book-card-menu', card).setAttribute('aria-label', `More actions for ${book.title}`)
    const remote = book.remoteOnly === true
    qs('.book-card-cloud', card).hidden = !remote
    qs('.book-card-remote', card).hidden = !remote
}

/** Shows the progress bar and the percent, or hides them when the book is not started. */
export function setCardProgress(card: HTMLElement, fraction: number): void {
    const bar = qs('.progress', card)
    const text = qs('.book-card-percent', card)
    const started = fraction > 0
    // A finished book shows the word only. The bar would be full and very short next to it.
    bar.hidden = !started || isFinished(fraction)
    text.hidden = !started
    text.textContent = progressText(fraction)
    if (!started) return
    bar.style.setProperty('--value', String(Math.min(1, fraction)))
    bar.setAttribute('aria-valuenow', String(progressPercent(fraction)))
}

export function createBookCard(book: CardBook, fraction: number): HTMLElement {
    const card = cloneTemplate('book-card-template')
    setCardBook(card, book)
    setCardProgress(card, fraction)
    setCoverState(card, book.hasCover ? 'pending' : 'none')
    return card
}

/**
 * Puts the cover image into a card. Without a URL, or when the image does not load, the card
 * shows the fallback tile.
 */
export function setCardCover(card: HTMLElement, url: string | null): void {
    const cover = qs('.book-cover', card)
    cover.querySelector('img')?.remove()
    if (!url) {
        setCoverState(card, 'none')
        return
    }

    const image = document.createElement('img')
    image.alt = ''
    image.decoding = 'async'
    // A drag of the image would look like a file drag to the drop handler of the window.
    image.draggable = false
    image.addEventListener('load', () => setCoverState(card, 'shown'), { once: true })
    image.addEventListener(
        'error',
        () => {
            image.remove()
            setCoverState(card, 'none')
        },
        { once: true },
    )
    image.src = url
    cover.append(image)
}

/** The id of the book of the card that holds this element, or null. */
export function bookIdOf(element: Element): string | null {
    return element.closest<HTMLElement>('.book-card')?.dataset.bookId ?? null
}
