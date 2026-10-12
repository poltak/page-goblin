import { afterEach, describe, expect, it, vi } from 'vitest'
import { noiseBytes, recordReads } from './testing/recording-blob'
import { crc32, createZip } from './testing/zip-writer'
import { openZip, readBlobBytes, type ZipArchive } from './zip'

const decoder = new TextDecoder()

afterEach(() => {
    vi.unstubAllGlobals()
})

async function readString(archive: ZipArchive, path: string): Promise<string> {
    const entry = archive.find(path)
    if (!entry) throw new Error(`No entry: ${path}`)
    return decoder.decode(await archive.read(entry))
}

/** An extra field with an unknown header id and `length` bytes in total. */
function extraField(length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length)
    new DataView(bytes.buffer).setUint16(0, 0xcafe, true)
    new DataView(bytes.buffer).setUint16(2, length - 4, true)
    return bytes
}

/** Offsets of two fields in a central directory header. */
const COMPRESSED_SIZE_FIELD = 20
const SIZE_FIELD = 24

/** A copy of an archive with a new value in a 32-bit field of its first directory header. */
async function patchDirectory(blob: Blob, field: number, value: number): Promise<Blob> {
    const bytes = await readBlobBytes(blob, 0, blob.size)
    const view = new DataView(bytes.buffer)
    const directoryOffset = view.getUint32(bytes.length - 22 + 16, true)
    view.setUint32(directoryOffset + field, value, true)
    return new Blob([bytes])
}

describe('zip writer', () => {
    it('calculates the standard CRC-32 check value', () => {
        expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    })

    it('writes the mimetype entry first and stored', async () => {
        const blob = await createZip({ 'a.txt': 'A', mimetype: 'application/epub+zip' })
        const head = decoder.decode(await readBlobBytes(blob, 0, 58))
        expect(head.slice(30)).toBe('mimetypeapplication/epub+zip')
        const archive = await openZip(blob)
        expect([...archive.entries.keys()]).toEqual(['mimetype', 'a.txt'])
        expect(archive.find('mimetype')?.method).toBe(0)
    })
})

