/**
 * Loads chapters of real EPUB files with the EPUB engine and the content pipeline together.
 * The test runs only when EPUB_DIR is set:
 *
 *     EPUB_DIR=/path/to/books pnpm exec vitest run src/lib/content/real-books.test.ts
 *
 * EPUB_LIMIT is the largest number of books (default 60). The test takes them at even steps
 * from the sorted file list. EPUB_CHAPTERS=all loads each chapter and not only a sample. The
 * directory is only read. The test writes nothing.
 */

import { openAsBlob, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openEpub, type EpubBook } from '$lib/epub'
import { buildSheet, loadStylesheetText } from './css'
import { createContentLoader } from './loader'
import { createResourceStore } from './resources'
import { IMAGE_PATH_ATTR, sanitizeDocument } from './sanitize'
import { buildTextModel, createTextIndex, segmentSentences, tokenizeWords } from './text-model'
import type { ChapterContent } from './types'

const directory = process.env.EPUB_DIR
const limit = Math.max(1, Math.floor(Number(process.env.EPUB_LIMIT)) || 60)
const allChapters = process.env.EPUB_CHAPTERS === 'all'

const FORBIDDEN_ELEMENTS = 'script, iframe, object, embed, form, link, meta, base, style, audio'
const REMOTE_URL = /^(?:https?:|javascript:|\/\/)/i
const REMOTE_CSS_URL = /url\(\s*["']?(?:https?:|\/\/)/i
const ABSOLUTE_SIZE =
    /^(?:[\d.]*[1-9][\d.]*(?:px|pt|pc|in|cm|mm|q)|(?:xx?-|xxx-)?(?:small|large)|medium)$/i
const ROUND_TRIP_OFFSETS = 30
const ANCHORS_CHECKED = 30
const MAX_FAILURES_SHOWN = 40

interface Totals {
    books: number
    chapters: number
    emptyChapters: number
    stylesheets: number
    nullSheets: number
    thrownSheets: number
    /** Style sources of the loaded chapters that gave no sheet. */
    missingChapterSheets: number
    images: number
    /** Images of the book that got no URL. */
    unresolvedImages: number
    /** Images with a source that is not a file of the book. This is a fault of the book. */
    imagesNotInBook: number
}

interface ChapterTime {
    file: string
    path: string
    size: number
    ms: number
}

/** The FileReader of jsdom does not accept the file Blob of Node. */
class BlobReader {
    result: string | null = null
    error: unknown = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    readAsDataURL(blob: Blob): void {
        blob.arrayBuffer().then(
            (buffer) => {
                this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
                this.onload?.()
            },
            (error) => {
                this.error = error
                this.onerror?.()
            },
        )
    }
}

function findEpubFiles(root: string): string[] {
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.toLowerCase().endsWith('.epub'))
        .sort()
    if (files.length <= limit) return files
    return Array.from({ length: limit }, (_, i) => files[Math.floor((i * files.length) / limit)])
}

/** The first 2 chapters, the last chapter, and 5 more at even steps. */
function sampleChapters(count: number): number[] {
    if (allChapters) return Array.from({ length: count }, (_, index) => index)
    const picked = new Set<number>()
    for (const index of [0, 1, count - 1]) {
        if (index >= 0 && index < count) picked.add(index)
    }
    for (let i = 1; i <= 5; i++) picked.add(Math.floor((i * (count - 1)) / 6))
    return [...picked].sort((a, b) => a - b)
}

function checkDom(chapter: ChapterContent, totals: Totals): string[] {
    const faults: string[] = []
    const { root } = chapter

    const forbidden = root.querySelector(FORBIDDEN_ELEMENTS)
    if (forbidden) faults.push(`forbidden element <${forbidden.localName}>`)
    if (chapter.lang !== root.getAttribute('lang')) {
        faults.push(`lang ${chapter.lang}, attribute ${root.getAttribute('lang')}`)
    }

    for (const element of [root, ...root.querySelectorAll('*')]) {
        const name = element.localName
        for (const attribute of element.getAttributeNames()) {
            const lower = attribute.toLowerCase()
            if (lower.startsWith('on')) faults.push(`event attribute ${attribute} on <${name}>`)
            if (lower !== 'href' && lower !== 'src' && lower !== 'xlink:href') continue

            const value = (element.getAttribute(attribute) ?? '').replace(/[\u0000-\u0020]+/g, '')
            const external =
                lower === 'href' && name === 'a' && element.hasAttribute('data-rd-external')
            if (REMOTE_URL.test(value) && !external) {
                faults.push(`remote ${attribute}="${value.slice(0, 80)}" on <${name}>`)
            }
        }

        if (element.hasAttribute('style')) {
            const style = (element as HTMLElement).style
            for (const property of ['font-size', 'line-height']) {
                const value = style.getPropertyValue(property)
                if (ABSOLUTE_SIZE.test(value)) faults.push(`style ${property}: ${value}`)
            }
        }

        if (
            name === 'svg' &&
            (element as SVGElement).style.getPropertyValue('--rd-scale') !== '1'
        ) {
            faults.push('an SVG drawing follows the font size setting')
        }

        if (name === 'img' || name === 'image') {
            totals.images++
            const path = element.getAttribute(IMAGE_PATH_ATTR)
            if (element.getAttribute(name === 'img' ? 'src' : 'href')) {
                // The image has a URL.
            } else if (path === null) {
                totals.imagesNotInBook++
            } else {
                totals.unresolvedImages++
                faults.push(`no URL for image ${path}`)
            }
        }
    }
    return faults
}

function checkText(chapter: ChapterContent): string[] {
    const faults: string[] = []
    const { body, length } = chapter
    const model = buildTextModel(body)
    const { text, blocks } = model
    if (text.length !== length) faults.push(`length ${length}, text model ${text.length}`)

    const index = createTextIndex(body)
    if (index.length !== length) faults.push(`length ${length}, text index ${index.length}`)
    for (let i = 0; i < ROUND_TRIP_OFFSETS && length > 0; i++) {
        const offset = Math.round((i * length) / (ROUND_TRIP_OFFSETS - 1))
        const point = index.locate(offset)
        const back = point ? index.offsetOf(point.node, point.offset) : -1
        if (back !== offset) faults.push(`offset ${offset} came back as ${back}`)
    }
    if (length === 0 && index.locate(0) !== null) faults.push('locate gave a point with no text')

    let previousEnd = 0
    for (const block of blocks) {
        if (!(block.start >= previousEnd && block.start < block.end && block.end <= length)) {
            faults.push(`bad block ${block.start} to ${block.end}`)
        }
        previousEnd = block.end
    }

    for (const word of tokenizeWords(model)) {
        const block = blocks[word.block]
        if (
            !block ||
            word.start < block.start ||
            word.end > block.end ||
            word.start >= word.end ||
            word.text !== text.slice(word.start, word.end) ||
            /\s/.test(word.text)
        ) {
            faults.push(`bad word ${word.start} to ${word.end} "${word.text.slice(0, 40)}"`)
        }
    }

    for (const sentence of segmentSentences({ model, locale: chapter.lang })) {
        const block = blocks[sentence.block]
        const content = text.slice(sentence.start, sentence.end)
        if (
            !block ||
            sentence.start < block.start ||
            sentence.end > block.end ||
            content === '' ||
            content !== content.trim()
        ) {
            faults.push(`bad sentence ${sentence.start} to ${sentence.end}`)
        }
    }

    for (const [id, offset] of chapter.anchors) {
        if (!(offset >= 0 && offset <= length)) faults.push(`anchor ${id} at ${offset}`)
    }
    // The anchor map and the text index find the offset of an element in different ways.
    const targets = body.querySelectorAll('[id]')
    const step = Math.max(1, Math.ceil(targets.length / ANCHORS_CHECKED))
    // The map has the first element with an id, and the body is before all others.
    const seen = new Set<string>([body.id])
    for (let i = 0; i < targets.length; i++) {
        const id = targets[i].id
        const first = !seen.has(id)
        seen.add(id)
        if (!first || i % step !== 0) continue
        const offset = index.offsetOfElement(targets[i])
        if (offset !== chapter.anchors.get(id)) {
            faults.push(`anchor ${id} at ${chapter.anchors.get(id)}, text index ${offset}`)
        }
    }
    return faults
}

function checkRules(rules: CSSRuleList, faults: Set<string>): void {
    for (const rule of rules) {
        const name = rule.constructor.name
        if (name === 'CSSFontFaceRule' || name === 'CSSImportRule' || name === 'CSSPageRule') {
            faults.add(`a ${name} is in the sheet`)
        }
        const { style, cssRules, selectorText } = rule as Partial<CSSStyleRule>
        if (selectorText && /:host/i.test(selectorText)) faults.add(`selector ${selectorText}`)
        if (style) {
            if (REMOTE_CSS_URL.test(style.cssText)) faults.add(`remote URL in ${rule.cssText}`)
            for (const property of ['font-size', 'line-height']) {
                const value = style.getPropertyValue(property)
                if (ABSOLUTE_SIZE.test(value)) faults.add(`${property}: ${value} has no scale`)
            }
        }
        if (cssRules) checkRules(cssRules, faults)
    }
}

/** Build each manifest stylesheet directly, because the loader hides a sheet that fails. */
async function checkStylesheets(book: EpubBook, totals: Totals): Promise<string[]> {
    const faults: string[] = []
    const resources = createResourceStore(book)
    for (const item of book.manifest) {
        if (item.mediaType !== 'text/css') continue
        totals.stylesheets++
        try {
            const css = await loadStylesheetText({ book, resources, path: item.path })
            const { sheet, fontFaces } = buildSheet(css)
            if (!sheet) {
                totals.nullSheets++
                faults.push(`${item.path}: no sheet`)
                continue
            }
            const found = new Set<string>()
            checkRules(sheet.cssRules, found)
            for (const face of fontFaces) {
                if (!/^(?:blob|data):/i.test(face.src.replace(/^url\(\s*["']?/i, ''))) {
                    found.add(`font source ${face.src.slice(0, 80)}`)
                }
            }
            for (const fault of found) faults.push(`${item.path}: ${fault.slice(0, 200)}`)
        } catch (error) {
            totals.thrownSheets++
            faults.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    resources.dispose()
    return faults
}

describe.skipIf(!directory)('real books: content', () => {
    beforeAll(() => {
        // The object URLs of Node do not accept a Blob of jsdom.
        let urls = 0
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${++urls}`)
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        vi.stubGlobal('FileReader', BlobReader)
    })

    afterAll(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it(
        'loads a sample of chapters of each book in EPUB_DIR',
        { timeout: 60 * 60_000 },
        async () => {
            const root = directory as string
            const files = findEpubFiles(root)
            const failures: string[] = []
            const times: ChapterTime[] = []
            const totals: Totals = {
                books: 0,
                chapters: 0,
                emptyChapters: 0,
                stylesheets: 0,
                nullSheets: 0,
                thrownSheets: 0,
                missingChapterSheets: 0,
                images: 0,
                unresolvedImages: 0,
                imagesNotInBook: 0,
            }
            const started = performance.now()
            let prepareMs = 0

            for (const file of files) {
                let book: EpubBook
                try {
                    // A file-backed Blob. Only the byte ranges that the parser asks for are read.
                    book = await openEpub((await openAsBlob(join(root, file))) as unknown as Blob)
                } catch (error) {
                    failures.push(`${file}: did not open: ${String(error)}`)
                    continue
                }
                totals.books++
                for (const fault of await checkStylesheets(book, totals)) {
                    failures.push(`${file}: stylesheet ${fault}`)
                }

                const loader = createContentLoader({ book, imageTimeoutMs: 0 })
                const beforePrepare = performance.now()
                await loader.prepare()
                prepareMs += performance.now() - beforePrepare
                for (const index of sampleChapters(book.spine.length)) {
                    const item = book.spine[index]
                    const label = `${file}: ${item.path}`
                    try {
                        // Before the load, the text path reads and sanitises the chapter itself.
                        const textOnly = await loader.loadText(index)
                        const before = performance.now()
                        const chapter = await loader.load(index)
                        times.push({
                            file,
                            path: item.path,
                            size: item.size,
                            ms: performance.now() - before,
                        })
                        await chapter.imagesReady

                        totals.chapters++
                        if (chapter.length === 0) totals.emptyChapters++
                        const sources = sanitizeDocument({
                            xhtml: await book.readText(item.path),
                            path: item.path,
                            book,
                        }).styleSources
                        totals.missingChapterSheets += sources.length - chapter.styles.length

                        for (const fault of [...checkDom(chapter, totals), ...checkText(chapter)]) {
                            failures.push(`${label}: ${fault}`)
                        }
                        if (textOnly.text !== buildTextModel(chapter.body).text) {
                            failures.push(`${label}: loadText gave a different text`)
                        }
                    } catch (error) {
                        const stack = error instanceof Error ? (error.stack ?? error.message) : ''
                        failures.push(`${label}: load failed: ${stack || String(error)}`)
                    }
                }
                loader.dispose()
            }

            const seconds = ((performance.now() - started) / 1000).toFixed(1)
            const loadSeconds = (times.reduce((sum, time) => sum + time.ms, 0) / 1000).toFixed(1)
            const summary =
                `real books content: ${totals.books} of ${files.length} books opened, ` +
                `${totals.chapters} chapters loaded (${totals.emptyChapters} with zero text), ` +
                `${totals.stylesheets} stylesheets (${totals.nullSheets} null, ` +
                `${totals.thrownSheets} threw, ${totals.missingChapterSheets} missing in chapters), ` +
                `${totals.images} images (${totals.unresolvedImages} not resolved, ` +
                `${totals.imagesNotInBook} not in the book), ` +
                `${failures.length} faults, ${seconds} s total, ` +
                `${(prepareMs / 1000).toFixed(1)} s in prepare(), ${loadSeconds} s in load()`
            const slowest = times
                .sort((a, b) => b.ms - a.ms)
                .slice(0, 5)
                .map(
                    (time) =>
                        `\n  SLOW ${time.ms.toFixed(0)} ms, ${(time.size / 1024).toFixed(0)} kB: ` +
                        `${time.file}: ${time.path}`,
                )
            const shown = failures
                .slice(0, MAX_FAILURES_SHOWN)
                .map((failure) => `\n  FAULT ${failure}`)
            process.stdout.write(`\n${summary}${slowest.join('')}${shown.join('')}\n`)

            expect(files.length, `No .epub files below ${root}`).toBeGreaterThan(0)
            expect(failures.slice(0, MAX_FAILURES_SHOWN)).toEqual([])
        },
    )
})
