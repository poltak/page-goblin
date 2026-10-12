/**
 * Decode the bytes of a text file. Most books are UTF-8, but older books use UTF-16 or a
 * legacy 8-bit encoding that only the XML declaration names.
 */

const DECLARATION_SCAN_LENGTH = 200
const DECLARED_ENCODING = /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([^"']+)["']/i
/** The labels that TextDecoder reads as UTF-16. */
const UTF16_LABEL = /^(?:utf-16|ucs-2|iso-10646-ucs-2|unicode|csunicode)/

let utf8Decoder: TextDecoder | undefined

export function decodeText(bytes: Uint8Array): string {
    const label = detectEncoding(bytes)
    if (label !== 'utf-8') {
        try {
            return new TextDecoder(label).decode(bytes)
        } catch {
            // The browser does not know the label. UTF-8 is the best guess that remains.
        }
    }
    return (utf8Decoder ??= new TextDecoder()).decode(bytes)
}

function detectEncoding(bytes: Uint8Array): string {
    const first = bytes[0]
    const second = bytes[1]
    if (first === 0xef && second === 0xbb && bytes[2] === 0xbf) return 'utf-8'
    if (first === 0xff && second === 0xfe) return 'utf-16le'
    if (first === 0xfe && second === 0xff) return 'utf-16be'
    // UTF-16 with no byte order mark. The first character of an XML file is '<'.
    if (first === 0x3c && second === 0) return 'utf-16le'
    if (first === 0 && second === 0x3c) return 'utf-16be'

    const head = String.fromCharCode(...bytes.subarray(0, DECLARATION_SCAN_LENGTH))
    const label = DECLARED_ENCODING.exec(head)?.[1].trim().toLowerCase()
    // A declaration that is readable as ASCII cannot be in UTF-16, so that label is wrong.
    if (!label || UTF16_LABEL.test(label) || label === 'utf8') return 'utf-8'
    return label
}
