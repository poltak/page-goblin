/**
 * The request handler of the sync server. One server holds the data of one person.
 *
 * The interfaces below are the parts of D1 and R2 that the handler uses. Tests give an
 * SQLite database and a bucket in memory.
 */

import {
    DEFAULT_PULL_CHANGES,
    FILE_HASH,
    MAX_COVER_BYTES,
    MAX_FILE_BYTES,
    MAX_PULL_CHANGES,
    MAX_PUSH_CHANGES,
    parseChange,
    TOKEN,
} from './protocol'
import type {
    Change,
    ErrorCode,
    ErrorResponse,
    PullResponse,
    PushResponse,
    StatusResponse,
    StoredChange,
} from './protocol'

export interface Statement {
    bind(...values: unknown[]): Statement
    first<T = Record<string, unknown>>(): Promise<T | null>
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
    run(): Promise<unknown>
}

export interface Database {
    prepare(sql: string): Statement
    /** Runs the statements in one transaction. Each result is that of `all()`. */
    batch<T = Record<string, unknown>>(statements: Statement[]): Promise<{ results: T[] }[]>
}

export interface ObjectInfo {
    size: number
    httpEtag: string
    httpMetadata?: { contentType?: string }
}

export interface StoredObject extends ObjectInfo {
    body: ReadableStream
}

export interface Bucket {
    head(key: string): Promise<ObjectInfo | null>
    get(key: string): Promise<StoredObject | null>
    put(
        key: string,
        value: ReadableStream | ArrayBuffer,
        options?: { httpMetadata?: { contentType?: string } },
    ): Promise<unknown>
}

export interface Env {
    DB: Database
    BUCKET: Bucket
    /** The secret that a new device needs to set the sync code. */
    SETUP_CODE?: string
    /** Comma-separated origins that may call the server from a browser. '*' allows all. */
    ALLOWED_ORIGINS?: string
}

/** A short setup code is easy to guess. The server has no limit on wrong tries. */
export const MIN_SETUP_CODE_LENGTH = 16

const MAX_PUSH_BYTES = 20 * 1024 * 1024
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

const SCHEMA = [
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL,
        format INTEGER NOT NULL,
        data TEXT,
        seq INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
    )`,
    'CREATE INDEX IF NOT EXISTS records_seq ON records (seq)',
]

// The new row gets the next sequence number. A row that loses keeps its old values, and then
// RETURNING gives no row.
const UPSERT = `INSERT INTO records (kind, key, updated_at, deleted, format, data, seq)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records))
ON CONFLICT (kind, key) DO UPDATE SET
    updated_at = excluded.updated_at,
    deleted = excluded.deleted,
    format = excluded.format,
    data = excluded.data,
    seq = excluded.seq
WHERE excluded.updated_at > records.updated_at
    OR (excluded.updated_at = records.updated_at AND excluded.deleted > records.deleted)
