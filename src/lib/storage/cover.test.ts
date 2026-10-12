import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCoverThumbnail } from './cover'

const SMALL_SIZE = 1000
const LARGE_SIZE = 2 * 1024 * 1024

interface FakeCanvasOptions {
    /** False makes getContext give null. */
    hasContext?: boolean
    /** The encoder result. An Error makes the encoder reject. */
    encoded?: Blob | Error
}

function makeImage(size: number): Blob {
    return new Blob([new Uint8Array(size)], { type: 'image/png' })
}

function stubBitmap(size: { width: number; height: number }) {
    const bitmap = { ...size, close: vi.fn() }
    const create = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', create)
    return { bitmap, create }
}

function stubOffscreenCanvas(options: FakeCanvasOptions = {}) {
    const encoded = options.encoded ?? new Blob(['jpeg'], { type: 'image/jpeg' })
    const context = {
        fillStyle: '',
        imageSmoothingQuality: '',
        fillRect: vi.fn(),
        drawImage: vi.fn(),
    }
    const convertToBlob = vi.fn(async () => {
        if (encoded instanceof Error) throw encoded
        return encoded
    })
    const sizes: { width: number; height: number }[] = []

    class FakeOffscreenCanvas {
        constructor(width: number, height: number) {
            sizes.push({ width, height })
        }
        getContext() {
            return options.hasContext === false ? null : context
        }
        convertToBlob = convertToBlob
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    return { encoded, context, convertToBlob, sizes }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('makeCoverThumbnail', () => {
    it('scales a large image down to fit in 480 by 720 and encodes it as JPEG', async () => {
        const { bitmap, create } = stubBitmap({ width: 1600, height: 2400 })
        const canvas = stubOffscreenCanvas()
        const image = makeImage(LARGE_SIZE)

        const thumbnail = await makeCoverThumbnail(image)

        expect(thumbnail).toBe(canvas.encoded)
        expect(create).toHaveBeenCalledWith(image)
        expect(canvas.sizes).toEqual([{ width: 480, height: 720 }])
        expect(canvas.context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 480, 720)
        expect(canvas.convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.85 })
        expect(bitmap.close).toHaveBeenCalledOnce()
    })

    it('paints a white background before the image', async () => {
        stubBitmap({ width: 480, height: 720 })
        const canvas = stubOffscreenCanvas()

        await makeCoverThumbnail(makeImage(SMALL_SIZE))

        expect(canvas.context.fillStyle).toBe('#fff')
        expect(canvas.context.fillRect).toHaveBeenCalledWith(0, 0, 480, 720)
        expect(canvas.context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(
            canvas.context.drawImage.mock.invocationCallOrder[0],
        )
    })

    it.each([
        { name: 'a wide image', width: 2000, height: 1000, expected: { width: 480, height: 240 } },
        { name: 'a tall image', width: 500, height: 3000, expected: { width: 120, height: 720 } },
        { name: 'a square image', width: 960, height: 960, expected: { width: 480, height: 480 } },
        { name: 'a thin line', width: 4000, height: 2, expected: { width: 480, height: 1 } },
    ])('keeps the aspect ratio of $name', async ({ width, height, expected }) => {
        stubBitmap({ width, height })
        const canvas = stubOffscreenCanvas()

        await makeCoverThumbnail(makeImage(SMALL_SIZE))

        expect(canvas.sizes).toEqual([expected])
    })

    it('does not make a small image larger', async () => {
        stubBitmap({ width: 200, height: 300 })
        const canvas = stubOffscreenCanvas()

        await makeCoverThumbnail(makeImage(SMALL_SIZE))

        expect(canvas.sizes).toEqual([{ width: 200, height: 300 }])
    })

    it('uses a canvas element when there is no OffscreenCanvas', async () => {
        const { bitmap } = stubBitmap({ width: 960, height: 1440 })
        const encoded = new Blob(['jpeg'], { type: 'image/jpeg' })
        const context = { fillRect: vi.fn(), drawImage: vi.fn() }
        const element = document.createElement('canvas')
        vi.spyOn(element, 'getContext').mockReturnValue(context as never)
        const toBlob = vi
            .spyOn(element, 'toBlob')
            .mockImplementation((callback) => callback(encoded))
        vi.spyOn(document, 'createElement').mockReturnValue(element)

        const thumbnail = await makeCoverThumbnail(makeImage(LARGE_SIZE))

        expect(thumbnail).toBe(encoded)
        expect(element.width).toBe(480)
        expect(element.height).toBe(720)
        expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 480, 720)
        expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85)
        expect(bitmap.close).toHaveBeenCalledOnce()
    })

    it('uses a canvas element when OffscreenCanvas has no 2D context', async () => {
        stubBitmap({ width: 960, height: 1440 })
        const offscreen = stubOffscreenCanvas({ hasContext: false })
        const encoded = new Blob(['jpeg'], { type: 'image/jpeg' })
        const element = document.createElement('canvas')
        vi.spyOn(element, 'getContext').mockReturnValue({
            fillRect: vi.fn(),
            drawImage: vi.fn(),
        } as never)
        vi.spyOn(element, 'toBlob').mockImplementation((callback) => callback(encoded))
        vi.spyOn(document, 'createElement').mockReturnValue(element)

        expect(await makeCoverThumbnail(makeImage(LARGE_SIZE))).toBe(encoded)
        expect(offscreen.convertToBlob).not.toHaveBeenCalled()
    })

    describe('when a step is not available or fails', () => {
        it('gives a small original when there is no createImageBitmap', async () => {
            // jsdom has no createImageBitmap.
            const image = makeImage(SMALL_SIZE)

            expect(await makeCoverThumbnail(image)).toBe(image)
        })

        it('gives null for a large original when there is no createImageBitmap', async () => {
            expect(await makeCoverThumbnail(makeImage(LARGE_SIZE))).toBeNull()
        })

        it('uses 1.5 MB as the limit for the original', async () => {
            const limit = 1.5 * 1024 * 1024
            const below = makeImage(limit - 1)

            expect(await makeCoverThumbnail(below)).toBe(below)
            expect(await makeCoverThumbnail(makeImage(limit))).toBeNull()
        })

        it('gives null for an image file that is empty', async () => {
            const empty = new Blob([], { type: 'image/png' })

            // The first call has no createImageBitmap. The second call has a decoder that fails.
            expect(await makeCoverThumbnail(empty)).toBeNull()
            vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('Not an image.')))
            expect(await makeCoverThumbnail(empty)).toBeNull()
        })

        it('gives the original when the image cannot be decoded', async () => {
            vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('Not an image.')))
            stubOffscreenCanvas()
            const image = makeImage(SMALL_SIZE)

            expect(await makeCoverThumbnail(image)).toBe(image)
            expect(await makeCoverThumbnail(makeImage(LARGE_SIZE))).toBeNull()
        })

        it('gives null for an SVG image that cannot be decoded', async () => {
            // An SVG file with a script. At its blob URL, a browser loads it as a document.
            const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
            const image = new Blob([svg], { type: 'image/svg+xml' })

            // The first call has no createImageBitmap. The second call has a decoder that fails.
            expect(await makeCoverThumbnail(image)).toBeNull()
            vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('Not an image.')))
            expect(await makeCoverThumbnail(image)).toBeNull()
        })

        it('gives the small JPEG of an SVG image that the browser can decode', async () => {
            stubBitmap({ width: 600, height: 900 })
            const canvas = stubOffscreenCanvas()
            const image = new Blob(['<svg/>'], { type: 'image/svg+xml' })

            expect(await makeCoverThumbnail(image)).toBe(canvas.encoded)
        })

        it('gives null for an SVG image when the encoder fails', async () => {
            stubBitmap({ width: 600, height: 900 })
            stubOffscreenCanvas({ encoded: new Error('Unable to encode.') })

            expect(
                await makeCoverThumbnail(new Blob(['<svg/>'], { type: 'image/svg+xml' })),
            ).toBeNull()
        })

        it.each([
            'image/svg+xml foo',
            'image/svg+xml;charset=utf-8',
            'text/html',
            'application/xhtml+xml',
            'application/octet-stream',
            '',
        ])('gives null for an original with the type "%s"', async (type) => {
            vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('Not an image.')))

            expect(await makeCoverThumbnail(new Blob(['data'], { type }))).toBeNull()
        })

        it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])(
            'keeps a small original with the type %s',
            async (type) => {
                vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('Not an image.')))
                const image = new Blob(['data'], { type })

                expect(await makeCoverThumbnail(image)).toBe(image)
            },
        )

        it('gives the original and closes the bitmap when the encoder fails', async () => {
            const { bitmap } = stubBitmap({ width: 1600, height: 2400 })
            stubOffscreenCanvas({ encoded: new Error('Unable to encode.') })
            const image = makeImage(SMALL_SIZE)

            expect(await makeCoverThumbnail(image)).toBe(image)
            expect(bitmap.close).toHaveBeenCalledOnce()
        })

        it('gives the original and closes the bitmap when no canvas has a context', async () => {
            const { bitmap } = stubBitmap({ width: 1600, height: 2400 })
            stubOffscreenCanvas({ hasContext: false })
            const element = document.createElement('canvas')
            vi.spyOn(element, 'getContext').mockReturnValue(null)
            vi.spyOn(document, 'createElement').mockReturnValue(element)
            const image = makeImage(SMALL_SIZE)

            expect(await makeCoverThumbnail(image)).toBe(image)
            expect(bitmap.close).toHaveBeenCalledOnce()
        })

        it('gives the original when the canvas element gives no blob', async () => {
            const { bitmap } = stubBitmap({ width: 1600, height: 2400 })
            const element = document.createElement('canvas')
            vi.spyOn(element, 'getContext').mockReturnValue({
                fillRect: vi.fn(),
                drawImage: vi.fn(),
            } as never)
            vi.spyOn(element, 'toBlob').mockImplementation((callback) => callback(null))
            vi.spyOn(document, 'createElement').mockReturnValue(element)
            const image = makeImage(SMALL_SIZE)

            expect(await makeCoverThumbnail(image)).toBe(image)
            expect(await makeCoverThumbnail(makeImage(LARGE_SIZE))).toBeNull()
            expect(bitmap.close).toHaveBeenCalledTimes(2)
        })
    })
})
