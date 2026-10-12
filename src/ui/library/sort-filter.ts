/** Sort order and search of the library. No DOM in this file. */

import type { LibrarySort } from '$lib/settings/schema'
import type { BookRecord } from '$lib/storage/types'

export type SortableBook = Pick<BookRecord, 'id' | 'title' | 'author' | 'addedAt' | 'lastOpenedAt'>

let collator: Intl.Collator | undefined

/** Compares text as a reader expects: no case, no accents, and 'Book 2' before 'Book 10'. */
function compareText(a: string, b: string): number {
    collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    return collator.compare(a, b)
}

/** The time of the last use of a book: the later of the last open and the import. */
export function recentTime(book: Pick<BookRecord, 'addedAt' | 'lastOpenedAt'>): number {
    return Math.max(book.lastOpenedAt ?? 0, book.addedAt)
}

/** The compare function of a sort order. The id is the last key, so the order is stable. */
export function compareBooks(sort: LibrarySort): (a: SortableBook, b: SortableBook) => number {
    const byId = (a: SortableBook, b: SortableBook) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const byTitle = (a: SortableBook, b: SortableBook) => compareText(a.title, b.title)
    switch (sort) {
        case 'added':
            return (a, b) => b.addedAt - a.addedAt || byTitle(a, b) || byId(a, b)
        case 'title':
            return (a, b) => byTitle(a, b) || compareText(a.author, b.author) || byId(a, b)
        case 'author':
            return (a, b) => compareText(a.author, b.author) || byTitle(a, b) || byId(a, b)
        default:
            return (a, b) => recentTime(b) - recentTime(a) || byTitle(a, b) || byId(a, b)
    }
}

/** A sorted copy. */
export function sortBooks<T extends SortableBook>(books: readonly T[], sort: LibrarySort): T[] {
    return [...books].sort(compareBooks(sort))
}

/**
 * The position for a new book in a list that is sorted already: the index of the first book
 * that comes after it, or the length of the list.
 */
export function insertIndex<T extends SortableBook>(
    sorted: readonly T[],
    book: T,
    sort: LibrarySort,
): number {
    const compare = compareBooks(sort)
    let low = 0
    let high = sorted.length
    while (low < high) {
        const middle = (low + high) >> 1
        if (compare(sorted[middle], book) <= 0) low = middle + 1
        else high = middle
    }
    return low
}

/** Lower case with no accents, so 'Émile' and 'emile' are the same text. */
export function normalizeText(text: string): string {
    return text
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
}

/** The text of a book that a search looks in. Make it one time for each book. */
export function searchKey(book: Pick<BookRecord, 'title' | 'author'>): string {
    return normalizeText(`${book.title} ${book.author}`)
}

/** The words of a search, normalised. An empty search gives no words. */
export function searchWords(query: string): string[] {
    return normalizeText(query).split(/\s+/).filter(Boolean)
}

/** True when the key has all words. No words match each key. */
export function matchesSearch(key: string, words: readonly string[]): boolean {
    for (const word of words) {
        if (!key.includes(word)) return false
    }
    return true
}

/** The books that match the search, in the order of the input. */
export function filterBooks<T extends Pick<BookRecord, 'title' | 'author'>>(
    books: readonly T[],
    query: string,
): T[] {
    const words = searchWords(query)
    if (words.length === 0) return [...books]
    return books.filter((book) => matchesSearch(searchKey(book), words))
}
