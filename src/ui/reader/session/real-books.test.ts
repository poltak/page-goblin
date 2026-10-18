/**
 * Runs the reader session on real EPUB files with a fake view. The test runs only when
 * EPUB_DIR is set:
 *
 *     EPUB_DIR=local-books pnpm exec vitest run src/ui/reader/session/real-books.test.ts
 *
 * The directory is only read. The test writes nothing.
 */

import { openAsBlob, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
    createContentLoader,
    INTERNAL_LINK_FRAGMENT_ATTR,
    INTERNAL_LINK_PATH_ATTR,
} from '$lib/content'
import { openEpub } from '$lib/epub'
import type { EpubBook } from '$lib/epub/types'
import { createFakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import { createSettingsStore } from '$lib/settings'
import { estimateTextStats } from '$lib/storage'
import type { BookRecord, SpineStats } from '$lib/storage/types'
import type { SearchResult } from '../types'
import { createReaderSession } from './session'
import type { SessionStorage } from './session'
import { createFakeViews, makeRecord, page } from './testing/fixtures'

const directory = process.env.EPUB_DIR
const MAX_BOOKS = 40

function findEpubFiles(root: string): string[] {
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.toLowerCase().endsWith('.epub'))
        .sort()
        .slice(0, MAX_BOOKS)
}

async function recordOf(book: EpubBook): Promise<BookRecord> {
    const spineStats: SpineStats[] = []
    for (const item of book.spine)
        spineStats.push(estimateTextStats(await book.readText(item.path)))
    return makeRecord({
        spineStats,
        totalChars: spineStats.reduce((sum, stats) => sum + stats.chars, 0),
        totalWords: spineStats.reduce((sum, stats) => sum + stats.words, 0),
    })
}

const storage: SessionStorage = {
    saveProgress: async () => {},
    putBookmark: async () => {},
    deleteBookmark: async () => {},
    putHighlight: async () => {},
    deleteHighlight: async () => {},
    listBookmarks: async () => [],
    listHighlights: async () => [],
}

async function checkBook(file: string, report: string[]): Promise<void> {
    const book = await openEpub(await openAsBlob(file))
    const content = createContentLoader({ book })
    await content.prepare()
    const record = await recordOf(book)
    const settings = createSettingsStore({ storage: null })
    const views = createFakeViews()
    const session = createReaderSession({
        record,
        book,
        content,
        storage,
        container: document.createElement('div'),
        settings,
        fonts: createFakeUserFonts(),
        createView: views.createView,
        bookmarks: [],
        highlights: [],
        systemDark: () => false,
        watchSystemTheme: () => () => {},
        now: () => Date.now(),
    })

    try {
        const linear = book.spine.filter((item) => item.linear)
        expect(views.current.options.initial).toEqual({ spineIndex: linear[0].index, offset: 0 })

        // Contents list.
        if (linear.length > 3) expect(session.toc.length).toBeGreaterThanOrEqual(2)
        for (const entry of session.toc) {
            expect(book.spine[entry.spineIndex]).toBeDefined()
            expect(entry.title).not.toBe('')
            expect(entry.depth).toBeGreaterThanOrEqual(0)
        }

        // Positions through the book.
        let last = -1
        for (const item of linear) {
            const fraction = session.fractionOf({ spineIndex: item.index, offset: 0 })
            expect(fraction).toBeGreaterThanOrEqual(0)
            expect(fraction).toBeLessThanOrEqual(1)
            expect(typeof session.chapterTitleAt({ spineIndex: item.index, offset: 0 })).toBe(
                'string',
            )
            if (item.index > last) last = item.index
        }
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
            await session.goToFraction(fraction)
            const [locator] = vi.mocked(views.current.goTo).mock.lastCall ?? []
            expect(book.spine[locator?.spineIndex ?? -1]).toBeDefined()
            expect(locator?.offset).toBeGreaterThanOrEqual(0)
        }

        // A page of the first chapter with a contents entry: anchors, bookmark and excerpt.
        const target = session.toc[Math.min(1, session.toc.length - 1)]
        const spineIndex = target?.spineIndex ?? linear[0].index
        const model = await content.loadText(spineIndex)
        views.current.relocate(
            page({
                spineIndex,
                start: 0,
                end: Math.min(800, model.text.length),
                chapterLength: model.text.length,
            }),
        )
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(session.wordsRemaining?.book).toBeGreaterThanOrEqual(0)
        await session.toggleBookmark()
        expect(session.bookmarks).toHaveLength(1)
        const { excerpt } = session.bookmarks[0]
        expect(excerpt.length).toBeLessThanOrEqual(120)
        expect(excerpt).not.toMatch(/\s{2}|[\n\t]/)

        // A note link, when the chapter has one.
        const chapter = await content.load(spineIndex)
        const link = chapter.body.querySelector(`[${INTERNAL_LINK_FRAGMENT_ATTR}]`)
        if (link) {
            const path = link.getAttribute(INTERNAL_LINK_PATH_ATTR) ?? ''
            const note = await session.loadNote({
                spineIndex: book.spineIndexOf(path),
                fragment: link.getAttribute(INTERNAL_LINK_FRAGMENT_ATTR),
            })
            if (note) expect(note.element.querySelectorAll('[id]')).toHaveLength(0)
        }

        // Search: a common word stops at the limit, and a word that is not there reads all.
        const results: SearchResult[] = []
        const signal = new AbortController().signal
        let started = performance.now()
        await session.search({
            query: 'the',
            signal,
            onResults: (batch) => void results.push(...batch),
        })
        const commonMs = performance.now() - started
        expect(results.length).toBeLessThanOrEqual(500)
        for (const result of results) {
            const match = result.excerpt.slice(result.matchStart, result.matchEnd)
            expect(match.toLowerCase()).toBe('the')
            expect(result.excerpt).not.toMatch(/\s{2}|[\n\t]/)
            // A paragraph end in the window adds one space.
            expect(result.excerpt.length).toBeLessThanOrEqual(3 + 40 + 60 + 12)
        }

        let chapters = 0
        started = performance.now()
        await session.search({
            query: 'zzqx no such text',
            signal,
            onResults: () => {
                throw new Error('A result for text that is not in the book')
            },
            onProgress: (done) => {
                chapters = done
            },
        })
        const fullMs = performance.now() - started
        expect(chapters).toBe(book.spine.length)

        report.push(
            `${file.split('/').pop()}: spine ${book.spine.length}, contents ${session.toc.length}, ` +
                `"the" ${results.length} results in ${commonMs.toFixed(0)} ms, ` +
                `full search ${fullMs.toFixed(0)} ms`,
        )
        if (results[0]) report.push(`    first: ${JSON.stringify(results[0].excerpt)}`)
        report.push(`    bookmark: ${JSON.stringify(excerpt)}`)
    } finally {
        await session.destroy()
        settings.destroy()
    }
}

describe.skipIf(!directory)('reader session with real books', () => {
    it('runs the session on each book in EPUB_DIR', { timeout: 20 * 60_000 }, async () => {
        const root = directory as string
        const failures: string[] = []
        const report: string[] = []
        for (const name of findEpubFiles(root)) {
            try {
                await checkBook(join(root, name), report)
            } catch (error) {
                failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        console.log(report.join('\n'))
        expect(failures).toEqual([])
    })
})
