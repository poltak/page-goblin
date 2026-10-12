import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCoverStore } from './covers'

const image = new Blob(['image bytes'], { type: 'image/jpeg' })

let created: string[]
let revoked: string[]

beforeEach(() => {
    created = []
    revoked = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        const url = `blob:cover-${created.length + 1}`
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

describe('createCoverStore', () => {
    it('makes an object URL from the cover in storage', async () => {
        const getCover = vi.fn(async () => image)
        const covers = createCoverStore({ getCover })

        expect(await covers.url('b1')).toBe('blob:cover-1')
        expect(getCover).toHaveBeenCalledWith('b1')
    })

    it('reads each cover one time and gives the same URL again', async () => {
        const getCover = vi.fn(async () => image)
        const covers = createCoverStore({ getCover })

        const [first, second] = await Promise.all([covers.url('b1'), covers.url('b1')])
        const third = await covers.url('b1')

        expect(first).toBe(second)
        expect(third).toBe(first)
        expect(getCover).toHaveBeenCalledTimes(1)
        expect(created).toHaveLength(1)
    })

    it('gives null for a book with no cover in storage', async () => {
        const covers = createCoverStore({ getCover: async () => undefined })

        expect(await covers.url('b1')).toBeNull()
        expect(created).toHaveLength(0)
    })

    it('gives null when the read fails', async () => {
        const covers = createCoverStore({
            getCover: async () => {
                throw new Error('The database is closed.')
            },
        })

        expect(await covers.url('b1')).toBeNull()
    })

    it('revokes the URL when the book leaves the library', async () => {
        const covers = createCoverStore({ getCover: async () => image })
        const url = await covers.url('b1')

        covers.release('b1')
        await Promise.resolve()

        expect(revoked).toEqual([url])
    })

    it('revokes a URL that is still on its way at the release', async () => {
        const covers = createCoverStore({ getCover: async () => image })
        const pending = covers.url('b1')

        covers.release('b1')
        await pending
        await Promise.resolve()

        expect(revoked).toEqual(['blob:cover-1'])
    })

    it('makes a new URL after a release', async () => {
        const covers = createCoverStore({ getCover: async () => image })
        await covers.url('b1')
        covers.release('b1')

        expect(await covers.url('b1')).toBe('blob:cover-2')
    })

    it('does nothing for a release of a book with no URL', () => {
        const covers = createCoverStore({ getCover: async () => image })

        covers.release('never-seen')

        expect(revoked).toEqual([])
    })
})
