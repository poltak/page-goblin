/**
 * A minimal ZIP reader for a Blob. It reads the central directory one time and then reads one
 * entry for each request, so a large archive never goes into memory as a whole.
 */

import { EpubError } from './types'

const END_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_END_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const DIGITAL_SIGNATURE = 0x05054b50
const LOCAL_SIGNATURE = 0x04034b50

const END_SIZE = 22
const ZIP64_LOCATOR_SIZE = 20
const ZIP64_END_SIZE = 56
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30
/** The end record with the longest archive comment. */
const TAIL_SIZE = END_SIZE + 0xffff
/** Bytes to read past the expected data end, for a local extra field that is longer. */
const LOCAL_EXTRA_SLACK = 64
const INFLATE_CHUNK_SIZE = 65536
/** Deflate cannot expand data by more than this factor. */
const MAX_DEFLATE_RATIO = 1032
/**
 * The largest entry that is decompressed. A small hostile file can state and give a very
 * large entry. The largest file in 175 real books was below 40 MB.
 */
const MAX_INFLATED_SIZE = 96 * 1024 * 1024
/**
 * The number of entries that are decompressed at the same time. A chapter asks for all its
 * images and a stylesheet for all its fonts in one step, and each entry is in memory while
 * it is decompressed. With no limit, a small hostile file could fill the memory of the page.
 */
const MAX_PARALLEL_INFLATES = 3

const METHOD_STORED = 0
const METHOD_DEFLATE = 8
const FLAG_ENCRYPTED = 0x1
const FLAG_UTF8 = 0x800
const ZIP64_EXTRA_ID = 0x1
const MAX_UINT16 = 0xffff
const MAX_UINT32 = 0xffffffff

export interface ZipEntry {
    /** File name with '/' between the directories. */
    readonly path: string
    /** Uncompressed size in bytes. A deflated entry never gives more bytes than this. */
    readonly size: number
    readonly compressedSize: number
    readonly method: number
    readonly flags: number
    /** Offset of the local file header in the Blob. */
    readonly headerOffset: number
    /** Length of the name and the extra field in the central directory. */
    readonly headerHint: number
    /** Offset of the entry data in the Blob. -1 until the local header was read. */
    dataOffset: number
}

export interface ZipArchive {
    /** All file entries by name. Directory entries are left out. */
    readonly entries: ReadonlyMap<string, ZipEntry>
    /** An exact match, or else a match that ignores letter case and the Unicode form. */
    find(path: string): ZipEntry | undefined
    read(entry: ZipEntry): Promise<Uint8Array<ArrayBuffer>>
    /** A stored entry becomes a slice of the archive Blob, so no bytes are copied. */
    readBlob(entry: ZipEntry, type: string): Promise<Blob>
}

/** Read a byte range of a Blob. All Blob reads of this module go through this function. */
export function readBlobBytes(
    blob: Blob,
    start: number,
    end: number,
): Promise<Uint8Array<ArrayBuffer>> {
    const slice = blob.slice(start, end)
    if (typeof slice.arrayBuffer === 'function') {
        return slice.arrayBuffer().then((buffer) => new Uint8Array(buffer))
    }

    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
        reader.readAsArrayBuffer(slice)
    })
}

