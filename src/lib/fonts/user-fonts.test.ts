import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FontRecord, NewFont } from '$lib/storage/types'
import { FONT_LOAD_LIMIT_MS } from './catalog'
import { createUserFonts, userFontsFor } from './user-fonts'
import type { UserFontSource } from './user-fonts'

function makeFont(id: string, changes: Partial<FontRecord> = {}): FontRecord {
    return {
        id,
        name: `Font ${id}`,
        fallback: 'serif',
        faces: [
            {
                hash: `${id}-regular`,
                format: 'truetype',
                weight: '400',
                style: 'normal',
                stretch: '100%',
                size: 10,
            },
            {
                hash: `${id}-italic`,
                format: 'opentype',
                weight: '100 900',
                style: 'italic',
                stretch: '100%',
                size: 10,
            },
        ],
        addedAt: 1,
        updatedAt: 1,
        ...changes,
    }
}

class FakeFontFace {
    readonly loaded = Promise.resolve(this)

    constructor(
        readonly family: string,
        readonly source: string,
        readonly descriptors: FontFaceDescriptors,
    ) {}
}

function makeSource(fonts: FontRecord[]) {
    const state = { fonts }
    const source = {
        listFonts: vi.fn(async () => state.fonts),
        getFontFile: vi.fn(
            async (hash: string): Promise<Blob | undefined> =>
                new Blob([hash], { type: 'font/ttf' }),
        ),
        putFont: vi.fn(async ({ record }: NewFont) => {
            state.fonts = [...state.fonts.filter((font) => font.id !== record.id), record]
        }),
        deleteFont: vi.fn(async (id: string) => {
            state.fonts = state.fonts.filter((font) => font.id !== id)
        }),
    } satisfies UserFontSource
    return { source, state }
}

let pageFaces: Set<FakeFontFace>
let fontsLoad: ReturnType<typeof vi.fn<(font: string) => Promise<unknown>>>
let urlCount: number
let revoked: string[]

beforeEach(() => {
    pageFaces = new Set()
    fontsLoad = vi.fn<(font: string) => Promise<unknown>>(async () => [])
    urlCount = 0
    revoked = []
    vi.stubGlobal('FontFace', FakeFontFace)
    Object.defineProperty(document, 'fonts', {
        value: {
            add: (face: FakeFontFace) => pageFaces.add(face),
            delete: (face: FakeFontFace) => pageFaces.delete(face),
            load: fontsLoad,
        },
        configurable: true,
    })
    Object.defineProperty(URL, 'createObjectURL', {
        value: () => `blob:test/${++urlCount}`,
        configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
        value: (url: string) => revoked.push(url),
        configurable: true,
    })
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'fonts')
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
})

