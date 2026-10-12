import { describe, expect, it } from 'vitest'
import { findChapter } from './chapters'
import {
    CHAPTER_1,
    CHAPTER_2,
    CHAPTER_3,
    COVER,
    NOTES,
    PLATE,
    makeFakeSession,
} from './testing/fixtures'

interface Search {
    from: number
    step?: 1 | -1
    acceptFirst?: boolean
}

function search({ from, step = 1, acceptFirst = false }: Search) {
    const { session, loadText } = makeFakeSession()
    const result = findChapter({
        content: session.content,
        spine: session.book.spine,
        from,
        step,
        acceptFirst,
    })
    return { result, loadText }
}

describe('findChapter', () => {
    it('gives the words and blocks of a chapter that has words', async () => {
        const chapter = await search({ from: CHAPTER_1 }).result
        expect(chapter?.spineIndex).toBe(CHAPTER_1)
        expect(chapter?.words.map((word) => word.text)).toEqual([
            'Chapter',
            'One',
            'Alpha',
            'beta',
            'gamma.',
            'Delta',
            'epsilon',
            'zeta.',
        ])
        expect(chapter?.blocks).toEqual([
            { start: 0, end: 11, heading: true },
            { start: 12, end: 49, heading: false },
        ])
    })

    it('goes past a chapter with no words', async () => {
        expect((await search({ from: COVER }).result)?.spineIndex).toBe(CHAPTER_1)
    })

    it('goes past an item that is not linear, and does not load it', async () => {
        const { result, loadText } = search({ from: NOTES })
        expect((await result)?.spineIndex).toBe(CHAPTER_3)
        expect(loadText.mock.calls.map(([index]) => index)).toEqual([PLATE, CHAPTER_3])
    })

    it('takes the first item when it is not linear and the caller accepts it', async () => {
        expect((await search({ from: NOTES, acceptFirst: true }).result)?.spineIndex).toBe(NOTES)
    })

    it('searches to the start of the book', async () => {
        expect((await search({ from: PLATE, step: -1 }).result)?.spineIndex).toBe(CHAPTER_2)
        expect(await search({ from: COVER, step: -1 }).result).toBeNull()
    })

    it('gives null after the last chapter and for an index that is not in the spine', async () => {
        expect(await search({ from: CHAPTER_3 + 1 }).result).toBeNull()
        expect(await search({ from: -1 }).result).toBeNull()
        expect(await search({ from: Number.NaN }).result).toBeNull()
    })

    it('rejects when a chapter does not load', async () => {
        const { session, loadText } = makeFakeSession()
        loadText.mockRejectedValueOnce(new Error('broken'))
        await expect(
            findChapter({
                content: session.content,
                spine: session.book.spine,
                from: CHAPTER_1,
                step: 1,
            }),
        ).rejects.toThrow('broken')
    })
})
