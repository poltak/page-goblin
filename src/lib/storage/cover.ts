const MAX_WIDTH = 480
const MAX_HEIGHT = 720
const JPEG_QUALITY = 0.85
/** A cover that cannot be made smaller is kept only when it is below this size. */
const MAX_ORIGINAL_BYTES = 1.5 * 1024 * 1024

interface DrawOptions {
    bitmap: ImageBitmap
    width: number
    height: number
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function draw(context: Context2D, { bitmap, width, height }: DrawOptions): void {
    // JPEG has no transparency. Without this, clear pixels become black.
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
}

async function encode(options: DrawOptions): Promise<Blob | null> {
    const { width, height } = options

    if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(width, height)
        const context = canvas.getContext('2d')
        if (context) {
            draw(context, options)
            return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
        }
    }

    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    draw(context, options)
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
}

/**
 * Make a small JPEG of a cover image for the library view. The result fits in 480 by 720
 * pixels and keeps the aspect ratio. A small image is not made larger.
 *
 * When the browser cannot decode or encode the image, the result is the original image if it
 * is small, else null. This function does not reject.
 */
export async function makeCoverThumbnail(blob: Blob): Promise<Blob | null> {
    // An empty file is not a cover. The library view would show a broken image for it.
    const original = blob.size > 0 && blob.size < MAX_ORIGINAL_BYTES ? blob : null
    if (typeof createImageBitmap !== 'function') return original

    let bitmap: ImageBitmap | null = null
    try {
        bitmap = await createImageBitmap(blob)
        const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height)
        const thumbnail = await encode({
            bitmap,
            width: Math.max(1, Math.round(bitmap.width * scale)),
            height: Math.max(1, Math.round(bitmap.height * scale)),
        })
        return thumbnail ?? original
    } catch {
        return original
    } finally {
        bitmap?.close()
    }
}
