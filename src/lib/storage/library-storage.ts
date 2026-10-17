import { compareLocators } from '$lib/types'
import { createDatabase, type Database, type DatabaseOptions, type StoreName } from './db'
import type {
    BookmarkRecord,
    BookRecord,
    ChangeTracker,
    HighlightRecord,
    LibraryStorage,
    OutboxEntry,
    ProgressRecord,
} from './types'

export interface LibraryStorageOptions extends DatabaseOptions {
    /** While `changes.isOn()` is true, each write also writes the outbox of the sync. */
    changes?: ChangeTracker
    /** Epoch milliseconds for the time of a change. The default is `Date.now`. */
    now?: () => number
}

/**
 * `LibraryStorage` with the write that repairs a book whose stored file is missing. The
 * import of a book uses it. See `importBook`.
 */
export interface LibraryFileStorage extends LibraryStorage {
    /**
     * Writes the file of a book that is in the library, in the place of the file that is
     * there. Does nothing when the library does not have the book. A book that had only a
     * record on this device then has its file.
     */
    putFile(id: string, file: Blob): Promise<void>
    /** The connection to the database. The sync runs its own transactions on it. */
    readonly database: Database
}

interface ReadOptions<T> {
    store: StoreName
    failureMessage: string
    request: (store: IDBObjectStore) => IDBRequest<T>
}

interface WriteOptions {
    store: StoreName
    failureMessage: string
    durability?: IDBTransactionDurability
    request: (store: IDBObjectStore) => void
    /** The outbox entry of the change. Without it, the write does not touch the outbox. */
    change?: () => OutboxEntry
}

export function outboxEntry(
    kind: OutboxEntry['kind'],
    key: string,
    change: { deleted: boolean; changedAt: number },
): OutboxEntry {
    return { id: `${kind}:${key}`, kind, key, ...change }
}

/** Fields of a book record that a change of does not sync. */
const LOCAL_FIELDS = new Set<string>(['lastOpenedAt', 'remoteOnly'])

/** The record without the field that is true only on a device that has no file. */
export function withFile(book: BookRecord): BookRecord {
    const { remoteOnly: _, ...rest } = book
    return rest
}

function compareBookmarks(a: BookmarkRecord, b: BookmarkRecord): number {
    return compareLocators(a.locator, b.locator) || a.createdAt - b.createdAt
}

function compareHighlights(a: HighlightRecord, b: HighlightRecord): number {
    return (
        a.spineIndex - b.spineIndex ||
        a.start - b.start ||
        a.end - b.end ||
        a.createdAt - b.createdAt
    )
}

