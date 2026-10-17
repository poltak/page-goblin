import { Blob as NodeBlob } from 'node:buffer'
import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLibraryStorage, type LibraryFileStorage } from './library-storage'
import { trackFactory, type TrackedFactory } from './testing/tracked-factory'
import type {
    BookmarkRecord,
    BookRecord,
    HighlightRecord,
    OutboxEntry,
    ProgressRecord,
} from './types'

function makeBook(id: string, changes: Partial<BookRecord> = {}): BookRecord {
    return {
        id,
        title: `Title ${id}`,
        author: 'An Author',
        language: 'en',
        identifier: `urn:test:${id}`,
        publisher: null,
        description: null,
        published: '2020-01-01',
        subjects: ['Fiction'],
        series: { name: 'A Series', position: 2 },
        fileName: `${id}.epub`,
        fileSize: 3,
        fileHash: `hash-${id}`,
        hasCover: true,
        spineStats: [
            { chars: 100, words: 20 },
            { chars: 300, words: 60 },
        ],
        totalChars: 400,
        totalWords: 80,
        addedAt: 1000,
        lastOpenedAt: null,
        ...changes,
    }
}

function makeProgress(bookId: string, changes: Partial<ProgressRecord> = {}): ProgressRecord {
    return {
        bookId,
        locator: { spineIndex: 1, offset: 42 },
        fraction: 0.5,
        updatedAt: 2000,
        ...changes,
    }
}

function makeBookmark(id: string, changes: Partial<BookmarkRecord> = {}): BookmarkRecord {
    return {
        id,
        bookId: 'a',
        locator: { spineIndex: 0, offset: 0 },
        fraction: 0.1,
        chapterTitle: 'Chapter',
        excerpt: 'The first words',
        createdAt: 3000,
        ...changes,
    }
}

function makeHighlight(id: string, changes: Partial<HighlightRecord> = {}): HighlightRecord {
    const start = changes.start ?? 0
    return {
        id,
        bookId: 'a',
        spineIndex: 0,
        start,
        end: start + 10,
        text: 'some words',
        color: 'yellow',
        note: '',
        chapterTitle: 'Chapter',
        fraction: 0.2,
        createdAt: 4000,
        updatedAt: 4000,
        ...changes,
    }
}

function hasBlob(value: unknown): boolean {
    if (value instanceof Blob) return true
    if (typeof value !== 'object' || value === null) return false
    return Object.values(value).some(hasBlob)
}