export async function openZip(blob: Blob): Promise<ZipArchive> {
    const blobSize = blob.size
    if (blobSize < END_SIZE) throw notZip()

    const tailStart = Math.max(0, blobSize - TAIL_SIZE)
    const tail = await readBlobBytes(blob, tailStart, blobSize)
    const tailView = viewOf(tail)
    const endIndex = findEndRecord(tail, tailView)
    if (endIndex < 0) throw notZip()

    // The directory of a small archive is in the tail, so it needs no second read.
    const section = (start: number, end: number) => {
        if (start < 0 || start > end || end > blobSize) throw damaged()
        return start >= tailStart
            ? tail.subarray(start - tailStart, end - tailStart)
            : readBlobBytes(blob, start, end)
    }

    let directorySize = tailView.getUint32(endIndex + 12, true)
    let directoryOffset = tailView.getUint32(endIndex + 16, true)
    const locatorIndex = endIndex - ZIP64_LOCATOR_SIZE
    const isZip64 =
        (tailView.getUint16(endIndex + 10, true) === MAX_UINT16 ||
            directorySize === MAX_UINT32 ||
            directoryOffset === MAX_UINT32) &&
        locatorIndex >= 0 &&
        tailView.getUint32(locatorIndex, true) === ZIP64_LOCATOR_SIGNATURE

    if (isZip64) {
        const recordOffset = readUint64(tailView, locatorIndex + 8)
        const record = await section(recordOffset, recordOffset + ZIP64_END_SIZE)
        const recordView = viewOf(record)
        if (recordView.getUint32(0, true) !== ZIP64_END_SIGNATURE) throw damaged()
        directorySize = readUint64(recordView, 40)
        directoryOffset = readUint64(recordView, 48)
    }

    let directory = await section(directoryOffset, directoryOffset + directorySize)
    let shift = 0
    if (!isZip64 && directorySize > 0 && !hasSignature(directory, CENTRAL_SIGNATURE)) {
        // Data before the archive (a self-extractor) moves all offsets by the same amount.
        shift = tailStart + endIndex - directorySize - directoryOffset
        if (shift <= 0) throw damaged()
        directory = await section(directoryOffset + shift, directoryOffset + shift + directorySize)
    }

    const entries = readDirectory(directory, shift)
    let folded: Map<string, ZipEntry> | undefined
    const inflateQueue = createQueue(MAX_PARALLEL_INFLATES)

    const dataOf = async (entry: ZipEntry): Promise<Uint8Array<ArrayBuffer>> => {
        const { compressedSize } = entry
        if (entry.dataOffset >= 0) {
            // A slice past the end of the Blob gives fewer bytes and no error.
            if (entry.dataOffset + compressedSize > blobSize) throw damaged()
            return readBlobBytes(blob, entry.dataOffset, entry.dataOffset + compressedSize)
        }

        // The local header can have a longer extra field than the central directory. A read
        // with some slack gets the header and the data of most entries in one step.
        const guess =
            LOCAL_HEADER_SIZE + entry.headerHint + LOCAL_EXTRA_SLACK + entry.compressedSize
        const chunk = await readBlobBytes(
            blob,
            entry.headerOffset,
            Math.min(blobSize, entry.headerOffset + guess),
        )
        const start = dataStartOf(chunk)
        entry.dataOffset = entry.headerOffset + start
        if (entry.dataOffset + compressedSize > blobSize) throw damaged()
        if (start + compressedSize > chunk.length) {
            return readBlobBytes(blob, entry.dataOffset, entry.dataOffset + compressedSize)
        }
        // A stored entry goes to the caller, so it gets a buffer of its own exact size.
        return entry.method === METHOD_STORED
            ? chunk.slice(start, start + compressedSize)
            : chunk.subarray(start, start + compressedSize)
    }

    // The read of the compressed data is in the queue too, so an entry that waits has no
    // data in memory.
    const inflated = (entry: ZipEntry) =>
        inflateQueue(async () => inflate(await dataOf(entry), entry.size))

    return {
        entries,
        find(path) {
            const exact = entries.get(path)
            if (exact) return exact
            // Most books never need the second index, so it is made on the first miss.
            if (!folded) {
                folded = new Map()
                for (const entry of entries.values()) {
                    const key = foldPath(entry.path)
                    if (!folded.has(key)) folded.set(key, entry)
                }
            }
            return folded.get(foldPath(path))
        },
        async read(entry) {
            assertReadable(entry)
            if (entry.size === 0 && entry.compressedSize === 0) return new Uint8Array(0)
            return entry.method === METHOD_STORED ? dataOf(entry) : inflated(entry)
        },
        async readBlob(entry, type) {
            assertReadable(entry)
            // Some tools give an empty file the deflate method and no data.
            if (entry.size === 0 && entry.compressedSize === 0) return new Blob([], { type })
            if (entry.method !== METHOD_STORED) {
                return new Blob([await inflated(entry)], { type })
            }
            if (entry.dataOffset < 0) {
                const header = await readBlobBytes(
                    blob,
                    entry.headerOffset,
                    Math.min(blobSize, entry.headerOffset + LOCAL_HEADER_SIZE),
                )
                entry.dataOffset = entry.headerOffset + dataStartOf(header)
            }
            const end = entry.dataOffset + entry.compressedSize
            if (end > blobSize) throw damaged()
            return blob.slice(entry.dataOffset, end, type)
        },
    }
}

