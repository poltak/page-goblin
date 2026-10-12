import { describe, expect, it } from 'vitest'
import { openEpub } from './index'
import { buildEpub, DEFAULT_IDENTIFIER } from './testing/build-epub'
import { noiseBytes } from './testing/recording-blob'
import { readBlobBytes } from './zip'

const IDPF = 'http://www.idpf.org/2008/embedding'
const ADOBE = 'http://ns.adobe.com/pdf/enc#RC'
const AES = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc'

function encryptionXml(resources: Array<{ algorithm: string; uri: string }>): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
${resources
    .map(
        ({ algorithm, uri }) => `<enc:EncryptedData>
<enc:EncryptionMethod Algorithm="${algorithm}"/>
<enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData>
</enc:EncryptedData>`,
    )
    .join('\n')}
</encryption>`
}

function xorStart(
    bytes: Uint8Array<ArrayBuffer>,
    key: Uint8Array,
    length: number,
): Uint8Array<ArrayBuffer> {
    const result = bytes.slice()
    for (let index = 0; index < Math.min(length, result.length); index++) {
        result[index] ^= key[index % key.length]
    }
    return result
}

/** The IDPF algorithm, written from the EPUB specification. */
async function obfuscateIdpf(
    font: Uint8Array<ArrayBuffer>,
    identifier: string,
): Promise<Uint8Array<ArrayBuffer>> {
    const source = new TextEncoder().encode(identifier.replace(/[ \t\r\n]/g, ''))
    const key = new Uint8Array(await crypto.subtle.digest('SHA-1', source))
    expect(key).toHaveLength(20)
    return xorStart(font, key, 1040)
}

/** The Adobe algorithm: the key is the 16 bytes of the UUID. */
function obfuscateAdobe(font: Uint8Array<ArrayBuffer>, uuid: string): Uint8Array<ArrayBuffer> {
    const hex = uuid.replace(/-/g, '')
    const key = Uint8Array.from({ length: 16 }, (_, index) =>
        Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
    )
    return xorStart(font, key, 1024)
}

describe('font obfuscation', () => {
    it('reverses the IDPF algorithm', async () => {
        const font = noiseBytes(3000, 7)
        const small = noiseBytes(500, 8)
        // The white space is not part of the key.
        const identifier = ' urn:uuid:12345678-1234-4234-8234-\n\t123456789abc '
        const obfuscated = await obfuscateIdpf(font, identifier)
        expect(obfuscated).not.toEqual(font)
        expect(obfuscated.subarray(1040)).toEqual(font.subarray(1040))

        const book = await openEpub(
            await buildEpub({
                metadata: { identifier },
                files: {
                    'fonts/Body Font.otf': obfuscated,
                    'fonts/small.ttf': await obfuscateIdpf(small, identifier),
                    'fonts/clear.woff': font,
                },
                rawFiles: {
                    'META-INF/encryption.xml': encryptionXml([
                        { algorithm: IDPF, uri: 'OEBPS/fonts/Body%20Font.otf' },
                        { algorithm: IDPF, uri: 'OEBPS/fonts/small.ttf' },
                    ]),
                },
            }),
        )

        expect(await book.readBytes('OEBPS/fonts/Body Font.otf')).toEqual(font)
        expect(await book.readBytes('OEBPS/fonts/small.ttf')).toEqual(small)
        // A file that the encryption file does not list stays as it is.
        expect(await book.readBytes('OEBPS/fonts/clear.woff')).toEqual(font)

        const blob = await book.readBlob('OEBPS/fonts/Body Font.otf')
        expect(blob.type).toBe('font/otf')
        expect(await readBlobBytes(blob, 0, blob.size)).toEqual(font)
        // Each read gives the clear form again.
        expect(await book.readBytes('OEBPS/fonts/Body Font.otf')).toEqual(font)
    })

    it('reverses the IDPF algorithm for a stored entry', async () => {
        const font = noiseBytes(2000, 9)
        const book = await openEpub(
            await buildEpub({
                compress: false,
                files: { 'fonts/a.otf': await obfuscateIdpf(font, DEFAULT_IDENTIFIER) },
                rawFiles: {
                    'META-INF/encryption.xml': encryptionXml([
                        { algorithm: IDPF, uri: 'OEBPS/fonts/a.otf' },
                    ]),
                },
            }),
        )
        const blob = await book.readBlob('OEBPS/fonts/a.otf')
        expect(await readBlobBytes(blob, 0, blob.size)).toEqual(font)
        expect(await book.readBytes('OEBPS/fonts/a.otf')).toEqual(font)
    })

    it('reverses the Adobe algorithm', async () => {
        const font = noiseBytes(3000, 11)
        const uuid = '9a0ca9ab-9e33-4181-b2a3-e7f2ceb8e9bd'
        const obfuscated = obfuscateAdobe(font, uuid)
        expect(obfuscated.subarray(0, 1024)).not.toEqual(font.subarray(0, 1024))
        expect(obfuscated.subarray(1024)).toEqual(font.subarray(1024))

        const book = await openEpub(
            await buildEpub({
                version: 2,
                // The unique identifier is not the UUID. A second identifier has it.
                metadata: { identifier: 'isbn:9780000000001' },
                extraMetadata: `<dc:identifier>URN:UUID:${uuid.toUpperCase()}</dc:identifier>`,
                files: { 'fonts/a.ttf': obfuscated },
                rawFiles: {
                    'META-INF/encryption.xml': encryptionXml([
                        { algorithm: ADOBE, uri: 'OEBPS/fonts/a.ttf' },
                    ]),
                },
            }),
        )

        expect(await book.readBytes('OEBPS/fonts/a.ttf')).toEqual(font)
        const blob = await book.readBlob('OEBPS/fonts/a.ttf')
        expect(await readBlobBytes(blob, 0, blob.size)).toEqual(font)
    })

    it('leaves the bytes as they are when the book has no data for the key', async () => {
        const font = noiseBytes(1500, 13)
        const book = await openEpub(
            await buildEpub({
                metadata: { identifier: 'not-a-uuid' },
                files: { 'fonts/a.ttf': font },
                rawFiles: {
                    'META-INF/encryption.xml': encryptionXml([
                        { algorithm: ADOBE, uri: 'OEBPS/fonts/a.ttf' },
                    ]),
                },
            }),
        )
        expect(await book.readBytes('OEBPS/fonts/a.ttf')).toEqual(font)
    })
})

describe('DRM', () => {
    const drm = { name: 'EpubError', code: 'drm' }

    it('rejects a book with another encryption algorithm', async () => {
        const blob = await buildEpub({
            rawFiles: {
                'META-INF/encryption.xml': encryptionXml([
                    { algorithm: AES, uri: 'OEBPS/text/chapter-1.xhtml' },
                ]),
            },
        })
        await expect(openEpub(blob)).rejects.toMatchObject(drm)
        await expect(openEpub(blob)).rejects.toThrow(/DRM/)
    })

    it('rejects a book that has DRM on one resource and font obfuscation on another', async () => {
        const blob = await buildEpub({
            files: { 'fonts/a.ttf': noiseBytes(100) },
            rawFiles: {
                'META-INF/encryption.xml': encryptionXml([
                    { algorithm: IDPF, uri: 'OEBPS/fonts/a.ttf' },
                    { algorithm: AES, uri: 'OEBPS/text/chapter-2.xhtml' },
                ]),
            },
        })
        await expect(openEpub(blob)).rejects.toMatchObject(drm)
    })

    it('finds the algorithm in an encryption file that is not well-formed', async () => {
        const blob = await buildEpub({
            rawFiles: {
                'META-INF/encryption.xml': `<encryption><EncryptedData><EncryptionMethod Algorithm="${AES}"><CipherData>`,
            },
        })
        await expect(openEpub(blob)).rejects.toMatchObject(drm)
    })

    it('does not use the key algorithm of a nested key as a font algorithm', async () => {
        const blob = await buildEpub({
            rawFiles: {
                'META-INF/encryption.xml': `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
    xmlns:enc="http://www.w3.org/2001/04/xmlenc#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
<enc:EncryptedData>
<ds:KeyInfo><enc:EncryptedKey><enc:EncryptionMethod Algorithm="${IDPF}"/></enc:EncryptedKey></ds:KeyInfo>
<enc:CipherData><enc:CipherReference URI="OEBPS/text/chapter-1.xhtml"/></enc:CipherData>
</enc:EncryptedData>
</encryption>`,
            },
        })
        await expect(openEpub(blob)).rejects.toMatchObject(drm)
    })

    it('opens a book with an encryption file that lists nothing', async () => {
        const book = await openEpub(
            await buildEpub({ rawFiles: { 'META-INF/encryption.xml': encryptionXml([]) } }),
        )
        expect(book.spine).toHaveLength(3)
    })
})