RETURNING kind, key`

const COLUMNS = 'kind, key, updated_at, deleted, format, data, seq'

/** The rows of these records, in one query. Two bound values for each record. */
function selectRecords(db: Database, keys: readonly { kind: string; key: string }[]): Statement {
    const where = keys.map((_, index) => `(kind = ?${index * 2 + 1} AND key = ?${index * 2 + 2})`)
    return db
        .prepare(`SELECT ${COLUMNS} FROM records WHERE ${where.join(' OR ')}`)
        .bind(...keys.flatMap(({ kind, key }) => [kind, key]))
}

/** D1 allows 100 bound values in one query. */
const KEYS_PER_SELECT = 50

const SELECT_AFTER = `SELECT ${COLUMNS} FROM records WHERE seq > ?1 ORDER BY seq LIMIT ?2`

interface RecordRow {
    kind: string
    key: string
    updated_at: number
    deleted: number
    format: number
    data: string | null
    seq: number
}

class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: ErrorCode,
        message: string,
    ) {
        super(message)
    }
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
}

function errorResponse(error: HttpError): Response {
    const body: ErrorResponse = { error: error.message, code: error.code }
    return json(body, error.status)
}

function toChange(row: RecordRow): StoredChange {
    return {
        kind: row.kind as StoredChange['kind'],
        key: row.key,
        updatedAt: row.updated_at,
        deleted: row.deleted === 1,
        format: row.format,
        data: row.data,
        seq: row.seq,
    }
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Compares two strings in a time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let difference = 0
    for (let index = 0; index < a.length; index++) {
        difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
    }
    return difference === 0
}

// ---------- CORS ----------

function allowedOrigin(origin: string | null, allowed: string | undefined): string | null {
    if (!origin) return null
    const list = (allowed ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    if (list.includes('*')) return '*'
    return list.includes(origin) ? origin : null
}

function withCors(response: Response, origin: string | null): Response {
    if (!origin) return response
    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Expose-Headers', 'ETag, Content-Length')
    headers.append('Vary', 'Origin')
    return new Response(response.body, { status: response.status, headers })
}

function preflight(origin: string | null): Response {
    if (!origin) return new Response(null, { status: 204 })
    const headers = new Headers({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    })
    return new Response(null, { status: 204, headers })
}

// ---------- Database ----------

const schemas = new WeakMap<Database, Promise<void>>()

/** Makes the tables at the first request. A new deploy needs no migration step. */
function ensureSchema(db: Database): Promise<void> {
    let ready = schemas.get(db)
    if (!ready) {
        ready = db
            .batch(SCHEMA.map((sql) => db.prepare(sql)))
            .then(() => undefined)
            .catch((error: unknown) => {
                schemas.delete(db)
                throw error
            })
        schemas.set(db, ready)
    }
    return ready
}

async function readMeta(db: Database, key: string): Promise<string | null> {
    const row = await db.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first<{
        value: string
    }>()
    return row?.value ?? null
}

async function requireToken(request: Request, db: Database): Promise<void> {
    const stored = await readMeta(db, 'token_hash')
    if (!stored) {
        throw new HttpError(401, 'not-set-up', 'This server has no sync code yet. Set it up first.')
    }
    const header = request.headers.get('Authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    if (!TOKEN.test(token) || !sameText(await sha256Hex(token), stored)) {
        throw new HttpError(401, 'unauthorized', 'The sync code is not correct.')
    }
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
    const length = Number(request.headers.get('Content-Length') ?? '0')
    if (length > maxBytes) throw new HttpError(413, 'too-large', 'The request is too large.')
    const text = await request.text()
    if (text.length > maxBytes) throw new HttpError(413, 'too-large', 'The request is too large.')
    try {
        return JSON.parse(text)
    } catch {
        throw new HttpError(400, 'bad-request', 'The request is not JSON.')
    }
}

// ---------- Routes ----------

async function setup(request: Request, env: Env): Promise<Response> {
    const setupCode = env.SETUP_CODE ?? ''
    if (setupCode.length < MIN_SETUP_CODE_LENGTH) {
        throw new HttpError(
            503,
            'no-setup-code',
            `The server needs a SETUP_CODE secret of ${MIN_SETUP_CODE_LENGTH} or more characters.`,
        )
    }
    const body = (await readJson(request, 4096)) as Record<string, unknown> | null
    const given = typeof body?.setupCode === 'string' ? body.setupCode : ''
    const token = typeof body?.token === 'string' ? body.token : ''
    if (!TOKEN.test(token)) throw new HttpError(400, 'bad-request', 'The token is not valid.')
    // The hashes have the same length, so the comparison time does not show the code length.
    if (!sameText(await sha256Hex(given), await sha256Hex(setupCode))) {
        throw new HttpError(403, 'setup-code', 'The setup code is not correct.')
    }

    const db = env.DB
    if ((await readMeta(db, 'token_hash')) && body?.replace !== true) {
        throw new HttpError(409, 'exists', 'This server has a sync code already.')
    }
    const account = (await readMeta(db, 'account')) ?? crypto.randomUUID()
    const put = 'INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)'
    await db.batch([
        db.prepare(put).bind('account', account),
        db.prepare(put).bind('token_hash', await sha256Hex(token)),
    ])
    const response: StatusResponse = { account }
    return json(response)
}

async function accountOf(db: Database): Promise<string> {
    const account = await readMeta(db, 'account')
    if (!account) throw new HttpError(401, 'not-set-up', 'This server has no sync code yet.')
    return account
}

async function pull(url: URL, db: Database): Promise<Response> {
    const since = Number(url.searchParams.get('since') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? String(DEFAULT_PULL_CHANGES))
    if (!Number.isSafeInteger(since) || since < 0) {
        throw new HttpError(400, 'bad-request', 'The value of since is not valid.')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PULL_CHANGES) {
        throw new HttpError(400, 'bad-request', 'The value of limit is not valid.')
    }
    const account = await accountOf(db)
    // One row more than the limit tells if more rows follow.
    const { results } = await db
        .prepare(SELECT_AFTER)
        .bind(since, limit + 1)
        .all<RecordRow>()
    const changes = results.slice(0, limit).map(toChange)
    const response: PullResponse = {
        account,
        changes,
        cursor: changes.at(-1)?.seq ?? since,
        more: results.length > limit,
    }
    return json(response)
}

async function push(request: Request, db: Database): Promise<Response> {
    const body = (await readJson(request, MAX_PUSH_BYTES)) as Record<string, unknown> | null
    const raw = body?.changes
    if (!Array.isArray(raw)) throw new HttpError(400, 'bad-request', 'The request has no changes.')
    if (raw.length > MAX_PUSH_CHANGES) {
        throw new HttpError(413, 'too-large', `Send ${MAX_PUSH_CHANGES} changes or fewer.`)
    }
    const changes: Change[] = []
    for (const item of raw) {
        const change = parseChange(item)
        if (!change) throw new HttpError(400, 'bad-request', 'A change is not valid.')
        changes.push(change)
    }
    if (changes.length === 0) return json({ rejected: [] } satisfies PushResponse)

    // One query for each change. A change that loses returns no row.
    const results = await db.batch<{ kind: string; key: string }>(
        changes.map((change) =>
            db
                .prepare(UPSERT)
                .bind(
                    change.kind,
                    change.key,
                    change.updatedAt,
                    change.deleted ? 1 : 0,
                    change.format,
                    change.data,
                ),
        ),
    )
    const lost = changes.filter((_, index) => (results[index]?.results.length ?? 0) === 0)

    // The device gets the versions that won, so it does not keep a version that lost.
    const rejected: StoredChange[] = []
    for (let start = 0; start < lost.length; start += KEYS_PER_SELECT) {
        const { results: rows } = await selectRecords(
            db,
            lost.slice(start, start + KEYS_PER_SELECT),
        ).all<RecordRow>()
        rejected.push(...rows.map(toChange))
    }
    const response: PushResponse = { rejected }
    return json(response)
}

async function blob(
    request: Request,
    env: Env,
    { folder, hash }: { folder: 'files' | 'covers'; hash: string },
): Promise<Response> {
    if (!FILE_HASH.test(hash)) throw new HttpError(400, 'bad-request', 'The hash is not valid.')
    const key = `${folder}/${hash}`

    if (request.method === 'PUT') {
        const length = Number(request.headers.get('Content-Length') ?? '')
        const max = folder === 'files' ? MAX_FILE_BYTES : MAX_COVER_BYTES
        if (!Number.isSafeInteger(length) || length < 1) {
            throw new HttpError(400, 'bad-request', 'The request needs a Content-Length.')
        }
        if (length > max) throw new HttpError(413, 'too-large', 'The file is too large.')
        const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
        if (folder === 'covers' && !COVER_TYPES.has(type)) {
            throw new HttpError(
                400,
                'bad-request',
                'A cover must be a JPEG, PNG, WebP, GIF or AVIF image.',
            )
        }
        if (!request.body) throw new HttpError(400, 'bad-request', 'The request has no body.')
        const contentType = folder === 'files' ? 'application/epub+zip' : type
        await env.BUCKET.put(key, request.body, { httpMetadata: { contentType } })
        return new Response(null, { status: 204 })
    }

    const found = request.method === 'HEAD' ? await env.BUCKET.head(key) : await env.BUCKET.get(key)
    if (!found) throw new HttpError(404, 'not-found', 'The server does not have this file.')
    const headers = new Headers({
        'Content-Type': found.httpMetadata?.contentType ?? 'application/octet-stream',
        'Content-Length': String(found.size),
        ETag: found.httpEtag,
        // The content of a hash never changes.
        'Cache-Control': 'private, max-age=31536000, immutable',
    })
    const body = request.method === 'HEAD' ? null : (found as StoredObject).body
    return new Response(body, { status: 200, headers })
}

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
        return new Response('Page Goblin sync server\n', {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
    }

    await ensureSchema(env.DB)

    if (pathname === '/v1/setup' && method === 'POST') return setup(request, env)

    const blobMatch = /^\/v1\/(files|covers)\/([^/]+)$/.exec(pathname)
    const isRoute =
        (pathname === '/v1/status' && method === 'GET') ||
        (pathname === '/v1/changes' && (method === 'GET' || method === 'POST')) ||
        (blobMatch !== null && ['GET', 'HEAD', 'PUT'].includes(method))
    if (!isRoute) throw new HttpError(404, 'not-found', 'This address is not part of the API.')

    await requireToken(request, env.DB)

    if (pathname === '/v1/status') {
        const response: StatusResponse = { account: await accountOf(env.DB) }
        return json(response)
    }
    if (pathname === '/v1/changes') {
        return method === 'GET' ? pull(url, env.DB) : push(request, env.DB)
    }
    return blob(request, env, {
        folder: blobMatch![1] as 'files' | 'covers',
        hash: blobMatch![2],
    })
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request.headers.get('Origin'), env.ALLOWED_ORIGINS)
    if (request.method === 'OPTIONS') return preflight(origin)
    let response: Response
    try {
        response = await route(request, env)
    } catch (error) {
        if (error instanceof HttpError) {
            response = errorResponse(error)
        } else {
            console.error(error)
            response = errorResponse(new HttpError(500, 'server', 'The server failed.'))
        }
    }
    return withCors(response, origin)
}
