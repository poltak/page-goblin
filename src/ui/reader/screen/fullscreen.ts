/**
 * Full screen for the reader. The request goes to the root element, so the dialogs and menus
 * of the page stay visible. Older Safari has only the names with the webkit prefix.
 *
 * The state is always read from the document. The user and the browser can leave full
 * screen without this code, so a flag of our own would be wrong after that.
 */

import { on } from '../../dom'

type MaybePromise = Promise<void> | void

interface PrefixedDocument extends Document {
    webkitFullscreenElement?: Element | null
    webkitFullscreenEnabled?: boolean
    webkitExitFullscreen?: () => MaybePromise
}

interface PrefixedElement extends HTMLElement {
    webkitRequestFullscreen?: () => MaybePromise
}

export interface FullscreenOptions {
    /** Runs after each change of the full screen state, also one that the browser made. */
    onChange(active: boolean): void
}

export interface FullscreenControl {
    /** False when the browser has no Fullscreen API for elements, as on an iPhone. */
    readonly supported: boolean
    readonly active: boolean
    /** Rejects when the browser refuses the request. */
    toggle(): Promise<void>
    /** Leaves full screen when a `toggle` call of this object entered it. Never rejects. */
    leave(): Promise<void>
    destroy(): void
}

export function createFullscreen({ onChange }: FullscreenOptions): FullscreenControl {
    const page = document as PrefixedDocument
    const root = document.documentElement as PrefixedElement

    const request: (() => MaybePromise) | undefined =
        root.requestFullscreen ?? root.webkitRequestFullscreen
    const exit: (() => MaybePromise) | undefined = page.exitFullscreen ?? page.webkitExitFullscreen
    const supported =
        typeof request === 'function' &&
        typeof exit === 'function' &&
        (page.fullscreenEnabled ?? page.webkitFullscreenEnabled) !== false

    // Only for `leave`. It never says that the page is in full screen.
    let entered = false

    const element = (): Element | null =>
        page.fullscreenElement ?? page.webkitFullscreenElement ?? null

    const handleChange = (): void => {
        const active = element() !== null
        if (!active) entered = false
        onChange(active)
    }
    const stops = [
        on(document, 'fullscreenchange', handleChange),
        on(document, 'webkitfullscreenchange', handleChange),
    ]

    return {
        supported,
        get active() {
            return element() !== null
        },
        async toggle() {
            if (!supported) return
            if (element()) {
                await exit!.call(page)
                return
            }
            await request!.call(root)
            entered = true
        },
        async leave() {
            if (!entered || !element()) return
            entered = false
            try {
                await exit?.call(page)
            } catch {
                // The browser left full screen in the same moment.
            }
        },
        destroy() {
            for (const stop of stops) stop()
        },
    }
}
