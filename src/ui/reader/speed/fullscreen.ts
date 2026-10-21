/**
 * Full screen for the speed reader, with the prefixed names of older Safari. iPhone Safari has
 * no full screen for an element, so `supported` is false there.
 *
 * The request goes to the root element, as the reader screen does it. The two full screen
 * buttons then show the same state, and the dialogs of the page stay visible. The state is
 * always read from the document, because the user and the browser can leave full screen
 * without this code.
 */

import { on } from '../../dom'

type MaybePromise = Promise<void> | void

interface PrefixedDocument {
    webkitFullscreenEnabled?: boolean
    webkitFullscreenElement?: Element | null
    webkitExitFullscreen?(): MaybePromise
}

interface PrefixedElement {
    webkitRequestFullscreen?(): MaybePromise
}

export interface FullscreenOptions {
    /** Called after each change of the full screen state, also one that the browser made. */
    onChange(active: boolean): void
}

export interface FullscreenControl {
    readonly supported: boolean
    /** True while the page is in full screen, also when a different part entered it. */
    readonly active: boolean
    toggle(): void
    /** Leave full screen if a `toggle` call of this object entered it. */
    leave(): void
    /** Remove the listeners. This does not leave full screen. */
    destroy(): void
}

export function createFullscreen({ onChange }: FullscreenOptions): FullscreenControl {
    const page = document as Document & PrefixedDocument
    const root = document.documentElement as HTMLElement & PrefixedElement

    const hasRequest =
        typeof root.requestFullscreen === 'function' ||
        typeof root.webkitRequestFullscreen === 'function'
    const hasExit =
        typeof page.exitFullscreen === 'function' || typeof page.webkitExitFullscreen === 'function'
    // False in a frame that has no permission for full screen.
    const enabled = (page.fullscreenEnabled ?? page.webkitFullscreenEnabled) !== false
    const supported = hasRequest && hasExit && enabled

    /** Only for `leave`. It never says that the page is in full screen. */
    let entered = false

    function isActive(): boolean {
        return (page.fullscreenElement ?? page.webkitFullscreenElement ?? null) !== null
    }

    function enter(): void {
        entered = true
        try {
            const result =
                typeof root.requestFullscreen === 'function'
                    ? root.requestFullscreen()
                    : root.webkitRequestFullscreen?.()
            // The browser can refuse, for example with no user action.
            if (result instanceof Promise) {
                result.catch(() => {
                    entered = false
                })
            }
        } catch {
            // Older Safari throws and gives no promise.
            entered = false
        }
    }

    function exit(): void {
        try {
            const result =
                typeof page.exitFullscreen === 'function'
                    ? page.exitFullscreen()
                    : page.webkitExitFullscreen?.()
            if (result instanceof Promise) result.catch(() => {})
        } catch {
            // The page left full screen in the same moment.
        }
    }

    function report(): void {
        const active = isActive()
        if (!active) entered = false
        onChange(active)
    }

    const removers = supported
        ? [on(document, 'fullscreenchange', report), on(document, 'webkitfullscreenchange', report)]
        : []

    return {
        supported,
        get active() {
            return isActive()
        },
        toggle() {
            if (!supported) return
            if (isActive()) exit()
            else enter()
        },
        leave() {
            if (!entered || !isActive()) return
            entered = false
            exit()
        },
        destroy() {
            for (const remove of removers) remove()
        },
    }
}
