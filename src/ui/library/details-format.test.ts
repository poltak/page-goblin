import { describe, expect, it } from 'vitest'
import {
    formatBytes,
    formatDate,
    languageName,
    publicationYear,
    safeFileName,
    seriesText,
} from './details-format'

describe('sizes', () => {
    it('formats bytes with a unit that fits', () => {
        expect(formatBytes(0)).toBe('0 kB')
        expect(formatBytes(300)).toBe('1 kB')
        expect(formatBytes(340_000)).toBe('340 kB')
        expect(formatBytes(1_234_567)).toBe('1.2 MB')
        expect(formatBytes(15_600_000)).toBe('15.6 MB')
        expect(formatBytes(2_500_000_000)).toBe('2.5 GB')
    })
})

describe('publicationYear', () => {
    it('reads the year of the usual date forms', () => {
        expect(publicationYear('2021')).toBe(2021)
        expect(publicationYear('2021-05-04')).toBe(2021)
        expect(publicationYear('1869-01-01T00:00:00+00:00')).toBe(1869)
        expect(publicationYear(' January 2021 ')).toBe(2021)
        expect(publicationYear('04/05/1999')).toBe(1999)
    })

    it('gives null when there is no year', () => {
        expect(publicationYear(null)).toBeNull()
        expect(publicationYear('')).toBeNull()
        expect(publicationYear('unknown')).toBeNull()
        expect(publicationYear('20210504')).toBeNull()
    })

    it('gives null for the year that Calibre writes for an unknown date', () => {
        expect(publicationYear('0101-01-01T00:00:00+00:00')).toBeNull()
    })
})

describe('seriesText', () => {
    it('names the position and the series', () => {
        expect(seriesText({ name: 'Earthsea', position: 2 })).toBe('Book 2 of Earthsea')
        expect(seriesText({ name: 'Discworld', position: 2.5 })).toBe('Book 2.5 of Discworld')
    })

    it('gives only the name when the position is not known', () => {
        expect(seriesText({ name: 'Earthsea', position: null })).toBe('Earthsea')
    })

    it('gives null when there is no series', () => {
        expect(seriesText(null)).toBeNull()
        expect(seriesText({ name: '  ', position: 1 })).toBeNull()
    })
})

describe('languageName', () => {
    it('gives null for no language', () => {
        expect(languageName(null)).toBeNull()
        expect(languageName('  ')).toBeNull()
    })

    it('gives a name for a known tag', () => {
        const name = languageName('en')
        expect(name).not.toBeNull()
        expect(name).not.toBe('')
    })

    it('gives the tag back when it is not valid', () => {
        expect(languageName('not a language tag')).toBe('not a language tag')
    })
})

describe('formatDate', () => {
    it('gives a date with the year in the locale of the browser', () => {
        expect(formatDate(new Date(2026, 2, 5).getTime())).toContain('2026')
    })
})

describe('file names', () => {
    it('removes the characters that a file system refuses', () => {
        expect(safeFileName('What If? Serious: Answers / Questions')).toBe(
            'What If Serious Answers Questions',
        )
        expect(safeFileName('a\u0000b\tc')).toBe('a b c')
    })

    it('does not start with a dot', () => {
        expect(safeFileName('../../etc/passwd')).toBe('etc passwd')
    })

    it('cuts a long title and gives a default for an empty one', () => {
        expect(safeFileName('x'.repeat(300))).toHaveLength(80)
        expect(safeFileName('???')).toBe('book')
    })
})
