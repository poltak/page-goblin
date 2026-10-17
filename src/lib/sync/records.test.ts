import { describe, expect, it } from 'vitest'
import type { SyncBookValue, SyncItem } from '$lib/storage/types'
import { fromChange, toChange } from './records'
import type { StoredChange } from './types'

const HASH = 'a'.repeat(64)

function book(changes: Partial<SyncBookValue> = {}): SyncBookValue {
    return {
        title: 'A Title',
        author: 'An Author',
        language: 'en',
        identifier: null,
        publisher: null,
        description: null,
        published: null,
        subjects: ['Fiction'],
        series: { name: 'Series', position: 1 },
        fileName: 'a.epub',
        fileSize: 10,
        fileHash: HASH,
        hasCover: false,
        spineStats: [{ chars: 10, words: 2 }],
        totalChars: 10,
        totalWords: 2,
        addedAt: 1000,
        lastOpenedAt: null,
        ...changes,
    }
}

function stored(item: SyncItem, seq = 1): StoredChange {
    return { ...toChange(item), seq }
}

describe('records', () => {
    it('sends a record as JSON text and reads it back', () => {
        const items: SyncItem[] = [
            { kind: 'book', key: HASH, updatedAt: 1000, deleted: false, value: book() },
            {
                kind: 'progress',
                key: HASH,
                updatedAt: 2000,
                deleted: false,
                value: {
                    fileHash: HASH,
                    locator: { spineIndex: 1, offset: 5 },
                    fraction: 0.4,
                    updatedAt: 2000,
                },
            },
            {
                kind: 'bookmark',
                key: 'm1',
                updatedAt: 3000,
                deleted: false,
                value: {
                    id: 'm1',
                    fileHash: HASH,
                    locator: { spineIndex: 0, offset: 0 },
                    fraction: 0,
                    chapterTitle: 'One',
                    excerpt: 'Words',
                    createdAt: 3000,
                },
            },
            {
                kind: 'highlight',
                key: 'h1',
                updatedAt: 4000,
                deleted: false,
                value: {
                    id: 'h1',
                    fileHash: HASH,
                    spineIndex: 0,
                    start: 1,
                    end: 4,
                    text: 'abc',
                    color: 'blue',
                    note: 'A note',
                    chapterTitle: 'One',
                    fraction: 0.1,
                    createdAt: 4000,
                    updatedAt: 4000,
                },
            },
            { kind: 'highlight', key: 'h2', updatedAt: 5000, deleted: true, value: null },
        ]
        for (const item of items) expect(fromChange(stored(item))).toEqual(item)
    })

    it('drops fields that are not in the contract', () => {
        const change = stored({
            kind: 'book',
            key: HASH,
            updatedAt: 1,
            deleted: false,
            value: book(),
        })
        change.data = JSON.stringify({ ...book(), id: 'local', remoteOnly: true, extra: 1 })
        expect(fromChange(change)?.value).toEqual(book())
    })

    it('drops a change that is not valid', () => {
        const base = stored({
            kind: 'book',
            key: HASH,
            updatedAt: 1,
            deleted: false,
            value: book(),
        })
        const bad: StoredChange[] = [
            { ...base, data: '{nope' },
            { ...base, format: 2 },
            { ...base, data: JSON.stringify(book({ fileHash: 'b'.repeat(64) })) },
            { ...base, data: JSON.stringify(book({ title: 5 as unknown as string })) },
            { ...base, data: JSON.stringify(book({ spineStats: [{ chars: -1, words: 0 }] })) },
            { ...base, data: JSON.stringify({ ...book(), subjects: [1] }) },
            {
                ...base,
                kind: 'progress',
                data: JSON.stringify({
                    fileHash: HASH,
                    locator: { spineIndex: 0, offset: 0 },
                    fraction: 2,
                    updatedAt: 1,
                }),
            },
            {
                ...base,
                kind: 'bookmark',
                key: 'm1',
                data: JSON.stringify({ id: 'other', fileHash: HASH }),
            },
        ]
        for (const change of bad) expect(fromChange(change)).toBeNull()
    })
})
