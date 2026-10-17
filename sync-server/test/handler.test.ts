// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRequest, type Env } from '../src/handler'
import { MAX_PUSH_CHANGES } from '../src/protocol'
import type { Change, PullResponse, PushResponse, StatusResponse } from '../src/protocol'
import { createMemoryBucket } from './memory-bucket'
import { createSqliteDatabase } from './sqlite-database'

const BASE = 'https://sync.example.workers.dev'
const SETUP_CODE = 'a-long-setup-code-for-tests'
const TOKEN = 'a'.repeat(64)
const OTHER_TOKEN = 'b'.repeat(64)
const HASH = '0'.repeat(63) + '1'
const ORIGIN = 'https://poltak.github.io'

describe('handleRequest', () => {
    let db: ReturnType<typeof createSqliteDatabase>
    let bucket: ReturnType<typeof createMemoryBucket>
    let env: Env

    beforeEach(() => {
        db = createSqliteDatabase()
        bucket = createMemoryBucket()
        env = { DB: db, BUCKET: bucket, SETUP_CODE, ALLOWED_ORIGINS: ORIGIN }
    })

    afterEach(() => {
        db.close()
        vi.restoreAllMocks()
    })

    function call(
        path: string,
        {
            method = 'GET',
            token = TOKEN,
            body,
            headers = {},
        }: {
            method?: string
            token?: string | null
            body?: unknown
            headers?: Record<string, string>
        } = {},
    ): Promise<Response> {
        const init: RequestInit = { method, headers: { ...headers } }
        const all = init.headers as Record<string, string>
        if (token) all.Authorization = `Bearer ${token}`
        if (body !== undefined) {
            init.body =
                typeof body === 'string'
                    ? body
                    : body instanceof Uint8Array
                      ? new Blob([body as Uint8Array<ArrayBuffer>])
                      : JSON.stringify(body)
            if (!(body instanceof Uint8Array)) all['Content-Type'] = 'application/json'
        }
        return handleRequest(new Request(BASE + path, init), env)
    }

    async function setUp(token = TOKEN, replace = false): Promise<Response> {
        return call('/v1/setup', {
            method: 'POST',
            token: null,
            body: { setupCode: SETUP_CODE, token, replace },
        })
    }

    function change(key: string, updatedAt: number, extra: Partial<Change> = {}): Change {
        return {
            kind: 'highlight',
            key,
            updatedAt,
            deleted: false,
            format: 1,
            data: JSON.stringify({ at: updatedAt }),
            ...extra,
        }
    }

    async function pushChanges(changes: Change[]): Promise<PushResponse> {
        const response = await call('/v1/changes', { method: 'POST', body: { changes } })
        expect(response.status).toBe(200)
        return (await response.json()) as PushResponse
    }

    async function pullChanges(since = 0, limit?: number): Promise<PullResponse> {
        const query = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`
        const response = await call(`/v1/changes?${query}`)
        expect(response.status).toBe(200)
        return (await response.json()) as PullResponse
    }

    it('answers at the root, so a person can check the address', async () => {
        const response = await call('/', { token: null })
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('Page Goblin sync server')
    })

    describe('CORS', () => {
        it('answers a preflight from an allowed origin', async () => {
            const response = await call('/v1/changes', {
                method: 'OPTIONS',
                token: null,
                headers: { Origin: ORIGIN },
            })
            expect(response.status).toBe(204)
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
            expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
        })

        it('gives no CORS headers to a different origin', async () => {
            const response = await call('/', {
                token: null,
                headers: { Origin: 'https://evil.example' },
            })
            expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
        })

        it('adds the origin to errors too, so the app can read them', async () => {
            const response = await call('/v1/status', { headers: { Origin: ORIGIN } })
            expect(response.status).toBe(401)
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
        })

        it('allows each origin with a star', async () => {
            env.ALLOWED_ORIGINS = '*'
            const response = await call('/', {
                token: null,
                headers: { Origin: 'http://localhost:5173' },
            })
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
        })
    })

    describe('setup', () => {
        it('refuses to start without a long setup code', async () => {
            env.SETUP_CODE = 'short'
            const response = await setUp()
            expect(response.status).toBe(503)
            expect(await response.json()).toMatchObject({ code: 'no-setup-code' })
        })

        it('refuses a wrong setup code', async () => {
            const response = await call('/v1/setup', {
                method: 'POST',
                token: null,
                body: { setupCode: 'wrong', token: TOKEN },
            })
            expect(response.status).toBe(403)
            expect(await response.json()).toMatchObject({ code: 'setup-code' })
        })

        it('refuses a token that is not 64 hex characters', async () => {
            const response = await setUp('not-a-token')
            expect(response.status).toBe(400)
        })

        it('sets the token and gives the account', async () => {
            const response = await setUp()
            expect(response.status).toBe(200)
            const { account } = (await response.json()) as StatusResponse
            expect(account).toMatch(/^[0-9a-f-]{36}$/)

            const status = await call('/v1/status')
            expect(status.status).toBe(200)
            expect(await status.json()).toEqual({ account })
        })

        it('keeps a token that is there unless the request replaces it', async () => {
            const first = (await (await setUp()).json()) as StatusResponse

            const again = await setUp(OTHER_TOKEN)
            expect(again.status).toBe(409)
            expect(await again.json()).toMatchObject({ code: 'exists' })

            const replaced = await setUp(OTHER_TOKEN, true)
            expect(await replaced.json()).toEqual({ account: first.account })
            expect((await call('/v1/status')).status).toBe(401)
            expect((await call('/v1/status', { token: OTHER_TOKEN })).status).toBe(200)
        })
    })

    describe('authorization', () => {
        it('tells that the server has no sync code yet', async () => {
            const response = await call('/v1/changes')
            expect(response.status).toBe(401)
            expect(await response.json()).toMatchObject({ code: 'not-set-up' })
        })

        it('refuses a missing or wrong token', async () => {
            await setUp()
            expect((await call('/v1/changes', { token: null })).status).toBe(401)
            const wrong = await call('/v1/changes', { token: OTHER_TOKEN })
            expect(wrong.status).toBe(401)
            expect(await wrong.json()).toMatchObject({ code: 'unauthorized' })
        })

        it('gives 404 for an unknown address', async () => {
            const response = await call('/v2/other')
            expect(response.status).toBe(404)
        })
    })

    describe('changes', () => {
        beforeEach(async () => {
            await setUp()
        })

        it('gives the pushed changes in order, with sequence numbers', async () => {
            expect(await pushChanges([change('one', 10), change('two', 20)])).toEqual({
                rejected: [],
            })

            const pulled = await pullChanges()
            expect(pulled.changes).toEqual([
                { ...change('one', 10), seq: 1 },
                { ...change('two', 20), seq: 2 },
            ])
            expect(pulled.cursor).toBe(2)
            expect(pulled.more).toBe(false)
            expect(pulled.account).toMatch(/^[0-9a-f-]{36}$/)

            const next = await pullChanges(2)
            expect(next.changes).toEqual([])
            expect(next.cursor).toBe(2)
        })

        it('keeps the newer version and gives it back for an older push', async () => {
            await pushChanges([change('one', 20)])

            const result = await pushChanges([change('one', 10)])

            expect(result.rejected).toEqual([{ ...change('one', 20), seq: 1 }])
            expect((await pullChanges()).changes).toEqual([{ ...change('one', 20), seq: 1 }])
        })

        it('moves a newer version to the end of the order', async () => {
            await pushChanges([change('one', 10), change('two', 10)])

            await pushChanges([change('one', 30)])

            const pulled = await pullChanges(2)
            expect(pulled.changes).toEqual([{ ...change('one', 30), seq: 3 }])
        })

        it('lets a delete win at the same time', async () => {
            await pushChanges([change('one', 10)])
            const deleted = change('one', 10, { deleted: true, data: null })

            expect(await pushChanges([deleted])).toEqual({ rejected: [] })
            expect((await pullChanges()).changes).toEqual([{ ...deleted, seq: 2 }])

            const result = await pushChanges([change('one', 10)])
            expect(result.rejected).toEqual([{ ...deleted, seq: 2 }])
        })

        it('keeps the first of two different values at the same version', async () => {
            await pushChanges([change('one', 10, { data: '"first"' })])

            const result = await pushChanges([change('one', 10, { data: '"second"' })])

            expect(result.rejected).toEqual([{ ...change('one', 10, { data: '"first"' }), seq: 1 }])
        })

        it('stays inside the 50 D1 queries of a free plan request, also when all changes lose', async () => {
            const newer = Array.from({ length: MAX_PUSH_CHANGES }, (_, index) =>
                change(`c${index}`, 20),
            )
            await pushChanges(newer)
            const older = newer.map((item) => ({ ...item, updatedAt: 10 }))

            db.queries = 0
            const result = await pushChanges(older)

            expect(result.rejected).toHaveLength(MAX_PUSH_CHANGES)
            expect(result.rejected.map((item) => item.key).sort()).toEqual(
                newer.map((item) => item.key).sort(),
            )
            expect(db.queries).toBeLessThanOrEqual(45)
        })

        it('gives the changes in pages', async () => {
            await pushChanges([change('one', 10), change('two', 20), change('three', 30)])

            const first = await pullChanges(0, 2)
            expect(first.changes.map((item) => item.key)).toEqual(['one', 'two'])
            expect(first.more).toBe(true)

            const second = await pullChanges(first.cursor, 2)
            expect(second.changes.map((item) => item.key)).toEqual(['three'])
            expect(second.more).toBe(false)
        })

        it('refuses a change that is not valid, and writes nothing', async () => {
            const bad = [change('one', 10), { ...change('two', 10), kind: 'settings' }]
            const response = await call('/v1/changes', { method: 'POST', body: { changes: bad } })
            expect(response.status).toBe(400)
            expect((await pullChanges()).changes).toEqual([])
        })

        it('refuses a book key that is not a file hash', async () => {
            const response = await call('/v1/changes', {
                method: 'POST',
                body: { changes: [change('one', 10, { kind: 'book' })] },
            })
            expect(response.status).toBe(400)
        })

        it('refuses a delete with data and a change with no data', async () => {
            for (const bad of [
                change('one', 10, { deleted: true }),
                change('one', 10, { data: null }),
            ]) {
                const response = await call('/v1/changes', {
                    method: 'POST',
                    body: { changes: [bad] },
                })
                expect(response.status).toBe(400)
            }
        })

        it('refuses too many changes in one push', async () => {
            const changes = Array.from({ length: MAX_PUSH_CHANGES + 1 }, (_, index) =>
                change(`c${index}`, 1),
            )
            const response = await call('/v1/changes', { method: 'POST', body: { changes } })
            expect(response.status).toBe(413)
        })

        it('refuses a bad since or limit', async () => {
            expect((await call('/v1/changes?since=-1')).status).toBe(400)
            expect((await call('/v1/changes?limit=0')).status).toBe(400)
            expect((await call('/v1/changes?limit=501')).status).toBe(400)
            expect((await call('/v1/changes?since=abc')).status).toBe(400)
        })

        it('refuses a body that is not JSON', async () => {
            const response = await call('/v1/changes', { method: 'POST', body: '{nope' })
            expect(response.status).toBe(400)
        })
    })

    describe('files and covers', () => {
        beforeEach(async () => {
            await setUp()
        })

        it('stores a file and gives it back', async () => {
            expect((await call(`/v1/files/${HASH}`, { method: 'HEAD' })).status).toBe(404)

            const bytes = new TextEncoder().encode('epub bytes')
            const put = await call(`/v1/files/${HASH}`, {
                method: 'PUT',
                body: bytes,
                headers: { 'Content-Length': String(bytes.byteLength) },
            })
            expect(put.status).toBe(204)
            expect(bucket.keys()).toEqual([`files/${HASH}`])

            const head = await call(`/v1/files/${HASH}`, { method: 'HEAD' })
            expect(head.status).toBe(200)
            expect(head.headers.get('Content-Length')).toBe(String(bytes.byteLength))

            const get = await call(`/v1/files/${HASH}`)
            expect(get.headers.get('Content-Type')).toBe('application/epub+zip')
            expect(await get.text()).toBe('epub bytes')
        })

        it('keeps the image type of a cover and refuses other types', async () => {
            const bytes = new Uint8Array([1, 2, 3])
            const headers = { 'Content-Length': '3' }
            const svg = await call(`/v1/covers/${HASH}`, {
                method: 'PUT',
                body: bytes,
                headers: { ...headers, 'Content-Type': 'image/svg+xml' },
            })
            expect(svg.status).toBe(400)

            await call(`/v1/covers/${HASH}`, {
                method: 'PUT',
                body: bytes,
                headers: { ...headers, 'Content-Type': 'image/jpeg' },
            })
            const get = await call(`/v1/covers/${HASH}`)
            expect(get.headers.get('Content-Type')).toBe('image/jpeg')
        })

        it('refuses a bad hash and a file that is too large', async () => {
            expect((await call('/v1/files/not-a-hash')).status).toBe(400)
            const large = await call(`/v1/covers/${HASH}`, {
                method: 'PUT',
                body: new Uint8Array([1]),
                headers: {
                    'Content-Length': String(3 * 1024 * 1024),
                    'Content-Type': 'image/png',
                },
            })
            expect(large.status).toBe(413)
        })

        it('needs the token', async () => {
            expect((await call(`/v1/files/${HASH}`, { token: null })).status).toBe(401)
        })
    })

    it('hides the details of an unexpected error', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await setUp()
        env.BUCKET = {
            ...bucket,
            head: () => Promise.reject(new Error('R2 is down')),
        }
        const response = await call(`/v1/files/${HASH}`, { method: 'HEAD' })
        expect(response.status).toBe(500)
    })
})
