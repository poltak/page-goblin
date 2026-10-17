/**
 * The HTTP API of the Page Goblin sync server. The app imports these types, so a change here
 * is a change of the contract between the two.
 *
 * All routes except `GET /`, `POST /v1/setup` and `OPTIONS` need the header
 * `Authorization: Bearer <token>`. The app derives the token from the sync code.
 *
 * - `GET  /v1/status`              gives `StatusResponse`.
 * - `POST /v1/setup`               takes `SetupRequest`, gives `StatusResponse`.
 * - `GET  /v1/changes?since=N`     gives `PullResponse`: the changes after sequence number N.
 * - `POST /v1/changes`             takes `PushRequest`, gives `PushResponse`.
 * - `HEAD|GET|PUT /v1/files/HASH`  the EPUB file with this SHA-256.
 * - `HEAD|GET|PUT /v1/covers/HASH` the cover of the book with this file hash.
 *
 * An error has a JSON body `ErrorResponse`.
 */

export type ChangeKind = 'book' | 'progress' | 'bookmark' | 'highlight'

export const CHANGE_KINDS: readonly ChangeKind[] = ['book', 'progress', 'bookmark', 'highlight']

/** One record as the app sends it. The server keeps the newest version of each record. */
export interface Change {
    kind: ChangeKind
    /** A file hash for 'book' and 'progress', a record id for 'bookmark' and 'highlight'. */
    key: string
    /** The version in epoch milliseconds. A higher version wins. At the same version a delete wins. */
    updatedAt: number
    deleted: boolean
    /** The format of `data`. 1 is JSON text. A later format can be encrypted. */
    format: number
    /** The record. Null for a delete. The server does not read it. */
    data: string | null
}

/** A change as the server has it, with the sequence number of its last write. */
export interface StoredChange extends Change {
    seq: number
}

export interface StatusResponse {
    /** A random id that the server makes one time. A new id means that the data started again. */
    account: string
}

export interface SetupRequest {
    /** The value of the SETUP_CODE secret of the Worker. */
    setupCode: string
    /** The new token: 64 lower-case hex characters. */
    token: string
    /** Replace a token that the server has. Devices with the old token then stop. */
    replace?: boolean
}

export interface PullResponse {
    account: string
    /** Sorted by `seq`. */
    changes: StoredChange[]
    /** Give this as `since` in the next pull. */
    cursor: number
    /** True when the server has more changes after `cursor`. */
    more: boolean
}

export interface PushRequest {
    changes: Change[]
}

export interface PushResponse {
    /** The changes that lost to a newer version. Each item is the version that the server keeps. */
    rejected: StoredChange[]
}

export type ErrorCode =
    | 'bad-request'
    | 'unauthorized'
    | 'not-set-up'
    | 'setup-code'
    | 'no-setup-code'
    | 'exists'
    | 'not-found'
    | 'too-large'
    | 'server'

export interface ErrorResponse {
    error: string
    code: ErrorCode
}

/** The largest number of changes in one push. */
export const MAX_PUSH_CHANGES = 200
/** The largest number of changes in one pull. */
export const MAX_PULL_CHANGES = 500
/** The largest `data` of one change, in UTF-16 code units. */
export const MAX_DATA_LENGTH = 1_000_000
/** The largest EPUB file. A Worker request has a limit of 100 MB. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_COVER_BYTES = 2 * 1024 * 1024

export const FILE_HASH = /^[0-9a-f]{64}$/
export const RECORD_ID = /^[\w.:-]{1,128}$/
export const TOKEN = /^[0-9a-f]{64}$/
/** The largest time that a Date can hold. */
export const MAX_TIME = 8.64e15

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The key rule of each kind. A book and its progress use the file hash. */
export function isValidKey(kind: ChangeKind, key: string): boolean {
    return kind === 'book' || kind === 'progress' ? FILE_HASH.test(key) : RECORD_ID.test(key)
}

/** Reads one change from untrusted JSON. Returns null when it is not a valid change. */
export function parseChange(value: unknown): Change | null {
    if (!isRecord(value)) return null
    const { kind, key, updatedAt, deleted, format, data } = value
    if (typeof kind !== 'string' || !CHANGE_KINDS.includes(kind as ChangeKind)) return null
    if (typeof key !== 'string' || !isValidKey(kind as ChangeKind, key)) return null
    if (!Number.isSafeInteger(updatedAt) || (updatedAt as number) < 0) return null
    if ((updatedAt as number) > MAX_TIME) return null
    if (typeof deleted !== 'boolean') return null
    if (!Number.isSafeInteger(format) || (format as number) < 1) return null
    if (deleted ? data !== null : typeof data !== 'string') return null
    if (typeof data === 'string' && data.length > MAX_DATA_LENGTH) return null
    return {
        kind: kind as ChangeKind,
        key,
        updatedAt: updatedAt as number,
        deleted,
        format: format as number,
        data: data as string | null,
    }
}

/** Reads a stored change from untrusted JSON. */
export function parseStoredChange(value: unknown): StoredChange | null {
    const change = parseChange(value)
    if (!change || !isRecord(value)) return null
    const { seq } = value
    if (!Number.isSafeInteger(seq) || (seq as number) < 1) return null
    return { ...change, seq: seq as number }
}
