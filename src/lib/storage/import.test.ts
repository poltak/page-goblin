import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { createHash } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeBook, type FakeBookOptions } from '$lib/epub/testing/fake-book'
import { EpubError, type EpubBook } from '$lib/epub/types'
import { DATABASE_NAME } from './db'
import { importBook, type ImportBookOptions, type ImportProgress } from './import'
import { createLibraryStorage } from './library-storage'
import { estimateTextStats } from './text-stats'
import type { BookRecord, LibraryStorage, NewBook } from './types'

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

const CHAPTER_1 = '<html><body><h1>One</h1><p>The first chapter has seven words.</p></body></html>'
const CHAPTER_2 = '<html><body><p>Two &amp; a half.</p><script>skip()</script></body></html>'
const COVER_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

// The bytes do not have to be an EPUB, because the test gives its own `open` function.
function makeFile(content = 'the bytes of the file', name = 'my-book.epub'): File {
    return new File([content], name, { type: 'application/epub+zip' })
}

function makeBook(changes: Partial<FakeBookOptions> = {}): EpubBook {
    return createFakeBook({
        files: {
            'OEBPS/one.xhtml': CHAPTER_1,
            'OEBPS/two.xhtml': CHAPTER_2,
            'OEBPS/cover.jpg': COVER_BYTES,
        },
        spine: ['OEBPS/one.xhtml', 'OEBPS/two.xhtml'],
        coverPath: 'OEBPS/cover.jpg',
        metadata: {
            title: 'The Title',
            author: 'First Author, Second Author',
            creators: ['First Author', 'Second Author'],
            language: 'en-GB',
            identifier: 'urn:isbn:9780000000000',
            publisher: 'A Publisher',
            description: 'About the book.',
            published: '2001-02-03',
            subjects: ['Fiction', 'Sea stories'],
            series: { name: 'The Series', position: 3 },
        },
        ...changes,
    })
}

