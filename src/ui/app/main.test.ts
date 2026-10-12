/**
 * One run of the real start sequence in `src/main.ts`, with the real router, storage, library
 * screen and importer. Only the reader screen is a fake, because it is a different module.
 *
 * `main.ts` starts the app when it is imported, so all steps share one app and run in order.
 */

import { Blob as NodeBlob } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLibraryStorage } from '$lib/storage/library-storage'
import type { BookRecord } from '$lib/storage/types'
import type { ReaderMountOptions } from '../reader/types'
import { installOverlayMethods, mountPage } from './testing/page'
import { clearToasts } from './toast'

const mounts: ReaderMountOptions[] = []
const destroyed: string[] = []

vi.mock('../reader', () => ({
    mountReader: async (options: ReaderMountOptions) => {
        mounts.push(options)
        const element = document.createElement('p')
        element.className = 'fake-reader'
        options.root.replaceChildren(element)
        return {
            destroy: async () => {
                destroyed.push(options.bookId)
                options.root.replaceChildren()
            },
        }
    },
}))

// The books of the owner are not in the repository.
const REAL_BOOK = join(import.meta.dirname, '../../../local-books/quick-start.epub')

const seed: BookRecord = {
    id: 'seed',
    title: 'The Seed Book',
    author: 'A Gardener',
    language: 'en',
    identifier: null,
    publisher: null,
    description: null,
    published: null,
    subjects: [],
    series: null,
    fileName: 'seed.epub',
    fileSize: 1,
    fileHash: 'hash-seed',
    hasCover: false,
    spineStats: [{ chars: 10, words: 2 }],
    totalChars: 10,
    totalWords: 2,
    addedAt: 1000,
    lastOpenedAt: null,
}

const el = <T extends HTMLElement = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)!
const cardTitles = () =>
    Array.from(document.querySelectorAll('#library-grid .book-card-title')).map(
        (item) => item.textContent,
    )
const toastTexts = () =>
    Array.from(document.querySelectorAll('#toasts .toast span')).map((item) => item.textContent)

beforeAll(async () => {
    const factory = new IDBFactory()
    vi.stubGlobal('indexedDB', factory)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    window.scrollBy = (() => {}) as typeof window.scrollBy
    localStorage.clear()
    history.replaceState(null, '', '#/')
    mountPage()
    installOverlayMethods()

    const storage = createLibraryStorage({ indexedDB: factory })
    await storage.addBook({ record: seed, file: new NodeBlob(['x']) as Blob, cover: null })
    storage.close()

    await import('../../main')
})

afterAll(() => {
    clearToasts()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('the app', () => {
    it('starts on the library with the stored books and the theme of the settings', async () => {
        await vi.waitFor(() => expect(cardTitles()).toEqual(['The Seed Book']))

        expect(el('#library-view').hidden).toBe(false)
        expect(el('#reader-view').hidden).toBe(true)
        expect(el('#library-count').textContent).toBe('1 book')
        expect(document.documentElement.dataset.theme).toBe('light')
    })

    it('opens a book from its card with a new history entry', async () => {
        const entries = history.length

        el('#library-grid .book-card-open').click()

        expect(location.hash).toBe('#/book/seed')
        expect(history.length).toBe(entries + 1)
        expect(el('#library-view').hidden).toBe(true)
        expect(el('#reader-view').hidden).toBe(false)
        await vi.waitFor(() => expect(el('#reader-view .fake-reader')).not.toBeNull())
        expect(mounts.at(-1)?.bookId).toBe('seed')
        expect(mounts.at(-1)?.root).toBe(el('#reader-view'))
        expect(document.title).toBe('The Seed Book')
    })

    it('goes back in the history when the reader closes the book', async () => {
        const entries = history.length

        mounts.at(-1)!.onExit()

        await vi.waitFor(() => expect(el('#library-view').hidden).toBe(false))
        expect(location.hash).toBe('#/')
        // The entry of the book is still there for Forward.
        expect(history.length).toBe(entries)
        expect(el('#reader-view').hidden).toBe(true)
        expect(document.title).toBe('Page Goblin')
        await vi.waitFor(() => expect(destroyed).toEqual(['seed']))
        expect(el('#reader-view').childElementCount).toBe(0)
    })

    it('opens the book again on Forward and closes it on Back', async () => {
        history.forward()
        await vi.waitFor(() => expect(el('#reader-view .fake-reader')).not.toBeNull())
        expect(mounts).toHaveLength(2)

        history.back()
        await vi.waitFor(() => expect(el('#library-view').hidden).toBe(false))
        await vi.waitFor(() => expect(destroyed).toEqual(['seed', 'seed']))
    })

    it('goes to the library with a toast for a book that is not in storage', async () => {
        location.hash = '#/book/not-a-book'

        await vi.waitFor(() => expect(toastTexts()).toEqual(['This book is not in your library.']))
        expect(el('#library-view').hidden).toBe(false)
        expect(el('#reader-view').hidden).toBe(true)
        expect(location.hash).toBe('#/')
        expect(mounts).toHaveLength(2)
        clearToasts()
    })

    it('goes to the library for an unknown address', async () => {
        location.hash = '#/no-such-page'

        await vi.waitFor(() => expect(location.hash).toBe('#/'))
        expect(el('#library-view').hidden).toBe(false)
    })

    it('shows a message for a dropped file that is not an EPUB file', async () => {
        const drop = Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
            dataTransfer: { types: ['Files'], files: [new File(['plain text'], 'notes.txt')] },
        })

        document.body.dispatchEvent(drop)

        await vi.waitFor(() =>
            expect(el('#import-status .import-failure-message')?.textContent).toBe(
                'This file is not an EPUB file, or it is damaged.',
            ),
        )
        expect(el('#import-status .import-failure-file').textContent).toBe('notes.txt')
        expect(cardTitles()).toEqual(['The Seed Book'])
    })

    it.skipIf(!existsSync(REAL_BOOK))(
        'imports a real EPUB file from the file input with the real parser',
        async () => {
            const bytes = readFileSync(REAL_BOOK)
            const file = new File([bytes], 'quick-start.epub', { type: 'application/epub+zip' })
            const input = el<HTMLInputElement>('#book-files')
            Object.defineProperty(input, 'files', { configurable: true, get: () => [file] })

            input.dispatchEvent(new Event('change', { bubbles: true }))

            await vi.waitFor(() => expect(cardTitles()).toHaveLength(2), { timeout: 10_000 })
            // The new book is first in the "recent" order, and its title is not a default.
            const title = cardTitles()[0] ?? ''
            expect(title).not.toBe('')
            expect(title).not.toBe('Unknown Title')
            expect(cardTitles()[1]).toBe('The Seed Book')
            expect(el('#library-count').textContent).toBe('2 books')
            expect(el('#import-status .import-current').hidden).toBe(true)
            expect(toastTexts()).toEqual(['The book was added.'])
        },
        15_000,
    )

    it('removes the card of a book that a different tab removed, when the user opens it', async () => {
        clearToasts()
        const other = createLibraryStorage()
        await other.deleteBook('seed')
        other.close()
        const seedCard = el('#library-grid .book-card[data-book-id="seed"]')

        seedCard.querySelector<HTMLElement>('.book-card-open')!.click()

        await vi.waitFor(() => expect(toastTexts()).toContain('This book is not in your library.'))
        await vi.waitFor(() => expect(cardTitles()).not.toContain('The Seed Book'))
        expect(el('#library-view').hidden).toBe(false)
        expect(location.hash).toBe('#/')
    })
})
