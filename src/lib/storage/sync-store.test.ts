import { Blob as NodeBlob } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLibraryStorage, type LibraryFileStorage } from './library-storage'
import { createSyncStore, FIRST_SYNC_KINDS, isNewer, type SyncStore } from './sync-store'
import type {
    BookmarkRecord,
    BookRecord,
    FontRecord,
    HighlightRecord,
    OutboxEntry,
    ProgressRecord,
    SyncBookValue,
    SyncItem,
} from './types'

function makeFont(id: string, hashes: string[], changes: Partial<FontRecord> = {}): FontRecord {
    return {
        id,
        name: `Font ${id}`,
        fallback: 'serif',
        faces: hashes.map((hash) => ({
            hash,
            format: 'truetype' as const,
            weight: '400',
            style: 'normal' as const,
            stretch: '100%',
            size: 10,
        })),
        addedAt: 500,
        updatedAt: 600,
        ...changes,
    }
}

function fontItem(font: FontRecord, updatedAt = font.updatedAt): SyncItem {
    const { id, ...value } = font
    return { kind: 'font', key: id, updatedAt, deleted: false, value }
}

function makeBook(id: string, changes: Partial<BookRecord> = {}): BookRecord {
    return {
        id,
        title: `Title ${id}`,
        author: 'An Author',
        language: 'en',
        identifier: null,
        publisher: null,
        description: null,
        published: null,
        subjects: [],
        series: null,
        fileName: `${id}.epub`,
        fileSize: 3,
        fileHash: `hash-${id}`,
        hasCover: true,
        spineStats: [{ chars: 100, words: 20 }],
        totalChars: 100,
        totalWords: 20,
        addedAt: 1000,
        lastOpenedAt: null,
        ...changes,
    }
}

function bookValue(id: string, changes: Partial<SyncBookValue> = {}): SyncBookValue {
    const { id: _, ...value } = makeBook(id)
    return { ...value, ...changes }
}

function makeProgress(bookId: string, updatedAt = 2000): ProgressRecord {
    return { bookId, locator: { spineIndex: 0, offset: 42 }, fraction: 0.5, updatedAt }
}

function makeBookmark(id: string, bookId: string): BookmarkRecord {
    return {
        id,
        bookId,
        locator: { spineIndex: 0, offset: 5 },
        fraction: 0.1,
        chapterTitle: 'One',
        excerpt: 'The first words',
        createdAt: 3000,
    }
}

function makeHighlight(id: string, bookId: string, updatedAt = 4000): HighlightRecord {
    return {
        id,
        bookId,
        spineIndex: 0,
        start: 0,
        end: 4,
        text: 'some',
        color: 'yellow',
        note: '',
        chapterTitle: 'One',
        fraction: 0.2,
        createdAt: 4000,
        updatedAt,
    }
}

function deletedItem(kind: SyncItem['kind'], key: string, updatedAt: number): SyncItem {
    return { kind, key, updatedAt, deleted: true, value: null }
}

describe('isNewer', () => {
    it('lets the later time win, and a delete at the same time', () => {
        expect(isNewer({ updatedAt: 2, deleted: false }, { updatedAt: 1, deleted: true })).toBe(
            true,
        )
        expect(isNewer({ updatedAt: 1, deleted: true }, { updatedAt: 1, deleted: false })).toBe(
            true,
        )
        expect(isNewer({ updatedAt: 1, deleted: false }, { updatedAt: 1, deleted: false })).toBe(
            false,
        )
        expect(isNewer({ updatedAt: 1, deleted: true }, { updatedAt: 2, deleted: false })).toBe(
            false,
        )
    })
})

