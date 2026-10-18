/**
 * Two devices sync through the real request handler of the sync server, on the SQLite of
 * Node. Each device has its own IndexedDB.
 */

import { Blob as NodeBlob } from 'node:buffer'
import { createHash } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFont, familyNames } from '$lib/fonts/testing/build-font'
import { createLibraryStorage, type LibraryFileStorage } from '$lib/storage/library-storage'
import { createSyncStore, type ApplyResult } from '$lib/storage/sync-store'
import type { BookmarkRecord, BookRecord, FontRecord, HighlightRecord } from '$lib/storage/types'
import { FIRST_KINDS } from '../../../sync-server/src/protocol'
import { handleRequest, type Env } from '../../../sync-server/src/handler'
import { createMemoryBucket } from '../../../sync-server/test/memory-bucket'
import { createSqliteDatabase } from '../../../sync-server/test/sqlite-database'
import { createSyncClient, setupServer } from './client'
import { deriveToken } from './code'
import { createSyncEngine, FONT_RETRY_MS, type SyncEngine } from './engine'
import { SyncError } from './types'

const SERVER = 'https://sync.test.workers.dev'
const SETUP_CODE = 'setup-code-for-the-engine-tests'
const CODE = '7K3Q-M9XA-0000-1111-2222-3333'

interface Device {
    storage: LibraryFileStorage
    engine: SyncEngine
    changes: ApplyResult[]
    clock: { now: number }
}

function hashOf(text: string): string {
    return createHash('sha256').update(text).digest('hex')
}

function makeBook(id: string, content: string, changes: Partial<BookRecord> = {}): BookRecord {
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
        fileSize: content.length,
        fileHash: hashOf(content),
        hasCover: true,
        spineStats: [{ chars: 100, words: 20 }],
        totalChars: 100,
        totalWords: 20,
        addedAt: 1000,
        lastOpenedAt: null,
        ...changes,
    }
}

function makeHighlight(id: string, bookId: string, changes: Partial<HighlightRecord> = {}) {
    const highlight: HighlightRecord = {
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
        updatedAt: 4000,
        ...changes,
    }
    return highlight
}

/** A font file that passes the checks of the sync: a font signature and its own hash. */
function fontBytes(name: string): Uint8Array<ArrayBuffer> {
    return buildFont({ names: familyNames(name) })
}

