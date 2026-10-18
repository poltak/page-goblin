/**
 * Reads the facts that the app needs from a font file: the format, the family name, the style
 * and the class of the fallback font. It reads only the tables `name`, `OS/2`, `head`, `post`
 * and `fvar`.
 *
 * The file is untrusted. Each offset and each length is checked. A value that is not valid
 * gives the default, so a damaged table does not stop the import. The browser does the full
 * check of the font when it loads it.
 */

export type FontFormat = 'truetype' | 'opentype' | 'woff' | 'woff2'
export type FontStyle = 'normal' | 'italic'
export type FontFallback = 'serif' | 'sans-serif' | 'monospace'

/** A format, or 'collection' for a TTC file with more than one font. */
export type FontKind = FontFormat | 'collection'

export interface FontInfo {
    format: FontFormat
    /**
     * The family name. Null when the file has no name that this module can read. A WOFF2 file
     * always gives null, because its tables use Brotli. The other fields are then defaults.
     */
    family: string | null
    /** The style name of the file, for example 'Bold Italic'. */
    styleName: string | null
    /** A CSS `font-weight` value: '400', or '100 900' for a variable font. */
    weight: string
    style: FontStyle
    /** A CSS `font-stretch` value: '100%', or '75% 100%' for a variable font. */
    stretch: string
    fallback: FontFallback
}

export type FontFileErrorCode = 'not-a-font' | 'collection' | 'damaged'

export class FontFileError extends Error {
    override name = 'FontFileError'

    constructor(
        readonly code: FontFileErrorCode,
        message: string,
    ) {
        super(message)
    }
}

/** The longest name that the module keeps. A longer name is cut. */
export const MAX_FONT_NAME_LENGTH = 100

/** A real font has fewer than 50 tables. */
const MAX_TABLES = 512
/** The largest table that the module decompresses from a WOFF file. */
const MAX_TABLE_BYTES = 4 * 1024 * 1024

const SFNT_HEADER = 12
const SFNT_ENTRY = 16
const WOFF_HEADER = 44
const WOFF_ENTRY = 20

const NAME_FAMILY = 1
const NAME_STYLE = 2
const NAME_TYPOGRAPHIC_FAMILY = 16
const NAME_TYPOGRAPHIC_STYLE = 17

const PLATFORM_UNICODE = 0
const PLATFORM_MAC = 1
const PLATFORM_WINDOWS = 3
const WINDOWS_ENGLISH_US = 0x0409

/** The `font-stretch` percentage of each `usWidthClass` value from 1 to 9. */
const WIDTH_PERCENT = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200]

const DEFAULT_WEIGHT = 400

function tagAt(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    )
}

/** The format from the first 4 bytes, or null when the data is not a font. */
export function sniffFont(bytes: Uint8Array): FontKind | null {
    if (bytes.length < 4) return null
    const tag = tagAt(bytes, 0)
    if (tag === '\x00\x01\x00\x00' || tag === 'true') return 'truetype'
    if (tag === 'OTTO') return 'opentype'
    if (tag === 'wOFF') return 'woff'
    if (tag === 'wOF2') return 'woff2'
    if (tag === 'ttcf') return 'collection'
    return null
}

type TableReader = (tag: string) => Promise<DataView | null>

function damaged(): FontFileError {
    return new FontFileError('damaged', 'The font file is damaged.')
}

function fits(view: DataView, offset: number, length: number): boolean {
    return offset >= 0 && length >= 0 && offset + length <= view.byteLength
}

function sfntTables(view: DataView): TableReader {
    if (view.byteLength < SFNT_HEADER) throw damaged()
    const count = view.getUint16(4)
    if (count > MAX_TABLES || !fits(view, SFNT_HEADER, count * SFNT_ENTRY)) throw damaged()
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    const tables = new Map<string, DataView>()
    for (let index = 0; index < count; index++) {
        const entry = SFNT_HEADER + index * SFNT_ENTRY
        const offset = view.getUint32(entry + 8)
        const length = view.getUint32(entry + 12)
        // A table outside the file is left out. The browser refuses such a file anyway.
        if (!fits(view, offset, length)) continue
        tables.set(tagAt(bytes, entry), new DataView(view.buffer, view.byteOffset + offset, length))
    }
    return async (tag) => tables.get(tag) ?? null
}

/** Decompresses zlib data. The result must have exactly `size` bytes. */
async function inflate(data: Uint8Array<ArrayBuffer>, size: number): Promise<Uint8Array | null> {
    if (typeof DecompressionStream === 'undefined') return null
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(data)
            controller.close()
        },
    })
    try {
        const reader = source.pipeThrough(new DecompressionStream('deflate')).getReader()
        const output = new Uint8Array(size)
        let length = 0
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (length + value.length > size) {
                void reader.cancel().catch(() => {})
                return null
            }
            output.set(value, length)
            length += value.length
        }
        return length === size ? output : null
    } catch {
        return null
    }
}