describe('importBook', () => {
    let factory: IDBFactory
    // The type that the app gives to the import. The object also has `putFile`.
    let storage: LibraryStorage

    beforeEach(() => {
        // A jsdom Blob does not survive structuredClone, which fake-indexeddb uses to store a
        // value. The Blob and File of Node do, as a Blob does in a browser.
        vi.stubGlobal('Blob', NodeBlob)
        vi.stubGlobal('File', NodeFile)
        factory = new IDBFactory()
        storage = createLibraryStorage({ indexedDB: factory })
    })

    /** Remove only the file of a book, as a browser does that lost a part of its data. */
    function deleteStoredFile(id: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = factory.open(DATABASE_NAME)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
                const db = request.result
                const transaction = db.transaction('files', 'readwrite')
                transaction.objectStore('files').delete(id)
                transaction.onerror = () => reject(transaction.error)
                transaction.oncomplete = () => {
                    db.close()
                    resolve()
                }
            }
        })
    }

    afterEach(() => {
        storage.close()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('makes the record from the book and the file', async () => {
        const file = makeFile()
        const open = vi.fn(async () => makeBook())

        const result = await importBook({ file, storage, open, now: () => 1_700_000_000_000 })

        expect(result.duplicate).toBe(false)
        expect(open).toHaveBeenCalledOnce()
        expect(result.book.id).toMatch(UUID_V4)
        expect(result.book).toEqual({
            id: result.book.id,
            title: 'The Title',
            author: 'First Author, Second Author',
            language: 'en-GB',
            identifier: 'urn:isbn:9780000000000',
            publisher: 'A Publisher',
            description: 'About the book.',
            published: '2001-02-03',
            subjects: ['Fiction', 'Sea stories'],
            series: { name: 'The Series', position: 3 },
            fileName: 'my-book.epub',
            fileSize: 21,
            fileHash: createHash('sha256').update('the bytes of the file').digest('hex'),
            hasCover: true,
            // 'One The first chapter has seven words.' and 'Two & a half.'
            spineStats: [
                { chars: 38, words: 7 },
                { chars: 13, words: 4 },
            ],
            totalChars: 51,
            totalWords: 11,
            addedAt: 1_700_000_000_000,
            lastOpenedAt: null,
        })
        expect(result.book.spineStats).toEqual([
            estimateTextStats(CHAPTER_1),
            estimateTextStats(CHAPTER_2),
        ])
    })

    it('stores the record, the original file and the cover', async () => {
        const { book } = await importBook({
            file: makeFile(),
            storage,
            open: async () => makeBook(),
        })

        expect(await storage.listBooks()).toEqual([book])
        expect(await storage.findBookByHash(book.fileHash)).toEqual(book)
        expect(await (await storage.getFile(book.id))?.text()).toBe('the bytes of the file')

        // jsdom cannot decode an image, so the cover is the original image.
        const cover = await storage.getCover(book.id)
        expect(cover?.type).toBe('image/jpeg')
        expect(new Uint8Array((await cover?.arrayBuffer()) ?? [])).toEqual(COVER_BYTES)
    })

    it('reads the file one time and gives the same copy to the parser and the storage', async () => {
        const file = makeFile()
        const arrayBuffer = vi.spyOn(file, 'arrayBuffer')
        const open = vi.fn(async (_file: Blob) => makeBook())
        const addBook = vi.fn(async (_book: NewBook) => undefined)

        await importBook({
            file,
            storage: { findBookByHash: async () => undefined, addBook },
            open,
        })

        expect(arrayBuffer).toHaveBeenCalledOnce()
        const copy = open.mock.calls[0][0]
        expect(copy).not.toBe(file)
        expect(copy.type).toBe('application/epub+zip')
        expect(await copy.text()).toBe('the bytes of the file')
        expect(addBook.mock.calls[0][0].file).toBe(copy)
    })

    it('gives the copy the EPUB media type when the file has no type', async () => {
        const open = vi.fn(async (_file: Blob) => makeBook())

        await importBook({ file: new Blob(['bytes']), storage, open })

        expect(open.mock.calls[0][0].type).toBe('application/epub+zip')
    })

    it('uses the time of the call when there is no clock input', async () => {
        const before = Date.now()

        const { book } = await importBook({
            file: makeFile(),
            storage,
            open: async () => makeBook(),
        })

        expect(book.addedAt).toBeGreaterThanOrEqual(before)
        expect(book.addedAt).toBeLessThanOrEqual(Date.now())
    })

    it('uses "book.epub" as the name of a file that has no name', async () => {
        const blob = new Blob(['the bytes of the file'])

        const { book } = await importBook({ file: blob, storage, open: async () => makeBook() })

        expect(book.fileName).toBe('book.epub')
        expect(book.fileSize).toBe(21)
    })

    it('does not share the subjects and the series with the book object', async () => {
        const epub = makeBook()

        const { book } = await importBook({ file: makeFile(), storage, open: async () => epub })

        expect(book.subjects).not.toBe(epub.metadata.subjects)
        expect(book.series).not.toBe(epub.metadata.series)
    })

    describe('duplicate', () => {
        it('gives the record that is there when the same file is imported again', async () => {
            const open = vi.fn(async () => makeBook())
            const first = await importBook({ file: makeFile(), storage, open, now: () => 1000 })

            const second = await importBook({
                file: makeFile('the bytes of the file', 'a-copy.epub'),
                storage,
                open,
                now: () => 2000,
            })

            expect(second).toEqual({ book: first.book, duplicate: true })
            expect(open).toHaveBeenCalledOnce()
            expect(await storage.listBooks()).toEqual([first.book])
        })

        it('stores one book when two imports of the same file run at the same time', async () => {
            const open = vi.fn(async () => makeBook())

            const results = await Promise.all([
                importBook({ file: makeFile(), storage, open }),
                importBook({
                    file: makeFile('the bytes of the file', 'a-copy.epub'),
                    storage,
                    open,
                }),
            ])

            const books = await storage.listBooks()
            expect(books).toHaveLength(1)
            expect(results.map((result) => result.duplicate).sort()).toEqual([false, true])
            expect(results[0].book).toEqual(books[0])
            expect(results[1].book).toEqual(books[0])
        })

        it('reports a save that the storage refused as a duplicate only when the book is there', async () => {
            const error = new DOMException('The key is in use.', 'ConstraintError')
            const findBookByHash = vi.fn(async () => undefined)

            const pending = importBook({
                file: makeFile(),
                storage: { findBookByHash, addBook: () => Promise.reject(error) },
                open: async () => makeBook(),
            })

            await expect(pending).rejects.toBe(error)
            expect(findBookByHash).toHaveBeenCalledTimes(2)
        })

        it('gives its file to a book that the sync added with no file', async () => {
            const open = vi.fn(async () => makeBook())
            const first = await importBook({ file: makeFile(), storage, open })
            await deleteStoredFile(first.book.id)
            await storage.updateBook(first.book.id, { remoteOnly: true })

            const second = await importBook({ file: makeFile(), storage, open })

            expect(second).toEqual({ book: first.book, duplicate: true })
            expect(second.book.remoteOnly).toBeUndefined()
            expect(await (await storage.getFile(first.book.id))?.text()).toBe(
                'the bytes of the file',
            )
        })

        it('keeps the file when the sync adds the same book during the import', async () => {
            const synced = {
                ...(await importBook({ file: makeFile(), storage, open: async () => makeBook() }))
                    .book,
            }
            const record = { ...synced, remoteOnly: true }
            const putFile = vi.fn(async () => {})
            const findBookByHash = vi
                .fn<(hash: string) => Promise<BookRecord | undefined>>()
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(record)
                .mockResolvedValueOnce(synced)
            const error = new DOMException('The key is in use.', 'ConstraintError')

            const result = await importBook({
                file: makeFile(),
                storage: {
                    findBookByHash,
                    addBook: () => Promise.reject(error),
                    getFile: async () => undefined,
                    putFile,
                },
                open: async () => makeBook(),
            })

            expect(putFile).toHaveBeenCalledOnce()
            expect(result).toEqual({ book: synced, duplicate: true })
        })

        it('imports a file with different bytes as a new book', async () => {
            const open = async () => makeBook()
            const first = await importBook({ file: makeFile('first bytes'), storage, open })

            const second = await importBook({ file: makeFile('second bytes'), storage, open })

            expect(second.duplicate).toBe(false)
            expect(second.book.id).not.toBe(first.book.id)
            expect(second.book.fileHash).not.toBe(first.book.fileHash)
            expect(await storage.listBooks()).toHaveLength(2)
        })
    })

    describe('duplicate of a book whose stored file is missing', () => {
        const record = { id: 'the-book', title: 'The Title' } as BookRecord

        /** A storage that has the book. The test gives the answer of `getFile`. */
        function storageWith(getFile: () => Promise<Blob | undefined>) {
            return {
                findBookByHash: vi.fn(async () => record),
                addBook: vi.fn(async (_book: NewBook) => undefined),
                getFile: vi.fn(getFile),
                putFile: vi.fn(async (_id: string, _file: Blob) => undefined),
            } satisfies ImportBookOptions['storage']
        }

        it('stores the file again and keeps the record, the cover and the position', async () => {
            const open = vi.fn(async () => makeBook())
            const first = await importBook({ file: makeFile(), storage, open, now: () => 1000 })
            const { id } = first.book
            const progress = {
                bookId: id,
                locator: { spineIndex: 1, offset: 5 },
                fraction: 0.5,
                updatedAt: 1500,
            }
            await storage.saveProgress(progress)
            await deleteStoredFile(id)
            expect(await storage.getFile(id)).toBeUndefined()

            const second = await importBook({
                file: makeFile('the bytes of the file', 'a-copy.epub'),
                storage,
                open,
                now: () => 2000,
            })

            expect(second).toEqual({ book: first.book, duplicate: true })
            expect(open).toHaveBeenCalledOnce()
            const stored = await storage.getFile(id)
            expect(stored?.type).toBe('application/epub+zip')
            expect(await stored?.text()).toBe('the bytes of the file')
            expect(await storage.listBooks()).toEqual([first.book])
            expect(await storage.getProgress(id)).toEqual(progress)
            expect((await storage.getCover(id))?.type).toBe('image/jpeg')
        })

        it('reports only the hash phase', async () => {
            const { book } = await importBook({
                file: makeFile(),
                storage,
                open: async () => makeBook(),
            })
            await deleteStoredFile(book.id)
            const events: ImportProgress[] = []

            await importBook({
                file: makeFile(),
                storage,
                open: async () => makeBook(),
                onProgress: (progress) => events.push(progress),
            })

            expect(events).toEqual([
                { phase: 'hash', done: 0, total: 1 },
                { phase: 'hash', done: 1, total: 1 },
            ])
        })

        it('does not write the file when the library has it', async () => {
            const fake = storageWith(async () => new Blob(['the bytes of the file']))

            const result = await importBook({
                file: makeFile(),
                storage: fake,
                open: async () => makeBook(),
            })

            expect(result).toEqual({ book: record, duplicate: true })
            expect(fake.getFile).toHaveBeenCalledWith('the-book')
            expect(fake.putFile).not.toHaveBeenCalled()
            expect(fake.addBook).not.toHaveBeenCalled()
        })

        it('gives the copy of the added file to the storage', async () => {
            const fake = storageWith(async () => undefined)

            const result = await importBook({
                file: makeFile(),
                storage: fake,
                open: async () => makeBook(),
            })

            expect(result).toEqual({ book: record, duplicate: true })
            expect(fake.putFile).toHaveBeenCalledOnce()
            const [id, copy] = fake.putFile.mock.calls[0]
            expect(id).toBe('the-book')
            expect(copy.type).toBe('application/epub+zip')
            expect(await copy.text()).toBe('the bytes of the file')
            expect(fake.addBook).not.toHaveBeenCalled()
        })

        it('stores the file again when the browser cannot read the stored file', async () => {
            const lost = new Blob(['the bytes of the file'])
            vi.spyOn(lost, 'slice').mockReturnValue({
                arrayBuffer: () => Promise.reject(new DOMException('Lost.', 'NotReadableError')),
            } as Blob)
            const fake = storageWith(async () => lost)

            await importBook({ file: makeFile(), storage: fake, open: async () => makeBook() })

            expect(fake.putFile).toHaveBeenCalledOnce()
        })

        it('stores the file again when the stored file has a different size', async () => {
            const fake = storageWith(async () => new Blob([]))

            await importBook({ file: makeFile(), storage: fake, open: async () => makeBook() })

            expect(fake.putFile).toHaveBeenCalledOnce()
        })

        it('stores the file again when the storage cannot give the stored file', async () => {
            const fake = storageWith(() => Promise.reject(new Error('Unable to read.')))

            await importBook({ file: makeFile(), storage: fake, open: async () => makeBook() })

            expect(fake.putFile).toHaveBeenCalledOnce()
        })

        it('lets an error of the write pass to the caller', async () => {
            const error = new DOMException('No space.', 'QuotaExceededError')
            const fake = storageWith(async () => undefined)
            fake.putFile.mockRejectedValue(error)

            const pending = importBook({
                file: makeFile(),
                storage: fake,
                open: async () => makeBook(),
            })

            await expect(pending).rejects.toBe(error)
        })

        it('gives the record when the storage cannot write a file', async () => {
            const getFile = vi.fn(async () => undefined)

            const result = await importBook({
                file: makeFile(),
                storage: {
                    findBookByHash: async () => record,
                    addBook: async () => undefined,
                    getFile,
                },
                open: async () => makeBook(),
            })

            expect(result).toEqual({ book: record, duplicate: true })
            expect(getFile).not.toHaveBeenCalled()
        })
    })

    describe('errors', () => {
        it('lets an EpubError pass to the caller and stores nothing', async () => {
            const error = new EpubError('drm', 'This book has DRM protection.')
            const onProgress = vi.fn()

            const pending = importBook({
                file: makeFile(),
                storage,
                open: () => Promise.reject(error),
                onProgress,
            })

            await expect(pending).rejects.toBe(error)
            expect(await storage.listBooks()).toEqual([])
            expect(onProgress).toHaveBeenLastCalledWith({ phase: 'open', done: 0, total: 1 })
        })

        it('lets a storage error pass to the caller', async () => {
            const error = new DOMException('No space.', 'QuotaExceededError')
            const failing: Pick<LibraryStorage, 'findBookByHash' | 'addBook'> = {
                findBookByHash: async () => undefined,
                addBook: () => Promise.reject(error),
            }

            const pending = importBook({
                file: makeFile(),
                storage: failing,
                open: async () => makeBook(),
            })

            await expect(pending).rejects.toBe(error)
        })
    })

    describe('cover', () => {
        it('imports a book that has no cover', async () => {
            const { book } = await importBook({
                file: makeFile(),
                storage,
                open: async () => makeBook({ coverPath: null }),
            })

            expect(book.hasCover).toBe(false)
            expect(await storage.getCover(book.id)).toBeUndefined()
        })

        it('imports the book when the cover cannot be read', async () => {
            const { book } = await importBook({
                file: makeFile(),
                storage,
                open: async () => makeBook({ coverPath: 'OEBPS/missing.jpg' }),
            })

            expect(book.hasCover).toBe(false)
            expect(book.totalWords).toBe(11)
            expect(await storage.getCover(book.id)).toBeUndefined()
            expect(await storage.getBook(book.id)).toEqual(book)
        })

        it('imports the book with no cover when the cover is too large to keep', async () => {
            const epub = makeBook({
                files: {
                    'OEBPS/one.xhtml': CHAPTER_1,
                    'OEBPS/cover.jpg': new Uint8Array(2 * 1024 * 1024),
                },
                spine: ['OEBPS/one.xhtml'],
            })

            const { book } = await importBook({ file: makeFile(), storage, open: async () => epub })

            expect(book.hasCover).toBe(false)
            expect(await storage.getCover(book.id)).toBeUndefined()
        })

        it('stores the small image when the browser can make one', async () => {
            const bitmap = { width: 1200, height: 1800, close: vi.fn() }
            vi.stubGlobal('createImageBitmap', async () => bitmap)
            vi.stubGlobal(
                'OffscreenCanvas',
                class {
                    getContext() {
                        return { fillRect: vi.fn(), drawImage: vi.fn() }
                    }
                    async convertToBlob() {
                        return new Blob(['a small jpeg'], { type: 'image/jpeg' })
                    }
                },
            )

            const { book } = await importBook({
                file: makeFile(),
                storage,
                open: async () => makeBook(),
            })

            expect(book.hasCover).toBe(true)
            expect(await (await storage.getCover(book.id))?.text()).toBe('a small jpeg')
            expect(bitmap.close).toHaveBeenCalledOnce()
        })
    })

    describe('spine', () => {
        it('gives zero to a spine item that cannot be read and measures the others', async () => {
            const epub = makeBook({
                spine: ['OEBPS/one.xhtml', 'OEBPS/missing.xhtml', 'OEBPS/two.xhtml'],
            })

            const { book } = await importBook({ file: makeFile(), storage, open: async () => epub })

            expect(book.spineStats).toEqual([
                { chars: 38, words: 7 },
                { chars: 0, words: 0 },
                { chars: 13, words: 4 },
            ])
            expect(book.totalChars).toBe(51)
            expect(book.totalWords).toBe(11)
            expect(await storage.getBook(book.id)).toEqual(book)
        })

        it('reads each spine item one time, in reading order', async () => {
            const epub = makeBook()
            const readText = vi.spyOn(epub, 'readText')

            await importBook({ file: makeFile(), storage, open: async () => epub })

            expect(readText.mock.calls).toEqual([['OEBPS/one.xhtml'], ['OEBPS/two.xhtml']])
        })

        it('imports a book with an empty spine', async () => {
            const epub = makeBook({ spine: [] })

            const { book } = await importBook({ file: makeFile(), storage, open: async () => epub })

            expect(book.spineStats).toEqual([])
            expect(book.totalChars).toBe(0)
            expect(book.totalWords).toBe(0)
        })
    })

    describe('progress events', () => {
        it('reports each phase in sequence', async () => {
            const events: ImportProgress[] = []

            await importBook({
                file: makeFile(),
                storage,
                open: async () => makeBook(),
                onProgress: (progress) => events.push({ ...progress }),
            })

            expect(events).toEqual([
                { phase: 'hash', done: 0, total: 1 },
                { phase: 'hash', done: 1, total: 1 },
                { phase: 'open', done: 0, total: 1 },
                { phase: 'open', done: 1, total: 1 },
                { phase: 'cover', done: 0, total: 1 },
                { phase: 'cover', done: 1, total: 1 },
                { phase: 'measure', done: 0, total: 2 },
                { phase: 'measure', done: 1, total: 2 },
                { phase: 'measure', done: 2, total: 2 },
                { phase: 'save', done: 0, total: 1 },
                { phase: 'save', done: 1, total: 1 },
            ])
        })

        it('reports the save as done only after the book is in the storage', async () => {
            let storedAtLastEvent = -1

            await importBook({
                file: makeFile(),
                storage,
                open: async () => makeBook(),
                onProgress: async ({ phase, done }) => {
                    if (phase === 'save' && done === 1) {
                        storedAtLastEvent = (await storage.listBooks()).length
                    }
                },
            })
            await vi.waitFor(() => expect(storedAtLastEvent).toBe(1))
        })

        it('reports only the hash phase for a duplicate', async () => {
            const open = async () => makeBook()
            await importBook({ file: makeFile(), storage, open })
            const events: ImportProgress[] = []

            await importBook({
                file: makeFile(),
                storage,
                open,
                onProgress: (progress) => events.push(progress),
            })

            expect(events).toEqual([
                { phase: 'hash', done: 0, total: 1 },
                { phase: 'hash', done: 1, total: 1 },
            ])
        })
    })

    describe('main thread', () => {
        // A storage with no IndexedDB, so the only timers are the timers of the import.
        const memoryStorage: Pick<LibraryStorage, 'findBookByHash' | 'addBook'> = {
            findBookByHash: async () => undefined,
            addBook: async () => undefined,
        }

        function makeLongBook(): EpubBook {
            const paths = Array.from({ length: 10 }, (_, index) => `OEBPS/chapter-${index}.xhtml`)
            return makeBook({
                files: Object.fromEntries(paths.map((path) => [path, CHAPTER_1])),
                spine: paths,
                coverPath: null,
            })
        }

        /** Each read of the clock moves it by `step` milliseconds. */
        function stubClock(step: number): void {
            let time = 0
            vi.spyOn(performance, 'now').mockImplementation(() => (time += step))
        }

        it('gives control back with scheduler.yield after more than 12 ms of work', async () => {
            const schedulerYield = vi.fn(async () => undefined)
            vi.stubGlobal('scheduler', { yield: schedulerYield })
            // The loop reads the clock one time for each chapter and one time after a yield.
            // With 5 ms for each read, the limit is passed at each third chapter.
            stubClock(5)

            const { book } = await importBook({
                file: makeFile(),
                storage: memoryStorage,
                open: async () => makeLongBook(),
            })

            expect(book.spineStats).toHaveLength(10)
            expect(schedulerYield).toHaveBeenCalledTimes(3)
        })

        it('gives control back with a timer when there is no scheduler.yield', async () => {
            expect(globalThis.scheduler).toBeUndefined()
            stubClock(5)
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
            let timersBeforeMeasure = 0

            const { book } = await importBook({
                file: makeFile(),
                storage: memoryStorage,
                open: async () => makeLongBook(),
                onProgress: ({ phase, done }) => {
                    if (phase === 'measure' && done === 0) {
                        timersBeforeMeasure = setTimeoutSpy.mock.calls.length
                    }
                },
            })

            const timers = setTimeoutSpy.mock.calls.slice(timersBeforeMeasure)
            expect(book.spineStats).toHaveLength(10)
            expect(timers).toHaveLength(3)
            expect(timers.every(([, delay]) => delay === 0)).toBe(true)
        })

        it('does not give control back when the work is short', async () => {
            const schedulerYield = vi.fn(async () => undefined)
            vi.stubGlobal('scheduler', { yield: schedulerYield })
            stubClock(0.5)

            await importBook({
                file: makeFile(),
                storage: memoryStorage,
                open: async () => makeLongBook(),
            })

            expect(schedulerYield).not.toHaveBeenCalled()
        })
    })
})
