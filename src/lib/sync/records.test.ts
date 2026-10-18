import { describe, expect, it } from 'vitest'
import { MAX_FONT_FILE_BYTES } from '$lib/fonts/import'
import type { SyncBookValue, SyncFontValue, SyncItem } from '$lib/storage/types'
import { MAX_FONT_BYTES } from '../../../sync-server/src/protocol'
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

function font(changes: Partial<SyncFontValue> = {}): SyncFontValue {
    return {
        name: 'My Font',
        fallback: 'sans-serif',
        faces: [
            {
                hash: HASH,
                format: 'woff2',
                weight: '100 900',
                style: 'italic',
                stretch: '75% 100%',
                size: 2000,
            },
        ],
        addedAt: 1000,
        updatedAt: 2000,
        ...changes,
    }
}

function fontChange(value: unknown, key = 'f-1'): StoredChange {
    return {
        kind: 'font',
        key,
        updatedAt: 2000,
        deleted: false,
        format: 1,
        data: JSON.stringify(value),
        seq: 1,
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
            { kind: 'font', key: 'f-1', updatedAt: 2000, deleted: false, value: font() },
            { kind: 'font', key: 'f-2', updatedAt: 6000, deleted: true, value: null },
            {
                kind: 'setting',
                key: 'fontId',
                updatedAt: 7000,
                deleted: false,
                value: { value: 'user:f-1' },
            },
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

    it('drops a font that is not valid', () => {
        const face = font().faces[0]
        const bad: unknown[] = [
            font({ name: 5 as unknown as string }),
            font({ name: ' \x00 ' }),
            font({ fallback: 'cursive' as SyncFontValue['fallback'] }),
            font({ faces: [] }),
            font({ faces: Array.from({ length: 17 }, () => face) }),
            font({ faces: [{ ...face, hash: 'x' }] }),
            font({ faces: [{ ...face, format: 'svg' as 'woff' }] }),
            font({ faces: [{ ...face, weight: '0' }] }),
            font({ faces: [{ ...face, weight: '900 100' }] }),
            font({ faces: [{ ...face, weight: '400; color: red' }] }),
            font({ faces: [{ ...face, style: 'oblique 10deg' as 'italic' }] }),
            font({ faces: [{ ...face, stretch: '300%' }] }),
            font({ faces: [{ ...face, size: MAX_FONT_FILE_BYTES + 1 }] }),
            font({ updatedAt: -1 }),
        ]
        for (const value of bad) expect(fromChange(fontChange(value))).toBeNull()
    })

    it('drops a font with an id that cannot be part of a CSS name', () => {
        expect(fromChange(fontChange(font(), 'a.b'))).toBeNull()
        expect(fromChange({ ...fontChange(null, 'a:b'), deleted: true, data: null })).toBeNull()
        expect(fromChange(fontChange(font(), 'Ab_9-x'))).not.toBeNull()
    })

    it('cleans the name of a font, which is text for the page', () => {
        const value = fromChange(fontChange(font({ name: '  Evil\u202e Name\n' })))?.value
        expect(value).toMatchObject({ name: 'Evil Name' })
    })

    it('drops the fields of a font that are not in the contract', () => {
        const value = fromChange(fontChange({ ...font(), id: 'other', extra: 1 }))?.value
        expect(value).toEqual(font())
    })

    it('drops a setting that the app does not sync, and a value that is not valid', () => {
        const setting = (key: string, value: unknown): StoredChange => ({
            ...fontChange({ value }),
            kind: 'setting',
            key,
        })
        expect(fromChange(setting('fontId', 'literata'))?.value).toEqual({ value: 'literata' })
        expect(fromChange(setting('theme', 'dark'))).toBeNull()
        expect(fromChange(setting('fontId', 5))).toBeNull()
        expect(fromChange(setting('fontId', ''))).toBeNull()
        expect(fromChange(setting('fontId', 'x'.repeat(301)))).toBeNull()
    })

    it('has the same font size limit as the server', () => {
        expect(MAX_FONT_FILE_BYTES).toBe(MAX_FONT_BYTES)
    })
})
