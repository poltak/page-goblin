import { describe, expect, it } from 'vitest'
import type { HighlightRecord } from '$lib/storage/types'
import { highlightsToKindleClippings } from './kindle'

const book = { title: 'Project Hail Mary', author: 'Andy Weir' }

/** A local time, so that the expected text is the same in each time zone. */
function localTime(day: number, clock: [number, number, number]): number {
    return new Date(2024, 2, day, ...clock).getTime()
}

function makeHighlight(changes: Partial<HighlightRecord> = {}): HighlightRecord {
    const time = localTime(5, [14, 3, 9])
    return {
        id: 'h',
        bookId: 'book',
        spineIndex: 3,
        start: 100,
        end: 140,
        text: 'I penetrated the outer cell membrane.',
        color: 'yellow',
        note: '',
        chapterTitle: 'Chapter 3',
        fraction: 0.42,
        createdAt: time,
        updatedAt: time,
        ...changes,
    }
}

/** The lines of the first entry. */
function linesOf(output: string): string[] {
    return output.split('\r\n').slice(0, 5)
}

describe('highlightsToKindleClippings', () => {
    it('writes one entry for a highlight with no note', () => {
        const output = highlightsToKindleClippings({ book, highlights: [makeHighlight()] })

        expect(output).toBe(
            'Project Hail Mary (Andy Weir)\r\n' +
                '- Your Highlight at location 4200-4200 | Added on Tuesday, 5 March 2024 14:03:09\r\n' +
                '\r\n' +
                'I penetrated the outer cell membrane.\r\n' +
                '==========\r\n',
        )
    })

    it('writes a highlight entry and then a note entry for a highlight with a note', () => {
        const output = highlightsToKindleClippings({
            book,
            highlights: [
                makeHighlight({
                    text: 'x'.repeat(300),
                    note: 'Rocky is the best character.',
                    updatedAt: localTime(9, [8, 0, 59]),
                }),
            ],
        })

        expect(output).toBe(
            'Project Hail Mary (Andy Weir)\r\n' +
                '- Your Highlight at location 4200-4202 | Added on Tuesday, 5 March 2024 14:03:09\r\n' +
                '\r\n' +
                `${'x'.repeat(300)}\r\n` +
                '==========\r\n' +
                'Project Hail Mary (Andy Weir)\r\n' +
                '- Your Note at location 4202 | Added on Saturday, 9 March 2024 08:00:59\r\n' +
                '\r\n' +
                'Rocky is the best character.\r\n' +
                '==========\r\n',
        )
    })

    it('uses CRLF for each line end', () => {
        const output = highlightsToKindleClippings({
            book,
            highlights: [makeHighlight({ note: 'A note' }), makeHighlight({ fraction: 0.5 })],
        })

        expect(output.match(/\r\n/g)).toHaveLength(15)
        expect(output.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
        expect(output.endsWith('==========\r\n')).toBe(true)
        expect(output.startsWith('Project Hail Mary')).toBe(true)
    })

    it('gives an empty text for a book with no highlights', () => {
        expect(highlightsToKindleClippings({ book, highlights: [] })).toBe('')
    })

    it('does not write the bookmarks', () => {
        const source = { book, highlights: [makeHighlight()] }
        const bookmark = {
            id: 'b',
            bookId: 'book',
            locator: { spineIndex: 0, offset: 0 },
            fraction: 0.1,
            chapterTitle: 'Chapter',
            excerpt: 'The first words',
            createdAt: 1000,
        }

        expect(highlightsToKindleClippings({ ...source, bookmarks: [bookmark] })).toBe(
            highlightsToKindleClippings(source),
        )
    })

    describe('title line', () => {
        // A parser that takes the first parenthesis for the author and a parser that takes the
        // last one must find the same author.
        const authorAtFirst = /^(.+?)(?:\s*\((.+)\))?\s*$/
        const authorAtLast = /^(.*) \(([^()]*)\)$/

        it('replaces the parentheses of the title and the author with square brackets', () => {
            const output = highlightsToKindleClippings({
                book: {
                    title: 'Dune (Dune Chronicles, Book 1)',
                    author: 'Herbert, Frank (Author)',
                },
                highlights: [makeHighlight()],
            })
            const line = linesOf(output)[0]

            expect(line).toBe('Dune [Dune Chronicles, Book 1] (Herbert, Frank [Author])')
            for (const pattern of [authorAtFirst, authorAtLast]) {
                expect(line.match(pattern)?.slice(1)).toEqual([
                    'Dune [Dune Chronicles, Book 1]',
                    'Herbert, Frank [Author]',
                ])
            }
        })

        it('writes only the title for a book with no author', () => {
            const output = highlightsToKindleClippings({
                book: { title: 'Beowulf (A New Translation)', author: ' ' },
                highlights: [makeHighlight()],
            })
            const line = linesOf(output)[0]

            expect(line).toBe('Beowulf [A New Translation]')
            expect(line.match(authorAtFirst)?.slice(1)).toEqual([line, undefined])
        })

        it('uses a fallback for an empty title', () => {
            const output = highlightsToKindleClippings({
                book: { title: '', author: 'Anonymous' },
                highlights: [makeHighlight()],
            })

            expect(linesOf(output)[0]).toBe('Untitled (Anonymous)')
        })

        it('puts a title with line breaks on one line', () => {
            const output = highlightsToKindleClippings({
                book: {
                    title: ' The Hobbit\r\n  or There and Back Again ',
                    author: 'J. R. R.\tTolkien',
                },
                highlights: [makeHighlight()],
            })

            expect(linesOf(output)[0]).toBe('The Hobbit or There and Back Again (J. R. R. Tolkien)')
        })
    })

    describe('location', () => {
        function locationOf(changes: Partial<HighlightRecord>): string {
            const output = highlightsToKindleClippings({
                book,
                highlights: [makeHighlight(changes)],
            })
            return linesOf(output)[1].match(/at location (\S+) \|/)?.[1] ?? ''
        }

        it.each([
            [0, '1-1'],
            [0.00004, '1-1'],
            [0.00016, '2-2'],
            [0.1234, '1234-1234'],
            [0.99996, '10000-10000'],
            [1, '10000-10000'],
            [3, '10000-10000'],
            [-0.5, '1-1'],
            [Number.NaN, '1-1'],
        ])('derives the location of the fraction %s as %s', (fraction, location) => {
            expect(locationOf({ fraction })).toBe(location)
        })

        it.each([
            [1, '5000-5000'],
            [127, '5000-5000'],
            [128, '5000-5001'],
            [1000, '5000-5007'],
        ])('gives a text of %s characters the range %s', (length, location) => {
            expect(locationOf({ fraction: 0.5, text: 'x'.repeat(length) })).toBe(location)
        })

        it('keeps the reading order in the location numbers', () => {
            const fractions = [0.001, 0.0011, 0.25, 0.250049, 0.9]
            const output = highlightsToKindleClippings({
                book,
                highlights: fractions.map((fraction) => makeHighlight({ fraction })),
            })
            const starts = [...output.matchAll(/at location (\d+)-/g)].map((match) =>
                Number(match[1]),
            )

            expect(starts).toEqual([10, 11, 2500, 2500, 9000])
        })
    })

    describe('date', () => {
        function dateOf(time: number): string {
            const output = highlightsToKindleClippings({
                book,
                highlights: [makeHighlight({ createdAt: time })],
            })
            return linesOf(output)[1].split(' | ')[1] ?? ''
        }

        it('writes the local time with the day before the month and a 24-hour clock', () => {
            expect(dateOf(localTime(1, [0, 0, 0]))).toBe('Added on Friday, 1 March 2024 00:00:00')
            expect(dateOf(localTime(31, [23, 59, 5]))).toBe(
                'Added on Sunday, 31 March 2024 23:59:05',
            )
            expect(dateOf(new Date(2021, 11, 25, 9, 7, 3).getTime())).toBe(
                'Added on Saturday, 25 December 2021 09:07:03',
            )
        })

        it('leaves out the date when the time is not valid', () => {
            const output = highlightsToKindleClippings({
                book,
                highlights: [makeHighlight({ createdAt: Number.NaN })],
            })

            expect(linesOf(output)[1]).toBe('- Your Highlight at location 4200-4200')
        })
    })

    describe('text', () => {
        it('puts the text and the note on one line each', () => {
            const output = highlightsToKindleClippings({
                book,
                highlights: [
                    makeHighlight({ text: ' Fist my\n\n  bump. ', note: 'Line one\r\nline two' }),
                ],
            })
            const lines = output.split('\r\n')

            expect(lines[3]).toBe('Fist my bump.')
            expect(lines[8]).toBe('Line one line two')
            expect(lines).toHaveLength(11)
        })

        it('shortens a run of equals signs, so that the text cannot end an entry', () => {
            const output = highlightsToKindleClippings({
                book: { title: 'A ========== B', author: '============' },
                highlights: [
                    makeHighlight({ text: '==========', note: 'a ===================== b' }),
                ],
            })

            expect(output.split('\r\n')).toEqual([
                'A ========= B (=========)',
                '- Your Highlight at location 4200-4200 | Added on Tuesday, 5 March 2024 14:03:09',
                '',
                '=========',
                '==========',
                'A ========= B (=========)',
                '- Your Note at location 4200 | Added on Tuesday, 5 March 2024 14:03:09',
                '',
                'a ========= b',
                '==========',
                '',
            ])
        })

        it('writes only the note entry for a highlight with empty text', () => {
            const output = highlightsToKindleClippings({
                book,
                highlights: [makeHighlight({ text: '  ', note: 'Only a note' })],
            })

            expect(output).toBe(
                'Project Hail Mary (Andy Weir)\r\n' +
                    '- Your Note at location 4200 | Added on Tuesday, 5 March 2024 14:03:09\r\n' +
                    '\r\n' +
                    'Only a note\r\n' +
                    '==========\r\n',
            )
        })

        it('writes nothing for a highlight with no text and no note', () => {
            expect(
                highlightsToKindleClippings({ book, highlights: [makeHighlight({ text: '' })] }),
            ).toBe('')
        })
    })
})
