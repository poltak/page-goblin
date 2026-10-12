import { describe, expect, it } from 'vitest'
import type { BookmarkRecord, HighlightRecord } from '$lib/storage/types'
import { highlightsToMarkdown } from './markdown'
import type { ExportSource } from './types'

const book = { title: 'The Elements of Style', author: 'William Strunk Jr.' }

function makeHighlight(changes: Partial<HighlightRecord> = {}): HighlightRecord {
    return {
        id: 'h',
        bookId: 'book',
        spineIndex: 0,
        start: 0,
        end: 10,
        text: 'Some words.',
        color: 'yellow',
        note: '',
        chapterTitle: 'Chapter',
        fraction: 0.1,
        createdAt: 1000,
        updatedAt: 1000,
        ...changes,
    }
}

function makeBookmark(changes: Partial<BookmarkRecord> = {}): BookmarkRecord {
    return {
        id: 'b',
        bookId: 'book',
        locator: { spineIndex: 0, offset: 0 },
        fraction: 0.1,
        chapterTitle: 'Chapter',
        excerpt: 'The first words',
        createdAt: 1000,
        ...changes,
    }
}

/** The quote line that the text of one highlight gives. */
function quoteOf(text: string): string {
    const output = highlightsToMarkdown({ book, highlights: [makeHighlight({ text })] })
    return output.split('\n').find((line) => line.startsWith('> ')) ?? ''
}

