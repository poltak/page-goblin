import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsStore } from '$lib/settings/store'
import type { LibraryStorage } from '$lib/storage/types'
import { installOverlayMethods } from '../../app/testing/page'
import { clearToasts } from '../../app/toast'
import type { OpenReaderSessionOptions, ReaderSession } from '../types'
import { SPINNER_DELAY_MS, startReader } from './start'
import type { StartedReader } from './start'
import { makeFakeParts, makeFakeSession } from './testing/fake-session'
import type { FakeSession } from './testing/fake-session'

const cleanups: Array<() => void> = []
const storage = {} as LibraryStorage

interface Open {
    resolve(session: ReaderSession): void
    reject(error: unknown): void
}

function setup() {
    const root = document.createElement('div')
    root.id = 'reader-view'
    document.body.append(root)
    const session = makeFakeSession()
    const parts = makeFakeParts(session)
    const settings = createSettingsStore({ storage: null })
    cleanups.push(() => settings.destroy())
    const onExit = vi.fn()

    let open!: Open
    const openSession = vi.fn(
        (_options: OpenReaderSessionOptions & { signal: AbortSignal }) =>
            new Promise<ReaderSession>((resolve, reject) => (open = { resolve, reject })),
    )
    const reader = startReader(
        { root, bookId: 'book-1', storage, onExit },
        { openSession, settings, parts: parts.factories },
    )
    // The listeners of an open screen are on the window, so each test must remove its reader.
    cleanups.unshift(() => void reader.destroy())
    return {
        root,
        session,
        parts,
        onExit,
        openSession,
        reader,
        resolve: (value: ReaderSession = session) => open.resolve(value),
        reject: (error: unknown) => open.reject(error),
    }
}

async function flush(): Promise<void> {
    for (let round = 0; round < 20; round++) await Promise.resolve()
}

/** 'resolved', 'rejected' or 'pending', after the promises that are ready now ran. */
async function stateOf(promise: Promise<unknown>): Promise<string> {
    let state = 'pending'
    promise.then(
        () => (state = 'resolved'),
        () => (state = 'rejected'),
    )
    await flush()
    return state
}

function barsVisible(root: HTMLElement): boolean {
    return !root.querySelector('.reader-bar-top')!.hasAttribute('inert')
}

function status(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>('.reader-status')!
}

function listenersOf(session: FakeSession): number {
    return session.listenerCount()
}

async function destroyAndWait(reader: StartedReader): Promise<void> {
    await reader.destroy()
}

beforeAll(installOverlayMethods)

beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    clearToasts()
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('startReader', () => {
    it('puts the screen into the root at once', () => {
        const { root } = setup()
        const screen = root.querySelector('.reader-screen')
        expect(screen).not.toBeNull()
        expect(root.children).toHaveLength(1)
        expect(screen?.querySelector('.reader-head')).not.toBeNull()
        expect(screen?.querySelector('.reader-stage')).not.toBeNull()
        expect(screen?.querySelector('.reader-dock')).not.toBeNull()
        expect(screen?.querySelector('.reader-foot')).not.toBeNull()
        expect(screen?.querySelector('.reader-overlay')).not.toBeNull()
    })

    it('replaces what the root had before', () => {
        const root = document.createElement('div')
        root.innerHTML = '<p class="old">Old</p>'
        document.body.append(root)
        const settings = createSettingsStore({ storage: null })
        cleanups.push(() => settings.destroy())
        const session = makeFakeSession()
        startReader(
            { root, bookId: 'book-1', storage, onExit: vi.fn() },
            {
                openSession: async () => session,
                settings,
                parts: makeFakeParts(session).factories,
            },
        )
        expect(root.querySelector('.old')).toBeNull()
        expect(root.querySelector('.reader-screen')).not.toBeNull()
    })

    it('opens the session with the stage as its container', async () => {
        const { root, openSession } = setup()
        await flush()
        expect(openSession).toHaveBeenCalledTimes(1)
        expect(openSession).toHaveBeenCalledWith({
            bookId: 'book-1',
            storage,
            container: root.querySelector('.reader-stage'),
            signal: expect.any(AbortSignal),
        })
    })

    it('keeps the bars hidden and inert while the book opens', async () => {
        const { root } = setup()
        await flush()
        expect(barsVisible(root)).toBe(false)
        expect(root.querySelector('.reader-bar-bottom')!.hasAttribute('inert')).toBe(true)
    })

    it('shows the spinner only after 200 ms', async () => {
        const { root } = setup()
        await flush()
        expect(SPINNER_DELAY_MS).toBe(200)
        vi.advanceTimersByTime(SPINNER_DELAY_MS - 1)
        expect(status(root).hidden).toBe(true)
        expect(root.querySelector('.spinner')).toBeNull()

        vi.advanceTimersByTime(1)
        expect(status(root).hidden).toBe(false)
        expect(root.querySelector('.spinner')).not.toBeNull()
        expect(status(root).querySelector('[role="status"]')?.textContent).toContain(
            'Opening the book',
        )
    })

    it('shows no spinner for a book that opens fast', async () => {
        const { root, resolve } = setup()
        await flush()
        vi.advanceTimersByTime(SPINNER_DELAY_MS - 50)
        resolve()
        await flush()
        vi.advanceTimersByTime(1000)
        expect(root.querySelector('.spinner')).toBeNull()
        expect(status(root).hidden).toBe(true)
    })

    it('connects the screen when the book is open', async () => {
        const { root, reader, session, resolve } = setup()
        await flush()
        vi.advanceTimersByTime(SPINNER_DELAY_MS)
        expect(await stateOf(reader.ready)).toBe('pending')

        resolve()
        expect(await stateOf(reader.ready)).toBe('resolved')
        expect(root.querySelector('.spinner')).toBeNull()
        expect(status(root).hidden).toBe(true)
        expect(barsVisible(root)).toBe(true)
        expect(root.querySelector('.reader-head-text')?.textContent).toBe('Chapter One')
        expect(root.querySelector('.reader-book-title')?.textContent).toBe('The Test Book')
        expect(listenersOf(session)).toBeGreaterThan(0)
    })

    it('calls onExit for the button back to the library', async () => {
        const { root, onExit, resolve } = setup()
        await flush()
        resolve()
        await flush()
        root.querySelector<HTMLButtonElement>('[data-screen-action="exit"]')!.click()
        expect(onExit).toHaveBeenCalledTimes(1)
    })

    it('closes the screen and the session in destroy()', async () => {
        const { root, reader, session, resolve } = setup()
        await flush()
        resolve()
        await flush()

        await destroyAndWait(reader)
        expect(session.destroy).toHaveBeenCalledTimes(1)
        expect(listenersOf(session)).toBe(0)
        expect(root.children).toHaveLength(0)
    })

    it('closes the session one time for two destroy() calls', async () => {
        const { reader, session, resolve } = setup()
        await flush()
        resolve()
        await flush()
        const first = reader.destroy()
        expect(reader.destroy()).toBe(first)
        await first
        expect(session.destroy).toHaveBeenCalledTimes(1)
    })

    describe('a book that does not open', () => {
        it('shows a message with a button back to the library', async () => {
            const { root, reader, onExit, reject } = setup()
            await flush()
            vi.advanceTimersByTime(SPINNER_DELAY_MS)
            reject(new Error('The package document is not well-formed XML.'))

            expect(await stateOf(reader.ready)).toBe('resolved')
            expect(root.querySelector('.spinner')).toBeNull()
            expect(status(root).hidden).toBe(false)
            expect(status(root).querySelector('[role="alert"]')).not.toBeNull()
            expect(status(root).querySelector('.empty-state-title')?.textContent).toBe(
                'This book did not open.',
            )
            const button = status(root).querySelector('button')!
            expect(button.textContent).toBe('Back to the library')
            expect(document.activeElement).toBe(button)
            expect(barsVisible(root)).toBe(false)

            button.click()
            expect(onExit).toHaveBeenCalledTimes(1)
        })

        it('shows the message for an error that is not an Error object', async () => {
            const { root, reader, reject } = setup()
            await flush()
            reject('book-not-found')
            expect(await stateOf(reader.ready)).toBe('resolved')
            expect(status(root).querySelector('.empty-state-title')).not.toBeNull()
        })

        it('shows the message when the open function throws', async () => {
            const root = document.createElement('div')
            document.body.append(root)
            const settings = createSettingsStore({ storage: null })
            cleanups.push(() => settings.destroy())
            const session = makeFakeSession()
            const reader = startReader(
                { root, bookId: 'book-1', storage, onExit: vi.fn() },
                {
                    openSession: () => {
                        throw new Error('no storage')
                    },
                    settings,
                    parts: makeFakeParts(session).factories,
                },
            )
            expect(await stateOf(reader.ready)).toBe('resolved')
            expect(status(root).querySelector('.empty-state-title')).not.toBeNull()
        })

        it('uses no key and loads no part', async () => {
            const { parts, session, reject } = setup()
            await flush()
            reject(new Error('damaged file'))
            await flush()
            vi.advanceTimersByTime(5000)
            await flush()
            document.body.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
            )
            expect(session.next).not.toHaveBeenCalled()
            for (const factory of Object.values(parts.factories)) {
                expect(factory).not.toHaveBeenCalled()
            }
        })

        it('stops cleanly in destroy()', async () => {
            const { root, reader, session, reject } = setup()
            await flush()
            reject(new Error('damaged file'))
            await flush()
            await destroyAndWait(reader)
            expect(root.children).toHaveLength(0)
            expect(session.destroy).not.toHaveBeenCalled()
        })
    })

    describe('a book that is not in the library', () => {
        it('rejects with the error of the session, so the app shell handles it', async () => {
            const { root, reader, reject } = setup()
            await flush()
            vi.advanceTimersByTime(SPINNER_DELAY_MS)
            const error = new Error('book-not-found')
            reject(error)

            await expect(reader.ready).rejects.toBe(error)
            expect(root.children).toHaveLength(0)
        })

        it('shows no message of its own', async () => {
            const { root, reader, reject } = setup()
            await flush()
            reject(new Error('book-not-found'))
            await expect(reader.ready).rejects.toThrow('book-not-found')
            expect(root.querySelector('.empty-state')).toBeNull()
            expect(document.querySelector('#toasts .toast')).toBeNull()
        })

        it('resolves destroy() after the rejection', async () => {
            const { reader, reject } = setup()
            await flush()
            reject(new Error('book-not-found'))
            await expect(reader.ready).rejects.toThrow()
            await expect(reader.destroy()).resolves.toBeUndefined()
        })
    })

    describe('destroy() during the open', () => {
        it('waits for the open, then closes the session and makes no screen', async () => {
            const { root, reader, session, parts, resolve } = setup()
            await flush()
            vi.advanceTimersByTime(SPINNER_DELAY_MS)
            const closed = reader.destroy()
            expect(await stateOf(closed)).toBe('pending')
            expect(session.destroy).not.toHaveBeenCalled()

            resolve()
            expect(await stateOf(closed)).toBe('resolved')
            expect(session.destroy).toHaveBeenCalledTimes(1)
            expect(listenersOf(session)).toBe(0)
            expect(root.children).toHaveLength(0)

            vi.advanceTimersByTime(5000)
            await flush()
            for (const factory of Object.values(parts.factories)) {
                expect(factory).not.toHaveBeenCalled()
            }
        })

        it('stops the open, so a view that waits for a size does not keep the reader', async () => {
            const { root, reader, session, openSession, reject } = setup()
            await flush()
            const { signal } = openSession.mock.calls[0][0]
            expect(signal.aborted).toBe(false)

            const closed = reader.destroy()
            expect(signal.aborted).toBe(true)
            // The real open rejects when its signal aborts.
            const stopped = new Error('The open was stopped.')
            stopped.name = 'AbortError'
            reject(stopped)

            expect(await stateOf(closed)).toBe('resolved')
            expect(await stateOf(reader.ready)).toBe('resolved')
            expect(session.destroy).not.toHaveBeenCalled()
            expect(root.children).toHaveLength(0)
            expect(document.querySelector('#toasts .toast')).toBeNull()
        })

        it('does not stop the open of a book that is on screen', async () => {
            const { reader, openSession, resolve } = setup()
            await flush()
            resolve()
            await reader.ready
            expect(openSession.mock.calls[0][0].signal.aborted).toBe(false)
        })

        it('resolves the ready promise, so the caller gets the reader', async () => {
            const { reader, resolve } = setup()
            await flush()
            void reader.destroy()
            resolve()
            expect(await stateOf(reader.ready)).toBe('resolved')
        })

        it('shows no spinner after destroy()', async () => {
            const { root, reader } = setup()
            await flush()
            void reader.destroy()
            vi.advanceTimersByTime(SPINNER_DELAY_MS * 2)
            expect(root.querySelector('.spinner')).toBeNull()
        })

        it('shows no message when the open fails after destroy()', async () => {
            const { root, reader, reject } = setup()
            await flush()
            const closed = reader.destroy()
            reject(new Error('damaged file'))
            expect(await stateOf(closed)).toBe('resolved')
            expect(await stateOf(reader.ready)).toBe('resolved')
            expect(root.children).toHaveLength(0)
        })

        it('does not reject for a book that is not in the library after destroy()', async () => {
            const { reader, reject } = setup()
            await flush()
            const closed = reader.destroy()
            reject(new Error('book-not-found'))
            expect(await stateOf(closed)).toBe('resolved')
            expect(await stateOf(reader.ready)).toBe('resolved')
        })
    })
})

