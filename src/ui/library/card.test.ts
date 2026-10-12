import { beforeEach, describe, expect, it } from 'vitest'
import { mountPage } from '../app/testing/page'
import { bookIdOf, createBookCard, setCardBook, setCardCover, setCardProgress } from './card'
import type { CardBook } from './card'

const HOSTILE_TITLE = '<img src=x onerror="window.hacked = true">'
const HOSTILE_AUTHOR = '"><script>window.hacked = true</script><b>bold</b>'

function book(changes: Partial<CardBook> = {}): CardBook {
    return {
        id: 'b1',
        title: 'The Harbour Light',
        author: 'Ada Marsh',
        hasCover: false,
        ...changes,
    }
}

function text(card: HTMLElement, selector: string): string {
    return card.querySelector(selector)?.textContent ?? ''
}

beforeEach(() => {
    mountPage()
})

describe('createBookCard', () => {
    it('makes a list item from the template with the text of the book', () => {
        const card = createBookCard(book(), 0)

        expect(card.tagName).toBe('LI')
        expect(card.classList.contains('book-card')).toBe(true)
        expect(card.dataset.bookId).toBe('b1')
        expect(text(card, '.book-card-title')).toBe('The Harbour Light')
        expect(text(card, '.book-card-author')).toBe('Ada Marsh')
        expect(text(card, '.book-cover-fallback')).toBe('The Harbour Light')
    })

    it('has a real link to the book as its main area', () => {
        const card = createBookCard(book({ id: 'id with space' }), 0)
        const link = card.querySelector('a.book-card-open')

        expect(link?.getAttribute('href')).toBe('#/book/id%20with%20space')
    })

    it('labels the menu button with the title', () => {
        const card = createBookCard(book(), 0)
        const button = card.querySelector('button.book-card-menu')

        expect(button?.getAttribute('aria-label')).toBe('More actions for The Harbour Light')
        expect(button?.getAttribute('type')).toBe('button')
    })

    it('makes each card from its own copy of the template', () => {
        const first = createBookCard(book({ id: 'one', title: 'One' }), 0)
        const second = createBookCard(book({ id: 'two', title: 'Two' }), 0)

        expect(text(first, '.book-card-title')).toBe('One')
        expect(text(second, '.book-card-title')).toBe('Two')
    })

    it('keeps metadata with markup as text', () => {
        const card = createBookCard(book({ title: HOSTILE_TITLE, author: HOSTILE_AUTHOR }), 0.5)
        document.body.append(card)

        expect(card.querySelector('img')).toBeNull()
        expect(card.querySelector('script')).toBeNull()
        expect(card.querySelector('b')).toBeNull()
        expect(text(card, '.book-card-title')).toBe(HOSTILE_TITLE)
        expect(text(card, '.book-cover-fallback')).toBe(HOSTILE_TITLE)
        expect(text(card, '.book-card-author')).toBe(HOSTILE_AUTHOR)
        expect(card.querySelector('.book-card-menu')?.getAttribute('aria-label')).toBe(
            `More actions for ${HOSTILE_TITLE}`,
        )
        expect((window as { hacked?: boolean }).hacked).toBeUndefined()
    })

    it('keeps a hostile id inside the href and the data attribute', () => {
        const id = '"><img src=x onerror=alert(1)>'
        const card = createBookCard(book({ id }), 0)

        expect(card.querySelector('img')).toBeNull()
        expect(card.dataset.bookId).toBe(id)
        expect(card.querySelector('a')?.getAttribute('href')).toBe(
            `#/book/${encodeURIComponent(id)}`,
        )
    })

    it('shows an empty tile for a book whose cover is not loaded yet', () => {
        expect(createBookCard(book({ hasCover: true }), 0).dataset.cover).toBe('pending')
        expect(createBookCard(book({ hasCover: false }), 0).dataset.cover).toBe('none')
    })
})

