/**
 * Opens real EPUB files from a directory. The test runs only when EPUB_DIR is set:
 *
 *     EPUB_DIR=/path/to/books pnpm exec vitest run src/lib/epub/real-books.test.ts
 *
 * The directory is only read. The test writes nothing.
 */

import { openAsBlob, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EpubError, openEpub, type EpubBook, type TocItem } from './index'

const directory = process.env.EPUB_DIR
const MAX_BOOKS = 400

function findEpubFiles(root: string): string[] {
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.toLowerCase().endsWith('.epub'))
        .sort()
        .slice(0, MAX_BOOKS)
}

async function checkBook(book: EpubBook): Promise<void> {
    if (!book.spine.length) throw new Error('The spine is empty')

    for (const item of new Set([book.spine[0], book.spine[book.spine.length - 1]])) {
        const text = await book.readText(item.path)
        if (typeof text !== 'string') throw new Error(`readText gave no text: ${item.path}`)
    }

    if (book.coverPath !== null) {
        const cover = await book.readBlob(book.coverPath)
        if (!(cover.size > 0)) throw new Error(`The cover is empty: ${book.coverPath}`)
    }

    const checkToc = (items: readonly TocItem[]) => {
        for (const item of items) {
            if (item.spineIndex >= 0 && book.spine[item.spineIndex]?.path !== item.path) {
                throw new Error(`TOC entry "${item.title}" has a path that is not in the spine`)
            }
            checkToc(item.children)
        }
    }
    checkToc(book.toc)
}

describe.skipIf(!directory)('real books', () => {
    it('opens each book in EPUB_DIR', { timeout: 20 * 60_000 }, async () => {
        const root = directory as string
        const files = findEpubFiles(root)
        const failures: string[] = []
        let opened = 0
        let drm = 0
        let noCover = 0
        let noToc = 0

        for (const file of files) {
            try {
                // A file-backed Blob. Only the byte ranges that the parser asks for are read.
                const blob = (await openAsBlob(join(root, file))) as unknown as Blob
                const book = await openEpub(blob)
                await checkBook(book)
                opened++
                if (book.coverPath === null) noCover++
                if (!book.toc.length) noToc++
            } catch (error) {
                if (error instanceof EpubError && error.code === 'drm') {
                    drm++
                    continue
                }
                const message = error instanceof Error ? error.message : String(error)
                const code = error instanceof EpubError ? ` [${error.code}]` : ''
                failures.push(`${file}:${code} ${message}`)
            }
        }

        const summary =
            `real books: ${files.length} found, ${opened} opened, ${drm} DRM, ` +
            `${failures.length} failures (${noCover} with no cover, ${noToc} with no table of contents)` +
            failures.map((failure) => `\n  FAILED ${failure}`).join('')
        process.stdout.write(`\n${summary}\n`)

        expect(files.length, `No .epub files below ${root}`).toBeGreaterThan(0)
        expect(failures).toEqual([])
    })
})
