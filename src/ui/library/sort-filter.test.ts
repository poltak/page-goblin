import { describe, expect, it } from 'vitest'
import {
    compareBooks,
    filterBooks,
    insertIndex,
    matchesSearch,
    normalizeText,
    recentTime,
    searchKey,
    searchWords,
    sortBooks,
} from './sort-filter'
import type { SortableBook } from './sort-filter'

function book(id: string, changes: Partial<SortableBook> = {}): SortableBook {
    return {
        id,
        title: `Title ${id}`,
        author: 'Author',
        addedAt: 0,
        lastOpenedAt: null,
        ...changes,
    }
}

const ids = (books: readonly SortableBook[]) => books.map((item) => item.id)

describe('recentTime', () => {
    it('is the time of the import for a book that was never opened', () => {
        expect(recentTime({ addedAt: 500, lastOpenedAt: null })).toBe(500)
    })

    it('is the later of the last open and the import', () => {
        expect(recentTime({ addedAt: 500, lastOpenedAt: 900 })).toBe(900)
        // A backup restore or a clock change can give an older open time.
        expect(recentTime({ addedAt: 500, lastOpenedAt: 100 })).toBe(500)
    })
})

describe('sortBooks', () => {
    const books = [
        book('a', { title: 'Middlemarch', author: 'George Eliot', addedAt: 100 }),
        book('b', { title: 'Anna Karenina', author: 'Leo Tolstoy', addedAt: 300 }),
        book('c', { title: 'Zuleika Dobson', author: 'Max Beerbohm', addedAt: 200 }),
        book('d', {
            title: 'emma',
            author: 'Jane Austen',
            addedAt: 50,
            lastOpenedAt: 1000,
        }),
    ]

    it('sorts "recent" by the later of the last open and the import, newest first', () => {
        expect(ids(sortBooks(books, 'recent'))).toEqual(['d', 'b', 'c', 'a'])
    })

    it('sorts "added" by the import time, newest first', () => {
        expect(ids(sortBooks(books, 'added'))).toEqual(['b', 'c', 'a', 'd'])
    })

    it('sorts "title" with no difference between upper and lower case', () => {
        expect(ids(sortBooks(books, 'title'))).toEqual(['b', 'd', 'a', 'c'])
    })

    it('sorts "author" by the author, then by the title', () => {
        const more = [...books, book('e', { title: 'Adam Bede', author: 'George Eliot' })]
        expect(ids(sortBooks(more, 'author'))).toEqual(['e', 'a', 'd', 'b', 'c'])
    })

    it('ignores accents and sorts numbers by value in titles', () => {
        const list = [
            book('1', { title: 'Book 10' }),
            book('2', { title: 'Book 2' }),
            book('3', { title: 'Élan' }),
            book('4', { title: 'Eland' }),
            book('5', { title: 'Ebb' }),
        ]
        expect(ids(sortBooks(list, 'title'))).toEqual(['2', '1', '5', '3', '4'])
    })

    it('does not change the input', () => {
        const before = ids(books)
        sortBooks(books, 'title')
        expect(ids(books)).toEqual(before)
    })

    it('keeps a fixed order for books with equal keys', () => {
        const twins = [book('z', { title: 'Same' }), book('y', { title: 'Same' })]
        for (const sort of ['recent', 'added', 'title', 'author'] as const) {
            expect(ids(sortBooks(twins, sort))).toEqual(['y', 'z'])
            expect(ids(sortBooks([...twins].reverse(), sort))).toEqual(['y', 'z'])
        }
    })

    it('uses the "recent" order for a sort value that is not known', () => {
        const compare = compareBooks('unknown' as never)
        expect(ids([...books].sort(compare))).toEqual(['d', 'b', 'c', 'a'])
    })
})