describe('openZip', () => {
    it('reads stored and deflated entries', async () => {
        const text = 'Hello, world. '.repeat(100)
        const archive = await openZip(
            await createZip([
                { path: 'stored.txt', data: text, compress: false },
                { path: 'dir/deflated.txt', data: text },
                { path: 'empty.txt', data: '' },
            ]),
        )

        expect(archive.find('stored.txt')).toMatchObject({ method: 0, size: text.length })
        expect(archive.find('dir/deflated.txt')).toMatchObject({ method: 8, size: text.length })
        expect(archive.find('dir/deflated.txt')!.compressedSize).toBeLessThan(text.length)
        expect(await readString(archive, 'stored.txt')).toBe(text)
        expect(await readString(archive, 'dir/deflated.txt')).toBe(text)
        expect(await readString(archive, 'empty.txt')).toBe('')
        // A second read uses the data offset from the first read.
        expect(await readString(archive, 'stored.txt')).toBe(text)
        expect(await readString(archive, 'dir/deflated.txt')).toBe(text)
    })

    it('gives a stored entry a buffer of its own exact size', async () => {
        const archive = await openZip(
            await createZip([{ path: 'a.bin', data: noiseBytes(500), compress: false }]),
        )
        const bytes = await archive.read(archive.find('a.bin')!)
        expect(bytes.byteOffset).toBe(0)
        expect(bytes.buffer.byteLength).toBe(500)
    })

    it('reads an archive that has a comment', async () => {
        const archive = await openZip(
            await createZip({ 'a.txt': 'alpha' }, { comment: 'A comment. '.repeat(500) }),
        )
        expect(await readString(archive, 'a.txt')).toBe('alpha')
    })

    it('skips a false end record signature in the comment', async () => {
        const archive = await openZip(
            await createZip({ 'a.txt': 'alpha' }, { comment: 'PK\u0005\u0006 is not the end' }),
        )
        expect(await readString(archive, 'a.txt')).toBe('alpha')
    })

    it('decodes names that are not ASCII', async () => {
        const archive = await openZip(
            await createZip([
                { path: 'text/café ☕.xhtml', data: 'flagged' },
                // UTF-8 bytes with no UTF-8 flag, as Info-ZIP on Linux writes them.
                {
                    path: 'unused-1',
                    data: 'unflagged',
                    rawName: new TextEncoder().encode('日本語.xhtml'),
                },
                // "résumé.txt" in windows-1252.
                {
                    path: 'unused-2',
                    data: 'legacy',
                    rawName: Uint8Array.from([
                        0x72, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x2e, 0x74, 0x78, 0x74,
                    ]),
                },
            ]),
        )

        expect(await readString(archive, 'text/café ☕.xhtml')).toBe('flagged')
        expect(await readString(archive, '日本語.xhtml')).toBe('unflagged')
        expect(await readString(archive, 'résumé.txt')).toBe('legacy')
    })

    it('reads a 200 kB entry', async () => {
        const text = Array.from({ length: 12000 }, (_, index) => `Line number ${index}.\n`).join('')
        const noise = noiseBytes(200_000)
        expect(text.length).toBeGreaterThan(200_000)
        const archive = await openZip(
            await createZip([
                { path: 'big.txt', data: text },
                { path: 'noise-deflated.bin', data: noise },
                { path: 'noise-stored.bin', data: noise, compress: false },
            ]),
        )

        expect(await readString(archive, 'big.txt')).toBe(text)
        expect(await archive.read(archive.find('noise-deflated.bin')!)).toEqual(noise)
        expect(await archive.read(archive.find('noise-stored.bin')!)).toEqual(noise)
    })

    it('uses the lengths of the local header to find the data', async () => {
        const archive = await openZip(
            await createZip([
                // The local extra field is longer than the central one.
                { path: 'a.txt', data: 'alpha', localExtra: extraField(13) },
                // The local extra field is longer than the slack of the first read.
                { path: 'b.txt', data: 'beta '.repeat(50), localExtra: extraField(300) },
                { path: 'c.txt', data: 'gamma', compress: false, localExtra: extraField(300) },
                // The central extra field is longer than the local one.
                { path: 'd.txt', data: 'delta', centralExtra: extraField(40) },
            ]),
        )

        expect(await readString(archive, 'a.txt')).toBe('alpha')
        expect(await readString(archive, 'b.txt')).toBe('beta '.repeat(50))
        expect(await readString(archive, 'c.txt')).toBe('gamma')
        expect(await readString(archive, 'd.txt')).toBe('delta')
    })

    it('reads entries that have a data descriptor', async () => {
        const archive = await openZip(
            await createZip([
                { path: 'a.txt', data: 'alpha '.repeat(20), dataDescriptor: true },
                { path: 'b.txt', data: 'beta', compress: false, dataDescriptor: true },
            ]),
        )
        expect(await readString(archive, 'a.txt')).toBe('alpha '.repeat(20))
        expect(await readString(archive, 'b.txt')).toBe('beta')
    })

    it('reads a ZIP64 archive', async () => {
        const archive = await openZip(
            await createZip(
                [
                    { path: 'a.txt', data: 'alpha '.repeat(20) },
                    { path: 'b.txt', data: 'beta', compress: false },
                ],
                { zip64: true, comment: 'zip64' },
            ),
        )
        expect(archive.find('a.txt')).toMatchObject({ size: 120, method: 8 })
        expect(await readString(archive, 'a.txt')).toBe('alpha '.repeat(20))
        expect(await readString(archive, 'b.txt')).toBe('beta')
    })

    it('reads an archive that has other data before it', async () => {
        const archive = await openZip(
            await createZip({ 'a.txt': 'alpha', 'b.txt': 'beta' }, { prefix: noiseBytes(777) }),
        )
        expect(await readString(archive, 'a.txt')).toBe('alpha')
        expect(await readString(archive, 'b.txt')).toBe('beta')
    })

    it('reads the directory of a large archive with a second read', async () => {
        const source = await createZip([
            { path: 'first.txt', data: 'first' },
            { path: 'noise.bin', data: noiseBytes(100_000), compress: false },
            ...Array.from({ length: 1200 }, (_, index) => ({
                path: `text/a-long-file-name-for-chapter-number-${index}.xhtml`,
                data: `chapter ${index}`,
                compress: false,
            })),
        ])
        const recording = recordReads(source)
        const archive = await openZip(recording.blob)

        expect(recording.reads).toHaveLength(2)
        expect(archive.entries.size).toBe(1202)
        expect(await readString(archive, 'first.txt')).toBe('first')
        expect(
            await readString(archive, 'text/a-long-file-name-for-chapter-number-1199.xhtml'),
        ).toBe('chapter 1199')
    })

    it('opens a small archive with one read and reads an entry with one read', async () => {
        const recording = recordReads(
            await createZip([
                { path: 'a.bin', data: noiseBytes(300_000, 1), compress: false },
                { path: 'b.bin', data: noiseBytes(300_000, 2) },
                { path: 'c.txt', data: 'gamma' },
            ]),
        )
        const archive = await openZip(recording.blob)
        expect(recording.reads).toHaveLength(1)
        expect(recording.bytesRead()).toBeLessThan(70_000)

        await archive.read(archive.find('b.bin')!)
        expect(recording.reads).toHaveLength(2)
        const [start, end] = recording.reads[1]
        expect(end - start).toBeLessThan(archive.find('b.bin')!.compressedSize + 200)
    })

    it('finds a path with a different letter case or Unicode form', async () => {
        const archive = await openZip(
            await createZip({
                'OEBPS/images/Cover.JPG': 'image',
                'OEBPS/text/caf\u00e9.xhtml': 'text',
                'a.txt': 'lower',
                'A.txt': 'upper',
            }),
        )

        expect(archive.find('OEBPS/Images/cover.jpg')?.path).toBe('OEBPS/images/Cover.JPG')
        expect(archive.find('OEBPS/text/cafe\u0301.xhtml')?.path).toBe('OEBPS/text/caf\u00e9.xhtml')
        // An exact match has priority.
        expect(await readString(archive, 'A.txt')).toBe('upper')
        expect(await readString(archive, 'a.txt')).toBe('lower')
        expect(archive.find('missing.txt')).toBeUndefined()
    })

    it('leaves out directory entries', async () => {
        const archive = await openZip(
            await createZip([
                { path: 'OEBPS/', data: '', compress: false },
                { path: 'OEBPS/a.txt', data: 'alpha' },
            ]),
        )
        expect([...archive.entries.keys()]).toEqual(['OEBPS/a.txt'])
    })

    it('reads an empty entry that has the deflate method and no data', async () => {
        // Some tools write an empty file in this form.
        const archive = await openZip(
            await createZip([
                { path: 'empty.css', data: '', compress: false, methodOverride: 8 },
                { path: 'a.txt', data: 'alpha' },
            ]),
        )
        const entry = archive.find('empty.css')!
        expect(entry).toMatchObject({ method: 8, size: 0, compressedSize: 0 })
        expect(await archive.read(entry)).toHaveLength(0)
        const blob = await archive.readBlob(entry, 'text/css')
        expect(blob.size).toBe(0)
        expect(blob.type).toBe('text/css')
    })

    it('changes a backslash in a name to a slash', async () => {
        // Some Windows tools write the names in this form.
        const archive = await openZip(
            await createZip([
                { path: 'OEBPS\\', data: '', compress: false },
                { path: 'OEBPS\\text\\a.xhtml', data: 'alpha' },
            ]),
        )
        expect([...archive.entries.keys()]).toEqual(['OEBPS/text/a.xhtml'])
        expect(archive.find('OEBPS/text/a.xhtml')?.path).toBe('OEBPS/text/a.xhtml')
        expect(archive.find('oebps/TEXT/a.xhtml')?.path).toBe('OEBPS/text/a.xhtml')
        expect(await readString(archive, 'OEBPS/text/a.xhtml')).toBe('alpha')
    })

    it('removes a slash or a dot and a slash from the start of a name', async () => {
        const archive = await openZip(
            await createZip([
                { path: './META-INF/container.xml', data: 'alpha' },
                { path: '/OEBPS/content.opf', data: 'beta' },
                { path: '.hidden', data: 'gamma' },
                { path: '../outside.txt', data: 'delta' },
            ]),
        )
        expect([...archive.entries.keys()]).toEqual([
            'META-INF/container.xml',
            'OEBPS/content.opf',
            '.hidden',
            '../outside.txt',
        ])
        expect(await readString(archive, 'META-INF/container.xml')).toBe('alpha')
        expect(await readString(archive, 'OEBPS/content.opf')).toBe('beta')
    })

    it('gives a stored entry as a slice of the archive and a deflated entry as a new Blob', async () => {
        const noise = noiseBytes(5000)
        const recording = recordReads(
            await createZip([
                { path: 'stored.png', data: noise, compress: false, localExtra: extraField(100) },
                { path: 'deflated.png', data: noise },
            ]),
        )
        const archive = await openZip(recording.blob)
        const readsAtOpen = recording.reads.length

        const stored = await archive.readBlob(archive.find('stored.png')!, 'image/png')
        expect(stored.type).toBe('image/png')
        expect(stored.size).toBe(5000)
        // Only the local header of 30 bytes was read.
        expect(recording.reads.slice(readsAtOpen).map(([start, end]) => end - start)).toEqual([30])
        expect(await readBlobBytes(stored, 0, stored.size)).toEqual(noise)

        const deflated = await archive.readBlob(archive.find('deflated.png')!, 'image/png')
        expect(deflated.type).toBe('image/png')
        expect(await readBlobBytes(deflated, 0, deflated.size)).toEqual(noise)
    })

    it('rejects a file that is not a ZIP archive', async () => {
        const notZip = { name: 'EpubError', code: 'not-zip' }
        await expect(openZip(new Blob([]))).rejects.toMatchObject(notZip)
        await expect(openZip(new Blob(['This is a text file.']))).rejects.toMatchObject(notZip)
        await expect(openZip(new Blob([noiseBytes(100_000)]))).rejects.toMatchObject(notZip)
    })

    it('rejects a damaged directory', async () => {
        const blob = await createZip({ 'a.txt': 'alpha', 'b.txt': 'beta' })
        const bytes = await readBlobBytes(blob, 0, blob.size)
        const endIndex = bytes.length - 22
        const directoryOffset = new DataView(bytes.buffer).getUint32(endIndex + 16, true)

        const badSignature = bytes.slice()
        badSignature[directoryOffset] = 0
        await expect(openZip(new Blob([badSignature]))).rejects.toMatchObject({ code: 'not-zip' })

        const badOffset = bytes.slice()
        new DataView(badOffset.buffer).setUint32(endIndex + 16, bytes.length + 100, true)
        await expect(openZip(new Blob([badOffset]))).rejects.toMatchObject({ code: 'not-zip' })

        const badNameLength = bytes.slice()
        new DataView(badNameLength.buffer).setUint16(directoryOffset + 28, 60000, true)
        await expect(openZip(new Blob([badNameLength]))).rejects.toMatchObject({ code: 'not-zip' })
    })

    it('rejects an entry with a damaged local header or damaged data', async () => {
        const text = 'Some text that deflate makes smaller. '.repeat(40)
        const blob = await createZip([
            { path: 'a.txt', data: text },
            { path: 'b.txt', data: text },
        ])
        const bytes = await readBlobBytes(blob, 0, blob.size)
        // Entry a: destroy the deflate data. Entry b: destroy the local header signature.
        const secondHeader = (await openZip(blob)).find('b.txt')!.headerOffset
        bytes.fill(0xff, 40, 60)
        bytes[secondHeader] = 0

        const archive = await openZip(new Blob([bytes]))
        await expect(archive.read(archive.find('a.txt')!)).rejects.toMatchObject({
            name: 'EpubError',
            code: 'not-zip',
        })
        await expect(archive.read(archive.find('b.txt')!)).rejects.toMatchObject({
            code: 'not-zip',
        })
    })

    it('rejects each read of a stored entry that is longer than the file', async () => {
        const blob = await createZip([{ path: 'a.bin', data: noiseBytes(500), compress: false }])
        const archive = await openZip(await patchDirectory(blob, COMPRESSED_SIZE_FIELD, 5000))
        const entry = archive.find('a.bin')!
        const damaged = { name: 'EpubError', code: 'not-zip' }

        await expect(archive.read(entry)).rejects.toMatchObject(damaged)
        // The second read knows the data offset. It must not give a part of the data.
        await expect(archive.read(entry)).rejects.toMatchObject(damaged)
        await expect(archive.readBlob(entry, 'image/png')).rejects.toMatchObject(damaged)
    })

    it('rejects a deflated entry that has more data than the directory states', async () => {
        const text = 'Some text that deflate makes smaller. '.repeat(400)
        const blob = await createZip([{ path: 'a.txt', data: text }])
        const archive = await openZip(await patchDirectory(blob, SIZE_FIELD, 100))
        const entry = archive.find('a.txt')!
        const damaged = { name: 'EpubError', code: 'not-zip' }

        expect(entry.size).toBe(100)
        await expect(archive.read(entry)).rejects.toMatchObject(damaged)
        await expect(archive.readBlob(entry, 'text/plain')).rejects.toMatchObject(damaged)
    })

    it('reads a deflated entry that has less data than the directory states', async () => {
        const text = 'Some text that deflate makes smaller. '.repeat(400)
        const blob = await createZip([{ path: 'a.txt', data: text }])
        const archive = await openZip(await patchDirectory(blob, SIZE_FIELD, 1_000_000))

        const bytes = await archive.read(archive.find('a.txt')!)
        expect(bytes.buffer.byteLength).toBe(text.length)
        expect(decoder.decode(bytes)).toBe(text)
    })

    it('rejects a deflated entry whose stated size is above 96 MB', async () => {
        const limit = 96 * 1024 * 1024
        const text = 'alpha '.repeat(100)
        const blob = await createZip([{ path: 'a.txt', data: text }])
        const tooLarge = { name: 'EpubError', code: 'unsupported-compression' }

        const atLimit = await openZip(await patchDirectory(blob, SIZE_FIELD, limit))
        expect(await readString(atLimit, 'a.txt')).toBe(text)

        const archive = await openZip(await patchDirectory(blob, SIZE_FIELD, limit + 1))
        const entry = archive.find('a.txt')!
        await expect(archive.read(entry)).rejects.toMatchObject(tooLarge)
        await expect(archive.readBlob(entry, 'text/plain')).rejects.toMatchObject(tooLarge)
    })

    it('has no size limit for a stored entry, which is a part of the file', async () => {
        // The stated size has no effect. The read gives the bytes that are in the file.
        const blob = await createZip([{ path: 'a.bin', data: noiseBytes(500), compress: false }])
        const archive = await openZip(await patchDirectory(blob, SIZE_FIELD, 600 * 1024 * 1024))
        const entry = archive.find('a.bin')!

        expect(await archive.read(entry)).toEqual(noiseBytes(500))
        expect((await archive.readBlob(entry, 'image/png')).size).toBe(500)
    })

    it('rejects a compression method that is not stored or deflate', async () => {
        const archive = await openZip(
            await createZip([
                { path: 'bzip2.txt', data: 'alpha', compress: false, methodOverride: 12 },
                { path: 'ok.txt', data: 'beta' },
            ]),
        )
        const expected = { name: 'EpubError', code: 'unsupported-compression' }
        const entry = archive.find('bzip2.txt')!
        await expect(archive.read(entry)).rejects.toMatchObject(expected)
        await expect(archive.readBlob(entry, 'text/plain')).rejects.toMatchObject(expected)
        expect(await readString(archive, 'ok.txt')).toBe('beta')
    })

    it('rejects an encrypted entry', async () => {
        const archive = await openZip(
            await createZip([{ path: 'secret.txt', data: 'alpha', flags: 1 }]),
        )
        await expect(archive.read(archive.find('secret.txt')!)).rejects.toMatchObject({
            code: 'drm',
        })
    })
})