export function createLibraryStorage(options: LibraryStorageOptions = {}): LibraryFileStorage {
    const database = createDatabase(options)
    const { changes } = options
    const now = options.now ?? Date.now

    /** True when the write that starts now must also write the outbox. */
    function tracking(): boolean {
        if (!changes) return false
        try {
            return changes.isOn()
        } catch {
            return false
        }
    }

    /** Tells the tracker about a write to the outbox. The write itself is complete. */
    function afterTracked<T>(tracked: boolean, write: Promise<T>): Promise<T> {
        if (!tracked) return write
        return write.then((result) => {
            try {
                changes?.onChange()
            } catch (error) {
                console.error(error)
            }
            return result
        })
    }

    function read<T>({ store, failureMessage, request }: ReadOptions<T>): Promise<T> {
        return database.run<T>({
            stores: store,
            mode: 'readonly',
            failureMessage,
            work: (transaction) => {
                const pending = request(transaction.objectStore(store))
                return () => pending.result
            },
        })
    }

    function write(writeOptions: WriteOptions): Promise<void> {
        const { store, failureMessage, durability, request, change } = writeOptions
        const tracked = change !== undefined && tracking()
        const written = database.run({
            stores: tracked ? [store, 'outbox'] : store,
            mode: 'readwrite',
            failureMessage,
            durability,
            work: (transaction) => {
                request(transaction.objectStore(store))
                if (tracked) transaction.objectStore('outbox').put(change())
            },
        })
        return afterTracked(tracked, written)
    }

    return {
        database,

        listBooks: () =>
            read<BookRecord[]>({
                store: 'books',
                failureMessage: 'Unable to read the library.',
                request: (store) => store.getAll(),
            }),

        getBook: (id) =>
            read<BookRecord | undefined>({
                store: 'books',
                failureMessage: 'Unable to read the book.',
                request: (store) => store.get(id),
            }),

        findBookByHash: (fileHash) =>
            read<BookRecord | undefined>({
                store: 'books',
                failureMessage: 'Unable to read the library.',
                request: (store) => store.index('fileHash').get(fileHash),
            }),

        addBook: ({ record, file, cover }) => {
            const tracked = tracking()
            const stores: StoreName[] = ['books', 'files', 'covers']
            if (tracked) stores.push('outbox')
            const written = database.run({
                stores,
                mode: 'readwrite',
                failureMessage: 'Unable to save the book.',
                work: (transaction) => {
                    // `add` fails when the id is in use, so it cannot replace a different book.
                    // It also fails when a book with the same file hash is there. In the two
                    // cases the error is a ConstraintError and the transaction writes nothing.
                    transaction.objectStore('books').add(record)
                    transaction.objectStore('files').put(file, record.id)
                    if (cover) transaction.objectStore('covers').put(cover, record.id)
                    if (tracked) {
                        const outbox = transaction.objectStore('outbox')
                        const change = { deleted: false, changedAt: record.addedAt }
                        outbox.put(outboxEntry('book', record.fileHash, change))
                        outbox.put(outboxEntry('file', record.fileHash, change))
                    }
                },
            })
            return afterTracked(tracked, written)
        },

        updateBook: (id, patch) => {
            // The time of the last open stays on this device. An open on one device must not
            // win over a delete of the book on a different device.
            const synced = Object.keys(patch).some((field) => !LOCAL_FIELDS.has(field))
            const tracked = synced && tracking()
            const written = database.run({
                stores: tracked ? ['books', 'outbox'] : 'books',
                mode: 'readwrite',
                failureMessage: 'Unable to update the book.',
                work: (transaction) => {
                    const store = transaction.objectStore('books')
                    const current = store.get(id)
                    current.onsuccess = () => {
                        const book = current.result as BookRecord | undefined
                        if (!book) return
                        store.put({ ...book, ...patch, id })
                        if (!tracked) return
                        transaction.objectStore('outbox').put(
                            outboxEntry('book', book.fileHash, {
                                deleted: false,
                                changedAt: now(),
                            }),
                        )
                    }
                },
            })
            return afterTracked(tracked, written)
        },

        deleteBook: (id) => {
            const tracked = tracking()
            const stores: StoreName[] = [
                'books',
                'files',
                'covers',
                'progress',
                'bookmarks',
                'highlights',
            ]
            if (tracked) stores.push('outbox')
            const written = database.run({
                stores,
                mode: 'readwrite',
                failureMessage: 'Unable to delete the book.',
                work: (transaction) => {
                    const deleted = { deleted: true, changedAt: now() }
                    const outbox = tracked ? transaction.objectStore('outbox') : null
                    if (outbox) {
                        // The other devices remove the book, its progress and its notes.
                        const book = transaction.objectStore('books').get(id)
                        book.onsuccess = () => {
                            const record = book.result as BookRecord | undefined
                            if (!record) return
                            outbox.put(outboxEntry('book', record.fileHash, deleted))
                            outbox.put(outboxEntry('progress', record.fileHash, deleted))
                            outbox.delete(outboxEntry('file', record.fileHash, deleted).id)
                        }
                    }
                    for (const name of ['books', 'files', 'covers', 'progress']) {
                        transaction.objectStore(name).delete(id)
                    }
                    for (const name of ['bookmarks', 'highlights'] as const) {
                        const store = transaction.objectStore(name)
                        const keys = store.index('bookId').getAllKeys(id)
                        keys.onsuccess = () => {
                            for (const key of keys.result) {
                                store.delete(key)
                                const kind = name === 'bookmarks' ? 'bookmark' : 'highlight'
                                outbox?.put(outboxEntry(kind, String(key), deleted))
                            }
                        }
                    }
                },
            })
            return afterTracked(tracked, written)
        },

        getFile: (id) =>
            read<Blob | undefined>({
                store: 'files',
                failureMessage: 'Unable to read the book file.',
                request: (store) => store.get(id),
            }),

        putFile: (id, file) => {
            const tracked = tracking()
            const written = database.run({
                stores: tracked ? ['books', 'files', 'outbox'] : ['books', 'files'],
                mode: 'readwrite',
                failureMessage: 'Unable to save the book file.',
                work: (transaction) => {
                    // The user can remove the book while the import reads the file. A file
                    // with no book record would stay in the storage, and nothing removes it.
                    const books = transaction.objectStore('books')
                    const current = books.get(id)
                    current.onsuccess = () => {
                        const book = current.result as BookRecord | undefined
                        if (!book) return
                        transaction.objectStore('files').put(file, id)
                        if (book.remoteOnly !== undefined) books.put(withFile(book))
                        if (!tracked) return
                        // The server can have no copy, for example after a failed upload.
                        transaction.objectStore('outbox').put(
                            outboxEntry('file', book.fileHash, {
                                deleted: false,
                                changedAt: now(),
                            }),
                        )
                    }
                },
            })
            return afterTracked(tracked, written)
        },

        getCover: (id) =>
            read<Blob | undefined>({
                store: 'covers',
                failureMessage: 'Unable to read the cover.',
                request: (store) => store.get(id),
            }),

        listProgress: () =>
            read<ProgressRecord[]>({
                store: 'progress',
                failureMessage: 'Unable to read the reading progress.',
                request: (store) => store.getAll(),
            }),

        getProgress: (bookId) =>
            read<ProgressRecord | undefined>({
                store: 'progress',
                failureMessage: 'Unable to read the reading progress.',
                request: (store) => store.get(bookId),
            }),

        // This runs on each position change. It must not open the stores with large records.
        // The books store has no file data, so the sync can read the file hash there.
        saveProgress: (progress) => {
            const tracked = tracking()
            const written = database.run({
                stores: tracked ? ['progress', 'books', 'outbox'] : 'progress',
                mode: 'readwrite',
                failureMessage: 'Unable to save the reading progress.',
                durability: 'relaxed',
                work: (transaction) => {
                    transaction.objectStore('progress').put(progress)
                    if (!tracked) return
                    const book = transaction.objectStore('books').get(progress.bookId)
                    book.onsuccess = () => {
                        const record = book.result as BookRecord | undefined
                        if (!record) return
                        transaction.objectStore('outbox').put(
                            outboxEntry('progress', record.fileHash, {
                                deleted: false,
                                changedAt: progress.updatedAt,
                            }),
                        )
                    }
                },
            })
            return afterTracked(tracked, written)
        },

        listBookmarks: (bookId) =>
            read<BookmarkRecord[]>({
                store: 'bookmarks',
                failureMessage: 'Unable to read the bookmarks.',
                request: (store) => store.index('bookId').getAll(bookId),
            }).then((bookmarks) => bookmarks.sort(compareBookmarks)),

        putBookmark: (bookmark) =>
            write({
                store: 'bookmarks',
                failureMessage: 'Unable to save the bookmark.',
                request: (store) => store.put(bookmark),
                change: () =>
                    outboxEntry('bookmark', bookmark.id, {
                        deleted: false,
                        changedAt: bookmark.createdAt,
                    }),
            }),

        deleteBookmark: (id) =>
            write({
                store: 'bookmarks',
                failureMessage: 'Unable to delete the bookmark.',
                request: (store) => store.delete(id),
                change: () => outboxEntry('bookmark', id, { deleted: true, changedAt: now() }),
            }),

        listHighlights: (bookId) =>
            read<HighlightRecord[]>({
                store: 'highlights',
                failureMessage: 'Unable to read the highlights.',
                request: (store) => store.index('bookId').getAll(bookId),
            }).then((highlights) => highlights.sort(compareHighlights)),

        putHighlight: (highlight) =>
            write({
                store: 'highlights',
                failureMessage: 'Unable to save the highlight.',
                request: (store) => store.put(highlight),
                change: () =>
                    outboxEntry('highlight', highlight.id, {
                        deleted: false,
                        changedAt: highlight.updatedAt,
                    }),
            }),

        deleteHighlight: (id) =>
            write({
                store: 'highlights',
                failureMessage: 'Unable to delete the highlight.',
                request: (store) => store.delete(id),
                change: () => outboxEntry('highlight', id, { deleted: true, changedAt: now() }),
            }),

        close: () => database.close(),
    }
}
