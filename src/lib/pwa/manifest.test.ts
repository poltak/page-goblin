// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PUBLIC_DIR = new URL('../../../public/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', PUBLIC_DIR), 'utf8'))

/** Width and height from the header of a PNG file. */
function pngSize(file: string): { width: number; height: number } {
    const bytes = readFileSync(new URL(file, PUBLIC_DIR))
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('web app manifest', () => {
    // A project site on GitHub Pages is below a repository path.
    const manifestUrl = 'https://example.github.io/page-goblin/manifest.webmanifest'

    it('names an app that fills the screen', () => {
        expect(manifest).toMatchObject({
            name: 'Page Goblin',
            short_name: 'Page Goblin',
            // Android hides its status bar and its navigation bar for this mode. A page
            // cannot hide them or set the colour of the navigation bar for each theme. iOS
            // and the desktop browsers show the app as a standalone app.
            display: 'fullscreen',
            background_color: '#fbfaf8',
            theme_color: '#fbfaf8',
            lang: 'en',
            dir: 'ltr',
            categories: ['books', 'education'],
            launch_handler: { client_mode: 'focus-existing' },
        })
        expect(manifest.description).toEqual(expect.any(String))
    })

    it('starts at the app root for each repository path', () => {
        expect(new URL(manifest.start_url, manifestUrl).pathname).toBe('/page-goblin/')
        expect(new URL(manifest.scope, manifestUrl).pathname).toBe('/page-goblin/')
        // A browser resolves `id` from the domain root, not from the manifest. Without the
        // field the identity is the start URL, which is different for each repository path.
        expect(manifest).not.toHaveProperty('id')
    })

    it('opens EPUB files at the app root', () => {
        expect(manifest.file_handlers).toEqual([
            { action: './', accept: { 'application/epub+zip': ['.epub'] } },
        ])
    })

    it('has icons with the declared sizes, with separate maskable files', () => {
        const icons = manifest.icons as Array<{
            src: string
            sizes: string
            type: string
            purpose: string
        }>

        expect(icons.map(({ sizes, purpose }) => `${purpose} ${sizes}`).sort()).toEqual([
            'any 192x192',
            'any 512x512',
            'maskable 192x192',
            'maskable 512x512',
        ])
        expect(new Set(icons.map((icon) => icon.src)).size).toBe(4)
        for (const icon of icons) {
            const size = Number(icon.sizes.split('x')[0])
            expect(icon.type).toBe('image/png')
            expect(pngSize(icon.src), icon.src).toEqual({ width: size, height: size })
        }
    })

    it('has an Apple touch icon of 180 pixels', () => {
        expect(pngSize('icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
    })
})
