function toHex(bytes: Uint8Array): string {
    let hex = ''
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
    return hex
}

/** A new random id in the UUID version 4 format. */
export function createId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

    // randomUUID is not there on a page without HTTPS, for example a test on the local network.
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = toHex(bytes)
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
    ].join('-')
}

/** SHA-256 of the bytes as lower-case hex. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    const subtle = globalThis.crypto?.subtle
    if (subtle) return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)))

    // crypto.subtle is not there on a page without HTTPS. The slow version loads only then.
    const { sha256 } = await import('./sha256-fallback')
    return toHex(sha256(new Uint8Array(bytes)))
}
