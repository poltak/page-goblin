import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EpubBook } from '$lib/epub/types'
import { createFakeBook } from '$lib/epub/testing/fake-book'
import { createResourceStore } from './resources'

function makeBook(): EpubBook {
    return createFakeBook({ files: { 'a.png': 'a', 'b.png': 'b' }, spine: [] })
}

let created: string[]
let revoked: string[]

beforeEach(() => {
    created = []
    revoked = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        const url = `blob:test/${created.length + 1}`
        created.push(url)
        return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
        revoked.push(url)
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('createResourceStore', () => {
    it('gives an object URL for a file of the book', async () => {
        const book = makeBook()
        const readBlob = vi.spyOn(book, 'readBlob')
        const store = createResourceStore(book)

        expect(await store.acquire('a.png')).toBe('blob:test/1')
        expect(readBlob).toHaveBeenCalledWith('a.png')
        expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toBeInstanceOf(Blob)
    })

    it('shares one read between concurrent calls', async () => {
        const book = makeBook()
        const readBlob = vi.spyOn(book, 'readBlob')
        const store = createResourceStore(book)

        const first = store.acquire('a.png')
        const second = store.acquire('a.png')

        expect(second).toBe(first)
        expect(await Promise.all([first, second])).toEqual(['blob:test/1', 'blob:test/1'])
        expect(readBlob).toHaveBeenCalledTimes(1)
    })

    it('gives the same URL for a later call and a different URL for a different file', async () => {
        const store = createResourceStore(makeBook())

        expect(await store.acquire('a.png')).toBe('blob:test/1')
        expect(await store.acquire('a.png')).toBe('blob:test/1')
        expect(await store.acquire('b.png')).toBe('blob:test/2')
        expect(created).toHaveLength(2)
    })

    it('revokes the URL when the count is 0', async () => {
        const store = createResourceStore(makeBook())
        await store.acquire('a.png')
        await store.acquire('a.png')

        store.release('a.png')
        expect(revoked).toEqual([])

        store.release('a.png')
        expect(revoked).toEqual(['blob:test/1'])

        store.release('a.png')
        expect(revoked).toEqual(['blob:test/1'])
    })

    it('reads the file again after the URL was revoked', async () => {
        const store = createResourceStore(makeBook())
        await store.acquire('a.png')
        store.release('a.png')

        expect(await store.acquire('a.png')).toBe('blob:test/2')
    })

    it('revokes the URL of a file that was released during the read', async () => {
        const store = createResourceStore(makeBook())

        const pending = store.acquire('a.png')
        store.release('a.png')
        await pending

        expect(revoked).toEqual(['blob:test/1'])
    })

    it('ignores a release for a path that it does not have', () => {
        const store = createResourceStore(makeBook())

        expect(() => store.release('missing.png')).not.toThrow()
        expect(revoked).toEqual([])
    })

    it('rejects for a missing file and tries again on the next call', async () => {
        const book = makeBook()
        const readBlob = vi.spyOn(book, 'readBlob')
        const store = createResourceStore(book)

        await expect(store.acquire('missing.png')).rejects.toThrow()
        await expect(store.acquire('missing.png')).rejects.toThrow()

        expect(readBlob).toHaveBeenCalledTimes(2)
        expect(created).toEqual([])
    })

    it('revokes all URLs on dispose and rejects later calls', async () => {
        const store = createResourceStore(makeBook())
        await store.acquire('a.png')
        await store.acquire('b.png')
        const late = store.acquire('a.png')

        store.dispose()

        expect(revoked.sort()).toEqual(['blob:test/1', 'blob:test/2'])
        await expect(late).resolves.toBe('blob:test/1')
        await expect(store.acquire('a.png')).rejects.toThrow('disposed')
    })

    describe('media types', () => {
        /** A book that gives each file the media type of the test. */
        function typedBook(types: Record<string, string>): EpubBook {
            const files = Object.fromEntries(Object.keys(types).map((path) => [path, '<x/>']))
            const book = createFakeBook({ files, spine: [] })
            book.readBlob = async (path) => new Blob(['<x/>'], { type: types[path] })
            return book
        }

        function blobTypes(): string[] {
            return vi.mocked(URL.createObjectURL).mock.calls.map((call) => (call[0] as Blob).type)
        }

        it('keeps the type of images, fonts, audio and video', async () => {
            const types = {
                'a.png': 'image/png',
                'a.woff2': 'font/woff2',
                'a.mp3': 'audio/mpeg',
                'a.mp4': 'video/mp4',
            }
            const store = createResourceStore(typedBook(types))

            for (const path of Object.keys(types)) await store.acquire(path)

            expect(blobTypes()).toEqual(Object.values(types))
        })

        it('gives a type that a browser does not open as a document to all other files', async () => {
            // A blob URL has the origin of the app. A file of the book with a document type
            // would run its scripts there when the user opens the URL in a tab.
            const types = {
                'a.xhtml': 'application/xhtml+xml',
                'a.html': 'text/html',
                'a.xml': 'application/xml',
                'b.xml': 'text/xml; charset=utf-8',
                'a.ncx': 'application/x-dtbncx+xml',
                'a.bin': '',
                'a.txt': 'text/plain',
                'a.js': 'text/javascript',
                'a.pdf': 'application/pdf',
                'a.otf': 'application/vnd.ms-opentype',
                'b.png': 'image/x-evil+xml',
                'c.png': 'image/png, text/html',
            }
            const store = createResourceStore(typedBook(types))

            for (const path of Object.keys(types)) {
                expect(await store.acquire(path)).toMatch(/^blob:test\//)
            }

            expect(new Set(blobTypes())).toEqual(new Set(['application/octet-stream']))
            const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
            expect(await blob.text()).toBe('<x/>')
        })

        it('gives a data URL for an SVG file', async () => {
            const types = { 'a.svg': 'image/svg+xml', 'b.svg': 'IMAGE/SVG+XML; charset=utf-8' }
            const store = createResourceStore(typedBook(types))

            const first = store.acquire('a.svg')
            expect(store.acquire('a.svg')).toBe(first)
            const url = await first

            // A data URL has no origin, so a script in the file cannot read the library.
            expect(url).toBe(`data:image/svg+xml;base64,${btoa('<x/>')}`)
            expect(await store.acquire('b.svg')).toBe(url)
            expect(created).toEqual([])

            store.release('a.svg')
            store.release('a.svg')
            store.release('b.svg')
            store.dispose()
            expect(revoked).toEqual([])
        })
    })

    it('revokes the URL of a read that ends after dispose', async () => {
        const store = createResourceStore(makeBook())

        const pending = store.acquire('a.png')
        store.dispose()
        await pending

        expect(revoked).toEqual(['blob:test/1'])
    })
})