function woffTables(view: DataView): TableReader {
    if (view.byteLength < WOFF_HEADER) throw damaged()
    const count = view.getUint16(12)
    if (count > MAX_TABLES || !fits(view, WOFF_HEADER, count * WOFF_ENTRY)) throw damaged()
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    const entries = new Map<string, { offset: number; compressed: number; size: number }>()
    for (let index = 0; index < count; index++) {
        const entry = WOFF_HEADER + index * WOFF_ENTRY
        entries.set(tagAt(bytes, entry), {
            offset: view.getUint32(entry + 4),
            compressed: view.getUint32(entry + 8),
            size: view.getUint32(entry + 12),
        })
    }
    return async (tag) => {
        const entry = entries.get(tag)
        if (!entry || !fits(view, entry.offset, entry.compressed)) return null
        if (entry.compressed === entry.size) {
            return new DataView(view.buffer, view.byteOffset + entry.offset, entry.size)
        }
        if (entry.compressed > entry.size || entry.size > MAX_TABLE_BYTES) return null
        const data = new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset + entry.offset)
        const table = await inflate(data.subarray(0, entry.compressed), entry.size)
        return table ? new DataView(table.buffer, table.byteOffset, table.byteLength) : null
    }
}

function decodeUtf16(view: DataView, offset: number, length: number): string {
    let text = ''
    for (let index = 0; index + 1 < length; index += 2) {
        text += String.fromCharCode(view.getUint16(offset + index))
    }
    return text
}

function decodeMacRoman(view: DataView, offset: number, length: number): string {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length)
    try {
        return new TextDecoder('macintosh').decode(bytes)
    } catch {
        // The ASCII part is the same in each single-byte encoding.
        return String.fromCharCode(...bytes)
    }
}

