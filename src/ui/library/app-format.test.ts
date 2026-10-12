import { describe, expect, it } from 'vitest'
import type { RestoreResult } from '$lib/annotations/types'
import { backupFileName, describeRestore, formatMegabytes } from './app-format'

describe('formatMegabytes', () => {
    it('formats megabytes for the storage dialog', () => {
        expect(formatMegabytes(0)).toBe('0.0')
        expect(formatMegabytes(12_340_000)).toBe('12.3')
        expect(formatMegabytes(123_400_000)).toBe('123')
    })
})

describe('backupFileName', () => {
    it('names the backup file with the local date', () => {
        expect(backupFileName(new Date(2026, 9, 12, 23, 59))).toBe(
            'page-goblin-backup-2026-10-12.json',
        )
        expect(backupFileName(new Date(2027, 0, 5))).toBe('page-goblin-backup-2027-01-05.json')
    })
})

describe('describeRestore', () => {
    const none: RestoreResult = {
        booksMatched: 0,
        booksMissing: 0,
        bookmarksAdded: 0,
        highlightsAdded: 0,
        highlightsUpdated: 0,
        progressUpdated: 0,
    }

    it('gives all numbers in one sentence', () => {
        expect(
            describeRestore({
                booksMatched: 3,
                booksMissing: 1,
                bookmarksAdded: 5,
                highlightsAdded: 12,
                highlightsUpdated: 4,
                progressUpdated: 2,
            }),
        ).toBe(
            'Restored 2 reading positions, 5 bookmarks, 12 highlights and 4 changed highlights for 3 books; 1 book of the backup is not in this library.',
        )
    })

    it('uses the singular for one', () => {
        expect(describeRestore({ ...none, booksMatched: 1, bookmarksAdded: 1 })).toBe(
            'Restored 1 bookmark for 1 book.',
        )
    })

    it('joins two parts with "and"', () => {
        expect(
            describeRestore({ ...none, booksMatched: 2, highlightsAdded: 3, progressUpdated: 1 }),
        ).toBe('Restored 1 reading position and 3 highlights for 2 books.')
    })

    it('says when the backup has nothing new', () => {
        expect(describeRestore({ ...none, booksMatched: 4 })).toBe(
            'The backup has nothing new for 4 books.',
        )
    })

    it('says when no book of the backup is in the library', () => {
        expect(describeRestore({ ...none, booksMissing: 2 })).toBe(
            'Nothing was restored: 2 books of the backup are not in this library.',
        )
    })

    it('says when the backup is empty', () => {
        expect(describeRestore(none)).toBe('The backup has no books.')
    })
})
