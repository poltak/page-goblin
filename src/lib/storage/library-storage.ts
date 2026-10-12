import { compareLocators } from '$lib/types'
import { createDatabase, type DatabaseOptions, type StoreName } from './db'
import type {
    BookmarkRecord,
    BookRecord,
    HighlightRecord,
    LibraryStorage,
    ProgressRecord,
} from './types'

export type LibraryStorageOptions = DatabaseOptions

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

export function createLibraryStorage(options: LibraryStorageOptions = {}): LibraryStorage {
    const database = createDatabase(options)

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

    function write({ store, failureMessage, durability, request }: WriteOptions): Promise<void> {
        return database.run({
            stores: store,
            mode: 'readwrite',
            failureMessage,
            durability,
            work: (transaction) => {
                request(transaction.objectStore(store))
            },
        })
    }

    return {
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

        addBook: ({ record, file, cover }) =>
            database.run({
                stores: ['books', 'files', 'covers'],
                mode: 'readwrite',
                failureMessage: 'Unable to save the book.',
                work: (transaction) => {
                    // `add` fails when the id is in use, so it cannot replace a different book.
                    // It also fails when a book with the same file hash is there. In the two
                    // cases the error is a ConstraintError and the transaction writes nothing.
                    transaction.objectStore('books').add(record)
                    transaction.objectStore('files').put(file, record.id)
                    if (cover) transaction.objectStore('covers').put(cover, record.id)
                },
            }),

        updateBook: (id, patch) =>
            write({
                store: 'books',
                failureMessage: 'Unable to update the book.',
                request: (store) => {
                    const current = store.get(id)
                    current.onsuccess = () => {
                        if (current.result) store.put({ ...current.result, ...patch, id })
                    }
                },
            }),

        deleteBook: (id) =>
            database.run({
                stores: ['books', 'files', 'covers', 'progress', 'bookmarks', 'highlights'],
                mode: 'readwrite',
                failureMessage: 'Unable to delete the book.',
                work: (transaction) => {
                    for (const name of ['books', 'files', 'covers', 'progress']) {
                        transaction.objectStore(name).delete(id)
                    }
                    for (const name of ['bookmarks', 'highlights']) {
                        const store = transaction.objectStore(name)
                        const keys = store.index('bookId').getAllKeys(id)
                        keys.onsuccess = () => {
                            for (const key of keys.result) store.delete(key)
                        }
                    }
                },
            }),

        getFile: (id) =>
            read<Blob | undefined>({
                store: 'files',
                failureMessage: 'Unable to read the book file.',
                request: (store) => store.get(id),
            }),

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
        saveProgress: (progress) =>
            write({
                store: 'progress',
                failureMessage: 'Unable to save the reading progress.',
                durability: 'relaxed',
                request: (store) => store.put(progress),
            }),

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
            }),

        deleteBookmark: (id) =>
            write({
                store: 'bookmarks',
                failureMessage: 'Unable to delete the bookmark.',
                request: (store) => store.delete(id),
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
            }),

        deleteHighlight: (id) =>
            write({
                store: 'highlights',
                failureMessage: 'Unable to delete the highlight.',
                request: (store) => store.delete(id),
            }),

        close: () => database.close(),
    }
}
