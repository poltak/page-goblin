import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookmarkRecord, BookRecord, HighlightRecord } from '$lib/storage/types'
import { installOverlayMethods, mountPage, settle } from '../app/testing/page'
import { clearToasts } from '../app/toast'
import type { CoverStore } from './covers'
import { createDetailsSheet } from './details'
import type { DetailsSheet, DetailsSheetOptions } from './details'

const mocks = vi.hoisted(() => ({
    highlightsToMarkdown: vi.fn(() => '# Markdown'),
    downloadTextFile: vi.fn(),
}))

vi.mock('$lib/annotations', () => ({
    highlightsToMarkdown: mocks.highlightsToMarkdown,
    downloadTextFile: mocks.downloadTextFile,
}))

const HOSTILE = '<img src=x onerror="window.hacked = true"><script>window.hacked = true</script>'

function makeBook(changes: Partial<BookRecord> = {}): BookRecord {
    return {
        id: 'b1',
        title: 'A Wizard of Earthsea',
        author: 'Ursula K. Le Guin',
        language: 'en',
        identifier: null,
        publisher: 'Parnassus Press',
        description: 'A boy learns magic.\n\nIt goes wrong.',
        published: '1968-11-01',
        subjects: [],
        series: { name: 'Earthsea', position: 1 },
        fileName: 'earthsea.epub',
        fileSize: 1_234_567,
        fileHash: 'hash',
        hasCover: true,
        spineStats: [],
        totalChars: 0,
        totalWords: 0,
        addedAt: new Date(2026, 2, 5).getTime(),
        lastOpenedAt: null,
        ...changes,
    }
}

const bookmark = { id: 'm1', bookId: 'b1' } as BookmarkRecord
const highlight = { id: 'h1', bookId: 'b1' } as HighlightRecord

let dialog: HTMLDialogElement
let opener: HTMLButtonElement
let bookmarks: BookmarkRecord[]
let highlights: HighlightRecord[]
let coverUrl: string | null
let onOpenBook: ReturnType<typeof vi.fn<DetailsSheetOptions['onOpenBook']>>
let onRemove: ReturnType<typeof vi.fn<DetailsSheetOptions['onRemove']>>
let sheet: DetailsSheet

const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!
const fact = (name: string) => q(`[data-fact="${name}"]`)
const factText = (name: string) => fact(name).querySelector('dd')?.textContent

function show(book: BookRecord = makeBook(), fraction = 0): BookRecord {
    sheet.show({ book, fraction, opener })
    return book
}

beforeEach(() => {
    mountPage()
    installOverlayMethods()
    dialog = document.querySelector('#details-sheet')!
    opener = document.createElement('button')
    document.body.append(opener)
    bookmarks = []
    highlights = []
    coverUrl = 'blob:cover'
    onOpenBook = vi.fn<DetailsSheetOptions['onOpenBook']>()
    onRemove = vi.fn<DetailsSheetOptions['onRemove']>()
    mocks.highlightsToMarkdown.mockClear()
    mocks.downloadTextFile.mockClear()
    const covers: CoverStore = { url: async () => coverUrl, release() {} }
    sheet = createDetailsSheet({
        dialog,
        storage: {
            listBookmarks: async () => bookmarks,
            listHighlights: async () => highlights,
        },
        covers,
        onOpenBook,
        onRemove,
    })
})

afterEach(() => {
    clearToasts()
})

