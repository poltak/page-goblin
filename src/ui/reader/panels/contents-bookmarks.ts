/** The Bookmarks tab of the contents panel. */

import type { BookmarkRecord } from '$lib/storage/types'
import { on, qs } from '../../dom'
import type { ReaderSession } from '../types'
import { createKeyedList, ignoreRejection, percentText, renderKeepingFocus } from './shared'
import type { Notice } from './shared'

export interface BookmarksViewOptions {
    session: ReaderSession
    /** The tab panel of this view. */
    pane: HTMLElement
    notice: Notice
    makeRow(): HTMLElement
    /** Gets the focus when the last bookmark is removed. */
    focusFallback: HTMLElement
    /** The user chose a bookmark. The panel closes. */
    onGo(): void
}

export interface BookmarksView {
    render(): void
}

export function createBookmarksView(options: BookmarksViewOptions): BookmarksView {
    const { session, pane, notice } = options
    const list = qs('.list', pane)
    const empty = qs('.empty-state', pane)

    const keyed = createKeyedList<BookmarkRecord>({
        list,
        key: (bookmark) => bookmark.id,
        create: options.makeRow,
        fill(row, bookmark) {
            const title = bookmark.chapterTitle.trim()
            const excerpt = bookmark.excerpt.trim()
            // A book with no contents list has no chapter titles. The excerpt is the title then.
            qs('.list-row-title', row).textContent = title || excerpt || 'Bookmark'
            const meta = qs('.list-row-meta', row)
            meta.textContent = title ? excerpt : ''
            meta.hidden = meta.textContent === ''
            qs('.list-row-trail', row).textContent = percentText(bookmark.fraction)
        },
    })

    async function remove(bookmark: BookmarkRecord): Promise<void> {
        try {
            await session.removeBookmark(bookmark.id)
        } catch {
            notice.show({ message: 'The bookmark was not removed.', tone: 'error' })
        }
    }

    on(list, 'click', (event) => {
        const target = event.target as Element
        const bookmark = keyed.itemOf(target)
        if (!bookmark) return
        if (target.closest('[data-remove]')) {
            void remove(bookmark)
        } else if (target.closest('[data-go]')) {
            ignoreRejection(session.goTo(bookmark.locator, { remember: true }))
            options.onGo()
        }
    })

    return {
        render() {
            const bookmarks = session.bookmarks
            renderKeepingFocus({
                list,
                render: () => keyed.render(bookmarks),
                fallback: options.focusFallback,
            })
            list.hidden = bookmarks.length === 0
            empty.hidden = bookmarks.length > 0
        },
    }
}