function notZip(): EpubError {
    return new EpubError('not-zip', 'The file is not a ZIP archive.')
}

function damaged(): EpubError {
    return new EpubError('not-zip', 'The ZIP archive is damaged.')
}

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function hasSignature(bytes: Uint8Array, signature: number): boolean {
    return bytes.length >= 4 && viewOf(bytes).getUint32(0, true) === signature
}

function readUint64(view: DataView, offset: number): number {
    const value = view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000
    if (!Number.isSafeInteger(value)) throw damaged()
    return value
}

/** Index of the last end record whose comment length fits in the bytes, or -1. */
function findEndRecord(bytes: Uint8Array, view: DataView): number {
    for (let index = bytes.length - END_SIZE; index >= 0; index--) {
        if (
            bytes[index] === 0x50 &&
            view.getUint32(index, true) === END_SIGNATURE &&
            index + END_SIZE + view.getUint16(index + 20, true) <= bytes.length
        ) {
            return index
        }
    }
    return -1
}

function readDirectory(directory: Uint8Array, shift: number): Map<string, ZipEntry> {
    const view = viewOf(directory)
    const entries = new Map<string, ZipEntry>()
    let offset = 0

    while (offset + 4 <= directory.length) {
        const signature = view.getUint32(offset, true)
        if (signature === DIGITAL_SIGNATURE) break
        if (signature !== CENTRAL_SIGNATURE || offset + CENTRAL_HEADER_SIZE > directory.length) {
            throw damaged()
        }

        const flags = view.getUint16(offset + 8, true)
        const method = view.getUint16(offset + 10, true)
        let compressedSize = view.getUint32(offset + 20, true)
        let size = view.getUint32(offset + 24, true)
        const nameLength = view.getUint16(offset + 28, true)
        const extraLength = view.getUint16(offset + 30, true)
        const commentLength = view.getUint16(offset + 32, true)
        let headerOffset = view.getUint32(offset + 42, true)

        const nameStart = offset + CENTRAL_HEADER_SIZE
        const extraStart = nameStart + nameLength
        const extraEnd = extraStart + extraLength
        offset = extraEnd + commentLength
        if (offset > directory.length) throw damaged()

        if (size === MAX_UINT32 || compressedSize === MAX_UINT32 || headerOffset === MAX_UINT32) {
            let field = extraStart
            while (field + 4 <= extraEnd) {
                const id = view.getUint16(field, true)
                const fieldEnd = Math.min(extraEnd, field + 4 + view.getUint16(field + 2, true))
                let value = field + 4
                if (id !== ZIP64_EXTRA_ID) {
                    field = fieldEnd
                    continue
                }
                // The field has only the values that are 0xffffffff in the header, in this order.
                if (size === MAX_UINT32 && value + 8 <= fieldEnd) {
                    size = readUint64(view, value)
                    value += 8
                }
                if (compressedSize === MAX_UINT32 && value + 8 <= fieldEnd) {
                    compressedSize = readUint64(view, value)
                    value += 8
                }
                if (headerOffset === MAX_UINT32 && value + 8 <= fieldEnd) {
                    headerOffset = readUint64(view, value)
                }
                break
            }
        }

        const path = containerPath(decodeName(directory.subarray(nameStart, extraStart), flags))
        if (!path || path.endsWith('/')) continue

        // A later entry with the same name replaces the earlier one, as in other ZIP readers.
        entries.set(path, {
            path,
            size,
            compressedSize,
            method,
            flags,
            headerOffset: headerOffset + shift,
            headerHint: nameLength + extraLength,
            dataOffset: -1,
        })
    }

    return entries
}