describe('the details sheet', () => {
    it('opens as a modal sheet with the text of the book', () => {
        show()

        expect(dialog.open).toBe(true)
        expect(q('.details-title').textContent).toBe('A Wizard of Earthsea')
        expect(q('.details-author').textContent).toBe('Ursula K. Le Guin')
        expect(q('.details-series').textContent).toBe('Book 1 of Earthsea')
        expect(factText('publisher')).toBe('Parnassus Press')
        expect(factText('published')).toBe('1968')
        expect(factText('language')).toBe(
            new Intl.DisplayNames(undefined, { type: 'language' }).of('en'),
        )
        expect(factText('file')).toBe('earthsea.epub (1.2 MB)')
        expect(factText('added')).toContain('2026')
        expect(q('.details-description').textContent).toBe('A boy learns magic.\n\nIt goes wrong.')
    })

    it('shows the progress in words', () => {
        show(makeBook(), 0)
        expect(factText('progress')).toBe('Not started')
        dialog.close()

        show(makeBook(), 0.42)
        expect(factText('progress')).toBe('42%')
        dialog.close()

        show(makeBook(), 1)
        expect(factText('progress')).toBe('Finished')
    })

    it('starts at the top when it opens after the user scrolled it for a different book', () => {
        // A browser keeps the scroll offset of an element through the time that it has no
        // box, and ignores a write in that time. A closed dialog has no boxes.
        let offset = 120
        Object.defineProperty(q('.sheet-body'), 'scrollTop', {
            configurable: true,
            get: () => offset,
            set(value: number) {
                if (dialog.open) offset = value
            },
        })

        show()

        expect(q('.sheet-body').scrollTop).toBe(0)
    })

    it('hides the rows and parts that the book has no value for', () => {
        show(
            makeBook({
                series: null,
                publisher: null,
                published: '0101-01-01T00:00:00+00:00',
                language: null,
                description: null,
            }),
        )

        expect(q('.details-series').hidden).toBe(true)
        expect(fact('publisher').hidden).toBe(true)
        expect(fact('published').hidden).toBe(true)
        expect(fact('language').hidden).toBe(true)
        expect(q('.details-about').hidden).toBe(true)
        expect(fact('file').hidden).toBe(false)
    })

    it('shows the rows again for the next book', () => {
        show(makeBook({ publisher: null, description: null }))
        dialog.close()

        show(makeBook({ id: 'b2' }))

        expect(fact('publisher').hidden).toBe(false)
        expect(q('.details-about').hidden).toBe(false)
    })

    it('keeps metadata with markup as text', () => {
        show(
            makeBook({
                title: HOSTILE,
                author: HOSTILE,
                publisher: HOSTILE,
                description: HOSTILE,
                fileName: HOSTILE,
                series: { name: HOSTILE, position: 2 },
            }),
        )

        expect(dialog.querySelector('script')).toBeNull()
        // The one image is the cover element of the page.
        expect(dialog.querySelectorAll('img')).toHaveLength(1)
        expect(q('.details-title').textContent).toBe(HOSTILE)
        expect(q('.details-description').textContent).toBe(HOSTILE)
        expect(q('.details-series').textContent).toBe(`Book 2 of ${HOSTILE}`)
        expect(factText('publisher')).toBe(HOSTILE)
        expect((window as { hacked?: boolean }).hacked).toBeUndefined()
    })

    it('shows the number of bookmarks and highlights from storage', async () => {
        bookmarks = [bookmark]
        highlights = [highlight, { ...highlight, id: 'h2' }]

        show()
        expect(factText('bookmarks')).toBe('…')
        await settle()

        expect(factText('bookmarks')).toBe('1')
        expect(factText('highlights')).toBe('2')
    })

    it('shows the cover after the image loads, and the title tile until then', async () => {
        show()
        const image = q<HTMLImageElement>('.details-cover img')
        const tile = q('.details-cover .book-cover-fallback')
        expect(tile.textContent).toBe('A Wizard of Earthsea')
        expect(image.hidden).toBe(true)

        await settle()
        expect(image.getAttribute('src')).toBe('blob:cover')
        image.dispatchEvent(new Event('load'))

        expect(image.hidden).toBe(false)
        expect(tile.hidden).toBe(true)
    })

    it('keeps the title tile when the cover does not load', async () => {
        show()
        await settle()
        const image = q<HTMLImageElement>('.details-cover img')

        image.dispatchEvent(new Event('error'))

        expect(image.hidden).toBe(true)
        expect(q('.details-cover .book-cover-fallback').hidden).toBe(false)
    })

    it('asks for no cover when the book has none', async () => {
        coverUrl = 'blob:wrong'
        show(makeBook({ hasCover: false }))
        await settle()

        expect(q('.details-cover img').hasAttribute('src')).toBe(false)
    })

    it('ignores the data of a book that is not on screen any more', async () => {
        bookmarks = [bookmark]
        show(makeBook({ id: 'first' }))
        dialog.close()
        bookmarks = []
        coverUrl = null
        show(makeBook({ id: 'second', hasCover: false }))
        await settle()

        expect(factText('bookmarks')).toBe('0')
        expect(q('.details-cover img').hasAttribute('src')).toBe(false)
    })

    it('opens the book and closes the sheet', () => {
        show()

        q('[data-action="open"]').click()

        expect(dialog.open).toBe(false)
        expect(onOpenBook).toHaveBeenCalledWith('b1')
    })

    it('closes the sheet and hands the remove to the library, with the opener', () => {
        const book = show()

        q('[data-action="remove"]').click()

        expect(dialog.open).toBe(false)
        expect(onRemove).toHaveBeenCalledWith(book, opener)
    })

    it('gives the focus back to the opener at the close', () => {
        show()

        dialog.close()

        expect(document.activeElement).toBe(opener)
    })
})

describe('export highlights', () => {
    it('is off while the numbers load and for a book with no notes', async () => {
        show()
        const button = q<HTMLButtonElement>('[data-action="export"]')
        expect(button.disabled).toBe(true)

        await settle()
        expect(button.disabled).toBe(true)
    })

    it('downloads the highlights and bookmarks as a Markdown file', async () => {
        bookmarks = [bookmark]
        highlights = [highlight]
        const book = show(makeBook({ title: 'What If? Part 1/2' }))
        await settle()
        const button = q<HTMLButtonElement>('[data-action="export"]')
        expect(button.disabled).toBe(false)

        button.click()
        await settle()

        expect(mocks.highlightsToMarkdown).toHaveBeenCalledWith({ book, bookmarks, highlights })
        expect(mocks.downloadTextFile).toHaveBeenCalledWith({
            name: 'What If Part 1 2 - highlights.md',
            text: '# Markdown',
            type: 'text/markdown;charset=utf-8',
        })
        expect(dialog.open).toBe(true)
    })

    it('closes the sheet and shows a toast when the export fails', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        mocks.highlightsToMarkdown.mockImplementationOnce(() => {
            throw new Error('bad data')
        })
        highlights = [highlight]
        show()
        await settle()

        q('[data-action="export"]').click()
        await settle()

        expect(mocks.downloadTextFile).not.toHaveBeenCalled()
        expect(dialog.open).toBe(false)
        expect(document.querySelector('#toasts .toast span')?.textContent).toBe(
            'The highlights were not exported.',
        )
        error.mockRestore()
    })
})
