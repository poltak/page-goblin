import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { HtmlTagDescriptor, Plugin } from 'vite'
import type { PrecacheManifest } from '../src/service-worker.js'

// Books are not trusted. This policy stops scripts and remote requests even if the sanitiser
// of the book content misses something.
export const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' blob: data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
].join('; ')

const WORKER_SOURCE = 'src/service-worker.ts'
const WORKER_FILE = 'sw.js'
const MANIFEST_TOKEN = 'self.__SW_MANIFEST'
const SPRITE_SOURCE = 'src/ui/icons.svg'
const SHELL = './'
// The service worker has the same rule in src/service-worker.ts.
const FONT_FILE = /\.(?:woff2?|ttf|otf)$/i
const PRECACHED_TYPE = /\.(?:js|css|webmanifest)$/
const SPRITE_COMMENT = /\s*<!--[\s\S]*?-->/g
// An svg root element after an optional XML declaration and doctype.
const SPRITE_ROOT = /^(?:\s*<\?xml[^>]*\?>|\s*<!doctype[^>]*>)*\s*<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i

/**
 * True when the service worker must cache this output file at install. `file` is a path
 * relative to the output directory, with forward slashes.
 */
export function isPrecached(file: string): boolean {
    if (file === WORKER_FILE || file.endsWith('.map')) return false
    // The worker caches a font the first time a page uses it. A book never goes into the cache.
    if (FONT_FILE.test(file) || file.toLowerCase().endsWith('.epub')) return false
    if (file.split('/').some((part) => part.startsWith('.'))) return false
    if (file === 'index.html') return true
    // App code can import each file below assets/, so the app needs all of them with no network.
    if (file.startsWith('assets/') || file.startsWith('icons/')) return true
    return PRECACHED_TYPE.test(file)
}

/**
 * Makes the precache list and its version from the output files. The keys of `contents` are
 * paths relative to the output directory. Files that are not precached are ignored.
 */
export function createPrecacheManifest(
    contents: ReadonlyMap<string, string | Uint8Array>,
): PrecacheManifest {
    const names = [...contents.keys()].filter(isPrecached).sort()
    const hash = createHash('sha256')
    for (const name of names) {
        hash.update(name)
        hash.update('\0')
        hash.update(contents.get(name)!)
        hash.update('\0')
    }
    return {
        version: hash.digest('hex').slice(0, 12),
        files: names.map((name) => (name === 'index.html' ? SHELL : name)).sort(),
    }
}

/** Replaces the manifest token in the service worker code. */
export function injectPrecacheManifest(code: string, manifest: PrecacheManifest): string {
    if (!code.includes(MANIFEST_TOKEN)) {
        throw new Error(`${WORKER_FILE} does not contain the token ${MANIFEST_TOKEN}.`)
    }
    // A function, because a replacement text gives "$&" and "$'" in a file name a special meaning.
    return code.replaceAll(MANIFEST_TOKEN, () => `(${JSON.stringify(manifest)})`)
}

/**
 * The bundler writes module code. A browser loads sw.js as a classic script, so the code gets
 * its own scope and strict mode, which a module has by default.
 */
export function wrapAsClassicScript(code: string): string {
    return `(() => {\n'use strict'\n${code}\n})()\n`
}