let strictUtf8Decoder: TextDecoder | undefined
let utf8Decoder: TextDecoder | undefined
let legacyDecoder: TextDecoder | undefined

function decodeName(bytes: Uint8Array, flags: number): string {
    try {
        return (strictUtf8Decoder ??= new TextDecoder('utf-8', { fatal: true })).decode(bytes)
    } catch {
        if (flags & FLAG_UTF8) return (utf8Decoder ??= new TextDecoder()).decode(bytes)
        return (legacyDecoder ??= new TextDecoder('windows-1252')).decode(bytes)
    }
}

/**
 * The container path for an entry name. Some tools write '\' between the directories, or
 * './' or '/' before the name. The EPUB container format does not permit '\' in a file name,
 * so it can only be a separator.
 */
function containerPath(name: string): string {
    return name.replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '')
}

function foldPath(path: string): string {
    return path.normalize('NFC').toLowerCase()
}

/** Offset of the entry data from the start of its local file header. */
function dataStartOf(header: Uint8Array): number {
    if (header.length < LOCAL_HEADER_SIZE) throw damaged()
    const view = viewOf(header)
    if (view.getUint32(0, true) !== LOCAL_SIGNATURE) throw damaged()
    return LOCAL_HEADER_SIZE + view.getUint16(26, true) + view.getUint16(28, true)
}

function assertReadable(entry: ZipEntry): void {
    if (entry.flags & FLAG_ENCRYPTED) {
        throw new EpubError('drm', `The file is encrypted: ${entry.path}`)
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
        throw new EpubError(
            'unsupported-compression',
            `The file uses a compression method that is not supported (${entry.method}): ${entry.path}`,
        )
    }
    if (entry.method === METHOD_DEFLATE && entry.size > MAX_INFLATED_SIZE) {
        throw new EpubError(
            'unsupported-compression',
            `The file is too large to decompress: ${entry.path}`,
        )
    }
}

/**
 * A queue that starts the tasks in the sequence of the calls and runs not more than `limit`
 * of them at the same time.
 */
function createQueue(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0
    const waiting: (() => void)[] = []

    return async (task) => {
        if (active < limit) active++
        // The task that ends gives its place to this task, so `active` does not change.
        else await new Promise<void>((resolve) => waiting.push(resolve))
        try {
            return await task()
        } finally {
            const next = waiting.shift()
            if (next) next()
            else active--
        }
    }
}

async function inflate(
    data: Uint8Array<ArrayBuffer>,
    expectedSize: number,
): Promise<Uint8Array<ArrayBuffer>> {
    if (typeof DecompressionStream === 'undefined') {
        throw new EpubError('unsupported-compression', 'This browser cannot decompress the file.')
    }

    // Small input chunks keep each decompression step short and let the output drain.
    let position = 0
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
            if (position >= data.length) {
                controller.close()
                return
            }
            controller.enqueue(data.subarray(position, position + INFLATE_CHUNK_SIZE))
            position += INFLATE_CHUNK_SIZE
        },
    })

    try {
        const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
        // The size in the directory is the limit. It can be too large in a damaged archive,
        // so the buffer is never larger than the data can become.
        const output = new Uint8Array(Math.min(expectedSize, data.length * MAX_DEFLATE_RATIO))
        let length = 0
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (length + value.length > output.length) {
                // More data than the directory states. The archive is damaged or hostile.
                void reader.cancel().catch(() => {})
                throw damaged()
            }
            output.set(value, length)
            length += value.length
        }
        return length === output.length ? output : output.slice(0, length)
    } catch {
        throw damaged()
    }
}
