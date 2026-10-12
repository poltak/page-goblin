import { Blob as NodeBlob } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLibraryStorage } from '$lib/storage'
import type {
    BookmarkRecord,
    BookRecord,
    HighlightRecord,
    LibraryStorage,
    ProgressRecord,
} from '$lib/storage/types'
import { createBackup, parseBackup, restoreBackup } from './backup'
import type { BackupBook, BackupFile } from './types'

const NOT_A_BACKUP = 'This file is not a Web eReader backup.'
const EXPORTED_AT = '2024-03-05T14:03:09.000Z'

/** A text of 64 hex digits, as a SHA-256 hash has. */
function hashOf(name: string): string {
    return name.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)
}

function makeBook(name: string, changes: Partial<BookRecord> = {}): BookRecord {
    return {
        id: `book-${name}`,
        title: `Title ${name}`,
        author: `Author ${name}`,
        language: 'en',
        identifier: null,
        publisher: null,
        description: null,
        published: null,
        subjects: [],
        series: null,
        fileName: `${name}.epub`,
        fileSize: 3,
        fileHash: hashOf(name),
        hasCover: false,
        spineStats: [
            { chars: 100, words: 20 },
            { chars: 300, words: 60 },
            { chars: 600, words: 120 },
        ],
        totalChars: 1000,
        totalWords: 200,
        addedAt: 1000,
        lastOpenedAt: null,
        ...changes,
    }
}

function makeProgress(bookId: string, changes: Partial<ProgressRecord> = {}): ProgressRecord {
    return {
        bookId,
        locator: { spineIndex: 1, offset: 42 },
        fraction: 0.25,
        updatedAt: 2000,
        ...changes,
    }
}

function makeBookmark(id: string, changes: Partial<BookmarkRecord> = {}): BookmarkRecord {
    return {
        id,
        bookId: 'book-a',
        locator: { spineIndex: 0, offset: 10 },
        fraction: 0.01,
        chapterTitle: 'Chapter 1',
        excerpt: 'The first words',
        createdAt: 3000,
        ...changes,
    }
}

function makeHighlight(id: string, changes: Partial<HighlightRecord> = {}): HighlightRecord {
    return {
        id,
        bookId: 'book-a',
        spineIndex: 1,
        start: 20,
        end: 30,
        text: 'some words',
        color: 'yellow',
        note: '',
        chapterTitle: 'Chapter 2',
        fraction: 0.12,
        createdAt: 4000,
        updatedAt: 4000,
        ...changes,
    }
}

function withoutBookId<T extends { bookId: string }>(record: T): Omit<T, 'bookId'> {
    const { bookId: _bookId, ...rest } = record
    return rest
}

/** The content of a backup file with one book. `book` replaces fields of that book. */
function fileWith(book: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        format: 'web-ereader-backup',
        version: 1,
        exportedAt: EXPORTED_AT,
        books: [
            {
                fileHash: hashOf('a'),
                title: 'Title a',
                author: 'Author a',
                progress: null,
                bookmarks: [],
                highlights: [],
                ...book,
            },
        ],
    }
}