describe('openZip: reads at the same time', () => {
    const text = 'Some text that deflate makes smaller. '.repeat(40)

    /**
     * A DecompressionStream that gives no data and ends only when the test releases it.
     * `started` counts the streams, and `release` ends the oldest stream that is open.
     */
    function holdDecompression() {
        const releases: (() => void)[] = []
        const state = { started: 0, release: () => releases.shift()?.() }

        class HeldStream {
            readable: ReadableStream<Uint8Array>
            writable = new WritableStream<Uint8Array>()

            constructor() {
                state.started++
                const released = new Promise<void>((resolve) => releases.push(resolve))
                this.readable = new ReadableStream({
                    async start(controller) {
                        await released
                        controller.close()
                    },
                })
            }
        }
        vi.stubGlobal('DecompressionStream', HeldStream)
        return state
    }

    it('decompresses not more than three entries at the same time', async () => {
        const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
        const recording = recordReads(
            await createZip(names.map((name) => ({ path: `${name}.txt`, data: text }))),
        )
        const archive = await openZip(recording.blob)
        const readsAtOpen = recording.reads.length
        const held = holdDecompression()

        const entries = names.map((name) => archive.find(`${name}.txt`)!)
        let done = 0
        const reads = entries.map(async (entry, index) => {
            // The two functions that decompress use the same queue.
            await (index % 2 ? archive.readBlob(entry, 'text/plain') : archive.read(entry))
            done++
        })
        /** The header offset of each entry whose data was read, in the sequence of the reads. */
        const dataReads = () => recording.reads.slice(readsAtOpen).map(([start]) => start)
        const offsets = entries.map((entry) => entry.headerOffset)

        await vi.waitFor(() => expect(held.started).toBe(3))
        // An entry that waits has no data in memory, because its data is not read yet.
        expect(dataReads()).toEqual(offsets.slice(0, 3))

        // Each read that ends gives its place to the read that waited the longest time.
        for (let started = 4; started <= names.length; started++) {
            held.release()
            await vi.waitFor(() => expect(held.started).toBe(started))
            expect(dataReads()).toEqual(offsets.slice(0, started))
            expect(done).toBe(started - 3)
        }

        for (let count = 0; count < 3; count++) held.release()
        await Promise.all(reads)
        expect(done).toBe(names.length)
        expect(held.started).toBe(names.length)
    })

    it('reads a stored entry while three other entries are decompressed', async () => {
        const noise = noiseBytes(300)
        const archive = await openZip(
            await createZip([
                { path: 'a.txt', data: text },
                { path: 'b.txt', data: text },
                { path: 'c.txt', data: text },
                { path: 'stored.bin', data: noise, compress: false },
            ]),
        )
        const held = holdDecompression()
        const reads = ['a.txt', 'b.txt', 'c.txt'].map((path) => archive.read(archive.find(path)!))
        await vi.waitFor(() => expect(held.started).toBe(3))

        expect(await archive.read(archive.find('stored.bin')!)).toEqual(noise)
        expect((await archive.readBlob(archive.find('stored.bin')!, 'image/png')).size).toBe(300)

        for (let count = 0; count < 3; count++) held.release()
        await Promise.all(reads)
    })

    it('gives the place of a read that fails to the next read', async () => {
        const blob = await createZip([
            { path: 'bad.txt', data: 'Some text that deflate makes smaller. '.repeat(400) },
            { path: 'good.txt', data: text },
        ])
        // More data than the directory states, so each read of this entry fails.
        const archive = await openZip(await patchDirectory(blob, SIZE_FIELD, 100))
        const bad = archive.find('bad.txt')!
        const good = archive.find('good.txt')!

        const results = await Promise.allSettled([
            archive.read(bad),
            archive.readBlob(bad, 'text/plain'),
            archive.read(bad),
            archive.read(bad),
            archive.read(good),
            archive.readBlob(good, 'text/plain'),
        ])

        expect(results.map((result) => result.status)).toEqual([
            'rejected',
            'rejected',
            'rejected',
            'rejected',
            'fulfilled',
            'fulfilled',
        ])
        expect(await readString(archive, 'good.txt')).toBe(text)
    })

    it('gives each of many reads at the same time its own data', async () => {
        const files = Array.from({ length: 40 }, (_, index) => ({
            path: `file-${index}.txt`,
            data: `File ${index}. `.repeat(200 + index),
        }))
        const archive = await openZip(await createZip(files))

        const texts = await Promise.all(files.map((file) => readString(archive, file.path)))

        expect(texts).toEqual(files.map((file) => file.data))
    })

    it('has a queue of its own for each archive', async () => {
        const blob = await createZip([
            { path: 'a.txt', data: text },
            { path: 'b.txt', data: text },
            { path: 'c.txt', data: text },
        ])
        const first = await openZip(blob)
        const second = await openZip(blob)
        const held = holdDecompression()
        const paths = ['a.txt', 'b.txt', 'c.txt']

        const reads = [first, second].flatMap((archive) =>
            paths.map((path) => archive.read(archive.find(path)!)),
        )

        // A read that never ends in one book must not stop the reads of a different book.
        await vi.waitFor(() => expect(held.started).toBe(6))
        for (let count = 0; count < 6; count++) held.release()
        await Promise.all(reads)
    })
})

describe('readBlobBytes', () => {
    it('uses FileReader when the Blob has no arrayBuffer method', async () => {
        const source = new Blob([Uint8Array.from([1, 2, 3, 4, 5])])
        const legacy = {
            size: source.size,
            slice(start: number, end: number) {
                const part = source.slice(start, end)
                Object.defineProperty(part, 'arrayBuffer', { value: undefined })
                return part
            },
        } as unknown as Blob

        expect(await readBlobBytes(legacy, 1, 4)).toEqual(Uint8Array.from([2, 3, 4]))
    })
})