describe('insertIndex', () => {
    const sorted = sortBooks(
        [
            book('a', { title: 'Alpha', addedAt: 300 }),
            book('c', { title: 'Charlie', addedAt: 200 }),
            book('e', { title: 'Echo', addedAt: 100 }),
        ],
        'title',
    )

    it('finds the place of a new book in a sorted list', () => {
        expect(insertIndex(sorted, book('b', { title: 'Bravo' }), 'title')).toBe(1)
        expect(insertIndex(sorted, book('0', { title: 'Aardvark' }), 'title')).toBe(0)
        expect(insertIndex(sorted, book('z', { title: 'Zulu' }), 'title')).toBe(3)
    })

    it('puts a new book first in the "recent" order', () => {
        const recent = sortBooks(sorted, 'recent')
        expect(insertIndex(recent, book('n', { addedAt: 999 }), 'recent')).toBe(0)
    })

    it('gives 0 for an empty list', () => {
        expect(insertIndex([], book('a'), 'recent')).toBe(0)
    })

    it('gives the same order as a full sort', () => {
        const all = [
            book('1', { title: 'Delta', addedAt: 5 }),
            book('2', { title: 'alpha', addedAt: 9 }),
            book('3', { title: 'Charlie', addedAt: 1, lastOpenedAt: 20 }),
            book('4', { title: 'Bravo', addedAt: 7 }),
            book('5', { title: 'Echo', addedAt: 3 }),
        ]
        for (const sort of ['recent', 'added', 'title', 'author'] as const) {
            const built: SortableBook[] = []
            for (const item of all) built.splice(insertIndex(built, item, sort), 0, item)
            expect(ids(built)).toEqual(ids(sortBooks(all, sort)))
        }
    })
})

describe('search', () => {
    it('removes accents and case', () => {
        expect(normalizeText('Émile ZOLA')).toBe('emile zola')
        expect(normalizeText('Dvořák')).toBe('dvorak')
    })

    it('reads composed and decomposed accents as the same text', () => {
        expect(normalizeText('é')).toBe(normalizeText('é'))
    })

    it('splits a search into words', () => {
        expect(searchWords('  Anna   Tolstoy ')).toEqual(['anna', 'tolstoy'])
        expect(searchWords('')).toEqual([])
        expect(searchWords('   ')).toEqual([])
    })

    it('makes one key from the title and the author', () => {
        expect(searchKey({ title: 'Les Misérables', author: 'Victor Hugo' })).toBe(
            'les miserables victor hugo',
        )
    })

    it('matches when the key has all words, in any order', () => {
        const key = searchKey({ title: 'Anna Karenina', author: 'Leo Tolstoy' })
        expect(matchesSearch(key, searchWords('anna'))).toBe(true)
        expect(matchesSearch(key, searchWords('tolstoy ANNA'))).toBe(true)
        expect(matchesSearch(key, searchWords('kare tols'))).toBe(true)
        expect(matchesSearch(key, searchWords('anna dickens'))).toBe(false)
    })

    it('matches each key when the search is empty', () => {
        expect(matchesSearch('anything', [])).toBe(true)
    })

    it('filters by title and author with no accents and no case', () => {
        const books = [
            { title: 'Les Misérables', author: 'Victor Hugo' },
            { title: 'Germinal', author: 'Émile Zola' },
            { title: 'Hard Times', author: 'Charles Dickens' },
        ]
        expect(filterBooks(books, 'miserables')).toEqual([books[0]])
        expect(filterBooks(books, 'EMILE')).toEqual([books[1]])
        expect(filterBooks(books, 'zola germinal')).toEqual([books[1]])
        expect(filterBooks(books, 'é')).toEqual([books[0], books[1], books[2]])
        expect(filterBooks(books, 'tolstoy')).toEqual([])
        expect(filterBooks(books, '  ')).toEqual(books)
    })

    it('reads a search with HTML characters as plain text', () => {
        const books = [{ title: '<b>Bold</b> & more', author: 'A' }]
        expect(filterBooks(books, '<b>bold')).toEqual(books)
    })
})
