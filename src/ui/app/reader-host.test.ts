import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookRecord, LibraryStorage } from '$lib/storage/types'
import type { MountedReader, ReaderMountOptions } from '../reader/types'
import { APP_TITLE, createReaderHost, LOADING_DELAY_MS } from './reader-host'
import type { ReaderHost, ReaderHostOptions } from './reader-host'
import { createRouter } from './router'
import { mountPage } from './testing/page'

type MountReader = (options: ReaderMountOptions) => Promise<MountedReader>

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve
        reject = onReject
    })
    return { promise, resolve, reject }
}

const books: Record<string, Pick<BookRecord, 'id' | 'title'>> = {
    b1: { id: 'b1', title: 'Anna Karenina' },
    b2: { id: 'b2', title: 'Middlemarch' },
}

let libraryView: HTMLElement
let readerView: HTMLElement
let scrollY: number
let events: string[]
let mounts: ReaderMountOptions[]
let mountReader: ReturnType<typeof vi.fn<MountReader>>
let failures: Parameters<ReaderHostOptions['onOpenFailed']>[0][]

/** A reader that puts one element into the root and takes it out again. */
function fakeReader(options: ReaderMountOptions): Promise<MountedReader> {
    mounts.push(options)
    events.push(`mount ${options.bookId}`)
    const element = document.createElement('p')
    element.className = 'fake-reader'
    element.textContent = options.bookId
    options.root.replaceChildren(element)
    return Promise.resolve({
        destroy: async () => {
            events.push(`destroy ${options.bookId}`)
            options.root.replaceChildren()
        },
    })
}

function makeHost(changes: Partial<ReaderHostOptions> = {}): ReaderHost {
    return createReaderHost({
        libraryView,
        readerView,
        storage: {
            getBook: async (id: string) => books[id],
        } as unknown as LibraryStorage,
        onExit: () => events.push('exit'),
        onOpenFailed(failure) {
            failures.push(failure)
            events.push(`failed ${failure.bookId} ${failure.reason}`)
        },
        onClosed: (bookId) => events.push(`closed ${bookId}`),
        loadReader: async () => ({ mountReader }),
        ...changes,
    })
}

beforeEach(() => {
    mountPage()
    libraryView = document.getElementById('library-view')!
    readerView = document.getElementById('reader-view')!
    document.title = APP_TITLE
    scrollY = 0
    events = []
    mounts = []
    failures = []
    mountReader = vi.fn<MountReader>(fakeReader)
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
    vi.spyOn(window, 'scrollTo').mockImplementation(((_x: number, y: number) => {
        scrollY = y
    }) as typeof window.scrollTo)
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete document.documentElement.dataset.route
})