/** Adds the policy to the head, before the first script. */
export function injectContentSecurityPolicy(html: string): string {
    const head = /<head[^>]*>/i.exec(html)
    if (!head) throw new Error('index.html has no head element.')
    const firstScript = html.search(/<script\b/i)
    const charset = /<meta\s+charset\b[^>]*>/i.exec(html)
    // The charset declaration stays first when it can.
    const anchor = charset && (firstScript === -1 || charset.index < firstScript) ? charset : head
    const position = anchor.index + anchor[0].length
    if (firstScript !== -1 && firstScript < position) {
        throw new Error('index.html has a script before the head element.')
    }
    // The new tag gets its own line when the page has one tag for each line.
    const lineStart = /\n[ \t]*$/.exec(html.slice(0, anchor.index))?.[0] ?? ''
    const separator = lineStart && anchor === head ? `${lineStart}    ` : lineStart
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`
    return html.slice(0, position) + separator + meta + html.slice(position)
}

/** A hidden svg element with the symbols of the sprite file, for the start of the body. */
export function spriteTag(sprite: string): HtmlTagDescriptor {
    // The comments are notes for developers. Without them the page is smaller.
    const content = sprite.replace(SPRITE_COMMENT, '')
    const root = SPRITE_ROOT.exec(content)
    return {
        tag: 'svg',
        attrs: {
            xmlns: 'http://www.w3.org/2000/svg',
            style: 'display: none',
            'aria-hidden': 'true',
        },
        children: (root ? root[1] : content).trim(),
        injectTo: 'body-prepend',
    }
}

/** All files below a directory as paths with forward slashes. Empty when there is no directory. */
async function listFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
        () => [],
    )
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
            path
                .relative(directory, path.join(entry.parentPath, entry.name))
                .split(path.sep)
                .join('/'),
        )
}

/**
 * The build and dev parts of the installable app:
 * - builds the service worker to sw.js and gives it the precache list,
 * - adds the Content Security Policy to the built page,
 * - puts the icon sprite into the page.
 */
export function pwaPlugin(): Plugin {
    let isBuild = false
    let publicDir = ''
    let workerPath = ''
    let spritePath = ''

    return {
        name: 'page-goblin:pwa',

        configResolved(config) {
            isBuild = config.command === 'build'
            publicDir = config.build.copyPublicDir ? config.publicDir : ''
            workerPath = path.resolve(config.root, WORKER_SOURCE)
            spritePath = path.resolve(config.root, SPRITE_SOURCE)
            if (isBuild && config.build.assetsDir !== 'assets') {
                throw new Error('The service worker expects build.assetsDir to be "assets".')
            }
        },

        buildStart() {
            if (!isBuild) return
            this.addWatchFile(spritePath)
            // A fixed file name keeps the worker URL the same in each deployment. Without the
            // entry signature, the exports that the unit tests use are not in the output.
            this.emitFile({
                type: 'chunk',
                id: workerPath,
                fileName: WORKER_FILE,
                preserveSignature: false,
            })
        },

        async transformIndexHtml(html) {
            const sprite = await readFile(spritePath, 'utf8').catch(() => null)
            return {
                html: isBuild ? injectContentSecurityPolicy(html) : html,
                tags: sprite === null ? [] : [spriteTag(sprite)],
            }
        },

        hotUpdate({ file }) {
            // The sprite is part of the page, so a module update cannot show a change.
            if (this.environment.name !== 'client' || path.normalize(file) !== spritePath) return
            this.environment.hot.send({ type: 'full-reload' })
            return []
        },

        generateBundle: {
            // The hash must cover the final content, so this runs after all other plugins.
            order: 'post',
            async handler(_options, bundle) {
                const worker = bundle[WORKER_FILE]
                if (worker?.type !== 'chunk') {
                    this.error(`The build did not write ${WORKER_FILE}.`)
                }
                // A classic script cannot have these statements.
                if (
                    worker.imports.length ||
                    worker.dynamicImports.length ||
                    worker.exports.length
                ) {
                    this.error(`${WORKER_FILE} must be one file with no import and no export.`)
                }

                const contents = new Map<string, string | Uint8Array>()
                if (publicDir) {
                    for (const file of await listFiles(publicDir)) {
                        if (isPrecached(file)) {
                            contents.set(file, await readFile(path.join(publicDir, file)))
                        }
                    }
                }
                // Vite writes the bundle after the public files, so a bundle file wins.
                for (const [file, output] of Object.entries(bundle)) {
                    if (isPrecached(file)) {
                        contents.set(file, output.type === 'chunk' ? output.code : output.source)
                    }
                }
                worker.code = wrapAsClassicScript(
                    injectPrecacheManifest(worker.code, createPrecacheManifest(contents)),
                )
            },
        },
    }
}
