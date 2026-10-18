/**
 * The IndexedDB connection of the library and the helper that runs one transaction.
 *
 * `./types` lists the object stores. This module has no knowledge of the record types.
 */

export const DATABASE_NAME = 'page-goblin'
export const DATABASE_VERSION = 3

export type StoreName =
    | 'books'
    | 'files'
    | 'covers'
    | 'progress'
    | 'bookmarks'
    | 'highlights'
    | 'outbox'
    | 'syncState'
    | 'fonts'
    | 'fontFiles'

export interface DatabaseOptions {
    /** The default is `page-goblin`. */
    databaseName?: string
    /** The default is the `indexedDB` of the page. A test passes its own factory. */
    indexedDB?: IDBFactory
}

export interface TransactionOptions<T> {
    stores: StoreName | StoreName[]
    mode: IDBTransactionMode
    /** The error message when the transaction fails and gives no error of its own. */
    failureMessage: string
    /** 'relaxed' lets the browser skip the flush to disk. Use it for small, frequent writes. */
    durability?: IDBTransactionDurability
    /**
     * Adds the requests to the transaction. It can return a function that reads the results of
     * the requests. That function runs after the transaction is complete.
     */
    work: (transaction: IDBTransaction) => (() => T) | void
}

export interface Database {
    /**
     * Run one transaction. The promise settles when the transaction completes or fails, not
     * when a request succeeds. With an open connection the transaction starts before this
     * function returns, so a save in a `pagehide` handler is not delayed.
     */
    run<T = void>(options: TransactionOptions<T>): Promise<T>
    /** Close the connection. The next `run` opens it again. */
    close(): void
}

const UNAVAILABLE_MESSAGE =
    'Book storage is not available in this browser. ' +
    'Private browsing or blocked site data can cause this.'

function upgrade(db: IDBDatabase, oldVersion: number): void {
    if (oldVersion < 1) {
        // The index is unique, so two imports of one file at the same time cannot both add it.
        db.createObjectStore('books', { keyPath: 'id' }).createIndex('fileHash', 'fileHash', {
            unique: true,
        })
        db.createObjectStore('files')
        db.createObjectStore('covers')
        db.createObjectStore('progress', { keyPath: 'bookId' })
        db.createObjectStore('bookmarks', { keyPath: 'id' }).createIndex('bookId', 'bookId')
        db.createObjectStore('highlights', { keyPath: 'id' }).createIndex('bookId', 'bookId')
    }
    if (oldVersion < 2) {
        db.createObjectStore('outbox', { keyPath: 'id' })
        db.createObjectStore('syncState')
    }
    if (oldVersion < 3) {
        db.createObjectStore('fonts', { keyPath: 'id' })
        db.createObjectStore('fontFiles')
    }
}

function hasName(error: unknown, name: string): boolean {
    return (
        typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name
    )
}

function start<T>(db: IDBDatabase, options: TransactionOptions<T>): Promise<T> {
    const { stores, mode, failureMessage, durability, work } = options
    // This call throws InvalidStateError when the connection is closed.
    const transaction = db.transaction(stores, mode, durability ? { durability } : undefined)

    return new Promise<T>((resolve, reject) => {
        let read: (() => T) | void

        transaction.oncomplete = () => {
            try {
                resolve(typeof read === 'function' ? read() : (undefined as T))
            } catch (error) {
                reject(error)
            }
        }
        // The error of a request arrives here before the transaction has its own error.
        // AbortError is not a cause. Each pending request of an aborted transaction gets it,
        // and the abort event follows.
        transaction.onerror = (event) => {
            const error = (event.target as IDBRequest | null)?.error
            if (error && error.name !== 'AbortError') reject(error)
        }
        // A commit that fails, for example when the disk is full, gives only this event.
        transaction.onabort = () => reject(transaction.error ?? new Error(failureMessage))

        try {
            read = work(transaction)
        } catch (error) {
            reject(error)
            try {
                transaction.abort()
            } catch {
                // The transaction is already finished.
            }
        }
    })
}

export function createDatabase(options: DatabaseOptions = {}): Database {
    const databaseName = options.databaseName ?? DATABASE_NAME
    let connection: IDBDatabase | null = null
    let opening: Promise<IDBDatabase> | null = null

    function findFactory(): IDBFactory | null {
        if (options.indexedDB) return options.indexedDB
        try {
            return globalThis.indexedDB ?? null
        } catch {
            // Some browsers throw here when site data is blocked.
            return null
        }
    }

    function openRequest(): Promise<IDBDatabase> {
        return new Promise<IDBDatabase>((resolve, reject) => {
            const factory = findFactory()
            if (!factory) {
                reject(new Error(UNAVAILABLE_MESSAGE))
                return
            }

            let request: IDBOpenDBRequest
            try {
                request = factory.open(databaseName, DATABASE_VERSION)
            } catch (error) {
                reject(new Error(UNAVAILABLE_MESSAGE, { cause: error }))
                return
            }

            // An open request can stay blocked and then succeed much later. The caller already
            // has an error at that time, so the late connection must not stay open.
            let cancelled = false

            request.onupgradeneeded = (event) => {
                if (cancelled) {
                    request.transaction?.abort()
                    return
                }
                upgrade(request.result, event.oldVersion)
            }
            request.onblocked = () => {
                cancelled = true
                reject(
                    new Error(
                        'Another tab uses an old version of the library. Close that tab and try again.',
                    ),
                )
            }
            request.onerror = () => {
                const cause = request.error
                // The text of the browser is the second sentence, because it names the reason.
                const message = hasName(cause, 'VersionError')
                    ? 'A newer version of this app changed the library. Reload this page.'
                    : ['Unable to open the library.', cause?.message].filter(Boolean).join(' ')
                reject(new Error(message, { cause }))
            }
            request.onsuccess = () => {
                const db = request.result
                if (cancelled) {
                    db.close()
                    return
                }
                // A tab with newer code cannot upgrade the database while this connection is open.
                db.onversionchange = () => {
                    db.close()
                    if (connection === db) connection = null
                }
                // A browser can close an idle connection, for example in a background tab.
                db.onclose = () => {
                    if (connection === db) connection = null
                }
                connection = db
                resolve(db)
            }
        })
    }

    function open(): Promise<IDBDatabase> {
        if (connection) return Promise.resolve(connection)
        // All callers that arrive during the open share one request.
        opening ??= openRequest().finally(() => {
            opening = null
        })
        return opening
    }

    function run<T = void>(transactionOptions: TransactionOptions<T>): Promise<T> {
        const reopen = () => open().then((db) => start(db, transactionOptions))

        if (!connection) return reopen()
        try {
            return start(connection, transactionOptions)
        } catch (error) {
            if (!hasName(error, 'InvalidStateError')) return Promise.reject(error)
            // The browser closed the connection and sent no close event. Try one more time.
            connection = null
            return reopen()
        }
    }

    function close(): void {
        connection?.close()
        connection = null
    }

    return { run, close }
}
