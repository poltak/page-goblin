import type { EpubBook } from '$lib/epub/types'
import {
    buildSheet,
    fixDeclarations,
    loadStylesheetText,
    needsStrictCheck,
    registerFontFaces,
    resolveCssText,
    resolveCssUrls,
    SCALE_PROPERTY,
    unregisterFontFaces,
    type FontFaceSpec,
} from './css'
import { normalizeLanguage } from './language'
import { createResourceStore } from './resources'
import { IMAGE_PATH_ATTR, PENDING_STYLE_ATTR, sanitizeDocument, type StyleSource } from './sanitize'
import { buildTextModel, measureChapter } from './text-model'
import type { ChapterContent, ContentLoader, TextModel } from './types'

export interface ContentLoaderOptions {
    book: EpubBook
    /** Number of prepared chapters that stay in memory. */
    cacheSize?: number
    /** Time limit of `ChapterContent.imagesReady`. */
    imageTimeoutMs?: number
}

interface ChapterEntry {
    promise: Promise<ChapterContent>
    /** One container path for each object URL that the chapter holds. */
    paths: string[]
    /** False after the chapter left the cache. */
    live: boolean
}

interface InlineStyleOptions {
    root: Element
    /** Container path of the chapter. */
    path: string
    entry: ChapterEntry
}

