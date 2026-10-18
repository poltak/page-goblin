import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncClient, setupServer } from './client'

const SERVER = 'https://sync.test.workers.dev'
const HASH = 'a'.repeat(64)

function reply(body: BodyInit | null, init: ResponseInit = {}): Promise<Response> {
    return Promise.resolve(new Response(body, init))
}

function jsonReply(body: unknown, status = 200): Promise<Response> {
    return reply(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('createSyncClient', () => {
    beforeEach(() => {
        vi.stubGlobal('Blob', NodeBlob)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('sends the token and never uses the HTTP cache', async () => {
        const fetch = vi.fn(() => jsonReply({ account: 'acc' }))
        const client = createSyncClient({ server: SERVER, token: 't', fetch })

        expect(await client.status()).toEqual({ account: 'acc' })
        expect(fetch).toHaveBeenCalledWith(`${SERVER}/v1/status`, {
            headers: { Authorization: 'Bearer t' },
            cache: 'no-store',
        })
    })

    it('gives the error code of the server', async () => {
        const fetch = vi.fn(() => jsonReply({ error: 'x', code: 'unauthorized' }, 401))
        const client = createSyncClient({ server: SERVER, token: 't', fetch })

        await expect(client.status()).rejects.toMatchObject({ code: 'unauthorized' })
    })

    it('reads a server error with an HTML body as a server problem', async () => {
        const fetch = vi.fn(() => reply('<html>Bad gateway</html>', { status: 502 }))
        const client = createSyncClient({ server: SERVER, token: 't', fetch })

        await expect(client.pull({ since: 0 })).rejects.toMatchObject({ code: 'server' })
    })

    it('reads the 413 page of Cloudflare as a file that is too large', async () => {
        const fetch = vi.fn(() => reply('<html>Payload Too Large</html>', { status: 413 }))
        const client = createSyncClient({ server: SERVER, token: 't', fetch })

        await expect(
            client.putBlob({ folder: 'files', hash: HASH }, new Blob(['x'])),
        ).rejects.toMatchObject({ code: 'too-large' })
    })

    it('reads no answer as offline', async () => {
        const fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
        const client = createSyncClient({ server: SERVER, token: 't', fetch })

        await expect(client.status()).rejects.toMatchObject({ code: 'offline' })
    })

    it('refuses a pull answer that does not follow the API', async () => {
        for (const body of [
            { account: 'acc', changes: [], cursor: 'x', more: false },
            { account: 'acc', changes: [{ kind: 'nope' }], cursor: 1, more: false },
            { changes: [], cursor: 1, more: false },
        ]) {
            const client = createSyncClient({
                server: SERVER,
                token: 't',
                fetch: () => jsonReply(body),
            })
            await expect(client.pull({ since: 0 })).rejects.toMatchObject({
                code: 'bad-response',
            })
        }
    })

    it('tells that an address with no API is not a sync server', async () => {
        const client = createSyncClient({
            server: SERVER,
            token: 't',
            fetch: () => jsonReply({ error: 'x', code: 'not-found' }, 404),
        })

        await expect(client.status()).rejects.toMatchObject({ code: 'not-found' })
    })

    it('gives null for a file that is not on the server', async () => {
        const client = createSyncClient({
            server: SERVER,
            token: 't',
            fetch: () => reply(null, { status: 404 }),
        })

        expect(await client.getBlob({ folder: 'files', hash: HASH })).toBeNull()
        expect(await client.hasBlob({ folder: 'files', hash: HASH })).toBe(false)
    })

    it('accepts only a raster image as a cover', async () => {
        const svg = createSyncClient({
            server: SERVER,
            token: 't',
            fetch: () => reply('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
        })
        expect(await svg.getBlob({ folder: 'covers', hash: HASH })).toBeNull()

        const png = createSyncClient({
            server: SERVER,
            token: 't',
            fetch: () => reply('png', { headers: { 'Content-Type': 'image/png' } }),
        })
        expect((await png.getBlob({ folder: 'covers', hash: HASH }))?.type).toBe('image/png')
    })

    it('does not upload a cover that is not a raster image', async () => {
        const fetch = vi.fn(() => reply(null, { status: 204 }))
        const client = createSyncClient({ server: SERVER, token: 't', fetch })

        await client.putBlob(
            { folder: 'covers', hash: HASH },
            new Blob(['x'], { type: 'image/svg+xml' }),
        )

        expect(fetch).not.toHaveBeenCalled()
    })

    it('asks for kinds and reads the kinds of the server', async () => {
        const fetch = vi.fn((_url: string, _init?: RequestInit) =>
            jsonReply({
                account: 'acc',
                changes: [],
                cursor: 0,
                more: false,
                kinds: ['book', 'font', 'comment'],
            }),
        )
        const client = createSyncClient({ server: SERVER, token: 't', fetch })

        const result = await client.pull({ since: 5, kinds: ['book', 'font'] })

        expect(fetch.mock.calls[0][0]).toBe(
            `${SERVER}/v1/changes?since=5&limit=100&kinds=book%2Cfont`,
        )
        expect(result.kinds).toEqual(['book', 'font'])
        expect(await client.status()).toEqual({ account: 'acc', kinds: ['book', 'font'] })
    })

    it('gives no kinds for an old server', async () => {
        const fetch = vi.fn(() =>
            jsonReply({ account: 'acc', changes: [], cursor: 0, more: false }),
        )
        const client = createSyncClient({ server: SERVER, token: 't', fetch })
        expect(await client.pull({ since: 0 })).toEqual({
            account: 'acc',
            changes: [],
            cursor: 0,
            more: false,
        })
        expect(await client.status()).toEqual({ account: 'acc' })
    })

    it('uploads only a font file with a font type, and gives the downloaded bytes', async () => {
        const fetch = vi.fn((_url: string, _init?: RequestInit) => reply(null, { status: 204 }))
        const client = createSyncClient({ server: SERVER, token: 't', fetch })

        await client.putBlob({ folder: 'fonts', hash: HASH }, new Blob(['x'], { type: 'text/css' }))
        expect(fetch).not.toHaveBeenCalled()
        await client.putBlob(
            { folder: 'fonts', hash: HASH },
            new Blob(['x'], { type: 'font/woff2' }),
        )
        expect(fetch.mock.calls[0][0]).toBe(`${SERVER}/v1/fonts/${HASH}`)
        expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ 'Content-Type': 'font/woff2' })

        const download = createSyncClient({
            server: SERVER,
            token: 't',
            fetch: () => reply('font bytes', { headers: { 'Content-Type': 'text/html' } }),
        })
        const blob = await download.getBlob({ folder: 'fonts', hash: HASH })
        expect(await blob?.text()).toBe('font bytes')
    })

    it('uses keepalive only for a small push', async () => {
        const fetch = vi.fn((_url: string, _init?: RequestInit) => jsonReply({ rejected: [] }))
        const client = createSyncClient({ server: SERVER, token: 't', fetch })
        const change = {
            kind: 'highlight' as const,
            key: 'h',
            updatedAt: 1,
            deleted: false,
            format: 1,
            data: 'x'.repeat(100),
        }

        await client.push([change], { keepalive: true })
        await client.push([{ ...change, data: 'x'.repeat(70_000) }], { keepalive: true })

        expect(fetch.mock.calls.map(([, init]) => init?.keepalive)).toEqual([true, false])
    })
})

describe('setupServer', () => {
    it('sends the setup code and the token', async () => {
        const fetch = vi.fn((_url: string, _init?: RequestInit) => jsonReply({ account: 'acc' }))

        const result = await setupServer({ server: SERVER, setupCode: 's', token: 't', fetch })

        expect(result).toEqual({ account: 'acc' })
        const [url, init] = fetch.mock.calls[0]
        expect(url).toBe(`${SERVER}/v1/setup`)
        expect(JSON.parse(String(init?.body))).toEqual({
            setupCode: 's',
            token: 't',
            replace: false,
        })
    })

    it('gives the code for a server with a sync code already', async () => {
        const fetch = () => jsonReply({ error: 'x', code: 'exists' }, 409)
        await expect(
            setupServer({ server: SERVER, setupCode: 's', token: 't', fetch }),
        ).rejects.toMatchObject({ code: 'exists' })
    })
})
