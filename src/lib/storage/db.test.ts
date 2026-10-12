import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { createDatabase, DATABASE_NAME, DATABASE_VERSION, type Database } from './db'
import { trackFactory } from './testing/tracked-factory'

function putProgress(database: Database, bookId: string): Promise<void> {
    return database.run({
        stores: 'progress',
        mode: 'readwrite',
        failureMessage: 'Unable to save.',
        work: (transaction) => {
            transaction.objectStore('progress').put({ bookId })
        },
    })
}

function countProgress(database: Database): Promise<number> {
    return database.run<number>({
        stores: 'progress',
        mode: 'readonly',
        failureMessage: 'Unable to read.',
        work: (transaction) => {
            const request = transaction.objectStore('progress').count()
            return () => request.result
        },
    })
}

function openRaw(factory: IDBFactory, version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory.open(DATABASE_NAME, version)
        request.onupgradeneeded = () => undefined
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('The open request is blocked.'))
    })
}

describe('createDatabase', () => {
    it('makes the stores and indexes of version 1', async () => {
        const factory = new IDBFactory()
        const database = createDatabase({ indexedDB: factory })
        await countProgress(database)
        database.close()

        const raw = await openRaw(factory)
        expect(raw.name).toBe('page-goblin')
        expect(raw.version).toBe(DATABASE_VERSION)
        expect([...raw.objectStoreNames]).toEqual([
            'bookmarks',
            'books',
            'covers',
            'files',
            'highlights',
            'progress',
        ])

        const transaction = raw.transaction([...raw.objectStoreNames], 'readonly')
        const store = (name: string) => transaction.objectStore(name)
        expect(store('books').keyPath).toBe('id')
        expect([...store('books').indexNames]).toEqual(['fileHash'])
        // One file is one book. The engine refuses a second record with the same hash.
        expect(store('books').index('fileHash').unique).toBe(true)
        expect(store('bookmarks').index('bookId').unique).toBe(false)
        expect(store('highlights').index('bookId').unique).toBe(false)
        expect(store('files').keyPath).toBeNull()
        expect(store('covers').keyPath).toBeNull()
        expect(store('progress').keyPath).toBe('bookId')
        expect(store('bookmarks').keyPath).toBe('id')
        expect([...store('bookmarks').indexNames]).toEqual(['bookId'])
        expect(store('highlights').keyPath).toBe('id')
        expect([...store('highlights').indexNames]).toEqual(['bookId'])
        raw.close()
    })

    it('uses the database name from the options', async () => {
        const factory = new IDBFactory()
        const database = createDatabase({ indexedDB: factory, databaseName: 'other' })
        await putProgress(database, 'a')

        const names = (await factory.databases()).map((info) => info.name)
        expect(names).toEqual(['other'])
    })

    it('shares one open request between calls that start together', async () => {
        const tracked = trackFactory(new IDBFactory())
        const database = createDatabase({ indexedDB: tracked.factory })

        await Promise.all([putProgress(database, 'a'), putProgress(database, 'b')])
        expect(await countProgress(database)).toBe(2)
        expect(tracked.openCount()).toBe(1)
    })

    it('starts the transaction before run returns when the connection is open', async () => {
        const tracked = trackFactory(new IDBFactory())
        const database = createDatabase({ indexedDB: tracked.factory })
        await countProgress(database)
        const before = tracked.transactions.length

        const pending = putProgress(database, 'a')
        expect(tracked.transactions.length).toBe(before + 1)
        await pending
    })

    it('resolves only after the transaction is complete', async () => {
        const database = createDatabase({ indexedDB: new IDBFactory() })
        const events: string[] = []

        await database
            .run({
                stores: 'progress',
                mode: 'readwrite',
                failureMessage: 'Unable to save.',
                work: (transaction) => {
                    const request = transaction.objectStore('progress').put({ bookId: 'a' })
                    request.onsuccess = () => events.push('request success')
                    transaction.addEventListener('complete', () => events.push('complete'))
                },
            })
            .then(() => events.push('resolved'))

        expect(events).toEqual(['request success', 'complete', 'resolved'])
    })

    it('rejects with the request error and writes nothing when a request fails', async () => {
        const database = createDatabase({ indexedDB: new IDBFactory() })
        const add = (bookId: string, id: string) =>
            database.run({
                stores: ['books', 'progress'],
                mode: 'readwrite',
                failureMessage: 'Unable to save.',
                work: (transaction) => {
                    transaction.objectStore('progress').put({ bookId })
                    transaction.objectStore('books').add({ id })
                },
            })

        await add('first', 'same-id')
        await expect(add('second', 'same-id')).rejects.toMatchObject({ name: 'ConstraintError' })
        expect(await countProgress(database)).toBe(1)
    })

    it('rejects with the failure message when the transaction aborts with no error', async () => {
        const database = createDatabase({ indexedDB: new IDBFactory() })

        const pending = database.run({
            stores: 'progress',
            mode: 'readwrite',
            failureMessage: 'Unable to save.',
            work: (transaction) => {
                transaction.objectStore('progress').put({ bookId: 'a' })
                transaction.abort()
            },
        })

        await expect(pending).rejects.toThrow('Unable to save.')
        expect(await countProgress(database)).toBe(0)
    })

    it('rejects and aborts when the work function throws', async () => {
        const database = createDatabase({ indexedDB: new IDBFactory() })

        const pending = database.run({
            stores: 'progress',
            mode: 'readwrite',
            failureMessage: 'Unable to save.',
            work: (transaction) => {
                transaction.objectStore('progress').put({ bookId: 'a' })
                throw new Error('The work failed.')
            },
        })

        await expect(pending).rejects.toThrow('The work failed.')
        expect(await countProgress(database)).toBe(0)
    })

    it('opens the database again after close()', async () => {
        const tracked = trackFactory(new IDBFactory())
        const database = createDatabase({ indexedDB: tracked.factory })
        await putProgress(database, 'a')

        database.close()
        expect(await countProgress(database)).toBe(1)
        expect(tracked.openCount()).toBe(2)
    })

    it('opens the database again after the browser closed the connection', async () => {
        const tracked = trackFactory(new IDBFactory())
        const database = createDatabase({ indexedDB: tracked.factory })
        await putProgress(database, 'a')

        // This sends the close event, as a browser does for a background tab.
        forceCloseDatabase(tracked.connections[0] as never)
        await putProgress(database, 'b')

        expect(await countProgress(database)).toBe(2)
        expect(tracked.openCount()).toBe(2)
    })

    it('opens the database again when the connection is closed and no event arrived', async () => {
        const tracked = trackFactory(new IDBFactory())
        const database = createDatabase({ indexedDB: tracked.factory })
        await putProgress(database, 'a')

        tracked.connections[0].close()
        await putProgress(database, 'b')

        expect(await countProgress(database)).toBe(2)
        expect(tracked.openCount()).toBe(2)
    })

    it('tries a closed connection only one more time', async () => {
        const tracked = trackFactory(new IDBFactory())
        const database = createDatabase({ indexedDB: tracked.factory })
        await putProgress(database, 'a')

        const open = tracked.factory.open.bind(tracked.factory)
        tracked.factory.open = (name, version) => {
            const request = open(name, version)
            request.addEventListener('success', () => request.result.close())
            return request
        }
        tracked.connections[0].close()

        await expect(putProgress(database, 'b')).rejects.toMatchObject({
            name: 'InvalidStateError',
        })
        expect(tracked.openCount()).toBe(2)
    })

    it('does not retry an error that is not about a closed connection', async () => {
        const tracked = trackFactory(new IDBFactory())
        const database = createDatabase({ indexedDB: tracked.factory })
        await putProgress(database, 'a')

        const pending = database.run({
            stores: 'missing' as 'books',
            mode: 'readonly',
            failureMessage: 'Unable to read.',
            work: () => undefined,
        })

        await expect(pending).rejects.toMatchObject({ name: 'NotFoundError' })
        expect(tracked.openCount()).toBe(1)
    })

    it('closes its connection when another tab upgrades the database', async () => {
        const factory = new IDBFactory()
        const database = createDatabase({ indexedDB: factory })
        await putProgress(database, 'a')

        // This open is blocked for all time if the first connection stays open.
        const newer = await openRaw(factory, DATABASE_VERSION + 1)
        newer.close()

        await expect(countProgress(database)).rejects.toThrow(
            'A newer version of this app changed the library. Reload this page.',
        )
    })

    it('rejects a blocked open and closes the connection that arrives later', async () => {
        const lateConnection = { close: vi.fn() }
        const request = { result: lateConnection, error: null } as unknown as IDBOpenDBRequest
        const factory = { open: vi.fn(() => request) } as unknown as IDBFactory
        const database = createDatabase({ indexedDB: factory })

        const pending = countProgress(database)
        request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)
        await expect(pending).rejects.toThrow(
            'Another tab uses an old version of the library. Close that tab and try again.',
        )

        request.onsuccess?.(new Event('success'))
        expect(lateConnection.close).toHaveBeenCalledOnce()
    })

    it('aborts the upgrade of a blocked open that continues later', async () => {
        const upgradeTransaction = { abort: vi.fn() }
        const lateConnection = { createObjectStore: vi.fn() }
        const request = {
            result: lateConnection,
            error: null,
            transaction: upgradeTransaction,
        } as unknown as IDBOpenDBRequest
        const factory = { open: vi.fn(() => request) } as unknown as IDBFactory
        const database = createDatabase({ indexedDB: factory })

        const pending = countProgress(database)
        request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)
        await expect(pending).rejects.toThrow('Another tab uses an old version of the library.')

        request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent)
        expect(upgradeTransaction.abort).toHaveBeenCalledOnce()
        expect(lateConnection.createObjectStore).not.toHaveBeenCalled()
    })

    it('keeps the browser error as the cause when the open request fails', async () => {
        const cause = new DOMException('Internal error.', 'UnknownError')
        const request = { error: cause } as unknown as IDBOpenDBRequest
        const factory = { open: vi.fn(() => request) } as unknown as IDBFactory
        const database = createDatabase({ indexedDB: factory })

        const pending = countProgress(database)
        request.onerror?.(new Event('error'))

        await expect(pending).rejects.toMatchObject({
            message: 'Unable to open the library. Internal error.',
            cause,
        })
    })

    it('opens the database again after an open that failed', async () => {
        const inner = new IDBFactory()
        let failures = 1
        const factory = {
            open: (name: string, version?: number) => {
                if (failures-- > 0) throw new DOMException('Not now.', 'UnknownError')
                return inner.open(name, version)
            },
        } as unknown as IDBFactory
        const database = createDatabase({ indexedDB: factory })

        await expect(putProgress(database, 'a')).rejects.toThrow('Book storage is not available')
        await putProgress(database, 'b')
        expect(await countProgress(database)).toBe(1)
    })

    it('rejects with a clear error when IndexedDB is not available', async () => {
        expect(globalThis.indexedDB).toBeUndefined()
        const database = createDatabase()

        await expect(countProgress(database)).rejects.toThrow(
            'Book storage is not available in this browser.',
        )
    })

    it('rejects with a clear error when the browser refuses the open call', async () => {
        const factory = {
            open: () => {
                throw new DOMException('The operation is insecure.', 'SecurityError')
            },
        } as unknown as IDBFactory
        const database = createDatabase({ indexedDB: factory })

        await expect(countProgress(database)).rejects.toThrow(
            'Book storage is not available in this browser.',
        )
    })

    it('uses the indexedDB of the page when the options have no factory', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory())
        try {
            const database = createDatabase()
            await putProgress(database, 'a')
            expect(await countProgress(database)).toBe(1)
            database.close()
        } finally {
            vi.unstubAllGlobals()
        }
    })
})