describe('createUserFonts', () => {
    it('has an empty list before the first read', () => {
        const { source } = makeSource([makeFont('a')])
        expect(createUserFonts(source).list).toEqual([])
    })

    it('reads the list sorted by name and tells the listeners about a change', async () => {
        const { source, state } = makeSource([makeFont('b', { name: 'Zed' }), makeFont('a')])
        const fonts = createUserFonts(source)
        const listener = vi.fn()
        fonts.subscribe(listener)

        await fonts.refresh()
        expect(fonts.list.map((font) => font.name)).toEqual(['Font a', 'Zed'])
        expect(listener).toHaveBeenCalledOnce()

        await fonts.refresh()
        expect(listener).toHaveBeenCalledOnce()

        state.fonts = [makeFont('a')]
        await fonts.refresh()
        expect(listener).toHaveBeenCalledTimes(2)
        expect(listener).toHaveBeenLastCalledWith(fonts.list)
    })

    it('reads again after a read that a call met on its way', async () => {
        const { source, state } = makeSource([])
        const fonts = createUserFonts(source)
        const first = fonts.refresh()
        state.fonts = [makeFont('a')]
        const second = fonts.refresh()

        expect(second).toBe(first)
        await second
        expect(source.listFonts).toHaveBeenCalledTimes(2)
        expect(fonts.list.map((font) => font.id)).toEqual(['a'])
    })

    it('keeps the list when the storage fails, and does not reject', async () => {
        const { source } = makeSource([makeFont('a')])
        const fonts = createUserFonts(source)
        await fonts.refresh()
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        source.listFonts.mockRejectedValueOnce(new Error('no storage'))

        await expect(fonts.refresh()).resolves.toBeUndefined()
        expect(fonts.list).toHaveLength(1)
        expect(error).toHaveBeenCalledOnce()
    })

    it('stops calling a listener that it removed', async () => {
        const { source } = makeSource([makeFont('a')])
        const fonts = createUserFonts(source)
        const listener = vi.fn()
        fonts.subscribe(listener)()
        await fonts.refresh()
        expect(listener).not.toHaveBeenCalled()
    })

    describe('ensureLoaded', () => {
        it('adds each face with a blob URL and waits for the regular face', async () => {
            const { source } = makeSource([makeFont('a')])
            const fonts = createUserFonts(source)

            await fonts.ensureLoaded('user:a')

            expect([...pageFaces]).toEqual([
                {
                    family: 'pg-font-a',
                    source: 'url("blob:test/1") format("truetype")',
                    descriptors: { weight: '400', style: 'normal', stretch: '100%' },
                    loaded: expect.any(Promise),
                },
                {
                    family: 'pg-font-a',
                    source: 'url("blob:test/2") format("opentype")',
                    descriptors: { weight: '100 900', style: 'italic', stretch: '100%' },
                    loaded: expect.any(Promise),
                },
            ])
            expect(source.getFontFile.mock.calls).toEqual([['a-regular'], ['a-italic']])
            expect(fontsLoad).toHaveBeenCalledWith('1em "pg-font-a"')
        })

        it('adds the faces of a family one time', async () => {
            const { source } = makeSource([makeFont('a')])
            const fonts = createUserFonts(source)
            await Promise.all([fonts.ensureLoaded('user:a'), fonts.ensureLoaded('user:a')])
            await fonts.ensureLoaded('user:a')

            expect(pageFaces.size).toBe(2)
            expect(source.getFontFile).toHaveBeenCalledTimes(2)
        })

        it('removes the faces of a family that left the list', async () => {
            const { source, state } = makeSource([makeFont('a'), makeFont('b')])
            const fonts = createUserFonts(source)
            await fonts.ensureLoaded('user:a')
            await fonts.ensureLoaded('user:b')

            state.fonts = [makeFont('b')]
            await fonts.refresh()

            expect([...pageFaces].map((face) => face.family)).toEqual(['pg-font-b', 'pg-font-b'])
            expect(revoked).toEqual(['blob:test/1', 'blob:test/2'])
        })

        it('gives a changed family new faces at its next load', async () => {
            const { source, state } = makeSource([makeFont('a')])
            const fonts = createUserFonts(source)
            await fonts.ensureLoaded('user:a')

            const changed = makeFont('a')
            changed.faces = [{ ...changed.faces[0], hash: 'new-regular' }]
            state.fonts = [changed]
            await fonts.refresh()
            expect(pageFaces.size).toBe(0)

            await fonts.ensureLoaded('user:a')
            expect([...pageFaces].map((face) => face.source)).toEqual([
                'url("blob:test/3") format("truetype")',
            ])
        })

        it('keeps the faces when only the name of a family changes', async () => {
            const { source, state } = makeSource([makeFont('a')])
            const fonts = createUserFonts(source)
            await fonts.ensureLoaded('user:a')

            state.fonts = [makeFont('a', { name: 'Renamed' })]
            await fonts.refresh()

            expect(pageFaces.size).toBe(2)
            expect(revoked).toEqual([])
        })

        it('reads the list again for a family that it does not know', async () => {
            const { source, state } = makeSource([])
            const fonts = createUserFonts(source)
            await fonts.refresh()

            state.fonts = [makeFont('a')]
            await fonts.ensureLoaded('user:a')
            expect(pageFaces.size).toBe(2)

            await fonts.ensureLoaded('user:gone')
            expect(source.listFonts).toHaveBeenCalledTimes(3)
            expect(pageFaces.size).toBe(2)
        })

        it('leaves out a face whose file is not there', async () => {
            const { source } = makeSource([makeFont('a')])
            source.getFontFile.mockResolvedValueOnce(undefined)
            const fonts = createUserFonts(source)

            await fonts.ensureLoaded('user:a')
            expect([...pageFaces].map((face) => face.descriptors.style)).toEqual(['italic'])
        })

        it('loads a font that is not a font of the user as ensureFontLoaded does', async () => {
            const { source } = makeSource([])
            const fonts = createUserFonts(source)

            await fonts.ensureLoaded('book:Minion Pro')
            await fonts.ensureLoaded('publisher')

            expect(fontsLoad.mock.calls).toEqual([['1em "Minion Pro"']])
            expect(source.listFonts).not.toHaveBeenCalled()
        })

        it('stops the wait after the time limit', async () => {
            vi.useFakeTimers()
            fontsLoad.mockReturnValue(new Promise(() => {}))
            const { source } = makeSource([makeFont('a')])
            const fonts = createUserFonts(source)
            let done = false
            void fonts.ensureLoaded('user:a').then(() => {
                done = true
            })

            await vi.advanceTimersByTimeAsync(FONT_LOAD_LIMIT_MS - 1)
            expect(done).toBe(false)
            await vi.advanceTimersByTimeAsync(1)
            expect(done).toBe(true)
        })

        it('does nothing in a page with no font API', async () => {
            vi.stubGlobal('FontFace', undefined)
            const { source } = makeSource([makeFont('a')])
            const fonts = createUserFonts(source)

            await fonts.ensureLoaded('user:a')
            expect(source.getFontFile).not.toHaveBeenCalled()
        })
    })
})

