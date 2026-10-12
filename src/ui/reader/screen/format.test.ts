import { describe, expect, it } from 'vitest'
import {
    errorMessage,
    locatorAtFraction,
    pageText,
    percentOf,
    percentText,
    progressText,
    SLIDER_MAX,
    sliderFraction,
    sliderLabel,
    sliderValue,
    timeLeftText,
} from './format'

describe('percentOf', () => {
    it('gives 0 at the start and for values that are not a position', () => {
        expect(percentOf(0)).toBe(0)
        expect(percentOf(-0.2)).toBe(0)
        expect(percentOf(Number.NaN)).toBe(0)
    })

    it('gives 100 only at the end', () => {
        expect(percentOf(1)).toBe(100)
        expect(percentOf(1.5)).toBe(100)
        expect(percentOf(0.999)).toBe(99)
    })

    it('never shows 0 after the start', () => {
        expect(percentOf(0.001)).toBe(1)
    })

    it('rounds to a whole percent', () => {
        expect(percentOf(0.344)).toBe(34)
        expect(percentOf(0.346)).toBe(35)
        expect(percentText(0.5)).toBe('50%')
    })
})

describe('pageText', () => {
    it('gives the page and the page count in the paged view', () => {
        expect(pageText({ page: 3, pageCount: 12 })).toBe('Page 3 of 12')
    })

    it('gives no text in the scroll view', () => {
        expect(pageText({ page: null, pageCount: null })).toBe('')
    })

    it('gives no text before the first position', () => {
        expect(pageText(null)).toBe('')
    })
})

describe('timeLeftText', () => {
    it('rounds the minutes up', () => {
        expect(timeLeftText({ words: 1150, wpm: 230 })).toBe('5 min left in chapter')
        expect(timeLeftText({ words: 1151, wpm: 230 })).toBe('6 min left in chapter')
    })

    it('gives one minute for exactly one minute of words', () => {
        expect(timeLeftText({ words: 230, wpm: 230 })).toBe('1 min left in chapter')
    })

    it('gives a fixed text below one minute', () => {
        expect(timeLeftText({ words: 229, wpm: 230 })).toBe('less than 1 min left in chapter')
        expect(timeLeftText({ words: 0, wpm: 230 })).toBe('less than 1 min left in chapter')
    })

    it('gives no text for a reading speed that is not a positive number', () => {
        expect(timeLeftText({ words: 500, wpm: 0 })).toBe('')
        expect(timeLeftText({ words: 500, wpm: Number.NaN })).toBe('')
    })
})

describe('progressText', () => {
    it('joins the percent and the time that is left', () => {
        expect(progressText({ fraction: 0.34, chapterWords: 1300, wpm: 230 })).toBe(
            '34% · 6 min left in chapter',
        )
    })

    it('gives only the percent before the first position', () => {
        expect(progressText({ fraction: 0.34, chapterWords: null, wpm: 230 })).toBe('34%')
    })

    it('gives only the percent when the reading speed is not known', () => {
        expect(progressText({ fraction: 1, chapterWords: 10, wpm: 0 })).toBe('100%')
    })
})

describe('the slider', () => {
    it('maps a fraction to a whole slider value', () => {
        expect(sliderValue(0)).toBe(0)
        expect(sliderValue(0.3456)).toBe(346)
        expect(sliderValue(1)).toBe(SLIDER_MAX)
        expect(sliderValue(2)).toBe(SLIDER_MAX)
        expect(sliderValue(Number.NaN)).toBe(0)
    })

    it('maps a slider value to a fraction', () => {
        expect(sliderFraction('0')).toBe(0)
        expect(sliderFraction('250')).toBe(0.25)
        expect(sliderFraction(1000)).toBe(1)
        expect(sliderFraction('1200')).toBe(1)
        expect(sliderFraction('')).toBe(0)
        expect(sliderFraction('x')).toBe(0)
    })

    it('gives the same value after a round trip', () => {
        for (const value of [0, 1, 499, 500, 999, 1000]) {
            expect(sliderValue(sliderFraction(value))).toBe(value)
        }
    })

    it('makes the label from the title and the percent', () => {
        expect(sliderLabel({ title: 'Chapter One', fraction: 0.34 })).toBe('Chapter One · 34%')
    })

    it('makes the label from the percent when there is no title', () => {
        expect(sliderLabel({ title: '', fraction: 0.34 })).toBe('34%')
        expect(sliderLabel({ title: '   ', fraction: 1 })).toBe('100%')
    })
})

describe('locatorAtFraction', () => {
    const stats = [
        { chars: 100, words: 20 },
        { chars: 300, words: 60 },
        { chars: 0, words: 0 },
        { chars: 600, words: 120 },
    ]

    it('gives the start of the book for 0', () => {
        expect(locatorAtFraction(stats, 0)).toEqual({ spineIndex: 0, offset: 0 })
    })

    it('gives the chapter and the offset of a fraction', () => {
        // 250 of 1000 characters is 150 characters into the second chapter.
        expect(locatorAtFraction(stats, 0.25)).toEqual({ spineIndex: 1, offset: 150 })
        expect(locatorAtFraction(stats, 0.7)).toEqual({ spineIndex: 3, offset: 300 })
    })

    it('gives the start of the next chapter on a border', () => {
        expect(locatorAtFraction(stats, 0.1)).toEqual({ spineIndex: 1, offset: 0 })
    })

    it('gives the end of the last chapter for 1', () => {
        expect(locatorAtFraction(stats, 1)).toEqual({ spineIndex: 3, offset: 600 })
    })

    it('gives the start for a book with no statistics', () => {
        expect(locatorAtFraction([], 0.5)).toEqual({ spineIndex: 0, offset: 0 })
    })
})

describe('errorMessage', () => {
    it('keeps a message that the session wrote for the user', () => {
        expect(errorMessage(new Error('This link cannot be opened.'))).toBe(
            'This link cannot be opened.',
        )
        expect(errorMessage(new Error('The reading position could not be saved.'))).toBe(
            'The reading position could not be saved.',
        )
    })

    it('gives a plain message for each other error', () => {
        expect(errorMessage(new Error('File not found in the book: OEBPS/c9.xhtml'))).toBe(
            'Something went wrong.',
        )
        expect(errorMessage('text')).toBe('Something went wrong.')
        expect(errorMessage(null)).toBe('Something went wrong.')
    })
})
