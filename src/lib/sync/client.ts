/**
 * The HTTP client of the sync server in `sync-server/`.
 */

import { isRecord } from '$lib/annotations/backup'
import { DEFAULT_PULL_CHANGES, parseStoredChange } from '../../../sync-server/src/protocol'
import type { ErrorCode, SetupRequest } from '../../../sync-server/src/protocol'
import { SyncError } from './types'
import type {
    BlobTarget,
    Change,
    PullResponse,
    PushResponse,
    StatusResponse,
    StoredChange,
    SyncBackend,
    SyncErrorCode,
} from './types'

/** A browser sends a keepalive request only when its body is smaller than 64 KiB. */
const KEEPALIVE_LIMIT = 60_000

// The same types that the storage keeps as a cover. See src/lib/storage/cover.ts.
const RASTER_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/bmp',
])

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface SyncClientOptions {
    /** The normal form of the address. See `normalizeServerUrl`. */
    server: string
    token: string
    /** The default is the fetch of the page. A test gives its own. */
    fetch?: Fetch
}

export interface SetupServerOptions {
    server: string
    setupCode: string
    token: string
    replace?: boolean
    fetch?: Fetch
}

const MESSAGES: Partial<Record<SyncErrorCode, string>> = {
    unauthorized: 'The sync code is not correct. A different device can have made a new code.',
    'not-set-up': 'The sync server has no sync code yet.',
    'setup-code': 'The setup code is not correct.',
    'no-setup-code':
        'The sync server has no setup code. Set the SETUP_CODE secret of the Worker, with 16 or more characters.',
    exists: 'The sync server has a sync code already.',
    'too-large': 'The file is too large for the sync server.',
    server: 'The sync server had a problem. Try again later.',
}

const SERVER_CODES = new Set<ErrorCode>([
    'bad-request',
    'unauthorized',
    'not-set-up',
    'setup-code',
    'no-setup-code',
    'exists',
    'not-found',
    'too-large',
    'server',
])

function badResponse(): SyncError {
    return new SyncError('bad-response', 'The answer of the sync server is not valid.')
}

async function errorOf(response: Response): Promise<SyncError> {
    // Cloudflare answers a body over its limit with its own 413 page, before the Worker runs.
    let code: SyncErrorCode =
        response.status === 413 ? 'too-large' : response.status >= 500 ? 'server' : 'bad-response'
    try {
        const body: unknown = await response.json()
        const given = isRecord(body) ? body.code : undefined
        if (typeof given === 'string' && SERVER_CODES.has(given as ErrorCode)) {
            code = given === 'bad-request' ? 'bad-response' : (given as SyncErrorCode)
        }
    } catch {
        // A proxy or a server that is down can answer with HTML.
    }
    return new SyncError(code, MESSAGES[code] ?? 'The sync server refused the request.')
}

async function send(fetcher: Fetch, url: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
        response = await fetcher(url, init)
    } catch (error) {
        throw new SyncError(
            'offline',
            'The sync server did not answer. Check the connection and the server address.',
            { cause: error },
        )
    }
    if (!response.ok && response.status !== 404) throw await errorOf(response)
    return response
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        throw badResponse()
    }
}

function parseAccount(body: unknown): string {
    const account = isRecord(body) ? body.account : undefined
    if (typeof account !== 'string' || account === '' || account.length > 200) throw badResponse()
    return account
}

function parseChanges(raw: unknown): StoredChange[] {
    if (!Array.isArray(raw)) throw badResponse()
    return raw.map((item) => {
        const change = parseStoredChange(item)
        if (!change) throw badResponse()
        return change
    })
}

/** Sets the sync code of a server. Only a device with the setup code can do this. */
export async function setupServer(options: SetupServerOptions): Promise<StatusResponse> {
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
    const body: SetupRequest = {
        setupCode: options.setupCode,
        token: options.token,
        replace: options.replace === true,
    }
    const response = await send(fetcher, `${options.server}/v1/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (response.status === 404) throw new SyncError('not-found', 'This is not a sync server.')
    return { account: parseAccount(await readJson(response)) }
}

export function createSyncClient(options: SyncClientOptions): SyncBackend {
    const { server, token } = options
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
    const auth = { Authorization: `Bearer ${token}` }

    function request(path: string, init: RequestInit = {}): Promise<Response> {
        return send(fetcher, server + path, {
            ...init,
            headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
            // A sync must never get an answer from the HTTP cache.
            cache: 'no-store',
        })
    }

    async function requireFound(response: Response): Promise<Response> {
        if (response.status === 404) {
            throw new SyncError('not-found', 'This address is not a Page Goblin sync server.')
        }
        return response
    }

    function blobPath({ folder, hash }: BlobTarget): string {
        return `/v1/${folder}/${hash}`
    }

    return {
        async status() {
            const response = await requireFound(await request('/v1/status'))
            return { account: parseAccount(await readJson(response)) }
        },

        async pull({ since, limit = DEFAULT_PULL_CHANGES }) {
            const query = new URLSearchParams({ since: String(since), limit: String(limit) })
            const response = await requireFound(await request(`/v1/changes?${query}`))
            const body = await readJson(response)
            if (!isRecord(body)) throw badResponse()
            const { cursor, more } = body
            if (!Number.isSafeInteger(cursor) || typeof more !== 'boolean') throw badResponse()
            const result: PullResponse = {
                account: parseAccount(body),
                changes: parseChanges(body.changes),
                cursor: cursor as number,
                more,
            }
            return result
        },

        async push(changes: Change[], pushOptions = {}) {
            const body = JSON.stringify({ changes })
            const response = await requireFound(
                await request('/v1/changes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    keepalive: pushOptions.keepalive === true && body.length < KEEPALIVE_LIMIT,
                }),
            )
            const result = await readJson(response)
            if (!isRecord(result)) throw badResponse()
            const pushed: PushResponse = { rejected: parseChanges(result.rejected) }
            return pushed
        },

        async hasBlob(target) {
            const response = await request(blobPath(target), { method: 'HEAD' })
            return response.status !== 404
        },

        async putBlob(target, blob) {
            const type =
                target.folder === 'files' ? 'application/epub+zip' : blob.type.toLowerCase()
            if (target.folder === 'covers' && !RASTER_TYPES.has(type)) return
            await requireFound(
                await request(blobPath(target), {
                    method: 'PUT',
                    headers: { 'Content-Type': type },
                    body: blob,
                }),
            )
        },

        async getBlob(target) {
            const response = await request(blobPath(target))
            if (response.status === 404) return null
            const blob = await response.blob()
            if (target.folder === 'files') return new Blob([blob], { type: 'application/epub+zip' })
            // A cover goes into an img element. Only a raster image can go there.
            const type = (response.headers.get('Content-Type') ?? '').split(';')[0].trim()
            return RASTER_TYPES.has(type) ? new Blob([blob], { type }) : null
        },
    }
}
