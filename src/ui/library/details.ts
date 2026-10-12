/**
 * The book details sheet. The library screen loads this file when the user opens the sheet
 * for the first time.
 *
 * All text of a book goes into the page through textContent.
 */

import type {
    BookmarkRecord,
    BookRecord,
    HighlightRecord,
    LibraryStorage,
} from '$lib/storage/types'
import { openDialog } from '../app/dialog'
import { showToast } from '../app/toast'
import { qs } from '../dom'
import type { CoverStore } from './covers'
import {
    formatBytes,
    formatDate,
    languageName,
    publicationYear,
    safeFileName,
    seriesText,
} from './details-format'
import { progressText } from './format'

export interface DetailsSheetOptions {
    dialog: HTMLDialogElement
    storage: Pick<LibraryStorage, 'listBookmarks' | 'listHighlights'>
    covers: CoverStore
    onOpenBook(bookId: string): void
    /** The user chose Remove. The sheet is closed at this time. */
    onRemove(book: BookRecord, opener: Element | null): void
}

export interface DetailsSheet {
    show(info: { book: BookRecord; fraction: number; opener: Element | null }): void
}

type Fact =
    | 'progress'
    | 'bookmarks'
    | 'highlights'
    | 'publisher'
    | 'published'
    | 'language'
    | 'file'
    | 'added'

interface Annotations {
    bookmarks: BookmarkRecord[]
    highlights: HighlightRecord[]
}

export function createDetailsSheet(options: DetailsSheetOptions): DetailsSheet {
    const { dialog, storage, covers } = options
    const title = qs('.details-title', dialog)
    const author = qs('.details-author', dialog)
    const series = qs('.details-series', dialog)
    const fallback = qs('.book-cover-fallback', dialog)
    const image = qs<HTMLImageElement>('.details-cover img', dialog)
    const body = qs('.sheet-body', dialog)
    const about = qs('.details-about', dialog)
    const description = qs('.details-description', dialog)
    const exportButton = qs<HTMLButtonElement>('[data-action="export"]', dialog)

    let shown: BookRecord | null = null
    let opener: Element | null = null
    let annotations: Annotations | null = null

    /** Sets the value of a row. Null hides the row. */
    function setFact(name: Fact, value: string | null): void {
        const row = qs(`[data-fact="${name}"]`, dialog)
        row.hidden = value === null
        qs('dd', row).textContent = value ?? ''
    }

    function setText(element: HTMLElement, value: string | null): void {
        element.hidden = value === null
        element.textContent = value ?? ''
    }

    function fill(book: BookRecord, fraction: number): void {
        title.textContent = book.title
        author.textContent = book.author
        setText(series, seriesText(book.series))
        fallback.textContent = book.title
        fallback.hidden = false
        image.hidden = true
        image.removeAttribute('src')

        setFact('progress', progressText(fraction) || 'Not started')
        // The two numbers come from storage a moment later. The rows keep their place.
        setFact('bookmarks', '…')
        setFact('highlights', '…')
        setFact('publisher', book.publisher?.trim() || null)
        const year = publicationYear(book.published)
        setFact('published', year === null ? null : String(year))
        setFact('language', languageName(book.language))
        setFact('file', `${book.fileName} (${formatBytes(book.fileSize)})`)
        setFact('added', formatDate(book.addedAt))

        const text = book.description?.trim() || null
        about.hidden = text === null
        description.textContent = text ?? ''
        exportButton.disabled = true
    }

    async function loadCover(book: BookRecord): Promise<void> {
        if (!book.hasCover) return
        const url = await covers.url(book.id)
        if (!url || shown !== book) return
        image.src = url
    }

    async function loadAnnotations(book: BookRecord): Promise<void> {
        const [bookmarks, highlights] = await Promise.all([
            storage.listBookmarks(book.id),
            storage.listHighlights(book.id),
        ])
        if (shown !== book) return
        annotations = { bookmarks, highlights }
        setFact('bookmarks', String(bookmarks.length))
        setFact('highlights', String(highlights.length))
        exportButton.disabled = bookmarks.length + highlights.length === 0
    }

    async function exportHighlights(book: BookRecord, data: Annotations): Promise<void> {
        try {
            const { highlightsToMarkdown, downloadTextFile } = await import('$lib/annotations')
            // A build without the export has no such functions.
            if (
                typeof highlightsToMarkdown !== 'function' ||
                typeof downloadTextFile !== 'function'
            ) {
                throw new Error('The export is not in this build.')
            }
            downloadTextFile({
                name: `${safeFileName(book.title)} - highlights.md`,
                text: highlightsToMarkdown({ book, ...data }),
                type: 'text/markdown;charset=utf-8',
            })
        } catch (error) {
            console.error(error)
            // A toast waits for the sheet to close, so close it.
            dialog.close()
            showToast({ message: 'The highlights were not exported.', tone: 'error' })
        }
    }

    // A cover can be an SVG file or a damaged image. It shows only when the browser reads it.
    image.addEventListener('load', () => {
        image.hidden = false
        fallback.hidden = true
    })
    image.addEventListener('error', () => {
        image.hidden = true
        fallback.hidden = false
    })

    dialog.addEventListener('click', (event) => {
        const button = (event.target as Element).closest<HTMLElement>('[data-action]')
        const book = shown
        if (!button || !book) return
        switch (button.dataset.action) {
            case 'open':
                dialog.close()
                options.onOpenBook(book.id)
                break
            case 'remove':
                dialog.close()
                options.onRemove(book, opener)
                break
            case 'export':
                if (annotations) void exportHighlights(book, annotations)
                break
        }
    })

    dialog.addEventListener('close', () => {
        // The event comes late. The sheet can be open again for a different book.
        if (dialog.open) return
        shown = null
        annotations = null
    })

    return {
        show(info) {
            shown = info.book
            opener = info.opener
            annotations = null
            fill(info.book, info.fraction)
            openDialog(dialog, info.opener)
            // The browser keeps the scroll offset from the last book, and a write has an
            // effect only while the sheet is open. One layout for each open.
            body.scrollTop = 0
            void loadCover(info.book)
            void loadAnnotations(info.book).catch(() => {
                if (shown !== info.book) return
                setFact('bookmarks', null)
                setFact('highlights', null)
            })
        },
    }
}