describe('createSyncStore', () => {
    let storage: LibraryFileStorage
    let sync: SyncStore
    let syncOn: boolean

    beforeEach(() => {
        vi.stubGlobal('Blob', NodeBlob)
        syncOn = false
        storage = createLibraryStorage({
            indexedDB: new IDBFactory(),
            changes: { isOn: () => syncOn, onChange: () => {} },
            now: () => 9000,
        })
        sync = createSyncStore(storage.database)
    })

    afterEach(() => {
        storage.close()
        vi.unstubAllGlobals()
    })

    function addBook(id: string, changes: Partial<BookRecord> = {}): Promise<void> {
        return storage.addBook({
            record: makeBook(id, changes),
            file: new Blob([`file of ${id}`]),
            cover: null,
        })
    }

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

    describe('seedOutbox', () => {
        it('adds an entry for each record, with the time of the record', async () => {
            await addBook('a', { lastOpenedAt: 1500 })
            await addBook('b', { remoteOnly: true })
            await storage.saveProgress(makeProgress('a'))
            await storage.putBookmark(makeBookmark('m', 'a'))
            await storage.putHighlight(makeHighlight('h', 'a'))
            // A note of a book that is not there does not go to the server.
            await storage.putHighlight(makeHighlight('lost', 'gone'))

            await sync.seedOutbox()

            expect(await readOutbox()).toEqual([
                { id: 'book:hash-a', kind: 'book', key: 'hash-a', deleted: false, changedAt: 1000 },
                { id: 'book:hash-b', kind: 'book', key: 'hash-b', deleted: false, changedAt: 1000 },
                { id: 'bookmark:m', kind: 'bookmark', key: 'm', deleted: false, changedAt: 3000 },
                { id: 'file:hash-a', kind: 'file', key: 'hash-a', deleted: false, changedAt: 1000 },
                { id: 'highlight:h', kind: 'highlight', key: 'h', deleted: false, changedAt: 4000 },
                {
                    id: 'progress:hash-a',
                    kind: 'progress',
                    key: 'hash-a',
                    deleted: false,
                    changedAt: 2000,
                },
            ])
        })

        it('keeps the entries that are there', async () => {
            await addBook('a')
            syncOn = true
            await storage.updateBook('a', { title: 'A new title' })

            await sync.seedOutbox()

            expect((await readOutbox()).find((entry) => entry.kind === 'book')?.changedAt).toBe(
                9000,
            )
        })
    })

    describe('readOutbox', () => {
        it('gives the values without local ids, books first', async () => {
            syncOn = true
            await addBook('a')
            await storage.putHighlight(makeHighlight('h', 'a'))
            await storage.saveProgress(makeProgress('a'))
            await storage.putBookmark(makeBookmark('m', 'a'))

            const batch = await sync.readOutbox(10)

            expect(batch.changes.map(({ item }) => item.kind)).toEqual([
                'book',
                'progress',
                'bookmark',
                'highlight',
            ])
            expect(batch.changes[0].item).toEqual({
                kind: 'book',
                key: 'hash-a',
                updatedAt: 1000,
                deleted: false,
                value: bookValue('a'),
            })
            expect(batch.changes[1].item.value).toEqual({
                fileHash: 'hash-a',
                locator: { spineIndex: 0, offset: 42 },
                fraction: 0.5,
                updatedAt: 2000,
            })
            const { bookId: _, ...bookmark } = makeBookmark('m', 'a')
            expect(batch.changes[2].item.value).toEqual({ ...bookmark, fileHash: 'hash-a' })
            expect(batch.files).toEqual([
                {
                    entry: expect.objectContaining({ id: 'file:hash-a' }),
                    bookId: 'a',
                    hasCover: true,
                },
            ])
            expect(batch.stale).toEqual([])
        })

        it('takes only the first records and the first files', async () => {
            syncOn = true
            await addBook('a')
            await addBook('b', { addedAt: 900 })
            await storage.putHighlight(makeHighlight('h', 'a'))

            const batch = await sync.readOutbox(1)

            expect(batch.changes.map(({ entry }) => entry.id)).toEqual(['book:hash-a'])
            // The file that waited longest comes first.
            expect(batch.files.map(({ entry }) => entry.id)).toEqual(['file:hash-b'])
        })

        it('gives the records even when many files wait', async () => {
            syncOn = true
            for (const id of ['a', 'b', 'c']) await addBook(id)
            await sync.removeOutbox((await readOutbox()).filter((entry) => entry.kind === 'book'))
            await storage.putHighlight(makeHighlight('h', 'a'))

            const batch = await sync.readOutbox(2)

            expect(batch.changes.map(({ entry }) => entry.id)).toEqual(['highlight:h'])
            expect(batch.files).toHaveLength(2)
        })

        it('moves a file that did not upload to the end', async () => {
            syncOn = true
            await addBook('a', { addedAt: 100 })
            await addBook('b', { addedAt: 200 })
            const [first] = (await sync.readOutbox(1)).files

            await sync.postponeUpload(first.entry, 5000)

            expect((await sync.readOutbox(1)).files[0].entry.id).toBe('file:hash-b')
        })

        it('sends a delete with no value and reports entries of lost records', async () => {
            syncOn = true
            await addBook('a')
            await storage.deleteBookmark('m')
            await storage.putBookmark(makeBookmark('orphan', 'gone'))

            const batch = await sync.readOutbox(10)

            expect(batch.changes.map(({ item }) => item)).toContainEqual(
                deletedItem('bookmark', 'm', 9000),
            )
            expect(batch.stale.map((entry) => entry.id)).toEqual(['bookmark:orphan'])
        })
    })

    describe('removeOutbox', () => {
        it('keeps an entry that changed after the read', async () => {
            syncOn = true
            await addBook('a')
            await storage.putHighlight(makeHighlight('h', 'a', 4000))
            const batch = await sync.readOutbox(10)
            await storage.putHighlight(makeHighlight('h', 'a', 4500))

            await sync.removeOutbox([
                ...batch.changes.map(({ entry }) => entry),
                ...batch.files.map(({ entry }) => entry),
            ])

            expect(await readOutbox()).toEqual([
                {
                    id: 'highlight:h',
                    kind: 'highlight',
                    key: 'h',
                    deleted: false,
                    changedAt: 4500,
                },
            ])
        })
    })

    describe('applyRemote', () => {
        it('adds a book from the server with no file and saves the state', async () => {
            const result = await sync.applyRemote({
                items: [
                    {
                        kind: 'book',
                        key: 'hash-a',
                        updatedAt: 1000,
                        deleted: false,
                        value: bookValue('a'),
                    },
                ],
                state: { account: 'acc', cursor: 7 },
            })

            const books = await storage.listBooks()
            expect(books).toHaveLength(1)
            expect(books[0]).toEqual({ ...makeBook('a'), id: books[0].id, remoteOnly: true })
            expect(books[0].id).not.toBe('a')
            expect(result.books).toEqual([books[0].id])
            expect(await sync.readState()).toEqual({ account: 'acc', cursor: 7 })
            // A change from the server does not go back to it.
            expect(await readOutbox()).toEqual([])
        })

        it('changes a book and keeps its local id, its file and its last open', async () => {
            await addBook('a', { lastOpenedAt: 3000 })

            const result = await sync.applyRemote({
                items: [
                    {
                        kind: 'book',
                        key: 'hash-a',
                        updatedAt: 1000,
                        deleted: false,
                        value: bookValue('a', { title: 'A new title', lastOpenedAt: 5000 }),
                    },
                ],
            })

            expect(await storage.getBook('a')).toEqual(
                makeBook('a', { title: 'A new title', lastOpenedAt: 3000 }),
            )
            expect(await (await storage.getFile('a'))?.text()).toBe('file of a')
            expect(result.books).toEqual(['a'])
        })

        it('reports no change for a book that has the same values', async () => {
            await addBook('a')

            const result = await sync.applyRemote({
                items: [
                    {
                        kind: 'book',
                        key: 'hash-a',
                        updatedAt: 1000,
                        deleted: false,
                        value: bookValue('a'),
                    },
                ],
            })

            expect(result.books).toEqual([])
        })

        it('removes a deleted book with its progress and notes', async () => {
            await addBook('a')
            await storage.saveProgress(makeProgress('a'))
            await storage.putBookmark(makeBookmark('m', 'a'))
            await storage.putHighlight(makeHighlight('h', 'a'))

            const result = await sync.applyRemote({ items: [deletedItem('book', 'hash-a', 5000)] })

            expect(result.books).toEqual(['a'])
            expect(await storage.getBook('a')).toBeUndefined()
            expect(await storage.getFile('a')).toBeUndefined()
            expect(await storage.getProgress('a')).toBeUndefined()
            expect(await storage.listBookmarks('a')).toEqual([])
            expect(await storage.listHighlights('a')).toEqual([])
        })

        it('keeps a newer change of this device and drops an older one', async () => {
            syncOn = true
            await addBook('a')
            await storage.putHighlight(makeHighlight('new', 'a', 6000))
            await storage.putHighlight(makeHighlight('old', 'a', 4000))
            syncOn = false

            await sync.applyRemote({
                items: [
                    deletedItem('highlight', 'new', 5000),
                    deletedItem('highlight', 'old', 5000),
                ],
            })

            expect((await storage.listHighlights('a')).map((item) => item.id)).toEqual(['new'])
            const ids = (await readOutbox()).map((entry) => entry.id)
            expect(ids).toContain('highlight:new')
            expect(ids).not.toContain('highlight:old')
        })

        it('writes progress and notes to the book with the same file, after the book', async () => {
            const { bookId: _, ...bookmark } = makeBookmark('m', 'x')
            const { bookId: __, ...highlight } = makeHighlight('h', 'x')
            const { bookId: ___, ...progress } = makeProgress('x', 2500)

            const result = await sync.applyRemote({
                items: [
                    {
                        kind: 'highlight',
                        key: 'h',
                        updatedAt: 4000,
                        deleted: false,
                        value: { ...highlight, fileHash: 'hash-a' },
                    },
                    {
                        kind: 'progress',
                        key: 'hash-a',
                        updatedAt: 2500,
                        deleted: false,
                        value: { ...progress, fileHash: 'hash-a' },
                    },
                    {
                        kind: 'bookmark',
                        key: 'm',
                        updatedAt: 3000,
                        deleted: false,
                        value: { ...bookmark, fileHash: 'hash-a' },
                    },
                    {
                        kind: 'book',
                        key: 'hash-a',
                        updatedAt: 1000,
                        deleted: false,
                        value: bookValue('a'),
                    },
                ],
            })

            const [book] = await storage.listBooks()
            expect(await storage.getProgress(book.id)).toEqual(makeProgress(book.id, 2500))
            expect(await storage.listBookmarks(book.id)).toEqual([makeBookmark('m', book.id)])
            expect(await storage.listHighlights(book.id)).toEqual([makeHighlight('h', book.id)])
            expect(result.progress).toEqual([makeProgress(book.id, 2500)])
            expect(result.annotations).toEqual([book.id])
        })

        it('skips older progress and the notes of a book that is not here', async () => {
            await addBook('a')
            await storage.saveProgress(makeProgress('a', 3000))
            const { bookId: _, ...bookmark } = makeBookmark('m', 'x')

            const result = await sync.applyRemote({
                items: [
                    {
                        kind: 'progress',
                        key: 'hash-a',
                        updatedAt: 2000,
                        deleted: false,
                        value: { ...makeProgress('x', 2000), fileHash: 'hash-a' },
                    },
                    {
                        kind: 'bookmark',
                        key: 'm',
                        updatedAt: 3000,
                        deleted: false,
                        value: { ...bookmark, fileHash: 'hash-other' },
                    },
                ],
            })

            expect(result).toEqual({
                books: [],
                progress: [],
                annotations: [],
                fonts: false,
                settings: {},
            })
            expect(await storage.getProgress('a')).toEqual(makeProgress('a', 3000))
        })

        it('removes a deleted bookmark', async () => {
            await addBook('a')
            await storage.putBookmark(makeBookmark('m', 'a'))

            const result = await sync.applyRemote({
                items: [deletedItem('bookmark', 'm', 5000), deletedItem('bookmark', 'none', 5000)],
            })

            expect(await storage.listBookmarks('a')).toEqual([])
            expect(result.annotations).toEqual(['a'])
        })
    })

    describe('files and covers', () => {
        it('stores a downloaded file and a cover', async () => {
            await addBook('a', { remoteOnly: true })

            await sync.storeFile('a', new Blob(['downloaded']))
            await sync.storeCover('a', new Blob(['cover']))
            await sync.storeCover('missing', new Blob(['cover']))

            expect(await storage.getBook('a')).toEqual(makeBook('a'))
            expect(await (await storage.getFile('a'))?.text()).toBe('downloaded')
            expect(await (await storage.getCover('a'))?.text()).toBe('cover')
            expect(await storage.getCover('missing')).toBeUndefined()
        })

        it('lists the books that have a cover on the server only', async () => {
            await addBook('a')
            await addBook('b', { hasCover: false })
            await storage.addBook({
                record: makeBook('c'),
                file: new Blob(['c']),
                cover: new Blob(['cover']),
            })

            expect((await sync.booksWithoutCover()).map((book) => book.id)).toEqual(['a'])
        })

        it('removes a download only when the server has the file', async () => {
            syncOn = true
            await addBook('a')

            expect(await sync.removeDownload('a')).toBe(false)
            expect(await storage.getFile('a')).toBeDefined()

            await sync.removeOutbox(await readOutbox())
            expect(await sync.removeDownload('a')).toBe(true)
            expect(await storage.getFile('a')).toBeUndefined()
            expect((await storage.getBook('a'))?.remoteOnly).toBe(true)
            expect(await sync.removeDownload('missing')).toBe(false)
        })
    })

    describe('fonts', () => {
        function putFont(font: FontRecord, ...hashes: string[]): Promise<void> {
            const files = new Map(hashes.map((hash) => [hash, new Blob([hash])]))
            return storage.putFont({ record: font, files })
        }

        function fontFileKeys(): Promise<string[]> {
            return storage.database.run<string[]>({
                stores: 'fontFiles',
                mode: 'readonly',
                failureMessage: 'Unable to read.',
                work: (transaction) => {
                    const request = transaction.objectStore('fontFiles').getAllKeys()
                    return () => request.result.map(String).sort()
                },
            })
        }

        it('reads a font and its files from the outbox, after the other records', async () => {
            syncOn = true
            await putFont(makeFont('f', ['r', 'i']), 'r', 'i')
            await addBook('a')

            const batch = await sync.readOutbox(10)

            expect(batch.changes.map(({ item }) => item.kind)).toEqual(['book', 'font'])
            expect(batch.changes[1].item).toEqual(fontItem(makeFont('f', ['r', 'i'])))
            expect(batch.fontFiles.map((entry) => entry.key).sort()).toEqual(['i', 'r'])
            expect(batch.stale).toEqual([])
        })

        it('leaves the font entries for a server that does not keep fonts', async () => {
            syncOn = true
            await putFont(makeFont('f', ['r']), 'r')

            const batch = await sync.readOutbox(10, FIRST_SYNC_KINDS)

            expect(batch).toEqual({ changes: [], files: [], fontFiles: [], stale: [] })
            expect((await readOutbox()).map((entry) => entry.id).sort()).toEqual([
                'font:f',
                'fontFile:r',
            ])
        })

        it('sends a removed font as a delete and drops the upload of its file', async () => {
            syncOn = true
            await putFont(makeFont('f', ['r']), 'r')
            await storage.deleteFont('f')

            const batch = await sync.readOutbox(10)

            expect(batch.changes.map(({ item }) => item)).toEqual([
                { kind: 'font', key: 'f', updatedAt: 9000, deleted: true, value: null },
            ])
            expect(batch.stale.map((entry) => entry.id)).toEqual(['fontFile:r'])
        })

        it('writes a font from the server and keeps a newer font of this device', async () => {
            const result = await sync.applyRemote({ items: [fontItem(makeFont('f', ['r']))] })
            expect(result.fonts).toBe(true)
            // The files come later. Until then the family does not show.
            expect(await storage.listFonts()).toEqual([])
            expect(await sync.missingFontFiles()).toEqual(['r'])

            await putFont(makeFont('g', ['x'], { updatedAt: 800 }), 'x')
            const older = await sync.applyRemote({
                items: [fontItem(makeFont('g', ['y'], { updatedAt: 700 }))],
            })
            expect(older.fonts).toBe(false)
            expect((await storage.listFonts()).map((font) => font.id)).toEqual(['g'])
        })

        it('removes the files that a font from the server does not use now', async () => {
            await putFont(makeFont('f', ['r', 'old']), 'r', 'old')
            await putFont(makeFont('g', ['r']))

            await sync.applyRemote({
                items: [fontItem(makeFont('f', ['r'], { updatedAt: 700 }))],
            })
            expect(await fontFileKeys()).toEqual(['r'])

            await sync.applyRemote({
                items: [{ kind: 'font', key: 'g', updatedAt: 800, deleted: true, value: null }],
            })
            expect(await fontFileKeys()).toEqual(['r'])
            await sync.applyRemote({
                items: [{ kind: 'font', key: 'f', updatedAt: 900, deleted: true, value: null }],
            })
            expect(await storage.listFonts()).toEqual([])
            expect(await fontFileKeys()).toEqual([])
        })

        it('stores a downloaded font file only for a family that uses it', async () => {
            await sync.applyRemote({ items: [fontItem(makeFont('f', ['r']))] })

            await sync.storeFontFile('r', new Blob(['r']))
            await sync.storeFontFile('other', new Blob(['other']))

            expect(await fontFileKeys()).toEqual(['r'])
            expect(await sync.missingFontFiles()).toEqual([])
            expect(await storage.listFonts()).toEqual([makeFont('f', ['r'])])
        })

        it('seeds the outbox with the fonts and their files', async () => {
            await putFont(makeFont('f', ['r']), 'r')
            await sync.seedOutbox()
            expect(await readOutbox()).toEqual([
                { id: 'font:f', kind: 'font', key: 'f', deleted: false, changedAt: 600 },
                { id: 'fontFile:r', kind: 'fontFile', key: 'r', deleted: false, changedAt: 0 },
            ])
        })

        it('removes the fonts that do not have all their files at reset', async () => {
            await putFont(makeFont('f', ['r']), 'r')
            await sync.applyRemote({ items: [fontItem(makeFont('g', ['r', 'missing']))] })

            await sync.reset()

            expect(await storage.listFonts()).toEqual([makeFont('f', ['r'])])
            expect(await fontFileKeys()).toEqual(['r'])
            expect(await sync.missingFontFiles()).toEqual([])
        })
    })

    describe('settings', () => {
        function setting(value: string, updatedAt: number): SyncItem {
            return { kind: 'setting', key: 'fontId', updatedAt, deleted: false, value: { value } }
        }

        it('sends the copy of a changed setting', async () => {
            syncOn = true
            await storage.putSyncedSetting({ name: 'fontId', value: 'literata' })

            const batch = await sync.readOutbox(10)
            expect(batch.changes.map(({ item }) => item)).toEqual([setting('literata', 9000)])
            expect(await sync.readOutbox(10, FIRST_SYNC_KINDS)).toMatchObject({ changes: [] })
        })

        it('gives a newer setting from the server to the app, one time', async () => {
            const first = await sync.applyRemote({ items: [setting('user:f', 5000)] })
            expect(first.settings).toEqual({ fontId: 'user:f' })

            const same = await sync.applyRemote({ items: [setting('user:f', 6000)] })
            expect(same.settings).toEqual({})
            const older = await sync.applyRemote({ items: [setting('inter', 5500)] })
            expect(older.settings).toEqual({})

            // The value from the server is the copy now, so the app does not send it back.
            syncOn = true
            await storage.putSyncedSetting({ name: 'fontId', value: 'user:f' })
            expect(await readOutbox()).toEqual([])
        })

        it('keeps a newer change of this device', async () => {
            syncOn = true
            await storage.putSyncedSetting({ name: 'fontId', value: 'literata' })
            const result = await sync.applyRemote({ items: [setting('inter', 8000)] })
            expect(result.settings).toEqual({})
            expect((await sync.readOutbox(10)).changes[0].item).toEqual(setting('literata', 9000))
        })
    })

    describe('reset', () => {
        it('removes the state and the books with no file here, and keeps the outbox', async () => {
            syncOn = true
            await addBook('a')
            await addBook('b', { remoteOnly: true })
            await storage.saveProgress(makeProgress('b'))
            await storage.deleteBookmark('m')
            await sync.writeState({ account: 'acc', cursor: 3 })

            expect(await sync.reset()).toEqual(['b'])

            expect((await storage.listBooks()).map((book) => book.id)).toEqual(['a'])
            expect(await storage.getProgress('b')).toBeUndefined()
            expect(await sync.readState()).toBeUndefined()
            // A delete that the server did not get goes when the sync is on again.
            expect((await readOutbox()).map((entry) => entry.id)).toContain('bookmark:m')
        })
    })
})
