import { describe, expect, it } from 'vitest'
import { bookCountText, isFinished, plural, progressPercent, progressText } from './format'

describe('progress', () => {
    it('gives no text for a book that is not started', () => {
        expect(progressText(0)).toBe('')
        expect(progressText(Number.NaN)).toBe('')
        expect(progressText(-1)).toBe('')
    })

    it('shows a whole percent', () => {
        expect(progressText(0.42)).toBe('42%')
        expect(progressText(0.994)).toBe('99%')
    })

    it('never shows 0% for progress above 0', () => {
        expect(progressText(0.001)).toBe('1%')
        expect(progressPercent(0.001)).toBe(1)
    })

    it('shows "Finished" from 99.5 percent', () => {
        expect(progressText(0.995)).toBe('Finished')
        expect(progressText(1)).toBe('Finished')
        expect(isFinished(0.9949)).toBe(false)
        expect(isFinished(0.995)).toBe(true)
    })

    it('keeps the percent between 0 and 100', () => {
        expect(progressPercent(0)).toBe(0)
        expect(progressPercent(3)).toBe(100)
    })
})

describe('bookCountText', () => {
    it('uses the singular for one book', () => {
        expect(bookCountText(1, 1)).toBe('1 book')
        expect(bookCountText(12, 12)).toBe('12 books')
        expect(bookCountText(0, 0)).toBe('0 books')
    })

    it('shows the two numbers when a search hides books', () => {
        expect(bookCountText(3, 12)).toBe('3 of 12 books')
        expect(bookCountText(0, 1)).toBe('0 of 1 books')
    })
})

describe('plural', () => {
    it('picks the noun for the number', () => {
        expect(plural(0, 'bookmark', 'bookmarks')).toBe('0 bookmarks')
        expect(plural(1, 'bookmark', 'bookmarks')).toBe('1 bookmark')
        expect(plural(2, 'bookmark', 'bookmarks')).toBe('2 bookmarks')
    })
})
