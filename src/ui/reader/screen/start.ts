/**
 * The open sequence of the reader screen: the screen shows at once with a quiet loading
 * state, then the book opens, then the screen connects to the session.
 */

import type { SettingsStore } from '$lib/settings/store'
import type { ProgressRecord } from '$lib/storage/types'
import { isLocatorInRange } from '$lib/types'
import { showToast } from '../../app/toast'
import type {
    MountedReader,
    OpenReaderSessionOptions,
    ReaderMountOptions,
    ReaderSession,
} from '../types'
import { createFrame } from './frame'
import { createReaderScreen } from './screen'
import type { PartFactories, ReaderScreen } from './screen'

/** A book that opens faster than this shows no spinner. */
export const SPINNER_DELAY_MS = 200

/** The message of the error that the session gives for a book that is not in the library. */
export const BOOK_NOT_FOUND = 'book-not-found'

export interface ReaderDeps {
    /** `signal` aborts when the reader is destroyed before the book is open. */
    openSession(options: OpenReaderSessionOptions & { signal: AbortSignal }): Promise<ReaderSession>
    settings: SettingsStore
    parts: PartFactories
}

/** How long the offer of a position from a different device stays on screen. */
export const OFFER_DURATION_MS = 15_000

export interface StartedReader extends Required<MountedReader> {
    /**
     * Resolves when the book is on screen, when the screen shows that the book did not open,
     * and when destroy() ran before the open ended. Rejects for a book that is not in the
     * library. The app shell then shows its own message.
     */
    readonly ready: Promise<void>
}

function ignore(): void {}

export function startReader(options: ReaderMountOptions, deps: ReaderDeps): StartedReader {
    const { root, bookId, storage, onExit } = options
    const frame = createFrame()
    root.replaceChildren(frame.root)

    let screen: ReaderScreen | null = null
    let openSession: ReaderSession | null = null
    let destroyed = false
    let closing: Promise<void> | null = null
    /**
     * Stops an open that runs. The app shell hides the reader view when the user leaves, and
     * the view of a hidden reader waits for a size with no time limit.
     */
    const opening = new AbortController()
    const spinner = setTimeout(() => frame.showLoading(), SPINNER_DELAY_MS)

    const ready = Promise.resolve()
        // An error that openSession throws before its first await is also a failed open.
        .then(() =>
            deps.openSession({
                bookId,
                storage,
                container: frame.stage,
                signal: opening.signal,
            }),
        )
        .then(
            async (session) => {
                clearTimeout(spinner)
                if (destroyed) {
                    // The user left during the open.
                    await session.destroy()
                    return
                }
                frame.clearStatus()
                try {
                    screen = createReaderScreen({
                        frame,
                        session,
                        settings: deps.settings,
                        parts: deps.parts,
                        onExit,
                    })
                    openSession = session
                } catch (error) {
                    console.error(error)
                    await session.destroy()
                    if (!destroyed) frame.showOpenError(onExit)
                }
            },
            (error: unknown) => {
                clearTimeout(spinner)
                if (destroyed) return
                if (error instanceof Error && error.message === BOOK_NOT_FOUND) {
                    frame.root.remove()
                    throw error
                }
                console.error(error)
                frame.showOpenError(onExit)
            },
        )
    // destroy() can run before a caller waits for `ready`.
    ready.catch(ignore)

    async function close(): Promise<void> {
        destroyed = true
        clearTimeout(spinner)
        opening.abort()
        // The open ends first: with an error when it stopped, or with a session that closes.
        await ready.catch(ignore)
        await screen?.destroy()
        frame.root.remove()
    }

    function offerPosition(progress: ProgressRecord): void {
        const session = openSession
        const here = session?.position
        if (!session || !here || destroyed) return
        if (isLocatorInRange(progress.locator, here.visible)) return
        const percent = Math.round(progress.fraction * 100)
        showToast({
            message: `You read to ${percent}% on a different device.`,
            action: {
                label: 'Go there',
                onSelect: () => {
                    if (openSession === session)
                        void session.goTo(progress.locator, { remember: true })
                },
            },
            duration: OFFER_DURATION_MS,
        })
    }

    return {
        ready,
        destroy: () => {
            openSession = null
            return (closing ??= close())
        },
        offerPosition,
    }
}
