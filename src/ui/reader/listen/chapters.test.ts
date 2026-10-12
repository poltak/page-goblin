import { describe, expect, it } from 'vitest'
import type { Sentence } from '$lib/content'
import {
    findSpeechChapter,
    hasSentenceAfter,
    nextLinearIndex,
    sentenceAt,
    sentencesFrom,
} from './chapters'
import { createFakeSession } from './testing/fake-session'

const SENTENCES: Sentence[] = [
    { start: 0, end: 4, block: 0 },
    { start: 5, end: 9, block: 0 },
    { start: 10, end: 16, block: 0 },
]

describe('nextLinearIndex', () => {
    const { book } = createFakeSession({
        chapters: ['a', { text: 'b', linear: false }, { text: 'c', linear: false }, 'd'],
    })

    it('skips the items that are not linear', () => {
        expect(nextLinearIndex(book, 0)).toBe(3)
        expect(nextLinearIndex(book, 1)).toBe(3)
    })

    it('gives -1 at the end of the book', () => {
        expect(nextLinearIndex(book, 3)).toBe(-1)
        expect(nextLinearIndex(book, 9)).toBe(-1)
    })
})

describe('hasSentenceAfter', () => {
    it('is true while a sentence ends after the offset', () => {
        expect(hasSentenceAfter(SENTENCES, 0)).toBe(true)
        expect(hasSentenceAfter(SENTENCES, 15)).toBe(true)
        expect(hasSentenceAfter(SENTENCES, 16)).toBe(false)
        expect(hasSentenceAfter([], 0)).toBe(false)
    })
})

describe('sentencesFrom', () => {
    //            0         1         2
    //            0123456789012345678901234567
    const text = 'One two three. Four five six.'
    const sentences: Sentence[] = [
        { start: 0, end: 14, block: 0 },
        { start: 15, end: 29, block: 0 },
    ]

    it('gives the same list for an offset at the start of a sentence or between two', () => {
        expect(sentencesFrom({ text, sentences, offset: 0 })).toBe(sentences)
        expect(sentencesFrom({ text, sentences, offset: 15 })).toBe(sentences)
        expect(sentencesFrom({ text, sentences, offset: 14 })).toBe(sentences)
        expect(sentencesFrom({ text, sentences, offset: 99 })).toBe(sentences)
    })

    it('starts the sentence of the offset at the offset', () => {
        const cut = sentencesFrom({ text, sentences, offset: 4 })
        expect(cut).toEqual([{ start: 4, end: 14, block: 0 }, sentences[1]])
        // The list of the chapter stays as it is.
        expect(sentences[0].start).toBe(0)
    })

    it('goes back to the start of the word when the offset is inside a word', () => {
        // The offset 21 is inside 'five'.
        expect(sentencesFrom({ text, sentences, offset: 21, wholeWord: true })[1].start).toBe(20)
        expect(sentencesFrom({ text, sentences, offset: 21 })[1].start).toBe(21)
        // The offset 17 is inside the first word of the sentence.
        expect(sentencesFrom({ text, sentences, offset: 17, wholeWord: true })).toBe(sentences)
    })

    it('keeps the offset in text that has no spaces', () => {
        const long = 'x'.repeat(100)
        const one: Sentence[] = [{ start: 0, end: 100, block: 0 }]
        expect(sentencesFrom({ text: long, sentences: one, offset: 60, wholeWord: true })).toEqual([
            { start: 60, end: 100, block: 0 },
        ])
    })
})

describe('sentenceAt', () => {
    it('gives the sentence that has the offset, or the next one', () => {
        expect(sentenceAt(SENTENCES, 0)).toBe(SENTENCES[0])
        expect(sentenceAt(SENTENCES, 3)).toBe(SENTENCES[0])
        // Between two sentences.
        expect(sentenceAt(SENTENCES, 4)).toBe(SENTENCES[1])
        expect(sentenceAt(SENTENCES, 12)).toBe(SENTENCES[2])
    })

    it('gives null after the last sentence', () => {
        expect(sentenceAt(SENTENCES, 16)).toBeNull()
        expect(sentenceAt([], 0)).toBeNull()
    })
})