describe('backup', () => {
    let libraries: LibraryStorage[]

    beforeEach(() => {
        // A jsdom Blob does not survive structuredClone, which fake-indexeddb uses to store a
        // value. The Blob of Node does, as a Blob does in a browser.
        vi.stubGlobal('Blob', NodeBlob)
        libraries = []
    })

    afterEach(() => {
        for (const library of libraries) library.close()
        vi.unstubAllGlobals()
    })

    /** A new database with the given books. The book ids start with `idPrefix`. */
    async function openLibrary(names: string[], idPrefix = 'book'): Promise<LibraryStorage> {
        const storage = createLibraryStorage({ indexedDB: new IDBFactory() })
        libraries.push(storage)
        for (const name of names) {
            await storage.addBook({
                record: makeBook(name, { id: `${idPrefix}-${name}` }),
                file: new Blob([`file of ${name}`]),
                cover: null,
            })
        }
        return storage
    }

    /** The positions and annotations of each book by file hash, and a check of each book id. */
    async function contentOf(storage: LibraryStorage): Promise<Record<string, unknown>> {
        const content: Record<string, unknown> = {}
        for (const book of await storage.listBooks()) {
            const progress = await storage.getProgress(book.id)
            const bookmarks = await storage.listBookmarks(book.id)
            const highlights = await storage.listHighlights(book.id)
            for (const record of [...bookmarks, ...highlights]) expect(record.bookId).toBe(book.id)
            content[book.fileHash] = {
                progress: progress ? withoutBookId(progress) : null,
                bookmarks: bookmarks.map(withoutBookId),
                highlights: highlights.map(withoutBookId),
            }
        }
        return content
    }

    /** Books a, b, c and d. Book c has no position and no annotations. */
    async function openFullLibrary(): Promise<LibraryStorage> {
        const storage = await openLibrary(['a', 'b', 'c', 'd'])
        await storage.saveProgress(makeProgress('book-a'))
        await storage.putBookmark(makeBookmark('bm-1'))
        await storage.putBookmark(
            makeBookmark('bm-2', { locator: { spineIndex: 2, offset: 0 }, fraction: 0.4 }),
        )
        await storage.putHighlight(makeHighlight('hl-1'))
        await storage.putHighlight(
            makeHighlight('hl-2', { start: 50, end: 90, color: 'blue', note: 'A note' }),
        )
        await storage.putHighlight(makeHighlight('hl-3', { spineIndex: 2, updatedAt: 4500 }))
        await storage.saveProgress(
            makeProgress('book-b', { locator: { spineIndex: 2, offset: 7 }, fraction: 0.9 }),
        )
        await storage.putHighlight(makeHighlight('hl-4', { bookId: 'book-d', color: 'pink' }))
        return storage
    }

    describe('createBackup', () => {
        it('reads the position, the bookmarks and the highlights of each book', async () => {
            const storage = await openFullLibrary()

            const backup = await createBackup({ storage, now: () => Date.parse(EXPORTED_AT) })

            expect(backup).toEqual({
                format: 'web-ereader-backup',
                version: 1,
                exportedAt: EXPORTED_AT,
                books: [
                    {
                        fileHash: hashOf('a'),
                        title: 'Title a',
                        author: 'Author a',
                        progress: withoutBookId(makeProgress('book-a')),
                        bookmarks: [
                            withoutBookId(makeBookmark('bm-1')),
                            withoutBookId(
                                makeBookmark('bm-2', {
                                    locator: { spineIndex: 2, offset: 0 },
                                    fraction: 0.4,
                                }),
                            ),
                        ],
                        highlights: [
                            withoutBookId(makeHighlight('hl-1')),
                            withoutBookId(
                                makeHighlight('hl-2', {
                                    start: 50,
                                    end: 90,
                                    color: 'blue',
                                    note: 'A note',
                                }),
                            ),
                            withoutBookId(
                                makeHighlight('hl-3', { spineIndex: 2, updatedAt: 4500 }),
                            ),
                        ],
                    },
                    {
                        fileHash: hashOf('b'),
                        title: 'Title b',
                        author: 'Author b',
                        progress: {
                            locator: { spineIndex: 2, offset: 7 },
                            fraction: 0.9,
                            updatedAt: 2000,
                        },
                        bookmarks: [],
                        highlights: [],
                    },
                    {
                        fileHash: hashOf('d'),
                        title: 'Title d',
                        author: 'Author d',
                        progress: null,
                        bookmarks: [],
                        highlights: [
                            withoutBookId(
                                makeHighlight('hl-4', { bookId: 'book-d', color: 'pink' }),
                            ),
                        ],
                    },
                ],
            })
        })

        it('leaves out a book with no position, no bookmark and no highlight', async () => {
            const storage = await openFullLibrary()

            const backup = await createBackup({ storage })

            expect(backup.books.map((book) => book.title)).toEqual([
                'Title a',
                'Title b',
                'Title d',
            ])
        })

        it('gives an empty list for an empty library', async () => {
            const storage = await openLibrary([])

            const backup = await createBackup({ storage, now: () => 0 })

            expect(backup).toEqual({
                format: 'web-ereader-backup',
                version: 1,
                exportedAt: '1970-01-01T00:00:00.000Z',
                books: [],
            })
        })

        it('uses the current time when no clock is given', async () => {
            const storage = await openLibrary([])
            const before = Date.now()

            const backup = await createBackup({ storage })

            const time = Date.parse(backup.exportedAt)
            expect(new Date(time).toISOString()).toBe(backup.exportedAt)
            expect(time).toBeGreaterThanOrEqual(before)
            expect(time).toBeLessThanOrEqual(Date.now())
        })

        it('writes the books in title order', async () => {
            const storage = createLibraryStorage({ indexedDB: new IDBFactory() })
            libraries.push(storage)
            const titles = { a: 'Zebra', b: 'apple', c: 'Mango', d: 'Mango' }
            for (const [name, title] of Object.entries(titles)) {
                const record = makeBook(name, { title })
                await storage.addBook({ record, file: new Blob(['x']), cover: null })
                await storage.saveProgress(makeProgress(record.id))
            }

            const backup = await createBackup({ storage })

            expect(backup.books.map((book) => [book.title, book.fileHash])).toEqual([
                ['Mango', hashOf('c')],
                ['Mango', hashOf('d')],
                ['Zebra', hashOf('a')],
                ['apple', hashOf('b')],
            ])
        })

        it('writes only the fields of the contract', async () => {
            const storage = await openLibrary(['a'])
            const extra = { extra: 'not in the contract' }
            await storage.saveProgress({
                ...makeProgress('book-a'),
                ...extra,
                locator: { spineIndex: 1, offset: 42, ...extra },
            })
            await storage.putBookmark({ ...makeBookmark('bm-1'), ...extra })
            await storage.putHighlight({ ...makeHighlight('hl-1'), ...extra })

            const backup = await createBackup({ storage })

            const text = JSON.stringify(backup)
            expect(text).not.toContain('extra')
            expect(text).not.toContain('bookId')
            expect(text).not.toContain('book-a')
            expect(backup.books[0]).toEqual({
                fileHash: hashOf('a'),
                title: 'Title a',
                author: 'Author a',
                progress: withoutBookId(makeProgress('book-a')),
                bookmarks: [withoutBookId(makeBookmark('bm-1'))],
                highlights: [withoutBookId(makeHighlight('hl-1'))],
            })
        })

        it('puts a fraction that is out of range into the range', async () => {
            const storage = await openLibrary(['a'])
            await storage.saveProgress(makeProgress('book-a', { fraction: 1.0000001 }))
            await storage.putBookmark(makeBookmark('bm-1', { fraction: -0.2 }))
            await storage.putHighlight(makeHighlight('hl-1', { fraction: Number.NaN }))

            const backup = await createBackup({ storage })

            const [book] = backup.books
            expect(book.progress?.fraction).toBe(1)
            expect(book.bookmarks[0].fraction).toBe(0)
            expect(book.highlights[0].fraction).toBe(0)
            expect(parseBackup(JSON.stringify(backup))).toEqual(backup)
        })

        it('gives a file that is the same after JSON text and parseBackup', async () => {
            const storage = await openFullLibrary()

            const backup = await createBackup({ storage })

            expect(parseBackup(JSON.stringify(backup))).toEqual(backup)
            expect(parseBackup(backup)).toEqual(backup)
        })
    })

    describe('round trip', () => {
        it('restores a backup into an empty library that has the same books', async () => {
            const first = await openFullLibrary()
            const second = await openLibrary(['a', 'b', 'c', 'd'], 'other')
            const backup = JSON.stringify(await createBackup({ storage: first }))

            const result = await restoreBackup({ storage: second, backup })

            expect(result).toEqual({
                booksMatched: 3,
                booksMissing: 0,
                bookmarksAdded: 2,
                highlightsAdded: 4,
                highlightsUpdated: 0,
                progressUpdated: 2,
            })
            expect(await contentOf(second)).toEqual(await contentOf(first))
            expect(
                (await second.listHighlights('other-a')).map((highlight) => highlight.id),
            ).toEqual(['hl-1', 'hl-2', 'hl-3'])
            expect(await second.getProgress('other-a')).toEqual(makeProgress('other-a'))
            expect(await second.getProgress('book-a')).toBeUndefined()
        })

        it('changes nothing when the same backup is restored again', async () => {
            const first = await openFullLibrary()
            const second = await openLibrary(['a', 'b', 'c', 'd'], 'other')
            const backup = await createBackup({ storage: first })
            await restoreBackup({ storage: second, backup })
            const before = await contentOf(second)

            const result = await restoreBackup({ storage: second, backup })

            expect(result).toEqual({
                booksMatched: 3,
                booksMissing: 0,
                bookmarksAdded: 0,
                highlightsAdded: 0,
                highlightsUpdated: 0,
                progressUpdated: 0,
            })
            expect(await contentOf(second)).toEqual(before)
        })

        it('gives the same backup from the second library', async () => {
            const first = await openFullLibrary()
            const second = await openLibrary(['d', 'c', 'b', 'a'], 'other')
            const now = () => Date.parse(EXPORTED_AT)
            const backup = await createBackup({ storage: first, now })

            await restoreBackup({ storage: second, backup })

            expect(await createBackup({ storage: second, now })).toEqual(backup)
        })
    })

    describe('restoreBackup', () => {
        const noChange = {
            booksMatched: 1,
            booksMissing: 0,
            bookmarksAdded: 0,
            highlightsAdded: 0,
            highlightsUpdated: 0,
            progressUpdated: 0,
        }

        describe('books', () => {
            it('does not restore the data of a book that is not in the library', async () => {
                const first = await openFullLibrary()
                const second = await openLibrary(['b', 'z'], 'other')
                const backup = await createBackup({ storage: first })

                const result = await restoreBackup({ storage: second, backup })

                expect(result).toEqual({
                    booksMatched: 1,
                    booksMissing: 2,
                    bookmarksAdded: 0,
                    highlightsAdded: 0,
                    highlightsUpdated: 0,
                    progressUpdated: 1,
                })
                expect(await contentOf(second)).toEqual({
                    [hashOf('b')]: {
                        progress: {
                            locator: { spineIndex: 2, offset: 7 },
                            fraction: 0.9,
                            updatedAt: 2000,
                        },
                        bookmarks: [],
                        highlights: [],
                    },
                    [hashOf('z')]: { progress: null, bookmarks: [], highlights: [] },
                })
            })

            it('counts each book as missing in an empty library', async () => {
                const first = await openFullLibrary()
                const second = await openLibrary([])
                const backup = await createBackup({ storage: first })

                const result = await restoreBackup({ storage: second, backup })

                expect(result).toEqual({ ...noChange, booksMatched: 0, booksMissing: 3 })
            })

            it('does nothing for a backup with no books', async () => {
                const storage = await openFullLibrary()
                const before = await contentOf(storage)
                const backup = { format: 'web-ereader-backup', version: 1, exportedAt: EXPORTED_AT }

                const result = await restoreBackup({ storage, backup: { ...backup, books: [] } })

                expect(result).toEqual({ ...noChange, booksMatched: 0 })
                expect(await contentOf(storage)).toEqual(before)
            })

            it('matches a book by its file hash and not by its title', async () => {
                const storage = await openLibrary(['a'])
                const backup = fileWith({
                    fileHash: hashOf('b'),
                    title: 'Title a',
                    highlights: [withoutBookId(makeHighlight('hl-1'))],
                })

                const result = await restoreBackup({ storage, backup })

                expect(result).toEqual({ ...noChange, booksMatched: 0, booksMissing: 1 })
                expect(await storage.listHighlights('book-a')).toEqual([])
            })
        })

        describe('position', () => {
            const position = {
                locator: { spineIndex: 2, offset: 5 },
                fraction: 0.7,
                updatedAt: 5000,
            }

            it('writes the position when the book has none', async () => {
                const storage = await openLibrary(['a'])

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ progress: position }),
                })

                expect(result).toEqual({ ...noChange, progressUpdated: 1 })
                expect(await storage.getProgress('book-a')).toEqual({
                    ...position,
                    bookId: 'book-a',
                })
            })

            it('writes the position when the backup has the later one', async () => {
                const storage = await openLibrary(['a'])
                await storage.saveProgress(makeProgress('book-a', { updatedAt: 4999 }))

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ progress: position }),
                })

                expect(result).toEqual({ ...noChange, progressUpdated: 1 })
                expect(await storage.getProgress('book-a')).toEqual({
                    ...position,
                    bookId: 'book-a',
                })
            })

            it.each([
                ['the same time', 5000],
                ['a later time', 5001],
            ])('keeps a stored position with %s', async (_name, updatedAt) => {
                const storage = await openLibrary(['a'])
                const stored = makeProgress('book-a', { updatedAt })
                await storage.saveProgress(stored)

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ progress: position }),
                })

                expect(result).toEqual(noChange)
                expect(await storage.getProgress('book-a')).toEqual(stored)
            })

            it('keeps the stored position when the backup has none', async () => {
                const storage = await openLibrary(['a'])
                const stored = makeProgress('book-a')
                await storage.saveProgress(stored)

                const result = await restoreBackup({ storage, backup: fileWith() })

                expect(result).toEqual(noChange)
                expect(await storage.getProgress('book-a')).toEqual(stored)
            })
        })

        describe('bookmarks', () => {
            it('adds a bookmark with a new id and a new position', async () => {
                const storage = await openLibrary(['a'], 'local')
                const bookmark = withoutBookId(makeBookmark('bm-1'))

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ bookmarks: [bookmark] }),
                })

                expect(result).toEqual({ ...noChange, bookmarksAdded: 1 })
                expect(await storage.listBookmarks('local-a')).toEqual([
                    { ...bookmark, bookId: 'local-a' },
                ])
            })

            it('does not add a bookmark when its id exists', async () => {
                const storage = await openLibrary(['a'])
                const stored = makeBookmark('bm-1')
                await storage.putBookmark(stored)
                const other = makeBookmark('bm-1', {
                    locator: { spineIndex: 2, offset: 99 },
                    excerpt: 'Other words',
                    createdAt: 9000,
                })

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ bookmarks: [withoutBookId(other)] }),
                })

                expect(result).toEqual(noChange)
                expect(await storage.listBookmarks('book-a')).toEqual([stored])
            })

            it('does not add a bookmark when a bookmark with the same locator exists', async () => {
                const storage = await openLibrary(['a'])
                const stored = makeBookmark('bm-1')
                await storage.putBookmark(stored)
                const other = makeBookmark('bm-2', { excerpt: 'Other words', createdAt: 9000 })

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ bookmarks: [withoutBookId(other)] }),
                })

                expect(result).toEqual(noChange)
                expect(await storage.listBookmarks('book-a')).toEqual([stored])
            })

            it('adds a bookmark at a different offset of the same spine item', async () => {
                const storage = await openLibrary(['a'])
                const stored = makeBookmark('bm-1')
                await storage.putBookmark(stored)
                const other = makeBookmark('bm-2', { locator: { spineIndex: 0, offset: 11 } })

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ bookmarks: [withoutBookId(other)] }),
                })

                expect(result).toEqual({ ...noChange, bookmarksAdded: 1 })
                expect(await storage.listBookmarks('book-a')).toEqual([stored, other])
            })

            it('adds one bookmark when the backup has two at the same locator', async () => {
                const storage = await openLibrary(['a'])
                const bookmarks = [makeBookmark('bm-1'), makeBookmark('bm-2')].map(withoutBookId)

                const result = await restoreBackup({ storage, backup: fileWith({ bookmarks }) })

                expect(result).toEqual({ ...noChange, bookmarksAdded: 1 })
                expect(await storage.listBookmarks('book-a')).toEqual([makeBookmark('bm-1')])
            })

            it('does not take a bookmark from a different book that has the same id', async () => {
                const storage = await openLibrary(['a', 'b'])
                const stored = makeBookmark('bm-1', { bookId: 'book-b' })
                await storage.putBookmark(stored)

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ bookmarks: [withoutBookId(makeBookmark('bm-1'))] }),
                })

                expect(result).toEqual(noChange)
                expect(await storage.listBookmarks('book-a')).toEqual([])
                expect(await storage.listBookmarks('book-b')).toEqual([stored])
            })
        })

        describe('highlights', () => {
            it('adds a highlight with a new id', async () => {
                const storage = await openLibrary(['a'], 'local')
                await storage.putHighlight(makeHighlight('hl-1', { bookId: 'local-a' }))
                const highlight = withoutBookId(makeHighlight('hl-2', { start: 5, end: 9 }))

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ highlights: [highlight] }),
                })

                expect(result).toEqual({ ...noChange, highlightsAdded: 1 })
                expect(await storage.listHighlights('local-a')).toEqual([
                    { ...highlight, bookId: 'local-a' },
                    makeHighlight('hl-1', { bookId: 'local-a' }),
                ])
            })

            it('updates a highlight when the backup has a later change', async () => {
                const storage = await openLibrary(['a'], 'local')
                await storage.putHighlight(makeHighlight('hl-1', { bookId: 'local-a' }))
                const changed = withoutBookId(
                    makeHighlight('hl-1', { color: 'green', note: 'A new note', updatedAt: 4001 }),
                )

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ highlights: [changed] }),
                })

                expect(result).toEqual({ ...noChange, highlightsUpdated: 1 })
                expect(await storage.listHighlights('local-a')).toEqual([
                    { ...changed, bookId: 'local-a' },
                ])
            })

            it.each([
                ['the same time', 4000],
                ['an earlier time', 3999],
            ])('keeps a stored highlight when the backup has %s', async (_name, updatedAt) => {
                const storage = await openLibrary(['a'])
                const stored = makeHighlight('hl-1', { note: 'The stored note' })
                await storage.putHighlight(stored)
                const changed = makeHighlight('hl-1', { color: 'green', note: 'Other', updatedAt })

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ highlights: [withoutBookId(changed)] }),
                })

                expect(result).toEqual(noChange)
                expect(await storage.listHighlights('book-a')).toEqual([stored])
            })

            it('adds, updates and keeps highlights in one restore', async () => {
                const storage = await openLibrary(['a'])
                await storage.putHighlight(makeHighlight('hl-1'))
                await storage.putHighlight(makeHighlight('hl-2', { start: 40, end: 50 }))
                const highlights = [
                    makeHighlight('hl-1', { note: 'Later', updatedAt: 7000 }),
                    makeHighlight('hl-2', { start: 40, end: 50, note: 'Earlier', updatedAt: 1 }),
                    makeHighlight('hl-3', { start: 60, end: 70 }),
                ]

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ highlights: highlights.map(withoutBookId) }),
                })

                expect(result).toEqual({ ...noChange, highlightsAdded: 1, highlightsUpdated: 1 })
                expect(await storage.listHighlights('book-a')).toEqual([
                    highlights[0],
                    makeHighlight('hl-2', { start: 40, end: 50 }),
                    highlights[2],
                ])
            })

            it('does not take a highlight from a different book that has the same id', async () => {
                const storage = await openLibrary(['a', 'b'])
                const stored = makeHighlight('hl-1', { bookId: 'book-b' })
                await storage.putHighlight(stored)
                const changed = makeHighlight('hl-1', { note: 'Later', updatedAt: 9000 })

                const result = await restoreBackup({
                    storage,
                    backup: fileWith({ highlights: [withoutBookId(changed)] }),
                })

                expect(result).toEqual(noChange)
                expect(await storage.listHighlights('book-a')).toEqual([])
                expect(await storage.listHighlights('book-b')).toEqual([stored])
            })
        })

        it('ignores a record for a spine item that the local book does not have', async () => {
            const storage = await openLibrary(['a'])
            const backup = fileWith({
                progress: { locator: { spineIndex: 3, offset: 0 }, fraction: 1, updatedAt: 9000 },
                bookmarks: [
                    withoutBookId(makeBookmark('bm-1', { locator: { spineIndex: 3, offset: 0 } })),
                    withoutBookId(makeBookmark('bm-2', { locator: { spineIndex: 2, offset: 0 } })),
                ],
                highlights: [
                    withoutBookId(makeHighlight('hl-1', { spineIndex: 1_000_000 })),
                    withoutBookId(makeHighlight('hl-2', { spineIndex: 2 })),
                ],
            })

            const result = await restoreBackup({ storage, backup })

            expect(result).toEqual({ ...noChange, bookmarksAdded: 1, highlightsAdded: 1 })
            expect(await storage.getProgress('book-a')).toBeUndefined()
            expect((await storage.listBookmarks('book-a')).map((bookmark) => bookmark.id)).toEqual([
                'bm-2',
            ])
            expect(
                (await storage.listHighlights('book-a')).map((highlight) => highlight.id),
            ).toEqual(['hl-2'])
        })

        it('restores each record of a book that has no spine statistics', async () => {
            const storage = createLibraryStorage({ indexedDB: new IDBFactory() })
            libraries.push(storage)
            await storage.addBook({
                record: makeBook('a', { spineStats: [] }),
                file: new Blob(['x']),
                cover: null,
            })
            const backup = fileWith({
                highlights: [withoutBookId(makeHighlight('hl-1', { spineIndex: 40 }))],
            })

            const result = await restoreBackup({ storage, backup })

            expect(result).toEqual({ ...noChange, highlightsAdded: 1 })
        })

        it('restores more records than one batch of writes holds', async () => {
            const storage = await openLibrary(['a'])
            const highlights = Array.from({ length: 100 }, (_, index) =>
                makeHighlight(`hl-${index}`, { start: index * 10, end: index * 10 + 5 }),
            )
            const bookmarks = Array.from({ length: 70 }, (_, index) =>
                makeBookmark(`bm-${index}`, { locator: { spineIndex: 0, offset: index } }),
            )
            const backup = fileWith({
                bookmarks: bookmarks.map(withoutBookId),
                highlights: highlights.map(withoutBookId),
            })

            const result = await restoreBackup({ storage, backup })

            expect(result).toEqual({ ...noChange, bookmarksAdded: 70, highlightsAdded: 100 })
            expect(await storage.listBookmarks('book-a')).toEqual(bookmarks)
            expect(await storage.listHighlights('book-a')).toEqual(highlights)
        })

        it('accepts the JSON text of a backup', async () => {
            const storage = await openLibrary(['a'])
            const backup = JSON.stringify(
                fileWith({ highlights: [withoutBookId(makeHighlight('hl-1'))] }),
            )

            const result = await restoreBackup({ storage, backup })

            expect(result).toEqual({ ...noChange, highlightsAdded: 1 })
        })

        it('does not write the extra fields of a backup', async () => {
            const storage = await openLibrary(['a'])
            const extra = { extra: 'not in the contract', bookId: 'book-z' }
            const backup = fileWith({
                progress: { ...withoutBookId(makeProgress('book-a')), ...extra },
                bookmarks: [{ ...withoutBookId(makeBookmark('bm-1')), ...extra }],
                highlights: [{ ...withoutBookId(makeHighlight('hl-1')), ...extra }],
            })

            await restoreBackup({ storage, backup })

            expect(await storage.getProgress('book-a')).toEqual(makeProgress('book-a'))
            expect(await storage.listBookmarks('book-a')).toEqual([makeBookmark('bm-1')])
            expect(await storage.listHighlights('book-a')).toEqual([makeHighlight('hl-1')])
            expect(await storage.listProgress()).toHaveLength(1)
        })

        it.each([
            ['a file of a different application', { format: 'other', version: 1, books: [] }],
            ['a newer version', { ...fileWith(), version: 2 }],
            ['text that is not JSON', 'Not a backup'],
            ['no value', undefined],
        ])('rejects %s and writes nothing', async (_name, backup) => {
            const storage = await openFullLibrary()
            const before = await contentOf(storage)

            await expect(restoreBackup({ storage, backup })).rejects.toThrow(NOT_A_BACKUP)
            expect(await contentOf(storage)).toEqual(before)
        })

        it('rejects with the storage error when a write fails', async () => {
            const storage = await openLibrary(['a'])
            const failure = new Error('Unable to save the highlight.')
            const failing: LibraryStorage = {
                ...storage,
                putHighlight: () => Promise.reject(failure),
            }
            const backup = fileWith({ highlights: [withoutBookId(makeHighlight('hl-1'))] })

            await expect(restoreBackup({ storage: failing, backup })).rejects.toBe(failure)
        })
    })

    describe('parseBackup', () => {
        const validBookmark = withoutBookId(makeBookmark('bm-1'))
        const validHighlight = withoutBookId(makeHighlight('hl-1'))
        const validProgress = withoutBookId(makeProgress('book-a'))

        function firstBook(raw: unknown): BackupBook {
            return parseBackup(raw).books[0]
        }

        it('gives a valid backup back with no change', () => {
            const backup: BackupFile = {
                format: 'web-ereader-backup',
                version: 1,
                exportedAt: EXPORTED_AT,
                books: [
                    {
                        fileHash: hashOf('a'),
                        title: 'Title a',
                        author: '',
                        progress: validProgress,
                        bookmarks: [validBookmark],
                        highlights: [validHighlight],
                    },
                    {
                        fileHash: hashOf('b'),
                        title: '',
                        author: 'Author b',
                        progress: null,
                        bookmarks: [],
                        highlights: [],
                    },
                ],
            }

            expect(parseBackup(backup)).toEqual(backup)
            expect(parseBackup(JSON.stringify(backup))).toEqual(backup)
            expect(parseBackup(backup)).not.toBe(backup)
        })

        it.each([
            ['undefined', undefined],
            ['null', null],
            ['a number', 42],
            ['a boolean', true],
            ['an array', [fileWith()]],
            ['an empty object', {}],
            ['an empty text', ''],
            ['text that is not JSON', '{"format": "web-ereader-backup", "version": 1'],
            ['JSON text of a text', JSON.stringify(JSON.stringify(fileWith()))],
            ['JSON text of null', 'null'],
            ['a function', () => fileWith()],
            ['no format', { ...fileWith(), format: undefined }],
            ['a format of a different application', { ...fileWith(), format: 'kindle-backup' }],
            ['a format with a different case', { ...fileWith(), format: 'Web-eReader-Backup' }],
            ['a format that is an array', { ...fileWith(), format: ['web-ereader-backup'] }],
            ['no version', { ...fileWith(), version: undefined }],
            ['version 0', { ...fileWith(), version: 0 }],
            ['version 2', { ...fileWith(), version: 2 }],
            ['version 1.5', { ...fileWith(), version: 1.5 }],
            ['a version that is a text', { ...fileWith(), version: '1' }],
            ['a version that is true', { ...fileWith(), version: true }],
            ['no export time', { ...fileWith(), exportedAt: undefined }],
            ['an export time that is a number', { ...fileWith(), exportedAt: 1709647389000 }],
            ['an export time that is not a date', { ...fileWith(), exportedAt: 'yesterday' }],
            ['an export time with no clock', { ...fileWith(), exportedAt: '2024-03-05' }],
            ['an export time out of range', { ...fileWith(), exportedAt: '2024-13-45T99:99:99Z' }],
            ['no books', { ...fileWith(), books: undefined }],
            ['books that are null', { ...fileWith(), books: null }],
            ['books that are an object', { ...fileWith(), books: { 0: {} } }],
            ['books that are a text', { ...fileWith(), books: 'none' }],
        ])('throws for %s', (_name, raw) => {
            expect(() => parseBackup(raw)).toThrow(new Error(NOT_A_BACKUP))
        })

        it('writes the export time in the form of toISOString', () => {
            const backup = { ...fileWith(), exportedAt: '2024-03-05T16:03:09+02:00' }

            expect(parseBackup(backup).exportedAt).toBe(EXPORTED_AT)
        })

        it('removes extra fields at each level', () => {
            const extra = { extra: 1, bookId: 'book-z' }
            const raw = {
                ...fileWith({
                    ...extra,
                    id: 'book-a',
                    progress: {
                        ...validProgress,
                        ...extra,
                        locator: { ...extra, ...validProgress.locator },
                    },
                    bookmarks: [
                        {
                            ...validBookmark,
                            ...extra,
                            locator: { ...validBookmark.locator, ...extra },
                        },
                    ],
                    highlights: [{ ...validHighlight, ...extra }],
                }),
                ...extra,
                device: 'phone',
            }

            expect(parseBackup(raw)).toEqual({
                format: 'web-ereader-backup',
                version: 1,
                exportedAt: EXPORTED_AT,
                books: [
                    {
                        fileHash: hashOf('a'),
                        title: 'Title a',
                        author: 'Author a',
                        progress: validProgress,
                        bookmarks: [validBookmark],
                        highlights: [validHighlight],
                    },
                ],
            })
            expect(JSON.stringify(parseBackup(raw))).not.toMatch(/extra|bookId|device/)
        })

        it('does not read a "__proto__" key of the JSON text as a prototype', () => {
            const text = JSON.stringify(fileWith()).replace(
                '"title":"Title a"',
                '"title":"Title a","__proto__":{"author":"From the prototype","polluted":true}',
            )

            const book = firstBook(text)

            expect(book.author).toBe('Author a')
            expect(Object.getPrototypeOf(book)).toBe(Object.prototype)
            expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        })

        describe('books', () => {
            it.each([
                ['is null', null],
                ['is a text', 'book'],
                ['is a number', 7],
                ['is an array', [fileWith()]],
            ])('drops a book that %s', (_name, book) => {
                const raw = { ...fileWith(), books: [book, (fileWith().books as unknown[])[0]] }

                expect(parseBackup(raw).books.map((entry) => entry.fileHash)).toEqual([hashOf('a')])
            })

            it.each([
                ['no file hash', { fileHash: undefined }],
                ['a file hash that is a number', { fileHash: 1234 }],
                ['an empty file hash', { fileHash: '' }],
                ['a short file hash', { fileHash: 'abc123' }],
                ['a file hash with capital letters', { fileHash: 'AB'.repeat(32) }],
                ['a file hash with one more digit', { fileHash: `${hashOf('a')}0` }],
                ['a file hash with a letter that is not a hex digit', { fileHash: 'g'.repeat(64) }],
                ['a file hash with a line break', { fileHash: `${hashOf('a')}\n` }],
                ['no title', { title: undefined }],
                ['a title that is a number', { title: 1984 }],
                ['a title that is null', { title: null }],
                ['no author', { author: undefined }],
                ['an author that is an array', { author: ['Author'] }],
                ['no bookmarks', { bookmarks: undefined }],
                ['bookmarks that are an object', { bookmarks: {} }],
                ['no highlights', { highlights: undefined }],
                ['highlights that are a text', { highlights: 'none' }],
            ])('drops a book with %s', (_name, changes) => {
                expect(parseBackup(fileWith(changes)).books).toEqual([])
            })

            it('keeps the first of two books with the same file hash', () => {
                const [book] = fileWith().books as Record<string, unknown>[]
                const raw = { ...fileWith(), books: [book, { ...book, title: 'Second' }] }

                expect(parseBackup(raw).books.map((entry) => entry.title)).toEqual(['Title a'])
            })

            it('keeps a book that has no valid entries', () => {
                const raw = fileWith({ progress: 'none', bookmarks: [1], highlights: [null] })

                expect(parseBackup(raw).books).toEqual([
                    {
                        fileHash: hashOf('a'),
                        title: 'Title a',
                        author: 'Author a',
                        progress: null,
                        bookmarks: [],
                        highlights: [],
                    },
                ])
            })
        })

        describe('position', () => {
            it('keeps a valid position', () => {
                expect(firstBook(fileWith({ progress: validProgress })).progress).toEqual(
                    validProgress,
                )
            })

            it.each([
                ['is not there', undefined],
                ['is a text', 'half'],
                ['is a number', 0.5],
                ['is an array', [validProgress]],
                ['has no locator', { ...validProgress, locator: undefined }],
                ['has a locator that is null', { ...validProgress, locator: null }],
                ['has a locator that is a number', { ...validProgress, locator: 42 }],
                ['has a locator that is an array', { ...validProgress, locator: [1, 42] }],
                ['has a locator with no offset', { ...validProgress, locator: { spineIndex: 1 } }],
                [
                    'has a locator with a negative offset',
                    { ...validProgress, locator: { spineIndex: 1, offset: -1 } },
                ],
                [
                    'has a locator with a negative spine index',
                    { ...validProgress, locator: { spineIndex: -1, offset: 0 } },
                ],
                [
                    'has a locator with a spine index that is not an integer',
                    { ...validProgress, locator: { spineIndex: 1.5, offset: 0 } },
                ],
                [
                    'has a locator with an offset that is a text',
                    { ...validProgress, locator: { spineIndex: 1, offset: '42' } },
                ],
                [
                    'has a locator with a very large offset',
                    { ...validProgress, locator: { spineIndex: 1, offset: 2 ** 53 } },
                ],
                ['has no fraction', { ...validProgress, fraction: undefined }],
                ['has a fraction above 1', { ...validProgress, fraction: 1.01 }],
                ['has a negative fraction', { ...validProgress, fraction: -0.01 }],
                ['has a fraction that is not a number', { ...validProgress, fraction: Number.NaN }],
                ['has a fraction that is a text', { ...validProgress, fraction: '0.5' }],
                ['has no time', { ...validProgress, updatedAt: undefined }],
                ['has a time that is a text', { ...validProgress, updatedAt: '2000' }],
                ['has a negative time', { ...validProgress, updatedAt: -1 }],
                ['has an infinite time', { ...validProgress, updatedAt: Infinity }],
                ['has a very large time', { ...validProgress, updatedAt: 1e300 }],
                ['has a time after the last Date', { ...validProgress, updatedAt: 8.64e15 + 1 }],
            ])('drops a position that %s', (_name, progress) => {
                expect(firstBook(fileWith({ progress })).progress).toBeNull()
            })
        })

        describe('bookmarks', () => {
            it.each([
                ['is null', null],
                ['is a text', 'bookmark'],
                ['is an array', [validBookmark]],
                ['has no id', { ...validBookmark, id: undefined }],
                ['has an empty id', { ...validBookmark, id: '' }],
                ['has an id that is a number', { ...validBookmark, id: 7 }],
                ['has a very long id', { ...validBookmark, id: 'x'.repeat(129) }],
                ['has an id with a space', { ...validBookmark, id: 'bm 3' }],
                ['has an id with a quotation mark', { ...validBookmark, id: 'bm-3"]' }],
                ['has an id with a line break', { ...validBookmark, id: 'bm-3\n' }],
                ['has an id with a letter that is not ASCII', { ...validBookmark, id: 'bm-é' }],
                ['has no locator', { ...validBookmark, locator: undefined }],
                [
                    'has a locator with a negative offset',
                    { ...validBookmark, locator: { spineIndex: 0, offset: -10 } },
                ],
                [
                    'has a locator with a very large spine index',
                    { ...validBookmark, locator: { spineIndex: 1e21, offset: 0 } },
                ],
                [
                    'has a locator with an infinite offset',
                    { ...validBookmark, locator: { spineIndex: 0, offset: Infinity } },
                ],
                ['has no fraction', { ...validBookmark, fraction: undefined }],
                ['has a fraction above 1', { ...validBookmark, fraction: 1e308 }],
                ['has no chapter title', { ...validBookmark, chapterTitle: undefined }],
                ['has a chapter title that is null', { ...validBookmark, chapterTitle: null }],
                ['has no excerpt', { ...validBookmark, excerpt: undefined }],
                ['has an excerpt that is a number', { ...validBookmark, excerpt: 12 }],
                ['has no time', { ...validBookmark, createdAt: undefined }],
                ['has a time that is a text', { ...validBookmark, createdAt: EXPORTED_AT }],
                ['has a very large time', { ...validBookmark, createdAt: Number.MAX_VALUE }],
            ])('drops a bookmark that %s', (_name, bookmark) => {
                const other = { ...validBookmark, id: 'bm-2' }

                const book = firstBook(fileWith({ bookmarks: [bookmark, other] }))

                expect(book.bookmarks).toEqual([other])
            })

            it('keeps a bookmark with empty texts and the largest valid numbers', () => {
                const bookmark = {
                    id: 'x'.repeat(128),
                    locator: { spineIndex: Number.MAX_SAFE_INTEGER, offset: 0 },
                    fraction: 1,
                    chapterTitle: '',
                    excerpt: '',
                    createdAt: 8.64e15,
                }

                expect(firstBook(fileWith({ bookmarks: [bookmark] })).bookmarks).toEqual([bookmark])
            })
        })

        describe('highlights', () => {
            it.each([
                ['is null', null],
                ['is a number', 3],
                ['has no id', { ...validHighlight, id: undefined }],
                ['has an id that is an object', { ...validHighlight, id: { id: 'hl-1' } }],
                ['has an id with an angle bracket', { ...validHighlight, id: '<hl-3>' }],
                ['has an id with a control character', { ...validHighlight, id: 'hl-3\u0000' }],
                ['has no spine index', { ...validHighlight, spineIndex: undefined }],
                ['has a negative spine index', { ...validHighlight, spineIndex: -1 }],
                ['has a spine index that is a text', { ...validHighlight, spineIndex: '1' }],
                ['has a very large spine index', { ...validHighlight, spineIndex: 1e400 }],
                ['has no start', { ...validHighlight, start: undefined }],
                ['has a negative start', { ...validHighlight, start: -5 }],
                ['has a start that is not an integer', { ...validHighlight, start: 20.5 }],
                ['has no end', { ...validHighlight, end: undefined }],
                ['has a very large end', { ...validHighlight, end: 2 ** 53 }],
                ['has an end before its start', { ...validHighlight, start: 30, end: 20 }],
                ['has an end at its start', { ...validHighlight, start: 20, end: 20 }],
                ['has no text', { ...validHighlight, text: undefined }],
                ['has a text that is an array', { ...validHighlight, text: ['some', 'words'] }],
                ['has no colour', { ...validHighlight, color: undefined }],
                ['has a colour that the reader does not have', { ...validHighlight, color: 'red' }],
                ['has a colour with a capital letter', { ...validHighlight, color: 'Yellow' }],
                ['has a colour that is a number', { ...validHighlight, color: 0 }],
                ['has no note', { ...validHighlight, note: undefined }],
                ['has a note that is null', { ...validHighlight, note: null }],
                ['has no chapter title', { ...validHighlight, chapterTitle: undefined }],
                ['has no fraction', { ...validHighlight, fraction: undefined }],
                ['has a fraction of 100', { ...validHighlight, fraction: 100 }],
                ['has no creation time', { ...validHighlight, createdAt: undefined }],
                ['has a negative creation time', { ...validHighlight, createdAt: -4000 }],
                ['has no change time', { ...validHighlight, updatedAt: undefined }],
                ['has an infinite change time', { ...validHighlight, updatedAt: Infinity }],
                ['has a very large change time', { ...validHighlight, updatedAt: 1e16 }],
            ])('drops a highlight that %s', (_name, highlight) => {
                const other = { ...validHighlight, id: 'hl-2' }

                const book = firstBook(fileWith({ highlights: [highlight, other] }))

                expect(book.highlights).toEqual([other])
            })

            it.each(['yellow', 'green', 'blue', 'pink', 'purple'])(
                'keeps a highlight with the colour %s',
                (color) => {
                    const highlight = { ...validHighlight, color }

                    expect(firstBook(fileWith({ highlights: [highlight] })).highlights).toEqual([
                        highlight,
                    ])
                },
            )

            it.each([
                ['a UUID', '3f2b8c1e-9d4a-4f6b-8a1c-0e5d7c9b2a41'],
                ['letters, digits and the signs _ . : -', 'Book_1.chapter:2-hl'],
            ])('keeps a highlight with an id that is %s', (_name, id) => {
                const highlight = { ...validHighlight, id }

                expect(firstBook(fileWith({ highlights: [highlight] })).highlights).toEqual([
                    highlight,
                ])
            })

            it('keeps a highlight with empty texts', () => {
                const highlight = { ...validHighlight, text: '', note: '', chapterTitle: '' }

                expect(firstBook(fileWith({ highlights: [highlight] })).highlights).toEqual([
                    highlight,
                ])
            })
        })

        it('drops numbers of the JSON text that are too large for a number', () => {
            const text = JSON.stringify(
                fileWith({
                    progress: { ...validProgress, updatedAt: 'LARGE' },
                    bookmarks: [{ ...validBookmark, createdAt: 'LARGE' }],
                    highlights: [
                        { ...validHighlight, end: 'LARGE' },
                        { ...validHighlight, id: 'hl-2', end: 'INTEGER' },
                    ],
                }),
            )
                .replaceAll('"LARGE"', '1e999')
                .replaceAll('"INTEGER"', '9007199254740993')

            expect(text).toContain('"updatedAt":1e999')
            expect(firstBook(text)).toEqual({
                fileHash: hashOf('a'),
                title: 'Title a',
                author: 'Author a',
                progress: null,
                bookmarks: [],
                highlights: [],
            })
        })

        it('drops an entry that repeats an id of the file, also in a different book', () => {
            const [book] = fileWith({
                bookmarks: [validBookmark, { ...validBookmark, excerpt: 'Second' }],
                highlights: [validHighlight, { ...validHighlight, note: 'Second' }],
            }).books as Record<string, unknown>[]
            const other = {
                ...book,
                fileHash: hashOf('b'),
                bookmarks: [validBookmark, { ...validBookmark, id: 'bm-2' }],
                highlights: [validHighlight, { ...validHighlight, id: 'hl-2' }],
            }

            const { books } = parseBackup({ ...fileWith(), books: [book, other] })

            expect(books[0].bookmarks).toEqual([validBookmark])
            expect(books[0].highlights).toEqual([validHighlight])
            expect(books[1].bookmarks).toEqual([{ ...validBookmark, id: 'bm-2' }])
            expect(books[1].highlights).toEqual([{ ...validHighlight, id: 'hl-2' }])
        })

        it('allows a bookmark and a highlight with the same id', () => {
            const raw = fileWith({
                bookmarks: [{ ...validBookmark, id: 'same' }],
                highlights: [{ ...validHighlight, id: 'same' }],
            })

            const book = firstBook(raw)

            expect(book.bookmarks).toHaveLength(1)
            expect(book.highlights).toHaveLength(1)
        })
    })
})
