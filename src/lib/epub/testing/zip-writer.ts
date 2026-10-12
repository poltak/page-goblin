/**
 * Builds real ZIP archives for tests. It is not part of the application build.
 */

export type ZipContent = string | Uint8Array<ArrayBuffer>

export interface ZipFileSpec {
    path: string
    data: ZipContent
    /** Deflate the data. The default is true. The entry "mimetype" is always stored. */
    compress?: boolean
    /** A compression method number to write in the headers in place of the real one. */
    methodOverride?: number
    /** Extra field bytes for the local file header only. */
    localExtra?: Uint8Array<ArrayBuffer>
    /** Extra field bytes for the central directory header only. */
    centralExtra?: Uint8Array<ArrayBuffer>
    /** Name bytes to write in place of the UTF-8 name. The UTF-8 flag is then not set. */
    rawName?: Uint8Array<ArrayBuffer>
    /** Write the sizes after the data (a data descriptor), as stream writers do. */
    dataDescriptor?: boolean
    /** More general purpose flag bits, for example 1 for an encrypted entry. */
    flags?: number
}

export interface CreateZipOptions {
    /** The archive comment. */
    comment?: string
    /** Write ZIP64 records. Sizes and offsets then go into ZIP64 extra fields. */
    zip64?: boolean
    /** Bytes before the first entry, as a self-extractor has them. Offsets do not count them. */
    prefix?: Uint8Array<ArrayBuffer>
    /** The media type of the Blob. The default is application/zip. */
    type?: string
}

const encoder = new TextEncoder()
const FLAG_DATA_DESCRIPTOR = 0x8
const FLAG_UTF8 = 0x800
const MAX_UINT32 = 0xffffffff

let crcTable: Uint32Array | undefined

export function crc32(bytes: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256)
        for (let index = 0; index < 256; index++) {
            let value = index
            for (let bit = 0; bit < 8; bit++) {
                value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
            }
            crcTable[index] = value >>> 0
        }
    }

    let crc = 0xffffffff
    for (let index = 0; index < bytes.length; index++) {
        crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
}

export async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            controller.enqueue(bytes)
            controller.close()
        },
    })
    const reader = source.pipeThrough(new CompressionStream('deflate-raw')).getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
    }
    return concat(chunks)
}

export function toBytes(content: ZipContent): Uint8Array<ArrayBuffer> {
    return typeof content === 'string' ? encoder.encode(content) : content
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.length
    }
    return result
}

/** A small helper to write little-endian header fields in sequence. */
function header(size: number) {
    const bytes = new Uint8Array(size)
    const view = new DataView(bytes.buffer)
    let offset = 0
    const writer = {
        bytes,
        u16(value: number) {
            view.setUint16(offset, value, true)
            offset += 2
            return writer
        },
        u32(value: number) {
            view.setUint32(offset, value, true)
            offset += 4
            return writer
        },
        u64(value: number) {
            view.setBigUint64(offset, BigInt(value), true)
            offset += 8
            return writer
        },
    }
    return writer
}

/**
 * Build a ZIP archive. `files` is a list of entries, or an object from path to content.
 * The entry "mimetype" goes first and is stored, as the EPUB container format requires.
 */
export async function createZip(
    files: ZipFileSpec[] | Record<string, ZipContent>,
    options: CreateZipOptions = {},
): Promise<Blob> {
    const specs: ZipFileSpec[] = Array.isArray(files)
        ? [...files]
        : Object.entries(files).map(([path, data]) => ({ path, data }))
    specs.sort((a, b) => Number(b.path === 'mimetype') - Number(a.path === 'mimetype'))

    const zip64 = options.zip64 ?? false
    const prefix = options.prefix ?? new Uint8Array(0)
    const parts: Uint8Array[] = [prefix]
    const centralParts: Uint8Array[] = []
    let offset = 0

    for (const spec of specs) {
        const raw = toBytes(spec.data)
        const compress = spec.path !== 'mimetype' && (spec.compress ?? true)
        const data = compress ? await deflateRaw(raw) : raw
        const method = spec.methodOverride ?? (compress ? 8 : 0)
        const name = spec.rawName ?? encoder.encode(spec.path)
        const crc = crc32(raw)
        const flags =
            (spec.rawName ? 0 : FLAG_UTF8) |
            (spec.dataDescriptor ? FLAG_DATA_DESCRIPTOR : 0) |
            (spec.flags ?? 0)

        const localZip64 = zip64 ? header(20).u16(1).u16(16).u64(raw.length).u64(data.length) : null
        const localExtra = concat([
            localZip64?.bytes ?? new Uint8Array(0),
            spec.localExtra ?? new Uint8Array(0),
        ])
        const inLocal = (value: number) => (spec.dataDescriptor ? 0 : zip64 ? MAX_UINT32 : value)
        const local = header(30)
            .u32(0x04034b50)
            .u16(zip64 ? 45 : 20)
            .u16(flags)
            .u16(method)
            .u16(0)
            .u16(0x21)
            .u32(spec.dataDescriptor ? 0 : crc)
            .u32(inLocal(data.length))
            .u32(inLocal(raw.length))
            .u16(name.length)
            .u16(localExtra.length)

        const centralZip64 = zip64
            ? header(28).u16(1).u16(24).u64(raw.length).u64(data.length).u64(offset)
            : null
        const centralExtra = concat([
            centralZip64?.bytes ?? new Uint8Array(0),
            spec.centralExtra ?? new Uint8Array(0),
        ])
        const inCentral = (value: number) => (zip64 ? MAX_UINT32 : value)
        const central = header(46)
            .u32(0x02014b50)
            .u16(zip64 ? 45 : 20)
            .u16(zip64 ? 45 : 20)
            .u16(flags)
            .u16(method)
            .u16(0)
            .u16(0x21)
            .u32(crc)
            .u32(inCentral(data.length))
            .u32(inCentral(raw.length))
            .u16(name.length)
            .u16(centralExtra.length)
            .u16(0)
            .u16(0)
            .u16(0)
            .u32(0)
            .u32(inCentral(offset))
        centralParts.push(central.bytes, name, centralExtra)

        const entryParts = [local.bytes, name, localExtra, data]
        if (spec.dataDescriptor) {
            entryParts.push(
                header(16).u32(0x08074b50).u32(crc).u32(data.length).u32(raw.length).bytes,
            )
        }
        for (const part of entryParts) {
            parts.push(part)
            offset += part.length
        }
    }

    const directory = concat(centralParts)
    const directoryOffset = offset
    parts.push(directory)
    offset += directory.length

    if (zip64) {
        parts.push(
            header(56)
                .u32(0x06064b50)
                .u64(44)
                .u16(45)
                .u16(45)
                .u32(0)
                .u32(0)
                .u64(specs.length)
                .u64(specs.length)
                .u64(directory.length)
                .u64(directoryOffset).bytes,
            header(20).u32(0x07064b50).u32(0).u64(offset).u32(1).bytes,
        )
    }

    const comment = encoder.encode(options.comment ?? '')
    parts.push(
        header(22)
            .u32(0x06054b50)
            .u16(0)
            .u16(0)
            .u16(zip64 ? 0xffff : specs.length)
            .u16(zip64 ? 0xffff : specs.length)
            .u32(zip64 ? MAX_UINT32 : directory.length)
            .u32(zip64 ? MAX_UINT32 : directoryOffset)
            .u16(comment.length).bytes,
        comment,
    )

    return new Blob([concat(parts)], { type: options.type ?? 'application/zip' })
}
