/**
 * Test helper. It wraps an IDBFactory and records what the code under test does with it.
 */

export interface RecordedTransaction {
    stores: string[]
    mode: IDBTransactionMode
}

export interface TrackedFactory {
    factory: IDBFactory
    /** Each connection that an open request gave, oldest first. */
    connections: IDBDatabase[]
    /** Each transaction that started on these connections, oldest first. */
    transactions: RecordedTransaction[]
    openCount: () => number
}

export function trackFactory(inner: IDBFactory): TrackedFactory {
    const connections: IDBDatabase[] = []
    const transactions: RecordedTransaction[] = []
    let opens = 0

    const factory = {
        open(name: string, version?: number) {
            opens++
            const request = inner.open(name, version)
            request.addEventListener('success', () => {
                const db = request.result
                const startTransaction = db.transaction.bind(db)
                db.transaction = (stores, mode, options) => {
                    const transaction = startTransaction(stores, mode, options)
                    transactions.push({
                        stores: typeof stores === 'string' ? [stores] : [...stores],
                        mode: mode ?? 'readonly',
                    })
                    return transaction
                }
                connections.push(db)
            })
            return request
        },
        deleteDatabase: (name: string) => inner.deleteDatabase(name),
        cmp: (first: unknown, second: unknown) => inner.cmp(first, second),
        databases: () => inner.databases(),
    } as IDBFactory

    return { factory, connections, transactions, openCount: () => opens }
}