describe('findSpeechChapter', () => {
    it('gives the text, the sentences and the language of the chapter', async () => {
        const { book, content } = createFakeSession({
            chapters: [{ text: 'One. Two.', lang: 'en-GB' }],
        })
        const chapter = await findSpeechChapter({
            book,
            content,
            from: { spineIndex: 0, offset: 5 },
        })
        expect(chapter).toEqual({
            spineIndex: 0,
            text: 'One. Two.',
            sentences: [
                { start: 0, end: 4, block: 0 },
                { start: 5, end: 9, block: 0 },
            ],
            lang: 'en-GB',
            offset: 5,
        })
    })

    it('uses the book language when the chapter does not load in full', async () => {
        const { book, content } = createFakeSession({ chapters: ['One.'], language: 'ENG' })
        content.load.mockRejectedValue(new Error('no'))
        const chapter = await findSpeechChapter({
            book,
            content,
            from: { spineIndex: 0, offset: 0 },
        })
        expect(chapter?.lang).toBe('en')
    })

    it('gives null as the language when the book has none', async () => {
        const { book, content } = createFakeSession({ chapters: ['One.'], language: null })
        const chapter = await findSpeechChapter({
            book,
            content,
            from: { spineIndex: 0, offset: 0 },
        })
        expect(chapter?.lang).toBeNull()
        expect(chapter?.sentences).toHaveLength(1)
    })

    it('goes to the next linear chapter when no sentence is after the offset', async () => {
        const { book, content } = createFakeSession({
            chapters: ['One.', ' \n ', { text: 'Note.', linear: false }, 'Four.'],
        })
        const chapter = await findSpeechChapter({
            book,
            content,
            from: { spineIndex: 0, offset: 4 },
        })
        expect(chapter?.spineIndex).toBe(3)
        expect(chapter?.offset).toBe(0)
        // Only the chapter with text gets a full load.
        expect(content.load.mock.calls).toEqual([[3]])
    })

    it('speaks a start chapter that is not linear', async () => {
        const { book, content } = createFakeSession({
            chapters: ['One.', { text: 'Note.', linear: false }],
        })
        const chapter = await findSpeechChapter({
            book,
            content,
            from: { spineIndex: 1, offset: 0 },
        })
        expect(chapter?.spineIndex).toBe(1)
    })

    it('skips a chapter that does not load', async () => {
        const { book, content } = createFakeSession({ chapters: ['One.', 'Two.'] })
        content.loadText.mockRejectedValueOnce(new Error('damaged'))
        const chapter = await findSpeechChapter({
            book,
            content,
            from: { spineIndex: 0, offset: 0 },
        })
        expect(chapter?.spineIndex).toBe(1)
    })

    it('gives null at the end of the book and for an index that the book does not have', async () => {
        const { book, content } = createFakeSession({ chapters: ['One.', ''] })
        expect(
            await findSpeechChapter({ book, content, from: { spineIndex: 0, offset: 4 } }),
        ).toBeNull()
        expect(
            await findSpeechChapter({ book, content, from: { spineIndex: 7, offset: 0 } }),
        ).toBeNull()
        expect(
            await findSpeechChapter({ book, content, from: { spineIndex: -1, offset: 0 } }),
        ).toBeNull()
    })

    it('takes an offset that is not a number as the start of the chapter', async () => {
        const { book, content } = createFakeSession({ chapters: ['One.'] })
        const chapter = await findSpeechChapter({
            book,
            content,
            from: { spineIndex: 0, offset: Number.NaN },
        })
        expect(chapter?.offset).toBe(0)
    })

    it('stops when the search is not current', async () => {
        const { book, content } = createFakeSession({ chapters: ['', '', 'Three.'] })
        let current = true
        content.loadText.mockImplementationOnce(async () => {
            current = false
            return { text: '', blocks: [] }
        })
        const chapter = await findSpeechChapter({
            book,
            content,
            from: { spineIndex: 0, offset: 0 },
            isCurrent: () => current,
        })
        expect(chapter).toBeNull()
        expect(content.loadText).toHaveBeenCalledTimes(1)
    })
})
