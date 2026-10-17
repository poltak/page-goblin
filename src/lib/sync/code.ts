/**
 * The sync code, the token that the app derives from it, the server address and the link that
 * adds a device.
 *
 * The code is 120 random bits in Crockford base32, in groups of four characters. The server
 * never gets the code. It gets a token that HKDF derives from the code, and it keeps only the
 * SHA-256 of the token. A second HKDF output from the same code can later be the key of an
 * encryption that the server cannot read.
 */

import { SyncError } from './types'
import type { SyncConfig } from './types'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_BYTES = 15
const CODE_LENGTH = 24
const GROUP = 4
const TOKEN_SALT = 'page-goblin-sync'
const TOKEN_INFO = 'auth-token-v1'

/** The start of the hash of a link that adds a device. */
export const SYNC_LINK_PREFIX = '#sync&'

function encodeBase32(bytes: Uint8Array): string {
    let bits = 0
    let value = 0
    let text = ''
    for (const byte of bytes) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            text += ALPHABET[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    if (bits > 0) text += ALPHABET[(value << (5 - bits)) & 31]
    return text
}

function decodeBase32(text: string): Uint8Array {
    const bytes: number[] = []
    let bits = 0
    let value = 0
    for (const char of text) {
        value = (value << 5) | ALPHABET.indexOf(char)
        bits += 5
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return new Uint8Array(bytes)
}

function group(text: string): string {
    return text.match(new RegExp(`.{1,${GROUP}}`, 'g'))!.join('-')
}

/** A new random sync code, for example `7K3Q-M9XA-...`. */
export function createSyncCode(): string {
    return group(encodeBase32(crypto.getRandomValues(new Uint8Array(CODE_BYTES))))
}

/**
 * The normal form of a code that a person typed or pasted, or null when it is not a code.
 * Case, spaces and dashes do not matter. The letters I and L read as 1, and O reads as 0.
 */
export function normalizeSyncCode(input: string): string | null {
    const text = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
    if (text.length !== CODE_LENGTH) return null
    for (const char of text) if (!ALPHABET.includes(char)) return null
    return group(text)
}

/** The token that the server knows the code by: 64 lower-case hex characters. */
export async function deriveToken(code: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) {
        throw new SyncError('insecure', 'The sync needs a secure (HTTPS) page.')
    }
    const normal = normalizeSyncCode(code)
    if (!normal) throw new SyncError('unauthorized', 'The sync code is not valid.')
    const encoder = new TextEncoder()
    const key = await subtle.importKey(
        'raw',
        decodeBase32(normal.replaceAll('-', '')) as Uint8Array<ArrayBuffer>,
        'HKDF',
        false,
        ['deriveBits'],
    )
    const bits = await subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode(TOKEN_SALT),
            info: encoder.encode(TOKEN_INFO),
        },
        key,
        256,
    )
    return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isLocalHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * The normal form of a server address, with no slash at the end. It must be HTTPS on
 * `workers.dev`, because the Content Security Policy of the app allows only that. A server on
 * this computer can use plain HTTP, for tests with `wrangler dev`.
 *
 * @throws SyncError with a sentence for the user.
 */
export function normalizeServerUrl(input: string): string {
    let url: URL
    try {
        url = new URL(input.trim().includes('://') ? input.trim() : `https://${input.trim()}`)
    } catch {
        throw new SyncError('bad-address', 'This is not a web address.')
    }
    const local = isLocalHost(url.hostname)
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
        throw new SyncError('bad-address', 'The address must start with https://.')
    }
    if (!local && !url.hostname.endsWith('.workers.dev')) {
        throw new SyncError(
            'bad-address',
            'Use the workers.dev address of your Worker. The app can connect only to addresses that end with .workers.dev.',
        )
    }
    if (url.search || url.hash || url.username || url.password) {
        throw new SyncError('bad-address', 'Use only the address of the Worker.')
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** A link that opens the app and fills in the server and the code. Keep it secret. */
export function createSyncLink({ appUrl, config }: { appUrl: string; config: SyncConfig }): string {
    const params = new URLSearchParams({ server: config.server, code: config.code })
    return `${appUrl.split('#')[0]}${SYNC_LINK_PREFIX}${params}`
}

/** The server and the code of a link hash, or null for a hash that is not a sync link. */
export function parseSyncLink(hash: string): { server: string; code: string } | null {
    if (!hash.startsWith(SYNC_LINK_PREFIX)) return null
    const params = new URLSearchParams(hash.slice(SYNC_LINK_PREFIX.length))
    const server = params.get('server') ?? ''
    const code = normalizeSyncCode(params.get('code') ?? '')
    return server && code ? { server, code } : null
}
