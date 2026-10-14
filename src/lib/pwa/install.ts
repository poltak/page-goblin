export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable'

/** Chromium sends this event when the app can be installed. It is not in the DOM types. */
interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<unknown>
    readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type AvailabilityListener = (canInstall: boolean) => void

let promptEvent: BeforeInstallPromptEvent | null = null
const listeners = new Set<AvailabilityListener>()

function setPromptEvent(event: BeforeInstallPromptEvent | null): void {
    if (event === promptEvent) return
    const changed = (event === null) !== (promptEvent === null)
    promptEvent = event
    if (!changed) return
    for (const listener of listeners) listener(event !== null)
}

// The browser sends the event one time, soon after the page loads. The listener must be there
// before the first user action, so it is added when this module loads.
if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (event) => {
        // Stops the small install bar of the browser. The app shows its own button.
        event.preventDefault()
        setPromptEvent(event as BeforeInstallPromptEvent)
    })
    window.addEventListener('appinstalled', () => setPromptEvent(null))
}

/** True when `promptInstall` can show the install dialog of the browser. */
export function canInstall(): boolean {
    return promptEvent !== null
}

/** Shows the install dialog of the browser. It must be called from a user action. */
export async function promptInstall(): Promise<InstallOutcome> {
    const event = promptEvent
    if (!event) return 'unavailable'
    // The browser accepts one prompt call for each event.
    setPromptEvent(null)
    try {
        await event.prompt()
        return (await event.userChoice).outcome === 'accepted' ? 'accepted' : 'dismissed'
    } catch {
        return 'unavailable'
    }
}

/**
 * True when the app runs in its own window with the system bars, not in a browser tab. iOS
 * and the desktop browsers show the installed app this way. On Android the installed app
 * fills the screen, and `fillsScreen` is true there.
 */
export function isStandalone(): boolean {
    return (
        window.matchMedia?.('(display-mode: standalone)').matches === true ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    )
}

/**
 * True when the page fills the screen, with no bar of the browser or of the system. The
 * installed app on Android does, because the manifest asks for the `fullscreen` display mode.
 * Full screen that the page or the user started gives the same result.
 */
export function fillsScreen(): boolean {
    return window.matchMedia?.('(display-mode: fullscreen)').matches === true
}

/** True on iPhone and iPad, where the user installs the app from the share menu. */
export function isIos(): boolean {
    // An iPad reports a Mac platform. A Mac has no touch points.
    return (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    )
}

/** Calls the listener each time the result of `canInstall` changes. Returns a remove function. */
export function onInstallAvailabilityChange(listener: AvailabilityListener): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}
