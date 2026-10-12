import { describe, expect, it } from 'vitest'
import type { TextBlock } from '$lib/content/types'
import { collapseWhitespace, leadingExcerpt, matchExcerpt } from './excerpt'

/** A text model of paragraphs with the given text between them. */
function modelOf(paragraphs: string[], separator = '\n') {
    const blocks: TextBlock[] = []
    let text = ''
    for (const paragraph of paragraphs) {
        if (blocks.length > 0) text += separator
        blocks.push({ start: text.length, end: text.length + paragraph.length, heading: false })
        text += paragraph
    }
    return { text, blocks }
}

function excerptOf(model: { text: string; blocks: TextBlock[] }, word: string) {
    const start = model.text.indexOf(word)
    return matchExcerpt({ model, start, end: start + word.length })
}

const SENTENCE =
    'The quick brown fox jumps over the lazy dog while the old cat sleeps under the warm afternoon sun near the garden wall and dreams.'

describe('collapseWhitespace', () => {
    it('makes one space from each run of white space', () => {
        expect(collapseWhitespace('a \n\t b  c')).toBe('a b c')
    })
})

describe('matchExcerpt', () => {
    it('gives the match position inside the excerpt', () => {
        const model = modelOf([SENTENCE])
        const result = excerptOf(model, 'cat')
        expect(result.excerpt.slice(result.matchStart, result.matchEnd)).toBe('cat')
        expect(result.excerpt).toContain('the old cat sleeps')
    })

    it('has about 40 characters before and 60 after, cut at word ends', () => {
        const model = modelOf([SENTENCE])
        const { excerpt, matchStart, matchEnd } = excerptOf(model, 'cat')
        const before = excerpt.slice(0, matchStart)
        const after = excerpt.slice(matchEnd)

        expect(before.length).toBeGreaterThan(25)
        expect(before.length).toBeLessThanOrEqual(40)
        expect(after.length).toBeGreaterThan(45)
        expect(after.length).toBeLessThanOrEqual(60)
        // Each end is at a word of the text, not inside one.
        const words = SENTENCE.split(' ')
        expect(words).toContain(excerpt.split(' ')[0])
        expect(words).toContain(excerpt.split(' ').at(-1))
        expect(SENTENCE).toContain(excerpt)
        expect(excerpt).toBe(excerpt.trim())
    })

    it('keeps a word that starts exactly at the window', () => {
        // The window starts 40 characters before the match, at the start of a word.
        const text = 'zz ' + 'abcdefghi '.repeat(4) + 'MATCH tail'
        const start = text.indexOf('MATCH')
        const { excerpt, matchStart } = matchExcerpt({
            model: { text, blocks: [] },
            start,
            end: start + 5,
        })
        expect(excerpt.slice(0, matchStart)).toBe('abcdefghi '.repeat(4))
    })

    it('does not cut at the start and the end of the chapter', () => {
        const model = modelOf(['Short text with a match in it.'])
        const result = excerptOf(model, 'match')
        expect(result.excerpt).toBe('Short text with a match in it.')
        expect(result.matchStart).toBe(18)
        expect(result.matchEnd).toBe(23)
    })

    it('gives a match at the chapter start and at the chapter end', () => {
        const model = modelOf(['Alpha beta gamma'])
        expect(excerptOf(model, 'Alpha')).toEqual({
            excerpt: 'Alpha beta gamma',
            matchStart: 0,
            matchEnd: 5,
        })
        expect(excerptOf(model, 'gamma')).toEqual({
            excerpt: 'Alpha beta gamma',
            matchStart: 11,
            matchEnd: 16,
        })
    })

    it('collapses white space and keeps the match position right', () => {
        const text = 'one  \n\n   two \t three\n\n\n     four    five'
        const start = text.indexOf('three')
        const result = matchExcerpt({ model: { text, blocks: [] }, start, end: start + 5 })
        expect(result.excerpt).toBe('one two three four five')
        expect(result.excerpt.slice(result.matchStart, result.matchEnd)).toBe('three')
    })

    it('collapses white space inside a match of two words', () => {
        const text = 'see the lazy \n   dog run'
        const start = text.indexOf('lazy')
        const end = text.indexOf('dog') + 3
        const result = matchExcerpt({ model: { text, blocks: [] }, start, end })
        expect(result.excerpt).toBe('see the lazy dog run')
        expect(result.excerpt.slice(result.matchStart, result.matchEnd)).toBe('lazy dog')
    })

    it('puts a space between two paragraphs that have no white space between them', () => {
        const model = modelOf(['It was the end.', 'Next came the match word.', 'After it.'], '')
        expect(model.text).toContain('end.Next')
        const result = excerptOf(model, 'match')
        expect(result.excerpt).toBe('It was the end. Next came the match word. After it.')
        expect(result.excerpt.slice(result.matchStart, result.matchEnd)).toBe('match')
    })

    it('puts a space before a match that starts a paragraph', () => {
        const model = modelOf(['It was the end.', 'Match came next.', 'After it.'], '')
        const result = excerptOf(model, 'Match')
        expect(result.excerpt).toBe('It was the end. Match came next. After it.')
        expect(result.excerpt.slice(result.matchStart, result.matchEnd)).toBe('Match')
    })

    it('puts a space after a match that ends a paragraph', () => {
        const model = modelOf(['It was the end.', 'Next came the match', 'After it.'], '')
        const result = excerptOf(model, 'match')
        expect(result.excerpt).toBe('It was the end. Next came the match After it.')
        expect(result.excerpt.slice(result.matchStart, result.matchEnd)).toBe('match')
    })

    it('keeps the first word of a paragraph that starts exactly at the window', () => {
        const second = 'Alpha beta gamma delta epsilon zeta eta match'
        const model = modelOf(['A first paragraph.', second], '')
        const start = model.text.indexOf('match')
        // The window of 40 characters starts at the first character of the second paragraph.
        expect(start - 40).toBe(model.blocks[1].start)
        const result = matchExcerpt({ model, start, end: start + 5 })
        expect(result.excerpt).toBe(second)
    })

    it('keeps the last word of a paragraph that ends exactly at the window', () => {
        const first = 'match and then some more words come here until the paragraph end.'
        const model = modelOf([first, 'A second paragraph.'], '')
        // The window of 60 characters ends at the last character of the first paragraph.
        expect(5 + 60).toBe(model.blocks[0].end)
        const result = matchExcerpt({ model, start: 0, end: 5 })
        expect(result.excerpt).toBe(first)
    })

    it('does not add a second space when the paragraphs have white space between them', () => {
        const model = modelOf(['First one.', 'Second match here.', 'Third.'], '\n    ')
        expect(excerptOf(model, 'match').excerpt).toBe('First one. Second match here. Third.')
    })

    it('cuts text with no white space at the window', () => {
        const text = '日'.repeat(100) + '本' + '語'.repeat(100)
        const result = matchExcerpt({ model: { text, blocks: [] }, start: 100, end: 101 })
        expect(result.matchStart).toBe(40)
        expect(result.matchEnd).toBe(41)
        expect(result.excerpt).toHaveLength(101)
    })

    it('does not cut a character that has two code units', () => {
        const face = '\u{1F600}'
        const even = face.repeat(30) + 'x' + face.repeat(40)
        const start = even.indexOf('x')
        expect(
            matchExcerpt({ model: { text: even, blocks: [] }, start, end: start + 1 }).excerpt,
        ).toBe(face.repeat(20) + 'x' + face.repeat(30))

        // One more character on each side puts both ends of the window inside a pair.
        const odd = face.repeat(30) + 'yxz' + face.repeat(40)
        const result = matchExcerpt({
            model: { text: odd, blocks: [] },
            start: start + 1,
            end: start + 2,
        })
        expect(result.excerpt).toBe(face.repeat(19) + 'yxz' + face.repeat(29))
        expect(result.excerpt.slice(result.matchStart, result.matchEnd)).toBe('x')
    })
})

