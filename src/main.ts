/**
 * The start of the app. Only the code for the first paint of the library is imported here.
 * The importer, the EPUB parser, the reader, the annotations and the sync load at their first
 * use.
 */

// This module adds its install prompt listener on import, so it must load at the start.
import '$lib/pwa/install'
import { onFilesLaunched } from '$lib/pwa/launch'
import { applyUpdate, registerServiceWorker } from '$lib/pwa/register'
import { settings } from '$lib/settings/store'
// Not from the index file of the storage module, which also has the importer.
import { createLibraryStorage } from '$lib/storage/library-storage'
import { createReaderHost } from './ui/app/reader-host'
import { createRouter } from './ui/app/router'
import { connectTheme } from './ui/app/theme'
import { showToast } from './ui/app/toast'
import { qs } from './ui/dom'
import { createLibraryScreen } from './ui/library'
import { createSyncHost } from './ui/sync/host'

connectTheme(settings)

// The app puts the library back at its place when a book closes. Without this, the browser
// then sets its own scroll offset for the history entry, which is less exact.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

// With the sync off, the sync host loads no sync code and the storage writes no outbox.
const sync = createSyncHost({
    onChanges(changes) {
        void library.applySyncChanges(changes.books)
        for (const progress of changes.progress) readerHost.offerPosition(progress)
    },
})
const storage = createLibraryStorage({ changes: sync.tracker })
sync.connectStorage(storage)
const libraryView = qs('#library-view')

// A link from a device that syncs: '#sync&server=...&code=...'. The secret must not stay in
// the address bar or in the history.
const syncLink = location.hash.startsWith('#sync&') ? location.hash : null
if (syncLink) history.replaceState(history.state, '', '#/')

const library = createLibraryScreen({
    root: libraryView,
    storage,
    settings,
    onOpenBook: (bookId) => router.openBook(bookId),
    sync,
})

const readerHost = createReaderHost({
    libraryView,
    readerView: qs('#reader-view'),
    storage,
    onExit: () => router.closeBook(),
    onOpenFailed({ bookId, reason, error }) {
        if (error) console.error(error)
        router.closeBook()
        // A different tab removed the book. Its card must not stay in the grid.
        if (reason === 'missing') void library.refreshBook(bookId)
        const messages = {
            missing: 'This book is not in your library.',
            download: `The book did not download. ${error instanceof Error ? error.message : ''}`,
            error: 'The book did not open. Try again.',
        }
        showToast({ message: messages[reason].trim(), tone: 'error' })
    },
    downloadFile: (book) => sync.downloadFile(book),
    onClosed: (bookId) => void library.refreshBook(bookId),
    captureLibraryPosition: (bookId) => library.capturePosition(bookId),
})

const router = createRouter({
    onRoute(route) {
        if (route.name === 'book') {
            readerHost.show(route.bookId)
        } else {
            readerHost.show(null)
            void library.load()
        }
    },
})

router.start()
sync.start()

// A page that starts on a book does not need the library at once. It reads the books when
// the browser has time, so the grid is there when the reader closes.
if (router.route.name === 'book') {
    const whenIdle: (work: () => void) => void =
        window.requestIdleCallback?.bind(window) ?? ((work) => setTimeout(work, 500))
    whenIdle(() => void library.load())
}

registerServiceWorker({
    onUpdateReady() {
        showToast({
            message: 'A new version is ready',
            action: { label: 'Reload', onSelect: applyUpdate },
            duration: 30_000,
        })
    },
})

if (syncLink) {
    void import('./lib/sync/code').then(({ parseSyncLink }) => {
        const link = parseSyncLink(syncLink)
        if (link) sync.openDialog(null, link)
    })
}

// Files that the system gives to the installed app, at the start or while the app is open.
onFilesLaunched((files) => {
    void library.importFiles(files).then((summary) => {
        if (summary.added.length === 1) router.openBook(summary.added[0].id)
    })
})
