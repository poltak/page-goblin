// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    CONTENT_SECURITY_POLICY,
    createPrecacheManifest,
    injectContentSecurityPolicy,
    injectPrecacheManifest,
    isPrecached,
    pwaPlugin,
    spriteTag,
    wrapAsClassicScript,
} from './pwa-plugin.js'

describe('isPrecached', () => {
    it('takes the page, the code, the styles, the manifest and the icons', () => {
        for (const file of [
            'index.html',
            'assets/index-P2Xu9kJm.js',
            'assets/index-DkTr3x1Z.css',
            'assets/reader-engine-B4fK2m9Q.js',
            'assets/placeholder-Qw3rT6yU.svg',
            'theme-init.js',
            'manifest.webmanifest',
            'icons/favicon.svg',
            'icons/icon-192.png',
            'icons/apple-touch-icon.png',
        ]) {
            expect(isPrecached(file), file).toBe(true)
        }
    })

    it('leaves out fonts, source maps, books, the worker and other public files', () => {
        for (const file of [
            'sw.js',
            'assets/literata-latin-wght-normal-C8sHkM2a.woff2',
            'assets/opendyslexic-latin-400-normal-Dd4Ee5Ff.woff',
            'assets/mono-Ab3dE5gH.ttf',
            'assets/display-Ab3dE5gH.otf',
            'assets/index-P2Xu9kJm.js.map',
            'sample.epub',
            'books/Sample.EPUB',
            '.nojekyll',
            '.vite/manifest.json',
            'icons/.DS_Store',
            'robots.txt',
            '404.html',
            'screenshots/library.png',
        ]) {
            expect(isPrecached(file), file).toBe(false)
        }
    })
})

describe('createPrecacheManifest', () => {
    const contents = new Map<string, string | Uint8Array>([
        ['theme-init.js', 'theme'],
        ['index.html', '<html></html>'],
        ['assets/index-P2Xu9kJm.js', 'code'],
        ['assets/font-C8sHkM2a.woff2', new Uint8Array([1, 2, 3])],
        ['icons/icon-192.png', new Uint8Array([137, 80, 78, 71])],
        ['sw.js', 'worker'],
    ])

    it('lists the precached files in a fixed sequence with the page as "./"', () => {
        expect(createPrecacheManifest(contents).files).toEqual([
            './',
            'assets/index-P2Xu9kJm.js',
            'icons/icon-192.png',
            'theme-init.js',
        ])
    })

    it('gives the same short version for the same files in a different sequence', () => {
        const reversed = new Map([...contents].reverse())

        const { version } = createPrecacheManifest(contents)

        expect(version).toMatch(/^[0-9a-f]{12}$/)
        expect(createPrecacheManifest(reversed).version).toBe(version)
    })

    it('changes the version when a precached file changes', () => {
        const { version } = createPrecacheManifest(contents)

        const edited = new Map(contents).set('index.html', '<html lang="en"></html>')
        const renamed = new Map(contents)
        renamed.delete('assets/index-P2Xu9kJm.js')
        renamed.set('assets/index-Zz9Yy8Xx.js', 'code')

        expect(createPrecacheManifest(edited).version).not.toBe(version)
        expect(createPrecacheManifest(renamed).version).not.toBe(version)
    })

    it('keeps the version when only a file outside the list changes', () => {
        const { version } = createPrecacheManifest(contents)

        const otherFont = new Map(contents).set('assets/font-C8sHkM2a.woff2', new Uint8Array([9]))

        expect(createPrecacheManifest(otherFont).version).toBe(version)
    })
})

describe('injectPrecacheManifest', () => {
    const manifest = { version: 'abc123', files: ['./', 'assets/index-P2Xu9kJm.js'] }

    it('replaces the token with the manifest as an expression', () => {
        const code = injectPrecacheManifest('const m=self.__SW_MANIFEST,v=m.version;', manifest)

        expect(code).not.toContain('__SW_MANIFEST')
        expect(new Function(`${code}return m`)()).toEqual(manifest)
    })

    it('keeps a dollar sign in a file name', () => {
        // In a replacement text, "$&" and "$'" are patterns. They must stay plain text here.
        const special = { version: 'abc123', files: ['./', "icons/a$&b$'c$$d.png"] }

        const code = injectPrecacheManifest('const m=self.__SW_MANIFEST;', special)

        expect(new Function(`${code}return m`)()).toEqual(special)
    })

    it('fails when the worker has no token', () => {
        expect(() => injectPrecacheManifest('const m={}', manifest)).toThrow('__SW_MANIFEST')
    })
})