const TEXT_CACHE_SIZE = 3
const STYLE_URL_HINT = /url\(|\\|image-set|src\(/i
// Most style attributes have nothing that `fixDeclarations` changes.
const STYLE_FIX_HINT = /break|fixed|font|line-height/i

function waitForImages(images: readonly Element[], timeoutMs: number): Promise<void> {
    const pending = images.filter(
        (image): image is HTMLImageElement =>
            image.localName === 'img' && !(image as HTMLImageElement).complete,
    )
    if (!pending.length) return Promise.resolve()

    return new Promise((resolve) => {
        let left = pending.length
        const finish = () => {
            clearTimeout(timer)
            for (const image of pending) {
                image.removeEventListener('load', settle)
                image.removeEventListener('error', settle)
            }
            resolve()
        }
        const settle = (event: Event) => {
            const image = event.currentTarget as HTMLImageElement
            image.removeEventListener('load', settle)
            image.removeEventListener('error', settle)
            if (--left === 0) finish()
        }
        const timer = setTimeout(finish, timeoutMs)
        for (const image of pending) {
            image.addEventListener('load', settle)
            image.addEventListener('error', settle)
        }
    })
}

function applyStyle(element: Element, css: string): void {
    const style = (element as HTMLElement | SVGElement).style
    if (!style) return
    // A content security policy for inline styles does not block the CSS object model.
    style.cssText = css
    const strict = needsStrictCheck(css)
    if (strict || STYLE_FIX_HINT.test(css)) fixDeclarations(style, strict)
}

/**
 * The text of an SVG drawing has its sizes in the units of the drawing. If such a size
 * followed the font size setting, the text would not fit the drawing. A scale of 1 on the
 * drawing gives each scaled size below it the value of the book.
 */
function resetSvgScale(body: Element): void {
    for (const svg of body.querySelectorAll<SVGElement>('svg')) {
        svg.style?.setProperty(SCALE_PROPERTY, '1')
    }
}

export function createContentLoader({
    book,
    cacheSize = 6,
    imageTimeoutMs = 4000,
}: ContentLoaderOptions): ContentLoader {
    const resources = createResourceStore(book)
    const sheets = new Map<string, Promise<CSSStyleSheet | null>>()
    // Both maps are in order of use. The first key is the least recently used.
    const chapters = new Map<number, ChapterEntry>()
    const models = new Map<number, Promise<TextModel>>()
    const fontKeys = new Set<string>()
    const fontHandles: FontFace[] = []
    const families = new Set<string>()
    let bookFonts: readonly string[] = []
    let disposed = false

    function addFonts(specs: readonly FontFaceSpec[]): void {
        // Two stylesheets of a book can declare the same face.
        const fresh = specs.filter((spec) => {
            const key = [spec.family, spec.src, spec.weight, spec.style, spec.unicodeRange].join(
                '|',
            )
            if (fontKeys.has(key)) return false
            fontKeys.add(key)
            return true
        })
        if (!fresh.length) return

        for (const face of registerFontFaces(fresh)) fontHandles.push(face)
        const before = families.size
        for (const spec of fresh) families.add(spec.family)
        if (families.size !== before) {
            bookFonts = [...families].sort((a, b) => a.localeCompare(b))
        }
    }

    function finishSheet(cssText: string): CSSStyleSheet | null {
        if (disposed) return null
        const { sheet, fontFaces } = buildSheet(cssText)
        addFonts(fontFaces)
        return sheet
    }

    /** The shared sheet of a CSS file. Resolves to null when the file is bad. */
    function linkedSheet(path: string, media?: string): Promise<CSSStyleSheet | null> {
        const key = media ? `${path}\n${media}` : path
        let promise = sheets.get(key)
        if (!promise) {
            promise = loadStylesheetText({ book, path, resources, media })
                .then(finishSheet)
                .catch(() => null)
            sheets.set(key, promise)
        }
        return promise
    }

    function inlineSheet(css: string, path: string): Promise<CSSStyleSheet | null> {
        return resolveCssText({ book, css, path, resources })
            .then(finishSheet)
            .catch(() => null)
    }

    async function loadStyles(sources: readonly StyleSource[], path: string) {
        const loaded = await Promise.all(
            sources.map((source) =>
                source.kind === 'link'
                    ? linkedSheet(source.path, source.media)
                    : inlineSheet(source.css, path),
            ),
        )
        return loaded.filter((sheet): sheet is CSSStyleSheet => sheet !== null)
    }

    function keep(entry: ChapterEntry, paths: readonly string[]): void {
        for (const path of paths) {
            if (entry.live) entry.paths.push(path)
            else resources.release(path)
        }
    }

    function releaseEntry(entry: ChapterEntry): void {
        entry.live = false
        for (const path of entry.paths.splice(0)) resources.release(path)
    }

    function attachImages(images: readonly Element[], entry: ChapterEntry): Promise<unknown> {
        return Promise.all(
            images.map(async (image) => {
                const path = image.getAttribute(IMAGE_PATH_ATTR)
                if (!path) return
                let url: string
                try {
                    url = await resources.acquire(path)
                } catch {
                    // The image stays empty and shows its alt text.
                    return
                }
                keep(entry, [path])
                if (image.localName === 'img') (image as HTMLImageElement).src = url
                else image.setAttribute('href', url)
            }),
        )
    }

    function applyInlineStyles({ root, path, entry }: InlineStyleOptions): Promise<unknown> {
        const pending: Promise<void>[] = []
        for (const element of root.querySelectorAll(`[${PENDING_STYLE_ATTR}]`)) {
            const css = element.getAttribute(PENDING_STYLE_ATTR) ?? ''
            element.removeAttribute(PENDING_STYLE_ATTR)
            if (!STYLE_URL_HINT.test(css)) {
                applyStyle(element, css)
                continue
            }
            pending.push(
                resolveCssUrls({ css, path, book, resources }).then(
                    (resolved) => {
                        keep(entry, resolved.paths)
                        applyStyle(element, resolved.css)
                    },
                    () => {},
                ),
            )
        }
        return Promise.all(pending)
    }

    async function buildChapter(spineIndex: number, entry: ChapterEntry): Promise<ChapterContent> {
        const item = book.spine[spineIndex]
        const xhtml = await book.readText(item.path)
        const sanitized = sanitizeDocument({ xhtml, path: item.path, book })
        const { root, body, dir, styleSources, images } = sanitized
        const lang = sanitized.lang ?? normalizeLanguage(book.metadata.language)
        // Hyphenation and speech read the language from the DOM.
        if (lang) root.setAttribute('lang', lang)
        const { length, anchors } = measureChapter(body)
        const [styles] = await Promise.all([
            loadStyles(styleSources, item.path),
            attachImages(images, entry),
            applyInlineStyles({ root, path: item.path, entry }),
        ])
        // After the style attributes, because each of them replaces the full inline style.
        resetSvgScale(body)

        return {
            spineIndex,
            path: item.path,
            root,
            body,
            styles,
            length,
            anchors,
            lang,
            dir,
            imagesReady: waitForImages(images, imageTimeoutMs),
        }
    }

    function disposedError(): Promise<never> {
        return Promise.reject(new Error('The content loader is disposed.'))
    }

    function missingItemError(spineIndex: number): Promise<never> {
        return Promise.reject(new RangeError(`The book has no spine item ${spineIndex}.`))
    }

    function load(spineIndex: number): Promise<ChapterContent> {
        if (disposed) return disposedError()
        // Reject before the cache changes. A new entry can remove a chapter that a view shows.
        if (!book.spine[spineIndex]) return missingItemError(spineIndex)

        const cached = chapters.get(spineIndex)
        if (cached) {
            chapters.delete(spineIndex)
            chapters.set(spineIndex, cached)
            return cached.promise
        }

        const entry: ChapterEntry = { paths: [], live: true, promise: null as never }
        entry.promise = buildChapter(spineIndex, entry)
        chapters.set(spineIndex, entry)
        entry.promise.catch(() => {
            // The cache does not keep a failed load, so the next call tries again.
            if (chapters.get(spineIndex) === entry) chapters.delete(spineIndex)
            releaseEntry(entry)
        })

        const limit = Math.max(1, cacheSize)
        for (const [index, oldest] of chapters) {
            if (chapters.size <= limit) break
            chapters.delete(index)
            releaseEntry(oldest)
        }
        return entry.promise
    }

    async function readTextModel(spineIndex: number): Promise<TextModel> {
        const chapter = chapters.get(spineIndex)
        if (chapter) return buildTextModel((await chapter.promise).body)

        // Styles and images do not change the text, so the loader only reads and sanitises a
        // chapter that is not in the cache. The chapters of the view then stay in the cache.
        const item = book.spine[spineIndex]
        const xhtml = await book.readText(item.path)
        return buildTextModel(sanitizeDocument({ xhtml, path: item.path, book }).body)
    }

    function loadText(spineIndex: number): Promise<TextModel> {
        if (disposed) return disposedError()
        if (!book.spine[spineIndex]) return missingItemError(spineIndex)

        const cached = models.get(spineIndex)
        if (cached) {
            models.delete(spineIndex)
            models.set(spineIndex, cached)
            return cached
        }

        const promise = readTextModel(spineIndex)
        models.set(spineIndex, promise)
        promise.catch(() => {
            if (models.get(spineIndex) === promise) models.delete(spineIndex)
        })
        for (const index of models.keys()) {
            if (models.size <= TEXT_CACHE_SIZE) break
            models.delete(index)
        }
        return promise
    }

    async function prepare(): Promise<void> {
        if (disposed) return
        const pending: Promise<unknown>[] = []
        for (const item of book.manifest) {
            if (item.mediaType === 'text/css') pending.push(linkedSheet(item.path))
        }
        await Promise.all(pending)
    }

    function dispose(): void {
        if (disposed) return
        disposed = true
        for (const entry of chapters.values()) entry.live = false
        resources.dispose()
        unregisterFontFaces(fontHandles.splice(0))
        chapters.clear()
        models.clear()
        sheets.clear()
        fontKeys.clear()
        families.clear()
        bookFonts = []
    }

    return {
        prepare,
        get bookFonts() {
            return bookFonts
        },
        load,
        loadText,
        dispose,
    }
}
