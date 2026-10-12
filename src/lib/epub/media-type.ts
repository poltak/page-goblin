const MEDIA_TYPES = new Map([
    ['xhtml', 'application/xhtml+xml'],
    ['xht', 'application/xhtml+xml'],
    ['html', 'text/html'],
    ['htm', 'text/html'],
    ['css', 'text/css'],
    ['js', 'text/javascript'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['gif', 'image/gif'],
    ['svg', 'image/svg+xml'],
    ['webp', 'image/webp'],
    ['avif', 'image/avif'],
    ['bmp', 'image/bmp'],
    ['otf', 'font/otf'],
    ['ttf', 'font/ttf'],
    ['woff', 'font/woff'],
    ['woff2', 'font/woff2'],
    ['ncx', 'application/x-dtbncx+xml'],
    ['opf', 'application/oebps-package+xml'],
    ['xml', 'application/xml'],
    ['smil', 'application/smil+xml'],
    ['mp3', 'audio/mpeg'],
    ['m4a', 'audio/mp4'],
    ['mp4', 'video/mp4'],
    ['txt', 'text/plain'],
])

export const HTML_MEDIA_TYPES: ReadonlySet<string> = new Set(['application/xhtml+xml', 'text/html'])

/** The media type for the file extension of a path, or null. */
export function mediaTypeFromPath(path: string): string | null {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    return MEDIA_TYPES.get(extension) ?? null
}
