import { describe, expect, it } from 'vitest'
import { decodeText } from './text'

function utf16(text: string, littleEndian: boolean, withMark = true): Uint8Array<ArrayBuffer> {
    const source = (withMark ? '\ufeff' : '') + text
    const bytes = new Uint8Array(source.length * 2)
    const view = new DataView(bytes.buffer)
    for (let index = 0; index < source.length; index++) {
        view.setUint16(index * 2, source.charCodeAt(index), littleEndian)
    }
    return bytes
}

/** One byte for each character. The text must have only characters below U+0100. */
function latin1(text: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(text, (char) => char.charCodeAt(0))
}

describe('decodeText', () => {
    it('decodes UTF-8 and removes the byte order mark', () => {
        const text = '<p>Café – 日本語</p>'
        const bytes = new TextEncoder().encode(text)
        expect(decodeText(bytes)).toBe(text)
        expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]))).toBe(text)
    })

    it('decodes UTF-16 with a byte order mark', () => {
        const text = '<?xml version="1.0" encoding="UTF-16"?><p>Café – 日本語</p>'
        expect(decodeText(utf16(text, true))).toBe(text)
        expect(decodeText(utf16(text, false))).toBe(text)
    })

    it('decodes UTF-16 that has no byte order mark', () => {
        const text = '<?xml version="1.0" encoding="UTF-16"?><p>Café</p>'
        expect(decodeText(utf16(text, true, false))).toBe(text)
        expect(decodeText(utf16(text, false, false))).toBe(text)
    })

    it('uses the encoding of the XML declaration', () => {
        // 0x93 and 0x94 are curly quotes in windows-1252. 0xe9 is e with acute accent.
        const bytes = latin1('<?xml version="1.0" encoding="windows-1252"?><p>\x93Caf\xe9\x94</p>')
        expect(decodeText(bytes)).toBe('<?xml version="1.0" encoding="windows-1252"?><p>“Café”</p>')

        const single = latin1(
            "<?xml version='1.0' encoding='ISO-8859-1' standalone='no'?><p>Caf\xe9</p>",
        )
        expect(decodeText(single)).toContain('<p>Café</p>')
    })

    it('decodes other legacy encodings that the declaration names', () => {
        // "あ" in Shift_JIS.
        const bytes = Uint8Array.from([
            ...latin1('<?xml version="1.0" encoding="Shift_JIS"?><p>'),
            0x82,
            0xa0,
            ...latin1('</p>'),
        ])
        expect(decodeText(bytes)).toContain('<p>あ</p>')
    })

    it('falls back to UTF-8 for an unknown or wrong label', () => {
        const body = '<p>Café</p>'
        const unknown = new TextEncoder().encode(
            `<?xml version="1.0" encoding="x-nothing"?>${body}`,
        )
        expect(decodeText(unknown)).toContain(body)
        // The declaration is readable as ASCII, so the file is not UTF-16.
        const wrong = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-16"?>${body}`)
        expect(decodeText(wrong)).toContain(body)
    })

    it('ignores a label that the browser reads as UTF-16', () => {
        // TextDecoder reads these labels as UTF-16, but the declaration is readable as ASCII.
        for (const label of ['unicode', 'UCS-2', 'ISO-10646-UCS-2', 'csUnicode', 'unicodeFFFE']) {
            const text = `<?xml version="1.0" encoding="${label}"?><p>Café</p>`
            expect(decodeText(new TextEncoder().encode(text))).toBe(text)
        }
    })

    it('uses UTF-8 when there is no declaration', () => {
        expect(decodeText(new TextEncoder().encode('p { content: "é" }'))).toBe(
            'p { content: "é" }',
        )
        expect(decodeText(new Uint8Array(0))).toBe('')
    })

    it('ignores an encoding name that is not in the declaration', () => {
        const text = '<html><!-- encoding="windows-1252" --><p>Café</p></html>'
        expect(decodeText(new TextEncoder().encode(text))).toBe(text)
    })
})
