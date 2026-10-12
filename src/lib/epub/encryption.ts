/**
 * Reads `META-INF/encryption.xml`. A book can obfuscate its fonts with one of two public
 * algorithms, and this module reverses them. All other algorithms are DRM.
 */

import { resolvePath } from './path'
import { attribute, childrenNamed, descendants, firstDescendant, parseXml } from './xml'

export type FontObfuscation = 'idpf' | 'adobe'

const ALGORITHMS = new Map<string, FontObfuscation>([
    ['http://www.idpf.org/2008/embedding', 'idpf'],
    ['http://ns.adobe.com/pdf/enc#RC', 'adobe'],
])
/** Number of bytes at the start of the font that each algorithm changes. */
const OBFUSCATED_LENGTH: Record<FontObfuscation, number> = { idpf: 1040, adobe: 1024 }

export interface EncryptionData {
    /** Container path (as written in the file) to the font algorithm. */
    fonts: Map<string, FontObfuscation>
    /** The first algorithm that is not font obfuscation, or null. */
    drmAlgorithm: string | null
}

export interface FontKeySource {
    /** The text of the package unique identifier, as written. */
    uniqueIdentifier: string | null
    /** All `dc:identifier` values. */
    identifiers: readonly string[]
}

export function readEncryption(text: string): EncryptionData {
    const fonts = new Map<string, FontObfuscation>()
    let drmAlgorithm: string | null = null

    const document = parseXml(text)
    if (!document) {
        // The algorithm names are sufficient to find DRM in a file that is not well-formed.
        for (const match of text.matchAll(/Algorithm\s*=\s*["']([^"']*)["']/g)) {
            if (!ALGORITHMS.has(match[1].trim())) drmAlgorithm ??= match[1].trim()
        }
        return { fonts, drmAlgorithm }
    }

    for (const data of descendants(document, 'encrypteddata')) {
        // A direct child only. Elements deeper in KeyInfo describe the key, not the resource.
        const method = childrenNamed(data, 'encryptionmethod')[0]
        const algorithm = (method && attribute(method, 'Algorithm')) ?? ''
        const kind = ALGORITHMS.get(algorithm)
        if (!kind) {
            drmAlgorithm ??= algorithm || 'unknown'
            continue
        }

        const reference = firstDescendant(data, 'cipherreference')
        const uri = reference ? attribute(reference, 'URI') : null
        const path = uri ? resolvePath('', uri) : null
        if (path !== null) fonts.set(path, kind)
    }

    return { fonts, drmAlgorithm }
}

/** The key for an algorithm, or null when the book does not have the data for the key. */
export async function fontKey(
    algorithm: FontObfuscation,
    source: FontKeySource,
): Promise<Uint8Array | null> {
    if (algorithm === 'adobe') return adobeKey(source.identifiers)

    const subtle = globalThis.crypto?.subtle
    if (!source.uniqueIdentifier || !subtle) return null
    // The specification removes exactly these four white space characters.
    const identifier = source.uniqueIdentifier.replace(/[ \u0009\u000d\u000a]/g, '')
    return new Uint8Array(await subtle.digest('SHA-1', new TextEncoder().encode(identifier)))
}

/** The 16 bytes of the UUID identifier. An identifier with 'urn:uuid:' has priority. */
function adobeKey(identifiers: readonly string[]): Uint8Array | null {
    const prefix = /^urn:uuid:/i
    const candidates = [
        ...identifiers.filter((identifier) => prefix.test(identifier)),
        ...identifiers.filter((identifier) => !prefix.test(identifier)),
    ]

    for (const identifier of candidates) {
        const hex = identifier.replace(prefix, '').replace(/-/g, '')
        if (!/^[\da-f]{32}$/i.test(hex)) continue
        const key = new Uint8Array(16)
        for (let index = 0; index < 16; index++) {
            key[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
        }
        return key
    }
    return null
}

/** Change obfuscated font bytes to their clear form, in place. */
export function deobfuscate(bytes: Uint8Array, key: Uint8Array, algorithm: FontObfuscation): void {
    const length = Math.min(bytes.length, OBFUSCATED_LENGTH[algorithm])
    for (let index = 0; index < length; index++) {
        bytes[index] ^= key[index % key.length]
    }
}