/** Removes control characters and extra spaces, and cuts a long name. Null for no text. */
export function cleanFontName(raw: string): string | null {
    const text = raw
        // Also the marks that change the direction of the text, so a name cannot hide its end.
        .replace(/[\0-\x1f\x7f-\x9f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (!text) return null
    return [...text].slice(0, MAX_FONT_NAME_LENGTH).join('').trim()
}

/** The rank of a name record. A lower rank wins. Null for an encoding that is not read. */
function nameRank(platform: number, encoding: number, language: number): number | null {
    if (platform === PLATFORM_WINDOWS && (encoding === 1 || encoding === 10)) {
        return language === WINDOWS_ENGLISH_US ? 0 : 1
    }
    if (platform === PLATFORM_UNICODE) return 2
    if (platform === PLATFORM_MAC && encoding === 0) return language === 0 ? 3 : 4
    return null
}

function readNames(table: DataView | null): Map<number, string> {
    const names = new Map<number, string>()
    if (!table || table.byteLength < 6) return names
    const count = table.getUint16(2)
    const storage = table.getUint16(4)
    const ranks = new Map<number, number>()
    for (let index = 0; index < count; index++) {
        const record = 6 + index * 12
        if (!fits(table, record, 12)) break
        const nameId = table.getUint16(record + 6)
        if (
            nameId !== NAME_FAMILY &&
            nameId !== NAME_STYLE &&
            nameId !== NAME_TYPOGRAPHIC_FAMILY &&
            nameId !== NAME_TYPOGRAPHIC_STYLE
        ) {
            continue
        }
        const platform = table.getUint16(record)
        const rank = nameRank(platform, table.getUint16(record + 2), table.getUint16(record + 4))
        if (rank === null || rank >= (ranks.get(nameId) ?? Infinity)) continue
        const length = table.getUint16(record + 8)
        const offset = storage + table.getUint16(record + 10)
        if (!fits(table, offset, length)) continue
        const raw =
            platform === PLATFORM_MAC
                ? decodeMacRoman(table, offset, length)
                : decodeUtf16(table, offset, length)
        const name = cleanFontName(raw)
        if (!name) continue
        names.set(nameId, name)
        ranks.set(nameId, rank)
    }
    return names
}

interface Axis {
    min: number
    max: number
}

function readAxes(table: DataView | null): Map<string, Axis> {
    const axes = new Map<string, Axis>()
    if (!table || table.byteLength < 16) return axes
    const start = table.getUint16(4)
    const count = table.getUint16(8)
    const size = table.getUint16(10)
    if (size < 20) return axes
    const bytes = new Uint8Array(table.buffer, table.byteOffset, table.byteLength)
    for (let index = 0; index < count; index++) {
        const record = start + index * size
        if (!fits(table, record, 20)) break
        const min = table.getInt32(record + 4) / 65536
        const max = table.getInt32(record + 12) / 65536
        if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
            axes.set(tagAt(bytes, record), { min, max })
        }
    }
    return axes
}

function clampWeight(value: number): number {
    return Math.min(1000, Math.max(1, Math.round(value)))
}

function weightOf(os2: DataView | null, axes: Map<string, Axis>): string {
    const axis = axes.get('wght')
    if (axis && axis.min >= 1 && axis.max <= 1000) {
        const min = clampWeight(axis.min)
        const max = clampWeight(axis.max)
        return min === max ? String(min) : `${min} ${max}`
    }
    if (!os2 || os2.byteLength < 6) return String(DEFAULT_WEIGHT)
    let weight = os2.getUint16(4)
    // Some old fonts use the scale from 1 to 9.
    if (weight >= 1 && weight <= 9) weight *= 100
    return String(weight >= 1 && weight <= 1000 ? weight : DEFAULT_WEIGHT)
}

function percent(value: number): string {
    return `${Math.round(value * 10) / 10}%`
}

function stretchOf(os2: DataView | null, axes: Map<string, Axis>): string {
    const axis = axes.get('wdth')
    if (axis && axis.min >= 50 && axis.max <= 200) {
        return axis.min === axis.max
            ? percent(axis.min)
            : `${percent(axis.min)} ${percent(axis.max)}`
    }
    if (!os2 || os2.byteLength < 8) return '100%'
    return percent(WIDTH_PERCENT[os2.getUint16(6) - 1] ?? 100)
}

function styleOf(os2: DataView | null, head: DataView | null, styleName: string | null): FontStyle {
    if (os2 && os2.byteLength >= 64) {
        const selection = os2.getUint16(62)
        // Bit 0 is ITALIC and bit 9 is OBLIQUE.
        return selection & 0x0201 ? 'italic' : 'normal'
    }
    if (head && head.byteLength >= 46) return head.getUint16(44) & 0x02 ? 'italic' : 'normal'
    return styleName && /italic|oblique/i.test(styleName) ? 'italic' : 'normal'
}

function fallbackOf(os2: DataView | null, post: DataView | null): FontFallback {
    if (post && post.byteLength >= 16 && post.getUint32(12) !== 0) return 'monospace'
    if (!os2 || os2.byteLength < 42) return 'serif'
    // PANOSE: family 2 is Latin text, proportion 9 is monospaced, serif styles 11 to 15 are sans.
    const panoseFamily = os2.getUint8(32)
    const serifStyle = os2.getUint8(33)
    const proportion = os2.getUint8(35)
    if (panoseFamily === 2 && proportion === 9) return 'monospace'
    if (panoseFamily === 2 && serifStyle >= 11 && serifStyle <= 15) return 'sans-serif'
    // The IBM font class 8 is sans serif.
    if (os2.getUint8(30) === 8) return 'sans-serif'
    return 'serif'
}

function unreadable(format: FontFormat): FontInfo {
    return {
        format,
        family: null,
        styleName: null,
        weight: String(DEFAULT_WEIGHT),
        style: 'normal',
        stretch: '100%',
        fallback: 'serif',
    }
}

/**
 * Reads the facts of a font file. Rejects with a FontFileError when the data is not a font,
 * when it is a collection, or when its table directory is damaged.
 */
export async function readFontInfo(data: ArrayBuffer): Promise<FontInfo> {
    const bytes = new Uint8Array(data)
    const kind = sniffFont(bytes)
    if (kind === null) throw new FontFileError('not-a-font', 'The file is not a font.')
    if (kind === 'collection') {
        throw new FontFileError(
            'collection',
            'A font collection (.ttc) cannot be used. Use a .ttf or .otf file.',
        )
    }
    if (kind === 'woff2') return unreadable(kind)

    const view = new DataView(data)
    const table = kind === 'woff' ? woffTables(view) : sfntTables(view)
    const [name, os2, head, post, fvar] = await Promise.all(
        ['name', 'OS/2', 'head', 'post', 'fvar'].map(table),
    )
    const names = readNames(name)
    const axes = readAxes(fvar)
    const styleName = names.get(NAME_TYPOGRAPHIC_STYLE) ?? names.get(NAME_STYLE) ?? null
    return {
        format: kind,
        family: names.get(NAME_TYPOGRAPHIC_FAMILY) ?? names.get(NAME_FAMILY) ?? null,
        styleName,
        weight: weightOf(os2, axes),
        style: styleOf(os2, head, styleName),
        stretch: stretchOf(os2, axes),
        fallback: fallbackOf(os2, post),
    }
}
