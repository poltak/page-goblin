/**
 * Builds small font files for tests. It is not part of the application build.
 *
 * The files have only the tables that `readFontInfo` reads. They are not fonts that a browser
 * can show.
 */

export interface FontNameSpec {
    id: number
    text: string
    /** Default: 3 (Windows). */
    platform?: number
    /** Default: 1 (Unicode BMP) for Windows, 0 for the other platforms. */
    encoding?: number
    /** Default: 0x0409 (English) for Windows, 0 for the other platforms. */
    language?: number
}

export interface FontAxisSpec {
    tag: string
    min: number
    max: number
}

export interface BuildFontOptions {
    /** Default: 'truetype'. */
    signature?: 'truetype' | 'opentype' | 'apple'
    names?: FontNameSpec[]
    /** Null leaves out the OS/2 table. */
    os2?: {
        weight?: number
        width?: number
        selection?: number
        familyClass?: number
        panose?: number[]
    } | null
    /** The `macStyle` of the head table. Null leaves out the head table. */
    macStyle?: number | null
    fixedPitch?: boolean
    axes?: FontAxisSpec[]
}

/** A family name and a style name in the Windows encoding. */
export function familyNames(family: string, style = 'Regular'): FontNameSpec[] {
    return [
        { id: 1, text: family },
        { id: 2, text: style },
    ]
}

function utf16(text: string): number[] {
    const bytes: number[] = []
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index)
        bytes.push(unit >> 8, unit & 0xff)
    }
    return bytes
}

class Writer {
    readonly bytes: number[] = []

    u8(value: number): this {
        this.bytes.push(value & 0xff)
        return this
    }

    u16(value: number): this {
        return this.u8(value >> 8).u8(value)
    }

    u32(value: number): this {
        return this.u16(value >>> 16).u16(value & 0xffff)
    }

    tag(tag: string): this {
        for (const char of tag.padEnd(4, ' ')) this.u8(char.charCodeAt(0))
        return this
    }

    raw(bytes: ArrayLike<number>): this {
        for (let index = 0; index < bytes.length; index++) this.bytes.push(bytes[index])
        return this
    }

    pad(): this {
        while (this.bytes.length % 4) this.bytes.push(0)
        return this
    }
}

function nameTable(names: readonly FontNameSpec[]): number[] {
    const records = new Writer()
    const strings = new Writer()
    for (const name of names) {
        const platform = name.platform ?? 3
        const data =
            platform === 1 ? [...name.text].map((char) => char.charCodeAt(0)) : utf16(name.text)
        records
            .u16(platform)
            .u16(name.encoding ?? (platform === 3 ? 1 : 0))
            .u16(name.language ?? (platform === 3 ? 0x0409 : 0))
            .u16(name.id)
            .u16(data.length)
            .u16(strings.bytes.length)
        strings.raw(data)
    }
    return new Writer()
        .u16(0)
        .u16(names.length)
        .u16(6 + names.length * 12)
        .raw(records.bytes)
        .raw(strings.bytes).bytes
}

function os2Table(os2: NonNullable<BuildFontOptions['os2']>): number[] {
    const table = new Writer()
        .u16(4)
        .u16(500)
        .u16(os2.weight ?? 400)
        .u16(os2.width ?? 5)
    while (table.bytes.length < 30) table.u8(0)
    table.u16((os2.familyClass ?? 0) << 8)
    const panose = os2.panose ?? []
    for (let index = 0; index < 10; index++) table.u8(panose[index] ?? 0)
    while (table.bytes.length < 62) table.u8(0)
    table.u16(os2.selection ?? 0x40)
    while (table.bytes.length < 96) table.u8(0)
    return table.bytes
}

function headTable(macStyle: number): number[] {
    const table = new Writer()
    while (table.bytes.length < 44) table.u8(0)
    table.u16(macStyle)
    while (table.bytes.length < 54) table.u8(0)
    return table.bytes
}

