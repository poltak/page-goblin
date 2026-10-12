import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createId, sha256Hex } from './crypto'
import { sha256 } from './sha256-fallback'

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

function bytesOf(length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length)
    for (let index = 0; index < length; index++) bytes[index] = (index * 31 + 7) & 0xff
    return bytes
}

function expectedHash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('createId', () => {
    it('makes a different UUID each time', () => {
        const first = createId()
        const second = createId()

        expect(first).toMatch(UUID_V4)
        expect(second).toMatch(UUID_V4)
        expect(first).not.toBe(second)
    })

    it('makes a UUID when the browser has no randomUUID', () => {
        const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0xff))
        vi.stubGlobal('crypto', { getRandomValues })

        expect(createId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
        expect(getRandomValues).toHaveBeenCalledOnce()
    })
})

describe('sha256Hex', () => {
    it('gives the known hash of an empty input and of "abc"', async () => {
        expect(await sha256Hex(new ArrayBuffer(0))).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        )
        expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        )
    })

    it('uses the fallback when the browser has no crypto.subtle', async () => {
        vi.stubGlobal('crypto', {})
        const bytes = bytesOf(1000)

        expect(await sha256Hex(bytes.buffer)).toBe(expectedHash(bytes))
    })
})

describe('sha256 fallback', () => {
    // The lengths around 55, 64 and 119 bytes are the borders of the padding.
    it.each([0, 1, 3, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 128, 1000, 70_001])(
        'gives the correct hash for %i bytes',
        (length) => {
            const bytes = bytesOf(length)
            const hex = Buffer.from(sha256(bytes)).toString('hex')

            expect(hex).toBe(expectedHash(bytes))
        },
    )
})