function bytesHash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function makeFont(id: string, bytes: Uint8Array[], changes: Partial<FontRecord> = {}): FontRecord {
    return {
        id,
        name: `Font ${id}`,
        fallback: 'serif',
        faces: bytes.map((data, index) => ({
            hash: bytesHash(data),
            format: 'truetype' as const,
            weight: String(400 + index * 300),
            style: 'normal' as const,
            stretch: '100%',
            size: data.length,
        })),
        addedAt: 1000,
        updatedAt: 1000,
        ...changes,
    }
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

describe('createSyncEngine', () => {
    let db: ReturnType<typeof createSqliteDatabase>
    let bucket: ReturnType<typeof createMemoryBucket>
    let env: Env
    let token: string
    const devices: Device[] = []

    // A browser sends the length of a Blob body. A Request object of Node has no such header.
    const serverFetch = (input: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        if (init.body instanceof Blob) headers.set('Content-Length', String(init.body.size))
        return handleRequest(new Request(input, { ...init, headers }), env)
    }

    beforeEach(async () => {
        vi.stubGlobal('Blob', NodeBlob)
        db = createSqliteDatabase()
        bucket = createMemoryBucket()
        env = { DB: db, BUCKET: bucket, SETUP_CODE }
        token = await deriveToken(CODE)
        await setupServer({ server: SERVER, setupCode: SETUP_CODE, token, fetch: serverFetch })
    })

    afterEach(() => {
        for (const device of devices.splice(0)) device.storage.close()
        db.close()
        vi.unstubAllGlobals()
    })

    function createDevice({ fetch = serverFetch, deviceToken = token } = {}): Device {
        const clock = { now: 10_000 }
        const storage = createLibraryStorage({
            indexedDB: new IDBFactory(),
            changes: { isOn: () => true, onChange: () => {} },
            now: () => clock.now,
        })
        const changes: ApplyResult[] = []
        const engine = createSyncEngine({
            store: createSyncStore(storage.database),
            storage,
            backend: createSyncClient({ server: SERVER, token: deviceToken, fetch }),
            onChanges: (result) => changes.push(result),
            now: () => clock.now,
        })
        const device = { storage, engine, changes, clock }
        devices.push(device)
        return device
    }

    /**
     * A server of the first version: it gives no list of kinds, refuses a push with a different
     * kind, and has no fonts folder. `old.on` false makes it the current server again.
     */
    const old = { on: true }
    const oldServerFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
        if (!old.on) return serverFetch(input, init)
        const url = new URL(input)
        const method = init.method ?? 'GET'
        if (url.pathname.startsWith('/v1/fonts/')) {
            return Response.json({ error: 'No such address.', code: 'not-found' }, { status: 404 })
        }
        if (url.pathname === '/v1/changes' && method === 'POST') {
            const { changes } = JSON.parse(String(init.body)) as { changes: { kind: string }[] }
            if (changes.some((change) => !FIRST_KINDS.includes(change.kind as never))) {
                return Response.json(
                    { error: 'A change is not valid.', code: 'bad-request' },
                    { status: 400 },
                )
            }
        }
        url.searchParams.delete('kinds')
        const response = await serverFetch(url.toString(), init)
        if (method !== 'GET' || !['/v1/changes', '/v1/status'].includes(url.pathname)) {
            return response
        }
        const { kinds: _, ...body } = (await response.json()) as Record<string, unknown>
        return Response.json(body, { status: response.status })
    }

    async function addFont(
        device: Device,
        font: FontRecord,
        bytes: Uint8Array<ArrayBuffer>[],
    ): Promise<void> {
        const files = new Map(
            bytes.map((data) => [bytesHash(data), new Blob([data], { type: 'font/ttf' })]),
        )
        await device.storage.putFont({ record: font, files })
    }

    async function addBook(device: Device, id: string, content: string): Promise<BookRecord> {
        const record = makeBook(id, content)
        await device.storage.addBook({
            record,
            file: new Blob([content], { type: 'application/epub+zip' }),
            cover: new Blob([`cover of ${id}`], { type: 'image/jpeg' }),
        })
        return record
    }

    it('copies a book, its cover, progress and notes to a second device', async () => {
        const phone = createDevice()
        const laptop = createDevice()
        const book = await addBook(phone, 'a', 'epub bytes of a')
        await phone.storage.saveProgress({
            bookId: 'a',
            locator: { spineIndex: 0, offset: 42 },
            fraction: 0.5,
            updatedAt: 2000,
        })
        await phone.storage.putBookmark(makeBookmark('m', 'a'))
        await phone.storage.putHighlight(makeHighlight('h', 'a'))

        await phone.engine.sync()
        await laptop.engine.sync()

        const [copy] = await laptop.storage.listBooks()
        expect(copy).toEqual({ ...book, id: copy.id, remoteOnly: true })
        expect(await (await laptop.storage.getCover(copy.id))?.text()).toBe('cover of a')
        expect(await laptop.storage.getFile(copy.id)).toBeUndefined()
        expect(await laptop.storage.getProgress(copy.id)).toEqual({
            bookId: copy.id,
            locator: { spineIndex: 0, offset: 42 },
            fraction: 0.5,
            updatedAt: 2000,
        })
        expect(await laptop.storage.listBookmarks(copy.id)).toEqual([makeBookmark('m', copy.id)])
        expect(await laptop.storage.listHighlights(copy.id)).toEqual([makeHighlight('h', copy.id)])
        expect(laptop.changes.flatMap((change) => change.books)).toContain(copy.id)
        expect(laptop.engine.status).toMatchObject({ phase: 'idle', syncedAt: 10_000, error: null })
    })

    it('downloads the file of a book and checks its hash', async () => {
        const phone = createDevice()
        const laptop = createDevice()
        await addBook(phone, 'a', 'epub bytes of a')
        await phone.engine.sync()
        await laptop.engine.sync()
        const [copy] = await laptop.storage.listBooks()

        await laptop.engine.downloadFile(copy)

        expect(await (await laptop.storage.getFile(copy.id))?.text()).toBe('epub bytes of a')
        expect((await laptop.storage.getBook(copy.id))?.remoteOnly).toBeUndefined()
    })

    it('refuses a downloaded file with a different hash', async () => {
        const phone = createDevice()
        const laptop = createDevice()
        const book = await addBook(phone, 'a', 'epub bytes of a')
        await phone.engine.sync()
        await laptop.engine.sync()
        await bucket.put(`files/${book.fileHash}`, new TextEncoder().encode('damaged').buffer)
        const [copy] = await laptop.storage.listBooks()

        await expect(laptop.engine.downloadFile(copy)).rejects.toMatchObject({
            code: 'integrity',
        })
        expect(await laptop.storage.getFile(copy.id)).toBeUndefined()
    })

    it('tells when the server does not have the file yet', async () => {
        const laptop = createDevice()
        await expect(
            laptop.engine.downloadFile({ id: 'x', fileHash: hashOf('missing') }),
        ).rejects.toMatchObject({ code: 'not-found' })
    })

    it('moves the newer reading position to the other device', async () => {
        const phone = createDevice()
        const laptop = createDevice()
        await addBook(phone, 'a', 'epub bytes of a')
        await phone.engine.sync()
        await laptop.engine.sync()
        const [copy] = await laptop.storage.listBooks()

        await phone.storage.saveProgress({
            bookId: 'a',
            locator: { spineIndex: 0, offset: 90 },
            fraction: 0.9,
            updatedAt: 5000,
        })
        await phone.engine.pushNow()
        laptop.changes.length = 0
        await laptop.engine.sync()

        const progress = {
            bookId: copy.id,
            locator: { spineIndex: 0, offset: 90 },
            fraction: 0.9,
            updatedAt: 5000,
        }
        expect(await laptop.storage.getProgress(copy.id)).toEqual(progress)
        expect(laptop.changes.flatMap((change) => change.progress)).toEqual([progress])
    })

    it('keeps the newer of two edits that two devices made apart', async () => {
        const phone = createDevice()
        const laptop = createDevice()
        await addBook(phone, 'a', 'epub bytes of a')
        await phone.storage.putHighlight(makeHighlight('h', 'a'))
        await phone.engine.sync()
        await laptop.engine.sync()
        const [copy] = await laptop.storage.listBooks()

        await laptop.storage.putHighlight(
            makeHighlight('h', copy.id, { note: 'later', updatedAt: 7000 }),
        )
        await phone.storage.putHighlight(
            makeHighlight('h', 'a', { note: 'earlier', updatedAt: 6000 }),
        )
        await laptop.engine.sync()
        await phone.engine.sync()
        await laptop.engine.sync()

        expect((await phone.storage.listHighlights('a'))[0].note).toBe('later')
        expect((await laptop.storage.listHighlights(copy.id))[0].note).toBe('later')
    })

    it('removes a deleted book and a deleted highlight on the other device', async () => {
        const phone = createDevice()
        const laptop = createDevice()
        await addBook(phone, 'a', 'epub bytes of a')
        await addBook(phone, 'b', 'epub bytes of b')
        await phone.storage.putHighlight(makeHighlight('h', 'b'))
        await phone.engine.sync()
        await laptop.engine.sync()
        const copies = await laptop.storage.listBooks()
        const copyB = copies.find((book) => book.title === 'Title b')!

        phone.clock.now = 20_000
        await phone.storage.deleteBook('a')
        laptop.clock.now = 20_000
        await laptop.storage.deleteHighlight('h')
        await phone.engine.sync()
        await laptop.engine.sync()
        await phone.engine.sync()

        expect((await laptop.storage.listBooks()).map((book) => book.title)).toEqual(['Title b'])
        expect(await laptop.storage.listHighlights(copyB.id)).toEqual([])
        expect(await phone.storage.listHighlights('b')).toEqual([])
    })

    it('removes a book on all devices when a device that has no file removes it', async () => {
        const phone = createDevice()
        const laptop = createDevice()
        await addBook(phone, 'a', 'epub bytes of a')
        await phone.engine.sync()
        await laptop.engine.sync()
        const [copy] = await laptop.storage.listBooks()
        expect(copy.remoteOnly).toBe(true)

        laptop.clock.now = 20_000
        await laptop.storage.deleteBook(copy.id)
        await laptop.engine.sync()
        await phone.engine.sync()

        expect(await phone.storage.listBooks()).toEqual([])
        expect(await laptop.storage.listBooks()).toEqual([])
    })

    it('uploads each file one time', async () => {
        const phone = createDevice()
        const book = await addBook(phone, 'a', 'epub bytes of a')

        await phone.engine.sync()
        await phone.engine.sync()

        expect(bucket.keys().sort()).toEqual([`covers/${book.fileHash}`, `files/${book.fileHash}`])
    })

    it('sends all records again to a server that started again', async () => {
        const phone = createDevice()
        await addBook(phone, 'a', 'epub bytes of a')
        await phone.engine.sync()

        db.close()
        db = createSqliteDatabase()
        env.DB = db
        await setupServer({ server: SERVER, setupCode: SETUP_CODE, token, fetch: serverFetch })
        await phone.engine.sync()

        const laptop = createDevice()
        await laptop.engine.sync()
        expect((await laptop.storage.listBooks()).map((book) => book.title)).toEqual(['Title a'])
    })

    it('reports a wrong sync code in its status', async () => {
        const device = createDevice({ deviceToken: 'f'.repeat(64) })

        await expect(device.engine.sync()).rejects.toMatchObject({ code: 'unauthorized' })
        expect(device.engine.status.phase).toBe('error')
        expect(device.engine.status.error).toBeInstanceOf(SyncError)
    })

    it('reports a server that does not answer', async () => {
        const device = createDevice({
            fetch: () => Promise.reject(new TypeError('Failed to fetch')),
        })

        await expect(device.engine.sync()).rejects.toMatchObject({ code: 'offline' })
    })

    it('keeps a record that the server would refuse on this device, and syncs the rest', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const phone = createDevice()
        const laptop = createDevice()
        await addBook(phone, 'a', 'epub bytes of a')
        // Larger than the server takes in one record.
        await phone.storage.putHighlight(
            makeHighlight('huge', 'a', { note: 'x'.repeat(1_000_001) }),
        )
        // A time from an old backup file can have a fraction.
        await phone.storage.putHighlight(makeHighlight('h', 'a', { updatedAt: 4000.5 }))

        await phone.engine.sync()
        await laptop.engine.sync()

        const [copy] = await laptop.storage.listBooks()
        const notes = await laptop.storage.listHighlights(copy.id)
        expect(notes.map((highlight) => highlight.id)).toEqual(['h'])
        expect(warn).toHaveBeenCalled()
        expect(phone.engine.status.error).toBeNull()
    })

    it('skips a file that is too large for the server, and uploads the others', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const big = await (async () => {
            const phone = createDevice({
                fetch: (input, init) =>
                    init?.method === 'PUT' && input.includes(hashOf('big book'))
                        ? Promise.resolve(new Response('<html>413</html>', { status: 413 }))
                        : serverFetch(input, init),
            })
            await addBook(phone, 'big', 'big book')
            await addBook(phone, 'small', 'small book')
            await phone.engine.sync()
            return phone
        })()

        expect(bucket.keys()).toContain(`files/${hashOf('small book')}`)
        expect(bucket.keys()).not.toContain(`files/${hashOf('big book')}`)
        expect(big.engine.status.error).toBeNull()
        expect(warn).toHaveBeenCalled()
    })

    it('removes a download only when the server has the file', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const phone = createDevice({
            fetch: (input, init) =>
                init?.method === 'PUT' && input.includes(hashOf('big book'))
                    ? Promise.resolve(new Response('<html>413</html>', { status: 413 }))
                    : serverFetch(input, init),
        })
        await addBook(phone, 'big', 'big book')
        await addBook(phone, 'small', 'small book')
        await phone.engine.sync()

        // The outbox has no upload for the large file, but the server does not have it.
        expect(await phone.engine.removeDownload('big')).toBe(false)
        expect(await phone.storage.getFile('big')).toBeDefined()
        expect(await phone.engine.removeDownload('small')).toBe(true)
        expect(await phone.storage.getFile('small')).toBeUndefined()
        expect((await phone.storage.getBook('small'))?.remoteOnly).toBe(true)
        expect(warn).toHaveBeenCalled()
    })

    it('uploads the other files when one fails, and tries the failed one again later', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        let failing = true
        const phone = createDevice({
            fetch: (input, init) =>
                failing && init?.method === 'PUT' && input.includes(hashOf('bad book'))
                    ? Promise.resolve(new Response('{}', { status: 500 }))
                    : serverFetch(input, init),
        })
        await addBook(phone, 'bad', 'bad book')
        await addBook(phone, 'good', 'good book')

        await phone.engine.sync()
        expect(bucket.keys()).toContain(`files/${hashOf('good book')}`)
        expect(bucket.keys()).not.toContain(`files/${hashOf('bad book')}`)
        expect(phone.engine.status.error).toBeNull()
        expect(warn).toHaveBeenCalled()

        failing = false
        await phone.engine.sync()
        expect(bucket.keys()).toContain(`files/${hashOf('bad book')}`)
    })

    it('does not ask again within an hour for a cover that the server did not have', async () => {
        const phone = createDevice({
            fetch: (input, init) =>
                init?.method === 'PUT' && input.includes('/v1/covers/')
                    ? Promise.resolve(new Response('{}', { status: 500 }))
                    : serverFetch(input, init),
        })
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        await addBook(phone, 'a', 'epub bytes of a')
        await phone.engine.sync()
        const fetchSpy = vi.fn(serverFetch)
        const laptop = createDevice({ fetch: fetchSpy })
        const coverGets = () =>
            fetchSpy.mock.calls.filter(
                ([url, init]) => url.includes('/v1/covers/') && (init?.method ?? 'GET') === 'GET',
            ).length

        await laptop.engine.sync()
        await laptop.engine.sync()
        expect(coverGets()).toBe(1)

        laptop.clock.now += 60 * 60_000
        await laptop.engine.sync()
        expect(coverGets()).toBe(2)
    })

    it('stops a pull that gives more pages with no new cursor', async () => {
        const device = createDevice({
            fetch: (input, init) =>
                input.includes('/v1/changes?')
                    ? Promise.resolve(
                          Response.json({ account: 'acc', changes: [], cursor: 0, more: true }),
                      )
                    : serverFetch(input, init),
        })

        await expect(device.engine.sync()).rejects.toMatchObject({ code: 'bad-response' })
    })

    describe('fonts', () => {
        beforeEach(() => {
            old.on = true
        })

        it('copies a font and its files to a second device', async () => {
            const phone = createDevice()
            const laptop = createDevice()
            const regular = fontBytes('Mine')
            const bold = fontBytes('Mine Bold')
            const font = makeFont('f-1', [regular, bold])
            await addFont(phone, font, [regular, bold])

            await phone.engine.sync()
            await laptop.engine.sync()

            expect(await laptop.storage.listFonts()).toEqual([font])
            const file = await laptop.storage.getFontFile(font.faces[1].hash)
            expect(new Uint8Array(await file!.arrayBuffer())).toEqual(bold)
            expect(file!.type).toBe('font/ttf')
            expect(laptop.changes.some((change) => change.fonts)).toBe(true)
            expect(laptop.engine.status.oldServer).toBe(false)
            expect(bucket.keys().filter((key) => key.startsWith('fonts/'))).toHaveLength(2)
        })

        it('removes a font on the other device', async () => {
            const phone = createDevice()
            const laptop = createDevice()
            const regular = fontBytes('Mine')
            await addFont(phone, makeFont('f-1', [regular]), [regular])
            await phone.engine.sync()
            await laptop.engine.sync()

            phone.clock.now = 20_000
            await phone.storage.deleteFont('f-1')
            await phone.engine.sync()
            laptop.changes.length = 0
            await laptop.engine.sync()

            expect(await laptop.storage.listFonts()).toEqual([])
            expect(await laptop.storage.getFontFile(bytesHash(regular))).toBeUndefined()
            expect(laptop.changes.some((change) => change.fonts)).toBe(true)
        })

        it('keeps the fonts for a server that does not keep them, and sends them after its update', async () => {
            const phone = createDevice({ fetch: oldServerFetch })
            const regular = fontBytes('Mine')
            await addFont(phone, makeFont('f-1', [regular]), [regular])
            await addBook(phone, 'a', 'epub bytes of a')

            await phone.engine.sync()

            // The other data syncs, and the status asks for an update of the server.
            expect(phone.engine.status).toMatchObject({ phase: 'idle', oldServer: true })
            const laptop = createDevice()
            await laptop.engine.sync()
            expect((await laptop.storage.listBooks()).map((book) => book.title)).toEqual([
                'Title a',
            ])
            expect(await laptop.storage.listFonts()).toEqual([])

            old.on = false
            await phone.engine.sync()
            expect(phone.engine.status.oldServer).toBe(false)
            await laptop.engine.sync()
            expect((await laptop.storage.listFonts()).map((font) => font.id)).toEqual(['f-1'])
        })

        it('gets the fonts that the cursor of this device moved past before', async () => {
            const phone = createDevice()
            const regular = fontBytes('Mine')
            await addFont(phone, makeFont('f-1', [regular]), [regular])
            await phone.engine.sync()
            // A later book moves the cursor of an older device past the font.
            await addBook(phone, 'a', 'epub bytes of a')
            await phone.engine.sync()

            const laptop = createDevice({ fetch: oldServerFetch })
            await laptop.engine.sync()
            expect((await laptop.storage.listBooks()).map((book) => book.title)).toEqual([
                'Title a',
            ])
            expect(await laptop.storage.listFonts()).toEqual([])

            old.on = false
            await laptop.engine.sync()
            expect((await laptop.storage.listFonts()).map((font) => font.id)).toEqual(['f-1'])
        })

        it('refuses a damaged font file and asks for it again after an hour', async () => {
            const phone = createDevice()
            const regular = fontBytes('Mine')
            const hash = bytesHash(regular)
            await addFont(phone, makeFont('f-1', [regular]), [regular])
            await phone.engine.sync()
            await bucket.put(`fonts/${hash}`, fontBytes('Other').buffer)

            const laptop = createDevice()
            await laptop.engine.sync()
            expect(await laptop.storage.listFonts()).toEqual([])

            await bucket.put(`fonts/${hash}`, regular.buffer)
            await laptop.engine.sync()
            expect(await laptop.storage.listFonts()).toEqual([])

            laptop.clock.now += FONT_RETRY_MS
            await laptop.engine.sync()
            expect((await laptop.storage.listFonts()).map((font) => font.id)).toEqual(['f-1'])
        })
    })

    describe('the font choice', () => {
        async function outboxOf(device: Device) {
            return (await createSyncStore(device.storage.database).readOutbox(10)).changes
        }

        it('goes to a new device, and does not come back from it', async () => {
            const phone = createDevice()
            await phone.engine.sync()
            await phone.storage.putSyncedSetting({ name: 'fontId', value: 'user:f-1' })
            await phone.engine.sync()

            const laptop = createDevice()
            await laptop.engine.sync()

            expect(laptop.changes.map((change) => change.settings?.fontId)).toContain('user:f-1')
            // The app writes the value to its settings. That write sends nothing.
            await laptop.storage.putSyncedSetting({ name: 'fontId', value: 'user:f-1' })
            expect(await outboxOf(laptop)).toEqual([])
        })

        it('lets the later of two choices win on both devices', async () => {
            const phone = createDevice()
            const laptop = createDevice()
            await phone.engine.sync()
            await laptop.engine.sync()

            await phone.storage.putSyncedSetting({ name: 'fontId', value: 'literata' })
            laptop.clock.now = 20_000
            await laptop.storage.putSyncedSetting({ name: 'fontId', value: 'inter' })
            await laptop.engine.sync()
            phone.changes.length = 0
            await phone.engine.sync()
            laptop.changes.length = 0
            await laptop.engine.sync()

            expect(phone.changes.map((change) => change.settings?.fontId)).toContain('inter')
            expect(laptop.changes.some((change) => change.settings?.fontId)).toBe(false)
        })
    })

    it('runs one more time for a call during a run', async () => {
        const phone = createDevice()
        await addBook(phone, 'a', 'epub bytes of a')
        const fetchSpy = vi.fn(serverFetch)
        const device = createDevice({ fetch: fetchSpy })

        const first = device.engine.sync()
        const second = device.engine.sync()
        expect(second).toBe(first)
        await first

        // Two runs, each with one pull. The device has no records to push.
        const pulls = fetchSpy.mock.calls.filter(
            ([url, init]) => url.includes('/v1/changes') && (init?.method ?? 'GET') === 'GET',
        )
        expect(pulls).toHaveLength(2)
    })
})