describe('setCardProgress', () => {
    function parts(fraction: number) {
        const card = createBookCard(book(), fraction)
        return {
            card,
            bar: card.querySelector<HTMLElement>('.progress')!,
            percent: card.querySelector<HTMLElement>('.book-card-percent')!,
        }
    }

    it('hides the bar and the percent for a book that is not started', () => {
        const { bar, percent } = parts(0)

        expect(bar.hidden).toBe(true)
        expect(percent.hidden).toBe(true)
        expect(percent.textContent).toBe('')
    })

    it('shows the bar and the percent when the progress is above 0', () => {
        const { bar, percent } = parts(0.42)

        expect(bar.hidden).toBe(false)
        expect(bar.style.getPropertyValue('--value')).toBe('0.42')
        expect(bar.getAttribute('aria-valuenow')).toBe('42')
        expect(percent.hidden).toBe(false)
        expect(percent.textContent).toBe('42%')
    })

    it('shows "Finished" with no bar from 99.5 percent', () => {
        const { bar, percent } = parts(0.996)

        expect(percent.textContent).toBe('Finished')
        expect(percent.hidden).toBe(false)
        expect(bar.hidden).toBe(true)
    })

    it('updates a card in place', () => {
        const { card, bar, percent } = parts(0.1)

        setCardProgress(card, 0.75)
        expect(percent.textContent).toBe('75%')
        expect(bar.style.getPropertyValue('--value')).toBe('0.75')

        setCardProgress(card, 0)
        expect(bar.hidden).toBe(true)
        expect(percent.hidden).toBe(true)
    })
})

describe('setCardBook', () => {
    it('writes new text into a card that exists', () => {
        const card = createBookCard(book(), 0)

        setCardBook(card, book({ title: 'New title', author: 'New author' }))

        expect(text(card, '.book-card-title')).toBe('New title')
        expect(text(card, '.book-card-author')).toBe('New author')
        expect(card.querySelectorAll('.book-card-title')).toHaveLength(1)
    })
})

describe('setCardCover', () => {
    it('adds an image that cannot be dragged, and shows it after it loads', () => {
        const card = createBookCard(book({ hasCover: true }), 0)

        setCardCover(card, 'blob:cover-1')
        const image = card.querySelector('img')!

        expect(image.getAttribute('src')).toBe('blob:cover-1')
        expect(image.alt).toBe('')
        expect(image.draggable).toBe(false)
        expect(card.dataset.cover).toBe('pending')

        image.dispatchEvent(new Event('load'))
        expect(card.dataset.cover).toBe('shown')
    })

    it('shows the fallback tile when the image does not load', () => {
        const card = createBookCard(book({ hasCover: true }), 0)
        setCardCover(card, 'blob:broken')

        card.querySelector('img')!.dispatchEvent(new Event('error'))

        expect(card.querySelector('img')).toBeNull()
        expect(card.dataset.cover).toBe('none')
        expect(text(card, '.book-cover-fallback')).toBe('The Harbour Light')
    })

    it('shows the fallback tile when there is no image', () => {
        const card = createBookCard(book({ hasCover: true }), 0)

        setCardCover(card, null)

        expect(card.querySelector('img')).toBeNull()
        expect(card.dataset.cover).toBe('none')
    })

    it('replaces an image and does not add a second one', () => {
        const card = createBookCard(book({ hasCover: true }), 0)

        setCardCover(card, 'blob:one')
        setCardCover(card, 'blob:two')

        expect(card.querySelectorAll('img')).toHaveLength(1)
        expect(card.querySelector('img')?.getAttribute('src')).toBe('blob:two')
    })
})

describe('bookIdOf', () => {
    it('finds the book of an element in a card', () => {
        const card = createBookCard(book({ id: 'b7' }), 0)

        expect(bookIdOf(card.querySelector('.book-card-menu')!)).toBe('b7')
        expect(bookIdOf(card)).toBe('b7')
    })

    it('gives null for an element that is not in a card', () => {
        expect(bookIdOf(document.body)).toBeNull()
    })
})