describe('writes', () => {
    it('saves families and reads the list again', async () => {
        const { source } = makeSource([])
        const fonts = createUserFonts(source)
        const listener = vi.fn()
        fonts.subscribe(listener)
        const font = { record: makeFont('a'), files: new Map() }

        await fonts.save([font, { record: makeFont('b'), files: new Map() }])

        expect(source.putFont.mock.calls).toEqual([[font], [expect.anything()]])
        expect(fonts.list.map((record) => record.id)).toEqual(['a', 'b'])
        expect(listener).toHaveBeenCalledOnce()
    })

    it('reads the list again also when a save fails', async () => {
        const { source, state } = makeSource([])
        const fonts = createUserFonts(source)
        source.putFont.mockImplementationOnce(async () => {
            state.fonts = [makeFont('partly')]
            throw new Error('disk full')
        })

        await expect(fonts.save([{ record: makeFont('a'), files: new Map() }])).rejects.toThrow(
            'disk full',
        )
        expect(fonts.list.map((record) => record.id)).toEqual(['partly'])
    })

    it('removes a family and gives a copy that puts it back', async () => {
        const { source } = makeSource([makeFont('a')])
        const fonts = createUserFonts(source)

        const removed = await fonts.remove('a')

        expect(source.deleteFont).toHaveBeenCalledWith('a')
        expect(fonts.list).toEqual([])
        expect(removed?.record).toEqual(makeFont('a'))
        expect([...removed!.files.keys()]).toEqual(['a-regular', 'a-italic'])
        expect(await removed!.files.get('a-italic')!.text()).toBe('a-italic')

        await fonts.save([removed!])
        expect(fonts.list).toEqual([makeFont('a')])
    })

    it('gives null for a family that is not there', async () => {
        const { source } = makeSource([])
        expect(await createUserFonts(source).remove('a')).toBeNull()
        expect(source.deleteFont).not.toHaveBeenCalled()
    })
})

describe('userFontsFor', () => {
    it('gives one registry for each storage', () => {
        const { source } = makeSource([])
        const { source: other } = makeSource([])
        expect(userFontsFor(source)).toBe(userFontsFor(source))
        expect(userFontsFor(other)).not.toBe(userFontsFor(source))
    })
})