describe('highlightsToMarkdown', () => {
    it('writes the title, the author, the chapters, the highlights, the notes and the bookmarks', () => {
        const source: ExportSource = {
            book,
            highlights: [
                makeHighlight({ chapterTitle: 'Introductory', text: 'Omit needless words.' }),
                makeHighlight({
                    chapterTitle: 'Elementary Principles of Composition',
                    text: 'Vigorous writing is concise.',
                    note: 'Use this in each review.',
                }),
                makeHighlight({
                    chapterTitle: 'Elementary Principles of Composition',
                    text: 'A sentence should contain no unnecessary words.',
                }),
            ],
            bookmarks: [
                makeBookmark({
                    chapterTitle: 'Introductory',
                    fraction: 0.034,
                    excerpt: 'This book is intended for use',
                }),
                makeBookmark({
                    chapterTitle: 'Words Often Misspelled',
                    fraction: 0.9151,
                    excerpt: 'accidentally advice affect',
                }),
            ],
        }

        expect(highlightsToMarkdown(source)).toBe(
            [
                '# The Elements of Style',
                '',
                'Author: William Strunk Jr.',
                '',
                '## Introductory',
                '',
                '> Omit needless words.',
                '',
                '## Elementary Principles of Composition',
                '',
                '> Vigorous writing is concise.',
                '',
                'Note: Use this in each review.',
                '',
                '> A sentence should contain no unnecessary words.',
                '',
                '## Bookmarks',
                '',
                '- Introductory, 3%: *This book is intended for use*',
                '- Words Often Misspelled, 92%: *accidentally advice affect*',
                '',
            ].join('\n'),
        )
    })

    it('ends the file with one newline', () => {
        const output = highlightsToMarkdown({ book, highlights: [makeHighlight()] })

        expect(output.endsWith('> Some words.\n')).toBe(true)
        expect(output.endsWith('\n\n')).toBe(false)
    })

    it('writes only the title and the author for a book with no highlights', () => {
        expect(highlightsToMarkdown({ book, highlights: [] })).toBe(
            '# The Elements of Style\n\nAuthor: William Strunk Jr.\n',
        )
    })

    it('has no author line for an empty author and a fallback for an empty title', () => {
        const output = highlightsToMarkdown({
            book: { title: '  ', author: '' },
            highlights: [makeHighlight({ chapterTitle: '' })],
        })

        expect(output).toBe('# Untitled\n\n> Some words.\n')
    })

    describe('chapter groups', () => {
        it('writes one heading for adjacent highlights of the same chapter', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [
                    makeHighlight({ chapterTitle: 'One', text: 'a' }),
                    makeHighlight({ chapterTitle: 'One', text: 'b' }),
                    makeHighlight({ chapterTitle: 'Two', text: 'c' }),
                ],
            })

            expect(output.split('\n').filter((line) => line.startsWith('#'))).toEqual([
                '# The Elements of Style',
                '## One',
                '## Two',
            ])
            expect(output).toContain('## One\n\n> a\n\n> b\n\n## Two\n\n> c\n')
        })

        it('writes no heading for a group with an empty chapter title', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [
                    makeHighlight({ chapterTitle: '', text: 'a' }),
                    makeHighlight({ chapterTitle: '  ', text: 'b' }),
                    makeHighlight({ chapterTitle: 'One', text: 'c' }),
                ],
            })

            expect(output).toBe(
                '# The Elements of Style\n\nAuthor: William Strunk Jr.\n\n> a\n\n> b\n\n## One\n\n> c\n',
            )
        })

        it('writes the heading again when a chapter title comes back later in the book', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [
                    makeHighlight({ chapterTitle: 'Notes', text: 'a' }),
                    makeHighlight({ chapterTitle: 'Part 2', text: 'b' }),
                    makeHighlight({ chapterTitle: 'Notes', text: 'c' }),
                ],
            })

            expect(output).toContain('## Notes\n\n> a\n\n## Part 2\n\n> b\n\n## Notes\n\n> c\n')
        })

        it('treats chapter titles that differ only in white space as one chapter', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [
                    makeHighlight({ chapterTitle: 'Chapter\n One', text: 'a' }),
                    makeHighlight({ chapterTitle: 'Chapter One ', text: 'b' }),
                ],
            })

            expect(output).toContain('## Chapter One\n\n> a\n\n> b\n')
        })
    })

    describe('escaping', () => {
        it.each([
            ['a backslash', 'C:\\Users\\me', 'C:\\\\Users\\\\me'],
            ['asterisks', 'a *very* big **deal**', 'a \\*very\\* big \\*\\*deal\\*\\*'],
            ['underscores', 'snake_case and _emphasis_', 'snake\\_case and \\_emphasis\\_'],
            ['backticks', 'run `make` now', 'run \\`make\\` now'],
            ['square brackets', 'see [1] and [a link](x)', 'see \\[1\\] and \\[a link\\](x)'],
            ['an HTML tag', 'the <b>bold</b> tag', 'the \\<b>bold\\</b> tag'],
            ['an HTML entity', 'write &amp; or &#38; here', 'write \\&amp; or \\&\\#38; here'],
            ['a tag of a note application', 'the #MeToo years', 'the \\#MeToo years'],
            ['strikethrough', 'it was ~~not~~ true', 'it was \\~\\~not\\~\\~ true'],
            ['mathematics', 'from $5 to $9', 'from \\$5 to \\$9'],
            [
                'a marker of a note application',
                'a == b and ==c== or ===',
                'a \\== b and \\==c\\== or \\=\\==',
            ],
        ])('escapes %s', (_name, text, expected) => {
            expect(quoteOf(text)).toBe(`> ${expected}`)
        })

        it.each([
            ['a number sign', '# not a heading', '\\# not a heading'],
            ['a greater-than sign', '> not a quote', '\\> not a quote'],
            ['a hyphen', '- not a list', '\\- not a list'],
            ['a line of hyphens', '---', '\\---'],
            ['a plus', '+ not a list', '\\+ not a list'],
            ['a number with a full stop', '1. Omit needless words.', '1\\. Omit needless words.'],
            ['a number with a parenthesis', '12) Twelve', '12\\) Twelve'],
        ])('escapes %s at the start of a highlight', (_name, text, expected) => {
            expect(quoteOf(text)).toBe(`> ${expected}`)
        })

        it('keeps plain text and characters that are special only at a line start', () => {
            const text = 'In 1984, a > b - c + d. It cost 5.50 (or less) & "AT&T" paid!'

            expect(quoteOf(text)).toBe(`> ${text}`)
        })

        it('collapses the white space inside a highlight', () => {
            expect(quoteOf('  one\n\n  two\tthree\u00a0four  ')).toBe('> one two three four')
        })

        it('escapes a line start that white space hid', () => {
            expect(quoteOf('\n  # heading')).toBe('> \\# heading')
        })

        it.each([
            [
                'writes a web address in angle brackets with no escapes',
                'See https://en.wikipedia.org/wiki/Foo_(bar)#History_of_foo for more_text.',
                'See <https://en.wikipedia.org/wiki/Foo_(bar)#History_of_foo> for more\\_text.',
            ],
            [
                'keeps the punctuation of the sentence out of the address',
                'Two (http://example.com/a_b), https://example.com/c_d. "https://example.com/e_f"!',
                'Two (<http://example.com/a_b>), <https://example.com/c_d>. "<https://example.com/e_f>"!',
            ],
            [
                'writes an address with capital letters in angle brackets',
                'HTTPS://EXAMPLE.COM/A_B and Http://Example.com/_c_.',
                '<HTTPS://EXAMPLE.COM/A_B> and <Http://Example.com/_c>\\_.',
            ],
            [
                'escapes an address that starts with "www." as plain text that is not a link',
                'At www.example.com/~me/some_page#part_2, WWW.Example.com/a*b[c], then a_b',
                'At www\\.example.com/\\~me/some\\_page\\#part\\_2, WWW\\.Example.com/a\\*b\\[c\\], then a\\_b',
            ],
            [
                'escapes underscores that make emphasis in an address that starts with "www."',
                'www.example.com/_foo_/bar and www.example.com/__init__.py',
                'www\\.example.com/\\_foo\\_/bar and www\\.example.com/\\_\\_init\\_\\_.py',
            ],
            [
                'escapes an HTML entity at the end of an address that starts with "www."',
                'See www.example.com/?a=1&amp; and www.example.com/b&#35;.',
                'See www\\.example.com/?a=1\\&amp; and www\\.example.com/b\\&\\#35;.',
            ],
            [
                'escapes an address with an HTML entity as plain text that is not a link',
                'https://example.com/?a=1&amp;b_c=2',
                'https\\://example.com/?a=1\\&amp;b\\_c=2',
            ],
            [
                'keeps an entity that the sentence punctuation completes out of the address',
                'https://example.com/?a=1&amp;',
                '<https://example.com/?a=1&amp>;',
            ],
            [
                'does not read a protocol with no host as an address',
                'http:// and https://_x_ and www. and www._y_',
                'http\\:// and https\\://\\_x\\_ and www. and www\\.\\_y\\_',
            ],
            [
                'does not read the middle of a word as an address',
                'xhttps://example.com/a_b and awww.example.com/c_d. "Awww..."',
                'xhttps\\://example.com/a\\_b and awww.example.com/c\\_d. "Awww..."',
            ],
            [
                'reads "www." after punctuation as the start of an address',
                '(www.example.com/a_b), _www.example.com_ and www.www.example.com',
                '(www\\.example.com/a\\_b), \\_www\\.example.com\\_ and www\\.www.example.com',
            ],
            [
                'escapes the address of a protocol that is not for the web',
                'ftp://example.com/_a_/b',
                'ftp\\://example.com/\\_a\\_/b',
            ],
        ])('%s', (_name, text, expected) => {
            expect(quoteOf(text)).toBe(`> ${expected}`)
        })

        it('escapes the title, the author and the chapter titles', () => {
            const output = highlightsToMarkdown({
                book: { title: 'C# in *Depth* #', author: 'J_Skeet [ed.]' },
                highlights: [makeHighlight({ chapterTitle: '1. The `var` <keyword>' })],
            })

            expect(output).toBe(
                [
                    '# C\\# in \\*Depth\\* \\#',
                    '',
                    'Author: J\\_Skeet \\[ed.\\]',
                    '',
                    '## 1. The \\`var\\` \\<keyword>',
                    '',
                    '> Some words.',
                    '',
                ].join('\n'),
            )
        })

        it('keeps a note as the user typed it, on one line', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [makeHighlight({ note: ' See [[Other note]]\n#idea  *important* ' })],
            })

            expect(output).toContain(
                '> Some words.\n\nNote: See [[Other note]] #idea *important*\n',
            )
        })

        it('does not let a note put HTML into the document', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [
                    makeHighlight({ note: 'Use <textarea> or <details open>, <!-- and a < b' }),
                    makeHighlight({ text: 'The next highlight.' }),
                ],
            })

            expect(output).toContain(
                'Note: Use \\<textarea> or \\<details open>, \\<!-- and a \\< b\n\n> The next highlight.\n',
            )
        })

        it.each([
            ['an escape that the user typed', 'a \\<b> tag', 'a \\<b> tag'],
            ['a backslash that the user escaped', 'a \\\\<b> tag', 'a \\\\\\<b> tag'],
            ['three backslashes', 'a \\\\\\<b> tag', 'a \\\\\\<b> tag'],
        ])('keeps the less-than sign of a note as text after %s', (_name, note, expected) => {
            const output = highlightsToMarkdown({ book, highlights: [makeHighlight({ note })] })

            expect(output).toContain(`Note: ${expected}\n`)
        })

        it('writes a note with a very long run of backslashes in a short time', () => {
            // A pattern that tries each backslash as a start needs minutes for this note.
            const note = `${'\\'.repeat(200_000)} and <b>`
            const start = performance.now()

            const output = highlightsToMarkdown({ book, highlights: [makeHighlight({ note })] })

            expect(output).toContain(`Note: ${'\\'.repeat(200_000)} and \\<b>\n`)
            expect(performance.now() - start).toBeLessThan(1000)
        })

        it('writes a note with no quote for a highlight with empty text', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [makeHighlight({ text: ' ', note: 'Only a note' })],
            })

            expect(output).toContain('## Chapter\n\nNote: Only a note\n')
            expect(output).not.toContain('>')
        })
    })

    describe('bookmarks', () => {
        it('has no bookmarks section when the list is empty or not given', () => {
            const highlights = [makeHighlight()]

            expect(highlightsToMarkdown({ book, highlights, bookmarks: [] })).not.toContain(
                'Bookmarks',
            )
            expect(highlightsToMarkdown({ book, highlights })).not.toContain('Bookmarks')
        })

        it('writes the bookmarks section for a book with no highlights', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [],
                bookmarks: [makeBookmark()],
            })

            expect(output).toBe(
                [
                    '# The Elements of Style',
                    '',
                    'Author: William Strunk Jr.',
                    '',
                    '## Bookmarks',
                    '',
                    '- Chapter, 10%: *The first words*',
                    '',
                ].join('\n'),
            )
        })

        it.each([
            [0, '0%'],
            [0.004, '0%'],
            [0.005, '1%'],
            [0.5, '50%'],
            [0.994, '99%'],
            [0.999, '100%'],
            [1, '100%'],
            [7, '100%'],
            [-1, '0%'],
            [Number.NaN, '0%'],
        ])('writes the fraction %s as %s', (fraction, percent) => {
            const output = highlightsToMarkdown({
                book,
                highlights: [],
                bookmarks: [makeBookmark({ fraction })],
            })

            expect(output).toContain(`- Chapter, ${percent}: *The first words*\n`)
        })

        it('leaves out an empty chapter title and an empty excerpt', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [],
                bookmarks: [
                    makeBookmark({ chapterTitle: '', fraction: 0.2 }),
                    makeBookmark({ excerpt: ' ', fraction: 0.3 }),
                    makeBookmark({ chapterTitle: '', excerpt: '', fraction: 0.4 }),
                ],
            })

            expect(output).toContain('- 20%: *The first words*\n- Chapter, 30%\n- 40%\n')
        })

        it('escapes the chapter title and the excerpt, and collapses their white space', () => {
            const output = highlightsToMarkdown({
                book,
                highlights: [],
                bookmarks: [
                    makeBookmark({
                        chapterTitle: '1. The *first*\nchapter',
                        excerpt: '  "Call me_Ishmael"  * he said\n',
                    }),
                    makeBookmark({ chapterTitle: '- Dash', excerpt: '# number' }),
                ],
            })

            expect(output).toContain(
                [
                    '- 1\\. The \\*first\\* chapter, 10%: *"Call me\\_Ishmael" \\* he said*',
                    '- \\- Dash, 10%: *\\# number*',
                    '',
                ].join('\n'),
            )
        })
    })
})