describe('createReaderHost', () => {
    it('shows the reader view in place of the library at once', () => {
        const host = makeHost()

        host.show('b1')

        expect(libraryView.hidden).toBe(true)
        expect(readerView.hidden).toBe(false)
        expect(host.bookId).toBe('b1')
    })

    it('mounts the reader with the root, the book id and the storage', async () => {
        const host = makeHost()

        host.show('b1')
        await host.settled()

        expect(mountReader).toHaveBeenCalledTimes(1)
        expect(mounts[0].root).toBe(readerView)
        expect(mounts[0].bookId).toBe('b1')
        expect(typeof mounts[0].storage.getBook).toBe('function')
        expect(readerView.querySelector('.fake-reader')?.textContent).toBe('b1')
    })

    it('sets the page title to the book title, and back at the close', async () => {
        const host = makeHost()

        host.show('b1')
        await host.settled()
        expect(document.title).toBe('Anna Karenina')

        host.show(null)
        expect(document.title).toBe('Page Goblin')
    })

    it('destroys the reader, shows the library and reports the closed book', async () => {
        const host = makeHost()
        host.show('b1')
        await host.settled()

        host.show(null)
        expect(libraryView.hidden).toBe(false)
        expect(readerView.hidden).toBe(true)
        await host.settled()

        expect(events).toEqual(['mount b1', 'destroy b1', 'closed b1'])
        expect(readerView.childElementCount).toBe(0)
        expect(host.bookId).toBeNull()
    })

    it('reports the closed book only after the reader saved its state', async () => {
        const destroyed = deferred<void>()
        mountReader.mockImplementation(async (options) => {
            mounts.push(options)
            return { destroy: () => destroyed.promise }
        })
        const host = makeHost()
        host.show('b1')
        await host.settled()

        host.show(null)
        await Promise.resolve()
        expect(events).not.toContain('closed b1')

        destroyed.resolve()
        await host.settled()
        expect(events).toContain('closed b1')
    })

    it('restores the scroll position of the library', async () => {
        const host = makeHost()
        scrollY = 1234

        host.show('b1')
        // A hidden library has no height, so the browser moves the page to the top.
        scrollY = 0
        await host.settled()
        host.show(null)

        expect(window.scrollTo).toHaveBeenCalledWith(0, 1234)
        expect(scrollY).toBe(1234)
    })

    it('uses the position function of the library when there is one', async () => {
        const restore = vi.fn()
        const captureLibraryPosition = vi.fn((_bookId: string) => {
            // The library is still on screen at this time, so it can measure a card.
            expect(libraryView.hidden).toBe(false)
            return restore
        })
        const host = makeHost({ captureLibraryPosition })

        host.show('b1')
        await host.settled()
        // A change from one book to the next does not capture again.
        host.show('b2')
        await host.settled()
        expect(captureLibraryPosition).toHaveBeenCalledTimes(1)
        expect(captureLibraryPosition).toHaveBeenCalledWith('b1')
        expect(restore).not.toHaveBeenCalled()

        host.show(null)
        expect(restore).toHaveBeenCalledTimes(1)
        expect(window.scrollTo).not.toHaveBeenCalled()
    })

    it('passes the exit of the reader on', async () => {
        const host = makeHost()
        host.show('b1')
        await host.settled()

        mounts[0].onExit()

        expect(events).toEqual(['mount b1', 'exit'])
    })

    it('ignores the exit of a reader whose book is not wanted any more', async () => {
        const host = makeHost()
        host.show('b1')
        await host.settled()
        host.show(null)

        mounts[0].onExit()

        expect(events).not.toContain('exit')
    })

    it('goes back to the library when the book is not in storage', async () => {
        const host = makeHost()

        host.show('unknown')
        await host.settled()

        expect(mountReader).not.toHaveBeenCalled()
        expect(failures).toEqual([{ bookId: 'unknown', reason: 'missing', error: undefined }])
        expect(libraryView.hidden).toBe(false)
        expect(readerView.hidden).toBe(true)
        expect(readerView.childElementCount).toBe(0)
        expect(host.bookId).toBeNull()
        expect(document.title).toBe(APP_TITLE)
    })

    it('goes back to the library when the reader does not start', async () => {
        const error = new Error('The file is damaged.')
        mountReader.mockRejectedValue(error)
        const host = makeHost()

        host.show('b1')
        await host.settled()

        expect(failures).toEqual([{ bookId: 'b1', reason: 'error', error }])
        expect(libraryView.hidden).toBe(false)
        expect(document.title).toBe(APP_TITLE)
        expect(events).not.toContain('closed b1')
    })

    it('goes back to the library when the reader screen does not load', async () => {
        const error = new Error('Failed to fetch the chunk')
        const host = makeHost({ loadReader: () => Promise.reject(error) })

        host.show('b1')
        await host.settled()

        expect(failures).toEqual([{ bookId: 'b1', reason: 'error', error }])
        expect(libraryView.hidden).toBe(false)
    })

    it('tries the same book again after a failure', async () => {
        mountReader.mockRejectedValueOnce(new Error('once'))
        const host = makeHost()
        host.show('b1')
        await host.settled()

        host.show('b1')
        await host.settled()

        expect(mountReader).toHaveBeenCalledTimes(2)
        expect(readerView.querySelector('.fake-reader')).not.toBeNull()
    })

    it('shows a loading state only when the load takes longer than the delay', async () => {
        vi.useFakeTimers()
        const module = deferred<{ mountReader: MountReader }>()
        const host = makeHost({ loadReader: () => module.promise })

        host.show('b1')
        await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS - 1)
        expect(readerView.querySelector('.reader-loading')).toBeNull()

        await vi.advanceTimersByTimeAsync(1)
        const loading = readerView.querySelector('.reader-loading')
        expect(loading?.getAttribute('role')).toBe('status')
        expect(loading?.textContent).toContain('Opening the book')

        module.resolve({ mountReader })
        await host.settled()
        expect(readerView.querySelector('.reader-loading')).toBeNull()
        expect(readerView.querySelector('.fake-reader')).not.toBeNull()
    })

    it('shows no loading state for a fast load', async () => {
        vi.useFakeTimers()
        const host = makeHost()

        host.show('b1')
        await host.settled()
        await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS * 2)

        expect(readerView.querySelector('.reader-loading')).toBeNull()
        expect(readerView.querySelector('.fake-reader')).not.toBeNull()
    })

    it('gives the reader an empty root', async () => {
        vi.useFakeTimers()
        const module = deferred<{ mountReader: MountReader }>()
        let childrenAtMount = -1
        mountReader.mockImplementation(async (options) => {
            childrenAtMount = options.root.childElementCount
            return { destroy: async () => {} }
        })
        const host = makeHost({ loadReader: () => module.promise })

        host.show('b1')
        await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS)
        module.resolve({ mountReader })
        await host.settled()

        expect(childrenAtMount).toBe(0)
    })

    it('does not mount a book that was closed while the reader screen loaded', async () => {
        const module = deferred<{ mountReader: MountReader }>()
        const host = makeHost({ loadReader: () => module.promise })

        host.show('b1')
        host.show(null)
        module.resolve({ mountReader })
        await host.settled()

        expect(mountReader).not.toHaveBeenCalled()
        expect(failures).toEqual([])
        expect(libraryView.hidden).toBe(false)
        expect(readerView.childElementCount).toBe(0)
    })

    it('destroys a reader that finished its mount after the book was closed', async () => {
        const mounted = deferred<MountedReader>()
        mountReader.mockImplementation((options) => {
            events.push(`mount ${options.bookId}`)
            return mounted.promise
        })
        const host = makeHost()
        host.show('b1')
        await vi.waitFor(() => expect(mountReader).toHaveBeenCalled())

        host.show(null)
        mounted.resolve({ destroy: async () => void events.push('destroy b1') })
        await host.settled()

        expect(events).toEqual(['mount b1', 'destroy b1', 'closed b1'])
    })

    it('keeps a reader that still mounts, and its title, for Back and then Forward', async () => {
        const reader = deferred<MountedReader>()
        mountReader.mockImplementation(() => reader.promise)
        const host = makeHost()
        host.show('b1')
        await vi.waitFor(() => expect(mountReader).toHaveBeenCalled())

        host.show(null)
        expect(document.title).toBe(APP_TITLE)
        host.show('b1')
        reader.resolve({ destroy: async () => void events.push('destroy b1') })
        await host.settled()

        expect(mountReader).toHaveBeenCalledTimes(1)
        expect(events).toEqual([])
        expect(document.title).toBe('Anna Karenina')
        expect(libraryView.hidden).toBe(true)
    })

    it('closes the open book before it opens a different one', async () => {
        const host = makeHost()
        host.show('b1')
        await host.settled()

        host.show('b2')
        await host.settled()

        expect(events).toEqual(['mount b1', 'destroy b1', 'closed b1', 'mount b2'])
        expect(document.title).toBe('Middlemarch')
        expect(libraryView.hidden).toBe(true)
        expect(readerView.querySelector('.fake-reader')?.textContent).toBe('b2')
    })

    it('opens only the last book of fast changes', async () => {
        const host = makeHost()

        host.show('b1')
        host.show('b2')
        host.show('b1')
        host.show('b2')
        await host.settled()

        expect(events).toEqual(['mount b2'])
    })

    it('still reports the closed book when the reader fails in destroy', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        mountReader.mockResolvedValue({
            destroy: () => Promise.reject(new Error('The save failed.')),
        })
        const host = makeHost()
        host.show('b1')
        await host.settled()

        host.show(null)
        await host.settled()

        expect(events).toEqual(['closed b1'])
        expect(error).toHaveBeenCalledTimes(1)
    })

    it('does nothing when the library is asked for and is on screen', async () => {
        const host = makeHost()

        host.show(null)
        await host.settled()

        expect(events).toEqual([])
        expect(window.scrollTo).not.toHaveBeenCalled()
        expect(libraryView.hidden).toBe(false)
    })

    describe('a book with no file on this device', () => {
        const remote = { id: 'r1', title: 'Persuasion', remoteOnly: true }

        function makeRemoteHost(changes: Partial<ReaderHostOptions> = {}): ReaderHost {
            return makeHost({
                storage: {
                    getBook: async (id: string) => (id === 'r1' ? remote : books[id]),
                } as unknown as LibraryStorage,
                ...changes,
            })
        }

        it('downloads the file before the reader mounts', async () => {
            const download = deferred<void>()
            const downloadFile = vi.fn(() => download.promise)
            const host = makeRemoteHost({ downloadFile })

            host.show('r1')
            await vi.waitFor(() => expect(downloadFile).toHaveBeenCalledWith(remote))
            expect(mountReader).not.toHaveBeenCalled()

            download.resolve()
            await host.settled()
            expect(mounts.map((mount) => mount.bookId)).toEqual(['r1'])
        })

        it('reports a failed download and shows the library', async () => {
            const error = new Error('The sync server did not answer.')
            const host = makeRemoteHost({ downloadFile: () => Promise.reject(error) })

            host.show('r1')
            await host.settled()

            expect(failures).toEqual([{ bookId: 'r1', reason: 'download', error }])
            expect(mountReader).not.toHaveBeenCalled()
            expect(libraryView.hidden).toBe(false)
        })

        it('does not open the book with the sync off', async () => {
            const host = makeRemoteHost()

            host.show('r1')
            await host.settled()

            expect(failures[0].reason).toBe('download')
            expect(String(failures[0].error)).toContain('Turn on sync')
        })

        it('does not mount a book that the user left during the download', async () => {
            const download = deferred<void>()
            const host = makeRemoteHost({ downloadFile: () => download.promise })

            host.show('r1')
            await vi.waitFor(() => expect(readerView.hidden).toBe(false))
            host.show(null)
            download.resolve()
            await host.settled()

            expect(mountReader).not.toHaveBeenCalled()
            expect(failures).toEqual([])
        })
    })

    it('gives a position from a different device to the reader of that book only', async () => {
        const offerPosition = vi.fn()
        mountReader.mockImplementation(async (options) => {
            await fakeReader(options)
            return { destroy: async () => options.root.replaceChildren(), offerPosition }
        })
        const host = makeHost()
        const progress = (bookId: string) => ({
            bookId,
            locator: { spineIndex: 1, offset: 10 },
            fraction: 0.6,
            updatedAt: 5000,
        })

        host.show('b1')
        await host.settled()
        host.offerPosition(progress('b2'))
        host.offerPosition(progress('b1'))

        expect(offerPosition.mock.calls).toEqual([[progress('b1')]])
    })
})