describe('wrapAsClassicScript', () => {
    it('keeps the declarations of the worker out of the global scope', () => {
        const context: Record<string, unknown> = { result: null }

        runInNewContext(wrapAsClassicScript('var top = 1\nfunction read() { return top }'), context)

        expect(Object.keys(context)).toEqual(['result'])
    })

    it('runs the code in strict mode, also after a last line that is a comment', () => {
        const context: Record<string, unknown> = { result: null }
        const code = 'result = (function () { return this })() === undefined\n//# comment'

        runInNewContext(wrapAsClassicScript(code), context)

        expect(context.result).toBe(true)
    })
})

describe('injectContentSecurityPolicy', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`

    it('stops scripts and requests that are not from the app itself', () => {
        expect(CONTENT_SECURITY_POLICY).toBe(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
                "img-src 'self' blob: data:; font-src 'self' blob: data:; media-src 'self' blob:; " +
                "connect-src 'self' https://*.workers.dev; worker-src 'self'; object-src 'none'; base-uri 'self'; " +
                "form-action 'none'",
        )
    })

    it('puts the policy after the charset declaration and before the first script', () => {
        const html = [
            '<!doctype html>',
            '<html lang="en">',
            '    <head>',
            '        <meta charset="utf-8" />',
            '        <script src="./theme-init.js"></script>',
            '    </head>',
            '    <body></body>',
            '</html>',
        ].join('\n')

        const result = injectContentSecurityPolicy(html)

        expect(result.split('\n')).toEqual([
            '<!doctype html>',
            '<html lang="en">',
            '    <head>',
            '        <meta charset="utf-8" />',
            `        ${meta}`,
            '        <script src="./theme-init.js"></script>',
            '    </head>',
            '    <body></body>',
            '</html>',
        ])
    })

    it('puts the policy at the start of the head when a script comes before the charset', () => {
        const html = '<html><head><script src="a.js"></script><meta charset="utf-8"></head></html>'

        const result = injectContentSecurityPolicy(html)

        expect(result.indexOf(meta)).toBe(html.indexOf('<head>') + '<head>'.length)
        expect(result.indexOf(meta)).toBeLessThan(result.indexOf('<script'))
    })

    it('fails when the page has no head', () => {
        expect(() => injectContentSecurityPolicy('<html><body></body></html>')).toThrow('head')
    })
})

describe('spriteTag', () => {
    it('puts the symbols in a hidden svg element at the start of the body', () => {
        const sprite = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">',
            '    <symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12" /></symbol>',
            '    <symbol id="i-menu" viewBox="0 0 24 24"><svg><path d="M4 6h16" /></svg></symbol>',
            '</svg>',
            '',
        ].join('\n')

        expect(spriteTag(sprite)).toEqual({
            tag: 'svg',
            attrs: {
                xmlns: 'http://www.w3.org/2000/svg',
                style: 'display: none',
                'aria-hidden': 'true',
            },
            children: [
                '<symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12" /></symbol>',
                '    <symbol id="i-menu" viewBox="0 0 24 24"><svg><path d="M4 6h16" /></svg></symbol>',
            ].join('\n'),
            injectTo: 'body-prepend',
        })
    })

    it('accepts a comment and a doctype before the root element', () => {
        const sprite = [
            '<?xml version="1.0"?>',
            '<!-- Icons of the app. -->',
            '<!DOCTYPE svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="i-close"></symbol></svg>',
        ].join('\n')

        expect(spriteTag(sprite).children).toBe('<symbol id="i-close"></symbol>')
    })

    it('leaves out the comments, which only a developer reads', () => {
        const sprite = [
            '<svg xmlns="http://www.w3.org/2000/svg">',
            '    <!-- Use an icon with: <svg class="icon"><use href="#i-a" /></svg> -->',
            '    <symbol id="i-a"><path d="M4 6h16" /></symbol>',
            '    <!-- Second',
            '         group. -->',
            '    <symbol id="i-b"></symbol>',
            '</svg>',
        ].join('\n')

        const { children } = spriteTag(sprite)

        expect(children).not.toContain('<!--')
        expect(children).toContain('<symbol id="i-a"><path d="M4 6h16" /></symbol>')
        expect(children).toContain('<symbol id="i-b"></symbol>')
        expect(children).not.toContain('class="icon"')
    })

    it('accepts a file that has only symbols', () => {
        const symbols = '<symbol id="i-a"><svg><path /></svg></symbol>\n<symbol id="i-b"></symbol>'

        expect(spriteTag(`${symbols}\n`).children).toBe(symbols)
    })
})

describe('pwaPlugin', () => {
    const directories: string[] = []

    /** Makes the plugin for a project in a new empty directory. */
    async function setUp({ command, sprite }: { command: 'build' | 'serve'; sprite?: string }) {
        const root = await mkdtemp(path.join(tmpdir(), 'pwa-plugin-'))
        directories.push(root)
        if (sprite !== undefined) {
            await mkdir(path.join(root, 'src/ui'), { recursive: true })
            await writeFile(path.join(root, 'src/ui/icons.svg'), sprite)
        }
        const plugin = pwaPlugin()
        const hook = <T>(value: T) => value as Extract<T, (...args: never[]) => unknown>
        hook(plugin.configResolved)!.call(
            {} as never,
            {
                command,
                root,
                publicDir: path.join(root, 'public'),
                build: { assetsDir: 'assets', copyPublicDir: true },
            } as never,
        )
        const transform = (html: string) =>
            hook(plugin.transformIndexHtml)!.call({} as never, html, {} as never)
        return { root, plugin, transform, hook }
    }

    afterEach(async () => {
        await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })))
    })

    const html = '<html><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>'

    it('adds the policy in a build and not in the dev server', async () => {
        const build = await setUp({ command: 'build' })
        const serve = await setUp({ command: 'serve' })

        expect(await build.transform(html)).toEqual({
            html: expect.stringContaining('http-equiv="Content-Security-Policy"'),
            tags: [],
        })
        expect(await serve.transform(html)).toEqual({ html, tags: [] })
    })

    it('adds the icon sprite in a build and in the dev server when the file is there', async () => {
        const sprite = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="i-a"></symbol></svg>'
        const build = await setUp({ command: 'build', sprite })
        const serve = await setUp({ command: 'serve', sprite })
        const tag = expect.objectContaining({
            tag: 'svg',
            children: '<symbol id="i-a"></symbol>',
            injectTo: 'body-prepend',
        })

        expect(await build.transform(html)).toMatchObject({ tags: [tag] })
        expect(await serve.transform(html)).toEqual({ html, tags: [tag] })
    })

    it('reloads the page in the dev server when the sprite changes', async () => {
        const { root, plugin, hook } = await setUp({ command: 'serve' })
        const send = vi.fn()
        const context = (name: string) => ({ environment: { name, hot: { send } } }) as never
        const update = hook(plugin.hotUpdate)!

        expect(update.call(context('client'), { file: path.join(root, 'main.ts') } as never)).toBe(
            undefined,
        )
        expect(
            update.call(context('ssr'), { file: path.join(root, 'src/ui/icons.svg') } as never),
        ).toBe(undefined)
        expect(send).not.toHaveBeenCalled()

        expect(
            update.call(context('client'), { file: path.join(root, 'src/ui/icons.svg') } as never),
        ).toEqual([])
        expect(send).toHaveBeenCalledWith({ type: 'full-reload' })
    })

    it('gives the worker the list of the bundle files and the public files', async () => {
        const { root, plugin, hook } = await setUp({ command: 'build' })
        const publicFiles = {
            'manifest.webmanifest': '{}',
            'theme-init.js': 'theme',
            'sample.epub': 'book',
        }
        await mkdir(path.join(root, 'public/icons'), { recursive: true })
        await writeFile(path.join(root, 'public/icons/favicon.svg'), '<svg />')
        for (const [name, content] of Object.entries(publicFiles)) {
            await writeFile(path.join(root, 'public', name), content)
        }
        const worker = {
            type: 'chunk',
            code: 'const m=self.__SW_MANIFEST;',
            imports: [],
            dynamicImports: [],
            exports: [],
        }
        const bundle = {
            'sw.js': worker,
            'index.html': { type: 'asset', source: '<html></html>' },
            'assets/index-P2Xu9kJm.js': { type: 'chunk', code: 'code' },
            'assets/font-C8sHkM2a.woff2': { type: 'asset', source: new Uint8Array([1]) },
        }
        const generate = plugin.generateBundle as { handler: (...args: never[]) => Promise<void> }

        await generate.handler.call({ error: vi.fn() } as never, {} as never, bundle as never)

        expect(worker.code).not.toContain('__SW_MANIFEST')
        expect(JSON.parse(/\{"version".*\}(?=\);)/.exec(worker.code)![0])).toEqual({
            version: expect.stringMatching(/^[0-9a-f]{12}$/),
            files: [
                './',
                'assets/index-P2Xu9kJm.js',
                'icons/favicon.svg',
                'manifest.webmanifest',
                'theme-init.js',
            ],
        })
    })

    it('stops the build when the worker has an import', async () => {
        const { plugin } = await setUp({ command: 'build' })
        const bundle = {
            'sw.js': {
                type: 'chunk',
                code: 'import"./assets/shared-Ab3dE5gH.js";const m=self.__SW_MANIFEST;',
                imports: ['assets/shared-Ab3dE5gH.js'],
                dynamicImports: [],
                exports: [],
            },
        }
        const error = vi.fn((message: string) => {
            throw new Error(message)
        })
        const generate = plugin.generateBundle as { handler: (...args: never[]) => Promise<void> }

        await expect(
            generate.handler.call({ error } as never, {} as never, bundle as never),
        ).rejects.toThrow('no import')
    })
})