describe('createLibraryStorage', () => {
    let tracked: TrackedFactory
    let storage: LibraryFileStorage

    beforeEach(() => {
        // A jsdom Blob does not survive structuredClone, which fake-indexeddb uses to store a
        // value. The Blob of Node does, as a Blob does in a browser.
        vi.stubGlobal('Blob', NodeBlob)
        tracked = trackFactory(new IDBFactory())
        storage = createLibraryStorage({ indexedDB: tracked.factory })
    })

    afterEach(() => {
        storage.close()
        vi.unstubAllGlobals()
    })

    function addBook(id: string, changes: Partial<BookRecord> = {}): Promise<void> {
        return storage.addBook({
            record: makeBook(id, changes),
            file: new Blob([`file of ${id}`], { type: 'application/epub+zip' }),
            cover: new Blob([`cover of ${id}`], { type: 'image/jpeg' }),
        })
    }

    describe('books', () => {
        it('has no books at the start', async () => {
            expect(await storage.listBooks()).toEqual([])
            expect(await storage.getBook('a')).toBeUndefined()
            expect(await storage.findBookByHash('hash-a')).toBeUndefined()
            expect(await storage.getFile('a')).toBeUndefined()
            expect(await storage.getCover('a')).toBeUndefined()
        })

        it('adds a book with its file and cover in one transaction', async () => {
            await addBook('a')

            expect(tracked.transactions).toEqual([
                { stores: ['books', 'files', 'covers'], mode: 'readwrite' },
            ])
            expect(await storage.getBook('a')).toEqual(makeBook('a'))

            const file = await storage.getFile('a')
            expect(file?.type).toBe('application/epub+zip')
            expect(await file?.text()).toBe('file of a')

            const cover = await storage.getCover('a')
            expect(cover?.type).toBe('image/jpeg')
            expect(await cover?.text()).toBe('cover of a')
        })

        it('adds a book that has no cover', async () => {
            await storage.addBook({
                record: makeBook('a', { hasCover: false }),
                file: new Blob(['file']),
                cover: null,
            })

            expect(await storage.getBook('a')).toMatchObject({ hasCover: false })
            expect(await storage.getCover('a')).toBeUndefined()
        })

        it('writes nothing when a part of addBook fails', async () => {
            await addBook('a')

            const second = storage.addBook({
                record: makeBook('a', { title: 'A different book' }),
                file: new Blob(['a different file']),
                cover: null,
            })

            await expect(second).rejects.toMatchObject({ name: 'ConstraintError' })
            expect(await storage.getBook('a')).toEqual(makeBook('a'))
            expect(await (await storage.getFile('a'))?.text()).toBe('file of a')
        })

        it('refuses a second book that has the same file hash and writes nothing', async () => {
            await addBook('a')

            const second = storage.addBook({
                record: makeBook('b', { fileHash: 'hash-a' }),
                file: new Blob(['the same file']),
                cover: new Blob(['the same cover']),
            })

            await expect(second).rejects.toMatchObject({ name: 'ConstraintError' })
            expect(await storage.listBooks()).toEqual([makeBook('a')])
            expect(await storage.getFile('b')).toBeUndefined()
            expect(await storage.getCover('b')).toBeUndefined()
        })

        it('lists small records with no file data and reads only the books store', async () => {
            await addBook('a')
            await addBook('b')
            tracked.transactions.length = 0

            const books = await storage.listBooks()

            expect(tracked.transactions).toEqual([{ stores: ['books'], mode: 'readonly' }])
            expect(books).toHaveLength(2)
            expect(books).toEqual(expect.arrayContaining([makeBook('a'), makeBook('b')]))
            expect(books.some(hasBlob)).toBe(false)
            // The check finds a Blob when there is one.
            expect(hasBlob({ nested: [await storage.getFile('a')] })).toBe(true)
        })

        it('finds a book by the hash of its file', async () => {
            await addBook('a')
            await addBook('b')

            expect(await storage.findBookByHash('hash-b')).toEqual(makeBook('b'))
            expect(await storage.findBookByHash('hash-c')).toBeUndefined()
        })

        it('merges a patch into the record and keeps the id', async () => {
            await addBook('a')

            await storage.updateBook('a', {
                lastOpenedAt: 5000,
                title: 'New title',
                ...({ id: 'changed' } as object),
            })

            expect(await storage.getBook('a')).toEqual(
                makeBook('a', { lastOpenedAt: 5000, title: 'New title' }),
            )
            expect(await storage.getBook('changed')).toBeUndefined()
            expect(await (await storage.getFile('a'))?.text()).toBe('file of a')
        })

        it('does nothing when updateBook gets an id that is not there', async () => {
            await storage.updateBook('missing', { title: 'New title' })

            expect(await storage.listBooks()).toEqual([])
        })

        it('deletes a book with all its records in one transaction', async () => {
            await addBook('a')
            await addBook('b')
            for (const bookId of ['a', 'b']) {
                await storage.saveProgress(makeProgress(bookId))
                await storage.putBookmark(
                    makeBookmark(`${bookId}-mark-1`, {
                        bookId,
                        locator: { spineIndex: 0, offset: 1 },
                    }),
                )
                await storage.putBookmark(
                    makeBookmark(`${bookId}-mark-2`, {
                        bookId,
                        locator: { spineIndex: 1, offset: 1 },
                    }),
                )
                await storage.putHighlight(
                    makeHighlight(`${bookId}-light-1`, { bookId, spineIndex: 0, start: 1 }),
                )
                await storage.putHighlight(
                    makeHighlight(`${bookId}-light-2`, { bookId, spineIndex: 1, start: 1 }),
                )
            }
            tracked.transactions.length = 0

            await storage.deleteBook('a')

            expect(tracked.transactions).toEqual([
                {
                    stores: ['books', 'files', 'covers', 'progress', 'bookmarks', 'highlights'],
                    mode: 'readwrite',
                },
            ])
            expect(await storage.getBook('a')).toBeUndefined()
            expect(await storage.getFile('a')).toBeUndefined()
            expect(await storage.getCover('a')).toBeUndefined()
            expect(await storage.getProgress('a')).toBeUndefined()
            expect(await storage.listBookmarks('a')).toEqual([])
            expect(await storage.listHighlights('a')).toEqual([])

            expect(await storage.listBooks()).toEqual([makeBook('b')])
            expect(await (await storage.getFile('b'))?.text()).toBe('file of b')
            expect(await (await storage.getCover('b'))?.text()).toBe('cover of b')
            expect(await storage.listProgress()).toEqual([makeProgress('b')])
            expect((await storage.listBookmarks('b')).map((mark) => mark.id)).toEqual([
                'b-mark-1',
                'b-mark-2',
            ])
            expect((await storage.listHighlights('b')).map((light) => light.id)).toEqual([
                'b-light-1',
                'b-light-2',
            ])
        })

        it('does nothing when deleteBook gets an id that is not there', async () => {
            await addBook('a')

            await storage.deleteBook('missing')

            expect(await storage.listBooks()).toEqual([makeBook('a')])
        })

        it('writes the file of a book again and changes nothing else', async () => {
            await addBook('a')
            await addBook('b')
            await storage.saveProgress(makeProgress('a'))
            tracked.transactions.length = 0

            await storage.putFile('a', new Blob(['a new file'], { type: 'application/epub+zip' }))

            expect(tracked.transactions).toEqual([
                { stores: ['books', 'files'], mode: 'readwrite' },
            ])
            const file = await storage.getFile('a')
            expect(file?.type).toBe('application/epub+zip')
            expect(await file?.text()).toBe('a new file')
            expect(await storage.getBook('a')).toEqual(makeBook('a'))
            expect(await (await storage.getCover('a'))?.text()).toBe('cover of a')
            expect(await storage.getProgress('a')).toEqual(makeProgress('a'))
            expect(await (await storage.getFile('b'))?.text()).toBe('file of b')
        })

        it('writes no file for a book that is not there', async () => {
            await addBook('a')

            await storage.putFile('missing', new Blob(['a file']))

            expect(await storage.getFile('missing')).toBeUndefined()
            expect(await (await storage.getFile('a'))?.text()).toBe('file of a')
        })
    })

    describe('progress', () => {
        it('saves, reads and replaces the progress of a book', async () => {
            expect(await storage.getProgress('a')).toBeUndefined()
            expect(await storage.listProgress()).toEqual([])

            await storage.saveProgress(makeProgress('a'))
            await storage.saveProgress(makeProgress('b'))
            await storage.saveProgress(makeProgress('a', { fraction: 0.75, updatedAt: 2500 }))

            expect(await storage.getProgress('a')).toEqual(
                makeProgress('a', { fraction: 0.75, updatedAt: 2500 }),
            )
            expect(await storage.listProgress()).toEqual([
                makeProgress('a', { fraction: 0.75, updatedAt: 2500 }),
                makeProgress('b'),
            ])
        })

        it('writes only the progress store and does not change the book record', async () => {
            await addBook('a')
            tracked.transactions.length = 0

            await storage.saveProgress(makeProgress('a'))

            expect(tracked.transactions).toEqual([{ stores: ['progress'], mode: 'readwrite' }])
            expect(await storage.getBook('a')).toEqual(makeBook('a'))
            expect(await (await storage.getFile('a'))?.text()).toBe('file of a')
        })
    })

    describe('bookmarks', () => {
        it('lists the bookmarks of one book in reading order', async () => {
            await storage.putBookmark(
                makeBookmark('late', { locator: { spineIndex: 2, offset: 0 } }),
            )
            await storage.putBookmark(
                makeBookmark('early', { locator: { spineIndex: 0, offset: 90 } }),
            )
            await storage.putBookmark(
                makeBookmark('middle-2', { locator: { spineIndex: 1, offset: 50 } }),
            )
            await storage.putBookmark(
                makeBookmark('middle-1', { locator: { spineIndex: 1, offset: 7 } }),
            )
            await storage.putBookmark(
                makeBookmark('other', { bookId: 'b', locator: { spineIndex: 0, offset: 0 } }),
            )

            const bookmarks = await storage.listBookmarks('a')

            expect(bookmarks.map((mark) => mark.id)).toEqual([
                'early',
                'middle-1',
                'middle-2',
                'late',
            ])
            expect(bookmarks[0]).toEqual(
                makeBookmark('early', { locator: { spineIndex: 0, offset: 90 } }),
            )
            expect(await storage.listBookmarks('none')).toEqual([])
        })

        it('replaces a bookmark that has the same id', async () => {
            await storage.putBookmark(
                makeBookmark('one', { locator: { spineIndex: 0, offset: 1 } }),
            )
            await storage.putBookmark({
                ...makeBookmark('one', { locator: { spineIndex: 0, offset: 1 } }),
                excerpt: 'Changed',
            })

            const bookmarks = await storage.listBookmarks('a')
            expect(bookmarks).toHaveLength(1)
            expect(bookmarks[0].excerpt).toBe('Changed')
        })

        it('deletes one bookmark', async () => {
            await storage.putBookmark(
                makeBookmark('one', { locator: { spineIndex: 0, offset: 1 } }),
            )
            await storage.putBookmark(
                makeBookmark('two', { locator: { spineIndex: 0, offset: 2 } }),
            )

            await storage.deleteBookmark('one')
            await storage.deleteBookmark('missing')

            expect((await storage.listBookmarks('a')).map((mark) => mark.id)).toEqual(['two'])
        })
    })

    describe('highlights', () => {
        it('lists the highlights of one book in reading order', async () => {
            await storage.putHighlight(makeHighlight('late', { spineIndex: 3, start: 0 }))
            await storage.putHighlight(makeHighlight('middle-2', { spineIndex: 1, start: 80 }))
            await storage.putHighlight(makeHighlight('early', { spineIndex: 0, start: 500 }))
            await storage.putHighlight(makeHighlight('middle-1', { spineIndex: 1, start: 9 }))
            await storage.putHighlight(
                makeHighlight('other', { bookId: 'b', spineIndex: 0, start: 0 }),
            )

            const highlights = await storage.listHighlights('a')

            expect(highlights.map((light) => light.id)).toEqual([
                'early',
                'middle-1',
                'middle-2',
                'late',
            ])
            expect(highlights[0]).toEqual(makeHighlight('early', { spineIndex: 0, start: 500 }))
            expect(await storage.listHighlights('none')).toEqual([])
        })

        it('replaces a highlight that has the same id', async () => {
            await storage.putHighlight(makeHighlight('one', { spineIndex: 0, start: 1 }))
            await storage.putHighlight({
                ...makeHighlight('one', { spineIndex: 0, start: 1 }),
                note: 'A note',
                color: 'blue',
            })

            const highlights = await storage.listHighlights('a')
            expect(highlights).toHaveLength(1)
            expect(highlights[0]).toMatchObject({ note: 'A note', color: 'blue' })
        })

        it('deletes one highlight', async () => {
            await storage.putHighlight(makeHighlight('one', { spineIndex: 0, start: 1 }))
            await storage.putHighlight(makeHighlight('two', { spineIndex: 0, start: 2 }))

            await storage.deleteHighlight('one')
            await storage.deleteHighlight('missing')

            expect((await storage.listHighlights('a')).map((light) => light.id)).toEqual(['two'])
        })
    })

    describe('outbox', () => {
        let syncOn: boolean
        let onChange: ReturnType<typeof vi.fn<() => void>>

        beforeEach(() => {
            storage.close()
            syncOn = true
            onChange = vi.fn<() => void>()
            storage = createLibraryStorage({
                indexedDB: tracked.factory,
                changes: { isOn: () => syncOn, onChange },
                now: () => 9000,
            })
        })

        function readOutbox(): Promise<OutboxEntry[]> {
            return storage.database.run<OutboxEntry[]>({
                stores: 'outbox',
                mode: 'readonly',
                failureMessage: 'Unable to read.',
                work: (transaction) => {
                    const request = transaction.objectStore('outbox').getAll()
                    return () => request.result as OutboxEntry[]
                },
            })
        }

        function entry(
            kind: OutboxEntry['kind'],
            key: string,
            deleted: boolean,
            changedAt: number,
        ): OutboxEntry {
            return { id: `${kind}:${key}`, kind, key, deleted, changedAt }
        }

        it('writes nothing to the outbox while the sync is off', async () => {
            syncOn = false
            await addBook('a')
            await storage.saveProgress(makeProgress('a'))
            await storage.putBookmark(makeBookmark('m'))
            await storage.deleteBook('a')

            expect(tracked.transactions.some((item) => item.stores.includes('outbox'))).toBe(false)
            expect(await readOutbox()).toEqual([])
            expect(onChange).not.toHaveBeenCalled()
        })

        it('treats a tracker that throws as a sync that is off', async () => {
            storage.close()
            storage = createLibraryStorage({
                indexedDB: tracked.factory,
                changes: {
                    isOn: () => {
                        throw new Error('broken')
                    },
                    onChange,
                },
            })
            await addBook('a')

            expect(await storage.getBook('a')).toEqual(makeBook('a'))
            expect(await readOutbox()).toEqual([])
        })

        it('asks to send a new book and its file, in the transaction of the book', async () => {
            await addBook('a', { addedAt: 1500 })

            expect(tracked.transactions.at(-1)).toEqual({
                stores: ['books', 'files', 'covers', 'outbox'],
                mode: 'readwrite',
            })
            expect(await readOutbox()).toEqual([
                entry('book', 'hash-a', false, 1500),
                entry('file', 'hash-a', false, 1500),
            ])
            expect(onChange).toHaveBeenCalledTimes(1)
        })

        it('uses the time of the change for a changed book', async () => {
            await addBook('a')
            await storage.updateBook('a', { lastOpenedAt: 5000 })
            await storage.updateBook('missing', { lastOpenedAt: 5000 })

            expect(await readOutbox()).toContainEqual(entry('book', 'hash-a', false, 9000))
            expect(await readOutbox()).toHaveLength(2)
        })

        it('keys the progress by the file hash and versions it by its own time', async () => {
            await addBook('a')
            await storage.saveProgress(makeProgress('a', { updatedAt: 2500 }))
            // A position of a book that is not in the library has no file hash.
            await storage.saveProgress(makeProgress('missing'))

            expect(tracked.transactions.at(-1)).toEqual({
                stores: ['progress', 'books', 'outbox'],
                mode: 'readwrite',
            })
            expect(await readOutbox()).toContainEqual(entry('progress', 'hash-a', false, 2500))
            expect(await readOutbox()).toHaveLength(3)
        })

        it('replaces the entry of a record with its later change', async () => {
            await storage.putBookmark(makeBookmark('m', { createdAt: 3100 }))
            await storage.putHighlight(makeHighlight('h', { updatedAt: 4100 }))
            expect(await readOutbox()).toEqual([
                entry('bookmark', 'm', false, 3100),
                entry('highlight', 'h', false, 4100),
            ])

            await storage.deleteBookmark('m')
            await storage.deleteHighlight('h')
            expect(await readOutbox()).toEqual([
                entry('bookmark', 'm', true, 9000),
                entry('highlight', 'h', true, 9000),
            ])
            expect(onChange).toHaveBeenCalledTimes(4)
        })

        it('marks a removed book, its progress and its notes as deleted', async () => {
            await addBook('a')
            await addBook('b')
            await storage.saveProgress(makeProgress('a'))
            await storage.putBookmark(makeBookmark('m', { bookId: 'a' }))
            await storage.putHighlight(makeHighlight('h', { bookId: 'a' }))
            await storage.putHighlight(makeHighlight('other', { bookId: 'b' }))

            await storage.deleteBook('a')

            const outbox = await readOutbox()
            expect(outbox).toEqual(
                expect.arrayContaining([
                    entry('book', 'hash-a', true, 9000),
                    entry('progress', 'hash-a', true, 9000),
                    entry('bookmark', 'm', true, 9000),
                    entry('highlight', 'h', true, 9000),
                    entry('highlight', 'other', false, 4000),
                ]),
            )
            // A file that the sync did not upload yet must not upload after the delete.
            expect(outbox.find((item) => item.id === 'file:hash-a')).toBeUndefined()
            expect(outbox.find((item) => item.id === 'file:hash-b')).toBeDefined()
        })

        it('gives a book with no file on this device its file', async () => {
            await addBook('a', { remoteOnly: true })
            await storage.putFile('a', new Blob(['downloaded']))

            expect(await storage.getBook('a')).toEqual(makeBook('a'))
            expect(await (await storage.getFile('a'))?.text()).toBe('downloaded')
            expect(await readOutbox()).toContainEqual(entry('file', 'hash-a', false, 9000))
        })
    })

    describe('connection', () => {
        it('opens the database again after close()', async () => {
            await addBook('a')

            storage.close()

            expect(await storage.listBooks()).toEqual([makeBook('a')])
            expect(await (await storage.getFile('a'))?.text()).toBe('file of a')
            expect(tracked.openCount()).toBe(2)
        })

        it('opens the database again after the browser closed the connection', async () => {
            await addBook('a')

            forceCloseDatabase(tracked.connections[0] as never)
            await storage.saveProgress(makeProgress('a'))

            expect(await storage.getProgress('a')).toEqual(makeProgress('a'))
            expect(tracked.openCount()).toBe(2)
        })

        it('opens the database again when the connection is closed and no event arrived', async () => {
            await addBook('a')

            tracked.connections[0].close()
            await storage.saveProgress(makeProgress('a'))

            expect(await storage.getProgress('a')).toEqual(makeProgress('a'))
            expect(await storage.listBooks()).toEqual([makeBook('a')])
            expect(tracked.openCount()).toBe(2)
        })

        it('keeps the data of two storages with different database names apart', async () => {
            const other = createLibraryStorage({
                indexedDB: tracked.factory,
                databaseName: 'other-library',
            })
            await addBook('a')

            expect(await other.listBooks()).toEqual([])
            other.close()
        })

        it('rejects with a clear error when IndexedDB is not available', async () => {
            const unavailable = createLibraryStorage()

            await expect(unavailable.listBooks()).rejects.toThrow(
                'Book storage is not available in this browser.',
            )
        })
    })
})