// theme-init.js hides the library before the first paint for each hash that starts with
// '#/book/'. shell.css does that with the data-route mark, which jsdom does not apply.
describe('the mark that theme-init.js sets for a book address', () => {
    const root = document.documentElement
    const themeInit = readFileSync(
        join(import.meta.dirname, '../../../public/theme-init.js'),
        'utf8',
    )

    /** Loads the page at the hash: the script of index.html runs, then the router starts. */
    function loadPageAt(hash: string): { host: ReaderHost; stop(): void } {
        history.replaceState(null, '', hash)
        new Function(themeInit)()
        const host = makeHost()
        const router = createRouter({
            onRoute: (route) => host.show(route.name === 'book' ? route.bookId : null),
        })
        router.start()
        return { host, stop: () => router.destroy() }
    }

    afterEach(() => {
        history.replaceState(null, '', '#/')
    })

    it('is gone when the reader shows the book of the address', async () => {
        const { host, stop } = loadPageAt('#/book/b1')
        await host.settled()

        expect(root.dataset.route).toBeUndefined()
        expect(libraryView.hidden).toBe(true)
        expect(readerView.querySelector('.fake-reader')?.textContent).toBe('b1')
        stop()
    })

    it.each(['#/book/', '#/book/b1/', '#/book/a/b', '#/book/%E0%A4%A'])(
        'is gone and the library shows for the bad book address %s',
        async (hash) => {
            const { host, stop } = loadPageAt(hash)
            await host.settled()

            expect(root.dataset.route).toBeUndefined()
            expect(libraryView.hidden).toBe(false)
            expect(readerView.hidden).toBe(true)
            expect(host.bookId).toBeNull()
            expect(mountReader).not.toHaveBeenCalled()
            // The address shows what is on screen.
            expect(location.hash).toBe('#/')
            stop()
        },
    )

    it('is gone when the library is asked for and is on screen', () => {
        root.dataset.route = 'book'
        const host = makeHost()

        host.show(null)

        expect(root.dataset.route).toBeUndefined()
        expect(libraryView.hidden).toBe(false)
    })
})