describe('a position from a different device', () => {
    const progress = (spineIndex: number, offset: number, fraction: number) => ({
        bookId: 'book-1',
        locator: { spineIndex, offset },
        fraction,
        updatedAt: 5000,
    })
    const toastTexts = () =>
        Array.from(document.querySelectorAll('#toasts .toast span')).map((item) => item.textContent)

    it('offers to go to a position that is not on screen', async () => {
        const { reader, resolve, session } = setup()
        await flush()
        resolve()
        await flush()

        // The fake session shows the text from 80 to 140 of chapter 1.
        reader.offerPosition(progress(1, 100, 0.3))
        expect(toastTexts()).toEqual([])

        reader.offerPosition(progress(2, 5, 0.62))
        expect(toastTexts()).toEqual(['You read to 62% on a different device.'])

        document.querySelector<HTMLButtonElement>('#toasts .toast button')!.click()
        expect(session.goTo).toHaveBeenCalledWith({ spineIndex: 2, offset: 5 }, { remember: true })
    })

    it('offers nothing before the book is open or after the reader is gone', async () => {
        const { reader, resolve } = setup()
        reader.offerPosition(progress(2, 5, 0.62))
        await flush()
        resolve()
        await flush()
        await reader.destroy()
        reader.offerPosition(progress(2, 5, 0.62))

        expect(toastTexts()).toEqual([])
    })
})

describe('annotations from a different device', () => {
    it('makes the open session read its annotations again', async () => {
        const { reader, resolve, session } = setup()
        reader.annotationsChanged()
        expect(session.reloadAnnotations).not.toHaveBeenCalled()

        await flush()
        resolve()
        await flush()
        reader.annotationsChanged()

        expect(session.reloadAnnotations).toHaveBeenCalledTimes(1)
    })
})

describe('fonts from a different device', () => {
    it('makes the open session read the fonts of the user again', async () => {
        const { reader, resolve, session } = setup()
        const refresh = vi.spyOn(session.fonts, 'refresh')
        reader.fontsChanged()

        await flush()
        resolve()
        await flush()
        reader.fontsChanged()

        expect(refresh).toHaveBeenCalledTimes(1)
    })
})
