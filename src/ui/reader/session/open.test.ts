import { describe, expect, it, vi } from 'vitest'
import type { EpubBook } from '$lib/epub/types'
import { openEpub } from '$lib/epub'
import { ensureFontLoaded } from '$lib/fonts'
import type { ReaderViewOptions } from '$lib/reader/types'
import { settings, systemPrefersDark, watchSystemTheme } from '$lib/settings'
import type { LibraryStorage } from '$lib/storage/types'
import type { SessionParts } from './open-with'

// `open.ts` imports the reader views, which are the work of a different module. A test file
// cannot load a module that is not there, so these tests run only when it is.
const hasReaderModule = Object.keys(import.meta.glob('/src/lib/reader/index.ts')).length > 0

const mocks = vi.hoisted(() => ({
    createContentLoader: vi.fn((_options: unknown): unknown => 'content loader'),
    createPagedView: vi.fn((_options: unknown): unknown => 'paged view'),
    createScrollView: vi.fn((_options: unknown): unknown => 'scroll view'),
    openSessionWith: vi.fn(async (_options: unknown, _parts: unknown): Promise<unknown> => {
        return 'session'
    }),
}))

vi.mock('$lib/reader', () => ({
    createPagedView: mocks.createPagedView,
    createScrollView: mocks.createScrollView,
}))

vi.mock('$lib/content', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/content')>()),
    createContentLoader: mocks.createContentLoader,
}))

vi.mock('./open-with', () => ({ openSessionWith: mocks.openSessionWith }))

describe.skipIf(!hasReaderModule)('openReaderSession', () => {
    it('opens the session with the real modules', async () => {
        const { openReaderSession } = await import('./open')
        const options = {
            bookId: 'book-1',
            storage: {} as LibraryStorage,
            container: document.createElement('div'),
        }

        expect(await openReaderSession(options)).toBe('session')

        expect(mocks.openSessionWith).toHaveBeenCalledTimes(1)
        const [given, parts] = mocks.openSessionWith.mock.calls[0] as [unknown, SessionParts]
        expect(given).toBe(options)
        expect(parts.openEpub).toBe(openEpub)
        // The scroll view can show 8 chapters, so the loader keeps more than that.
        const book = {} as EpubBook
        expect(parts.createContentLoader({ book })).toBe('content loader')
        expect(mocks.createContentLoader).toHaveBeenCalledWith({ book, cacheSize: 12 })
        expect(parts.loadFont).toBe(ensureFontLoaded)
        expect(parts.settings).toBe(settings)
        expect(parts.systemDark).toBe(systemPrefersDark)
        expect(parts.watchSystemTheme).toBe(watchSystemTheme)
        expect(parts.now).toBe(Date.now)

        const viewOptions = { initial: { spineIndex: 0, offset: 0 } } as ReaderViewOptions
        expect(parts.createView('paged', viewOptions)).toBe('paged view')
        expect(mocks.createPagedView).toHaveBeenCalledWith(viewOptions)
        expect(mocks.createScrollView).not.toHaveBeenCalled()

        expect(parts.createView('scroll', viewOptions)).toBe('scroll view')
        expect(mocks.createScrollView).toHaveBeenCalledWith(viewOptions)
        expect(mocks.createPagedView).toHaveBeenCalledTimes(1)
    })
})