describe('leadingExcerpt', () => {
    it('gives the whole text when it is short', () => {
        const model = modelOf(['A short chapter.'])
        expect(leadingExcerpt({ model, offset: 0 })).toBe('A short chapter.')
        expect(leadingExcerpt({ model, offset: 2 })).toBe('short chapter.')
    })

    it('gives 120 characters at most and cuts at a word end', () => {
        const model = modelOf([SENTENCE + ' ' + SENTENCE])
        const excerpt = leadingExcerpt({ model, offset: 4 })
        expect(excerpt.length).toBeLessThanOrEqual(120)
        expect(excerpt.length).toBeGreaterThan(100)
        expect(excerpt.startsWith('quick brown fox')).toBe(true)
        expect(model.text.slice(4)).toContain(excerpt)
        // The character after the excerpt is the space after a full word.
        expect(model.text[4 + excerpt.length]).toBe(' ')
    })

    it('keeps the last word when the limit is exactly at its end', () => {
        const text = 'ab '.repeat(39) + 'abc next words follow here'
        expect(text.indexOf(' next')).toBe(120)
        const excerpt = leadingExcerpt({ model: { text, blocks: [] }, offset: 0 })
        expect(excerpt).toHaveLength(120)
        expect(excerpt.endsWith(' abc')).toBe(true)
    })

    it('collapses white space and starts at the first word', () => {
        const text = '   \n\n  Chapter   One\n\n\n      It was a   dark night.  '
        expect(leadingExcerpt({ model: { text, blocks: [] }, offset: 0 })).toBe(
            'Chapter One It was a dark night.',
        )
    })

    it('puts a space between a heading and a paragraph that touch', () => {
        const model = modelOf(['Chapter One', 'It was a dark night.'], '')
        expect(leadingExcerpt({ model, offset: 0 })).toBe('Chapter One It was a dark night.')
    })

    it('uses a different limit', () => {
        const model = modelOf([SENTENCE])
        expect(leadingExcerpt({ model, offset: 0, maxLength: 12 })).toBe('The quick')
        expect(leadingExcerpt({ model, offset: 0, maxLength: 9 })).toBe('The quick')
    })

    it('cuts a text with no white space at the limit', () => {
        const text = '日'.repeat(300)
        expect(leadingExcerpt({ model: { text, blocks: [] }, offset: 10 })).toHaveLength(120)
        // The limit is inside a character that has two code units.
        const pairs = '\u{1F600}'.repeat(100)
        const excerpt = leadingExcerpt({ model: { text: 'a' + pairs, blocks: [] }, offset: 0 })
        expect(excerpt).toBe('a' + '\u{1F600}'.repeat(59))
    })

    it('gives an empty text at the chapter end and for a chapter with no text', () => {
        const model = modelOf(['Some words.'])
        expect(leadingExcerpt({ model, offset: model.text.length })).toBe('')
        expect(leadingExcerpt({ model, offset: 9999 })).toBe('')
        expect(leadingExcerpt({ model: { text: '', blocks: [] }, offset: 0 })).toBe('')
        expect(leadingExcerpt({ model: { text: ' \n ', blocks: [] }, offset: 0 })).toBe('')
    })

    it('reads an offset that is not valid as the chapter start', () => {
        const model = modelOf(['Some words.'])
        expect(leadingExcerpt({ model, offset: -5 })).toBe('Some words.')
        expect(leadingExcerpt({ model, offset: Number.NaN })).toBe('Some words.')
    })
})
