import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { cleanFontName, FontFileError, MAX_FONT_NAME_LENGTH, readFontInfo, sniffFont } from './sfnt'
import { buildFont, familyNames, packTables, wrapWoff } from './testing/build-font'

const here = dirname(fileURLToPath(import.meta.url))
const fontsource = resolve(here, '../../../node_modules/@fontsource')

function buffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer
}

async function errorOf(promise: Promise<unknown>): Promise<FontFileError> {
    const error = await promise.then(
        () => null,
        (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(FontFileError)
    return error as FontFileError
}

describe('sniffFont', () => {
    it('knows each font signature', () => {
        const kinds = ['\x00\x01\x00\x00', 'true', 'OTTO', 'wOFF', 'wOF2', 'ttcf'].map((tag) =>
            sniffFont(Uint8Array.from(tag + '\x00\x00', (char) => char.charCodeAt(0))),
        )
        expect(kinds).toEqual(['truetype', 'truetype', 'opentype', 'woff', 'woff2', 'collection'])
    })

    it('gives null for other data and for a short file', () => {
        expect(sniffFont(new TextEncoder().encode('PK\x03\x04 a zip file'))).toBeNull()
        expect(sniffFont(Uint8Array.of(0, 1, 0))).toBeNull()
    })
})

describe('readFontInfo', () => {
    it('reads the names, weight, style and class of a TrueType file', async () => {
        const font = buildFont({
            names: familyNames('Merriweather', 'Bold Italic'),
            os2: { weight: 700, selection: 0x21, panose: [2, 6] },
        })
        expect(await readFontInfo(buffer(font))).toEqual({
            format: 'truetype',
            family: 'Merriweather',
            styleName: 'Bold Italic',
            weight: '700',
            style: 'italic',
            stretch: '100%',
            fallback: 'serif',
        })
    })

    it('reads an OpenType file with CFF outlines and an old Apple file', async () => {
        const otf = await readFontInfo(buffer(buildFont({ signature: 'opentype' })))
        const apple = await readFontInfo(buffer(buildFont({ signature: 'apple' })))
        expect(otf.format).toBe('opentype')
        expect(apple.format).toBe('truetype')
        expect(otf.family).toBe('Test Serif')
    })

    it('prefers the typographic family to the family of the style link group', async () => {
        const font = buildFont({
            names: [
                { id: 1, text: 'Roboto Light' },
                { id: 2, text: 'Regular' },
                { id: 16, text: 'Roboto' },
                { id: 17, text: 'Light' },
            ],
            os2: { weight: 300 },
        })
        const info = await readFontInfo(buffer(font))
        expect(info).toMatchObject({ family: 'Roboto', styleName: 'Light', weight: '300' })
    })

    it('prefers the English Windows name and reads the other platforms', async () => {
        const preferred = buildFont({
            names: [
                { id: 1, text: 'Mac Name', platform: 1 },
                { id: 1, text: 'Unicode Name', platform: 0, encoding: 3 },
                { id: 1, text: 'Nom', language: 0x040c },
                { id: 1, text: 'English Name' },
            ],
        })
        const mac = buildFont({ names: [{ id: 1, text: 'Mac Name', platform: 1 }] })
        const unicode = buildFont({ names: [{ id: 1, text: 'Ünïcode', platform: 0, encoding: 3 }] })
        expect((await readFontInfo(buffer(preferred))).family).toBe('English Name')
        expect((await readFontInfo(buffer(mac))).family).toBe('Mac Name')
        expect((await readFontInfo(buffer(unicode))).family).toBe('Ünïcode')
    })

    it('gives the range of a variable font', async () => {
        const font = buildFont({
            axes: [
                { tag: 'wght', min: 100, max: 900 },
                { tag: 'wdth', min: 75, max: 100 },
                { tag: 'slnt', min: -15, max: 0 },
            ],
        })
        const info = await readFontInfo(buffer(font))
        expect(info).toMatchObject({ weight: '100 900', stretch: '75% 100%' })
    })

    it('ignores a weight axis outside the CSS range', async () => {
        const font = buildFont({ axes: [{ tag: 'wght', min: 0, max: 2000 }], os2: { weight: 500 } })
        expect((await readFontInfo(buffer(font))).weight).toBe('500')
    })

    it('reads the width class and the old weight scale', async () => {
        const condensed = buildFont({ os2: { width: 3 } })
        const oldScale = buildFont({ os2: { weight: 7 } })
        const bad = buildFont({ os2: { weight: 5000, width: 40 } })
        expect((await readFontInfo(buffer(condensed))).stretch).toBe('75%')
        expect((await readFontInfo(buffer(oldScale))).weight).toBe('700')
        expect(await readFontInfo(buffer(bad))).toMatchObject({ weight: '400', stretch: '100%' })
    })

    it('finds the italic in the oblique bit, the head table or the style name', async () => {
        const oblique = buildFont({ os2: { selection: 0x200 } })
        const head = buildFont({ os2: null, macStyle: 2 })
        const named = buildFont({
            os2: null,
            macStyle: null,
            names: familyNames('Serif', 'Oblique'),
        })
        expect((await readFontInfo(buffer(oblique))).style).toBe('italic')
        expect((await readFontInfo(buffer(head))).style).toBe('italic')
        expect((await readFontInfo(buffer(named))).style).toBe('italic')
    })

    it('guesses the fallback class', async () => {
        const fallbackOf = async (options: Parameters<typeof buildFont>[0]) =>
            (await readFontInfo(buffer(buildFont(options)))).fallback
        expect(await fallbackOf({ fixedPitch: true })).toBe('monospace')
        expect(await fallbackOf({ os2: { panose: [2, 11, 0, 9] } })).toBe('monospace')
        expect(await fallbackOf({ os2: { panose: [2, 11] } })).toBe('sans-serif')
        expect(await fallbackOf({ os2: { familyClass: 8 } })).toBe('sans-serif')
        expect(await fallbackOf({ os2: { familyClass: 1 } })).toBe('serif')
        expect(await fallbackOf({ os2: null })).toBe('serif')
    })

    it('gives defaults for a file with no names and no style tables', async () => {
        const font = packTables({ glyf: [0, 0, 0, 0] })
        expect(await readFontInfo(buffer(font))).toEqual({
            format: 'truetype',
            family: null,
            styleName: null,
            weight: '400',
            style: 'normal',
            stretch: '100%',
            fallback: 'serif',
        })
    })

    it('reads a WOFF file with compressed and stored tables', async () => {
        const sfnt = buildFont({ names: familyNames('Lora', 'Italic'), os2: { selection: 1 } })
        for (const compress of [undefined, (data: Uint8Array) => deflateSync(data)]) {
            const info = await readFontInfo(buffer(wrapWoff(sfnt, { compress })))
            expect(info).toMatchObject({
                format: 'woff',
                family: 'Lora',
                styleName: 'Italic',
                style: 'italic',
            })
        }
    })

    it('skips a WOFF table that does not decompress to its size', async () => {
        const sfnt = buildFont({ names: familyNames('Lora') })
        const woff = wrapWoff(sfnt, { compress: () => Uint8Array.of(1, 2, 3) })
        expect((await readFontInfo(buffer(woff))).family).toBeNull()
    })

    it('gives defaults for a WOFF2 file', async () => {
        const woff2 = new TextEncoder().encode('wOF2' + '\x00'.repeat(60))
        const info = await readFontInfo(buffer(woff2))
        expect(info).toMatchObject({ format: 'woff2', family: null, weight: '400' })
    })

    it('refuses data that is not a font and a collection', async () => {
        expect((await errorOf(readFontInfo(buffer(new TextEncoder().encode('hello'))))).code).toBe(
            'not-a-font',
        )
        const ttc = new TextEncoder().encode('ttcf\x00\x01\x00\x00')
        expect(await errorOf(readFontInfo(buffer(ttc)))).toMatchObject({
            code: 'collection',
            message: expect.stringContaining('.ttc'),
        })
    })

    it('refuses a table directory that is longer than the file', async () => {
        const font = buildFont()
        new DataView(font.buffer).setUint16(4, 400)
        expect((await errorOf(readFontInfo(buffer(font)))).code).toBe('damaged')
        expect((await errorOf(readFontInfo(buffer(font.subarray(0, 8))))).code).toBe('damaged')
    })

    it('leaves out a table and a name that point outside the data', async () => {
        const font = buildFont({ names: familyNames('Lora') })
        const view = new DataView(font.buffer)
        // The first table entry is 'OS/2'. Its length now goes past the end of the file.
        view.setUint32(12 + 12, font.length)
        const info = await readFontInfo(buffer(font))
        expect(info).toMatchObject({ family: 'Lora', weight: '400' })

        const names = buildFont({ names: familyNames('Lora') })
        const nameView = new DataView(names.buffer)
        const count = nameView.getUint16(4)
        for (let index = 0; index < count; index++) {
            const entry = 12 + index * 16
            if (nameView.getUint32(entry) !== 0x6e616d65) continue
            const table = nameView.getUint32(entry + 8)
            // The length of the first name record.
            nameView.setUint16(table + 6 + 8, 60000)
        }
        expect((await readFontInfo(buffer(names))).family).toBeNull()
    })

    it('keeps names of untrusted files clean and short', async () => {
        const font = buildFont({
            names: familyNames('  Evil‮\x00Font\n' + 'x'.repeat(300)),
        })
        const { family } = await readFontInfo(buffer(font))
        expect(family?.startsWith('Evil Font x')).toBe(true)
        expect(family).toHaveLength(MAX_FONT_NAME_LENGTH)
    })

    it('reads a real WOFF file', async () => {
        const path = resolve(
            fontsource,
            'libre-baskerville/files/libre-baskerville-latin-400-italic.woff',
        )
        const data = readFileSync(path)
        const info = await readFontInfo(buffer(new Uint8Array(data)))
        expect(info).toMatchObject({
            format: 'woff',
            family: 'Libre Baskerville',
            weight: '400',
            style: 'italic',
            fallback: 'serif',
        })
    })
})

describe('cleanFontName', () => {
    it('gives null for a name with no text', () => {
        expect(cleanFontName(' \x00\t ')).toBeNull()
    })

    it('does not cut a character in two', () => {
        const name = cleanFontName('😀'.repeat(MAX_FONT_NAME_LENGTH + 5))
        expect([...name!]).toHaveLength(MAX_FONT_NAME_LENGTH)
    })
})
