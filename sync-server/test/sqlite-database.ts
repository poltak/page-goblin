/**
 * The parts of D1 that the handler uses, on the SQLite of Node. D1 is SQLite too, so the SQL
 * of the handler runs here as it does on Cloudflare.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Database, Statement } from '../src/handler'

// Not an import: Vite refuses to bundle node:sqlite for the tests that run in jsdom.
const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')

class SqliteStatement implements Statement {
    constructor(
        private readonly db: DatabaseSync,
        private readonly sql: string,
        private readonly values: SQLInputValue[] = [],
    ) {}

    bind(...values: unknown[]): Statement {
        return new SqliteStatement(this.db, this.sql, values as SQLInputValue[])
    }

    async first<T>(): Promise<T | null> {
        return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null
    }

    async all<T>(): Promise<{ results: T[] }> {
        return { results: this.allNow<T>() }
    }

    async run(): Promise<unknown> {
        return this.db.prepare(this.sql).run(...this.values)
    }

    allNow<T>(): T[] {
        const statement = this.db.prepare(this.sql)
        if (!statement.columns().length) {
            statement.run(...this.values)
            return []
        }
        return statement.all(...this.values) as T[]
    }
}

export function createSqliteDatabase(): Database & { close(): void } {
    const db = new sqlite.DatabaseSync(':memory:')
    return {
        prepare: (sql) => new SqliteStatement(db, sql),
        async batch<T>(statements: Statement[]) {
            db.exec('BEGIN')
            try {
                const results = statements.map((statement) => ({
                    results: (statement as SqliteStatement).allNow<T>(),
                }))
                db.exec('COMMIT')
                return results
            } catch (error) {
                db.exec('ROLLBACK')
                throw error
            }
        },
        close: () => db.close(),
    }
}
