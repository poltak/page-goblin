import { describe, expect, it } from 'vitest'
import {
    createSyncCode,
    createSyncLink,
    deriveToken,
    normalizeServerUrl,
    normalizeSyncCode,
    parseSyncLink,
} from './code'
import { SyncError } from './types'

const CODE_FORM = /^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/

describe('sync code', () => {
    it('makes a new random code of six groups', () => {
        const first = createSyncCode()
        expect(first).toMatch(CODE_FORM)
        expect(createSyncCode()).not.toBe(first)
    })

    it('reads a typed code in any case, with or without dashes', () => {
        const code = createSyncCode()
        expect(normalizeSyncCode(code.toLowerCase())).toBe(code)
        expect(normalizeSyncCode(` ${code.replaceAll('-', ' ')} `)).toBe(code)
        expect(normalizeSyncCode(code.replaceAll('-', ''))).toBe(code)
    })

    it('reads the letters that look like digits as the digits', () => {
        expect(normalizeSyncCode('OOOO-IIII-LLLL-0000-1111-2222')).toBe(
            '0000-1111-1111-0000-1111-2222',
        )
    })

    it('refuses text that is not a code', () => {
        expect(normalizeSyncCode('')).toBeNull()
        expect(normalizeSyncCode('ABCD')).toBeNull()
        expect(normalizeSyncCode('UUUU-UUUU-UUUU-UUUU-UUUU-UUUU')).toBeNull()
    })

    it('derives the same token from the same code, and a different one from another', async () => {
        const code = createSyncCode()
        const token = await deriveToken(code)
        expect(token).toMatch(/^[0-9a-f]{64}$/)
        expect(await deriveToken(code.toLowerCase())).toBe(token)
        expect(await deriveToken(createSyncCode())).not.toBe(token)
    })

    it('derives a fixed token for a fixed code', async () => {
        // HKDF-SHA256 of 15 zero bytes. A change here stops each device that has a sync code.
        expect(await deriveToken('0000-0000-0000-0000-0000-0000')).toBe(
            '50b23fe38b9b581276f64110260bcc17ca720345ba2a048a2815a72108409112',
        )
    })

    it('refuses to derive a token from a bad code', async () => {
        await expect(deriveToken('nope')).rejects.toBeInstanceOf(SyncError)
    })
})

describe('normalizeServerUrl', () => {
    it('accepts a workers.dev address and removes the slash at the end', () => {
        expect(normalizeServerUrl('https://sync.name.workers.dev/')).toBe(
            'https://sync.name.workers.dev',
        )
        expect(normalizeServerUrl('sync.name.workers.dev')).toBe('https://sync.name.workers.dev')
    })

    it('accepts plain HTTP on this computer, for wrangler dev', () => {
        expect(normalizeServerUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
        expect(normalizeServerUrl('http://localhost:8787/')).toBe('http://localhost:8787')
    })

    it('refuses other addresses with a reason', () => {
        for (const input of [
            'http://sync.name.workers.dev',
            'https://example.com',
            'https://sync.name.workers.dev/?a=1',
            'not an address at all',
        ]) {
            expect(() => normalizeServerUrl(input)).toThrow(SyncError)
        }
    })
})

describe('sync link', () => {
    it('carries the server and the code in the hash', () => {
        const config = { server: 'https://sync.name.workers.dev', code: createSyncCode() }
        const link = createSyncLink({ appUrl: 'https://poltak.github.io/page-goblin/#/', config })

        expect(link.startsWith('https://poltak.github.io/page-goblin/#sync&')).toBe(true)
        expect(parseSyncLink(new URL(link).hash)).toEqual(config)
    })

    it('is null for other hashes and for a link with a bad code', () => {
        expect(parseSyncLink('#/book/a')).toBeNull()
        expect(parseSyncLink('#sync&server=https%3A%2F%2Fa.workers.dev&code=bad')).toBeNull()
    })
})