function postTable(fixedPitch: boolean): number[] {
    const table = new Writer()
        .u32(0x00030000)
        .u32(0)
        .u16(0)
        .u16(0)
        .u32(fixedPitch ? 1 : 0)
    while (table.bytes.length < 32) table.u8(0)
    return table.bytes
}

function fvarTable(axes: readonly FontAxisSpec[]): number[] {
    const table = new Writer().u16(1).u16(0).u16(16).u16(2).u16(axes.length).u16(20).u16(0).u16(0)
    for (const axis of axes) {
        table
            .tag(axis.tag)
            .u32(Math.round(axis.min * 65536))
            .u32(Math.round(axis.min * 65536))
            .u32(Math.round(axis.max * 65536))
            .u16(0)
            .u16(256)
    }
    return table.bytes
}

const SIGNATURES = { truetype: 0x00010000, opentype: 0x4f54544f, apple: 0x74727565 }

/** Puts the tables into an sfnt file, sorted by tag. */
export function packTables(
    tables: Record<string, ArrayLike<number>>,
    signature = 0x00010000,
): Uint8Array<ArrayBuffer> {
    const tags = Object.keys(tables).sort()
    const directory = new Writer().u32(signature).u16(tags.length).u16(0).u16(0).u16(0)
    const body = new Writer()
    let offset = 12 + tags.length * 16
    for (const tag of tags) {
        const data = tables[tag]
        directory.tag(tag).u32(0).u32(offset).u32(data.length)
        body.raw(data).pad()
        offset = 12 + tags.length * 16 + body.bytes.length
    }
    return Uint8Array.from([...directory.bytes, ...body.bytes])
}

/** An sfnt file with the tables of the options. */
export function buildFont(options: BuildFontOptions = {}): Uint8Array<ArrayBuffer> {
    const tables: Record<string, number[]> = {
        name: nameTable(options.names ?? familyNames('Test Serif')),
        post: postTable(options.fixedPitch ?? false),
    }
    if (options.macStyle !== null) tables.head = headTable(options.macStyle ?? 0)
    if (options.os2 !== null) tables['OS/2'] = os2Table(options.os2 ?? {})
    if (options.axes) tables.fvar = fvarTable(options.axes)
    return packTables(tables, SIGNATURES[options.signature ?? 'truetype'])
}

export interface WrapWoffOptions {
    /** Compresses a table with zlib. Without it, each table is stored as it is. */
    compress?: (data: Uint8Array) => Uint8Array
}

/** Puts the tables of an sfnt file into a WOFF file. */
export function wrapWoff(sfnt: Uint8Array, options: WrapWoffOptions = {}): Uint8Array<ArrayBuffer> {
    const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength)
    const count = view.getUint16(4)
    const entries: { tag: number; data: Uint8Array; size: number }[] = []
    for (let index = 0; index < count; index++) {
        const entry = 12 + index * 16
        const offset = view.getUint32(entry + 8)
        const length = view.getUint32(entry + 12)
        const original = sfnt.subarray(offset, offset + length)
        const compressed = options.compress?.(original)
        const data = compressed && compressed.length < original.length ? compressed : original
        entries.push({ tag: view.getUint32(entry), data, size: length })
    }
    const header = 44 + count * 20
    const directory = new Writer()
    const body = new Writer()
    for (const entry of entries) {
        directory
            .u32(entry.tag)
            .u32(header + body.bytes.length)
            .u32(entry.data.length)
            .u32(entry.size)
            .u32(0)
        body.raw(entry.data).pad()
    }
    const total = header + body.bytes.length
    const start = new Writer()
        .tag('wOFF')
        .u32(view.getUint32(0))
        .u32(total)
        .u16(count)
        .u16(0)
        .u32(sfnt.length)
        .u16(1)
        .u16(0)
        .u32(0)
        .u32(0)
        .u32(0)
        .u32(0)
        .u32(0)
    return Uint8Array.from([...start.bytes, ...directory.bytes, ...body.bytes])
}
