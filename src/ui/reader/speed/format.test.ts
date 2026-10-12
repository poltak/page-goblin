import { describe, expect, it } from 'vitest'
import { percent, statusText, timeLeft } from './format'

describe('timeLeft', () => {
    it('rounds up to a full minute', () => {
        expect(timeLeft({ wordsLeft: 1000, wpm: 250 })).toBe('4 min left')
        expect(timeLeft({ wordsLeft: 1001, wpm: 250 })).toBe('5 min left')
        expect(timeLeft({ wordsLeft: 1, wpm: 250 })).toBe('1 min left')
    })

    it('is 0 at the last word', () => {
        expect(timeLeft({ wordsLeft: 0, wpm: 250 })).toBe('0 min left')
    })

    it('shows hours for a long chapter', () => {
        expect(timeLeft({ wordsLeft: 16250, wpm: 250 })).toBe('1 h 5 min left')
        expect(timeLeft({ wordsLeft: 15000, wpm: 250 })).toBe('1 h 0 min left')
    })

    it('is 0 for a speed that is not valid', () => {
        expect(timeLeft({ wordsLeft: 100, wpm: 0 })).toBe('0 min left')
    })
})

describe('percent', () => {
    it('rounds down, so only a finished book shows 100', () => {
        expect(percent(0.629)).toBe(62)
        expect(percent(0.999)).toBe(99)
        expect(percent(1)).toBe(100)
        expect(percent(1.2)).toBe(100)
    })

    it('corrects a product that is a little below a whole number', () => {
        expect(percent(0.29)).toBe(29)
        expect(percent(0.57)).toBe(57)
    })

    it('is 0 for a value that is not a positive number', () => {
        expect(percent(0)).toBe(0)
        expect(percent(-1)).toBe(0)
        expect(percent(Number.NaN)).toBe(0)
    })
})

describe('statusText', () => {
    it('joins the chapter time and the book percent', () => {
        expect(statusText({ wordsLeft: 1000, wpm: 250, bookFraction: 0.62 })).toBe(
            'Chapter: 4 min left · Book: 62%',
        )
    })
})
