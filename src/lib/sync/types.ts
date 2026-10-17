/**
 * Contracts of the sync module. The sync copies books, reading positions, bookmarks and
 * highlights between the devices of one person, through a server that the person runs.
 *
 * The HTTP API of the server is in `sync-server/src/protocol.ts`.
 */

import type { ApplyResult } from '$lib/storage/sync-store'
import type {
    Change,
    PullResponse,
    PushResponse,
    StatusResponse,
} from '../../../sync-server/src/protocol'

export type {
    Change,
    PullResponse,
    PushResponse,
    StatusResponse,
    StoredChange,
} from '../../../sync-server/src/protocol'

/** The settings of the sync on this device. With no config the sync is off. */
export interface SyncConfig {
    /** The address of the server, for example `https://page-goblin-sync.name.workers.dev`. */
    server: string
    /** The sync code in its normal form. See `normalizeSyncCode`. */
    code: string
}

/** A file or a cover on the server. Both have the file hash of the book as their name. */
export interface BlobTarget {
    folder: 'files' | 'covers'
    hash: string
}

/** The server as the sync engine sees it. A test can give a different implementation. */
export interface SyncBackend {
    status(): Promise<StatusResponse>
    pull(options: { since: number; limit?: number }): Promise<PullResponse>
    /** With `keepalive` the request continues after the page closes. Only for small bodies. */
    push(changes: Change[], options?: { keepalive?: boolean }): Promise<PushResponse>
    hasBlob(target: BlobTarget): Promise<boolean>
    putBlob(target: BlobTarget, blob: Blob): Promise<void>
    /** Null when the server does not have it. */
    getBlob(target: BlobTarget): Promise<Blob | null>
}

export type SyncErrorCode =
    /** No answer: no network, a blocked address, or a server that is down. */
    | 'offline'
    /** The sync code is wrong, or a different device changed it. */
    | 'unauthorized'
    | 'not-set-up'
    | 'setup-code'
    | 'no-setup-code'
    | 'exists'
    | 'not-found'
    | 'too-large'
    | 'server'
    /** The answer of the server is not what the API gives. */
    | 'bad-response'
    /** A downloaded file does not have the hash of its book. */
    | 'integrity'
    /** The page has no Web Crypto, for example on plain HTTP. */
    | 'insecure'
    /** The server address is not one that the app can use. */
    | 'bad-address'

export class SyncError extends Error {
    override name = 'SyncError'

    constructor(
        readonly code: SyncErrorCode,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options)
    }
}

export type SyncPhase = 'idle' | 'syncing' | 'error'

export interface SyncStatus {
    phase: SyncPhase
    /** Epoch milliseconds of the last sync that completed, or null. */
    syncedAt: number | null
    /** The error of the last sync, when it failed. */
    error: SyncError | null
}

/** What a sync changed in the library of this device. */
export type SyncChanges = ApplyResult
