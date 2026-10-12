import { normalizeSettings, SETTINGS_VERSION } from './schema'
import type { RsvpSettings, Settings, SpeechSettings } from './schema'

export const SETTINGS_STORAGE_KEY = 'page-goblin:settings'

/** Time between the last change and the write to storage. */
export const SETTINGS_SAVE_DELAY_MS = 250

/** The part of the Storage interface that the settings use. */
export interface SettingsStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
}

/** A change to the settings. The `rsvp` and `speech` groups can be partial. */
export type SettingsPatch = Partial<Omit<Settings, 'rsvp' | 'speech'>> & {
    rsvp?: Partial<RsvpSettings>
    speech?: Partial<SpeechSettings>
}

export type SettingsListener = (settings: Settings, previous: Settings) => void

export interface SettingsStore {
    /**
     * The current settings. The object is frozen. It stays the same object until a change,
     * and the `rsvp` and `speech` objects stay the same until a change in that group.
     */
    get(): Settings
    /**
     * Merge the patch, normalise the result, tell the listeners and save after a short delay.
     * While the page is hidden the save has no delay.
     */
    update(patch: SettingsPatch): void
    /**
     * The listener runs after each change, not at the time of the call. Returns the function
     * that removes the listener. When a listener throws, the other listeners still run, and
     * then the first error goes to the caller of update().
     */
    subscribe(listener: SettingsListener): () => void
    /** Write a waiting change to storage now. */
    flush(): void
}

export interface OwnedSettingsStore extends SettingsStore {
    /**
     * Flush, then remove all listeners. For a store that does not live as long as the page.
     * A later update() changes the value in memory only.
     */
    destroy(): void
}

export interface SettingsStoreOptions {
    /** Omit to use `localStorage`. Null keeps the settings in memory only. */
    storage?: SettingsStorage | null
}

function browserStorage(): SettingsStorage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        // Access to localStorage throws when the browser blocks storage.
        return null
    }
}

function pageIsHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function parseSettings(json: string | null): Settings {
    if (!json) return normalizeSettings(null)
    try {
        return normalizeSettings(JSON.parse(json))
    } catch {
        return normalizeSettings(null)
    }
}

/** Reads the saved settings. Blocked storage and bad data give the defaults. */
export function loadSettings(storage: SettingsStorage | null = browserStorage()): Settings {
    let json: string | null = null
    try {
        json = storage?.getItem(SETTINGS_STORAGE_KEY) ?? null
    } catch {
        // Storage is blocked.
    }
    return parseSettings(json)
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
    for (const key in a) {
        if (a[key] !== b[key]) return false
    }
    return true
}

/** Copies `base` and sets each value of `patch` that is not undefined. */
function mergeDefined<T extends object>(base: T, patch: Partial<T> | undefined): T {
    const result = { ...base }
    for (const key in patch) {
        const value = patch[key]
        if (value !== undefined) result[key] = value as T[typeof key]
    }
    return result
}

export function createSettingsStore(options: SettingsStoreOptions = {}): OwnedSettingsStore {
    const storage = options.storage === undefined ? browserStorage() : options.storage
    const listeners = new Set<SettingsListener>()
    const teardown = new AbortController()
    const changes: [settings: Settings, previous: Settings][] = []
    let current = freeze(loadSettings(storage))
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let notifying = false
    let destroyed = false

    function freeze(settings: Settings): Settings {
        Object.freeze(settings.rsvp)
        Object.freeze(settings.speech)
        return Object.freeze(settings)
    }

    function write(): void {
        saveTimer = undefined
        try {
            storage?.setItem(
                SETTINGS_STORAGE_KEY,
                JSON.stringify({ version: SETTINGS_VERSION, ...current }),
            )
        } catch {
            // Storage is blocked or full. The settings stay in memory.
        }
    }

    function flush(): void {
        if (saveTimer === undefined) return
        clearTimeout(saveTimer)
        write()
    }

    function notify(previous: Settings): void {
        changes.push([current, previous])
        // A listener that calls update() adds to the queue, so each listener gets the
        // changes in the sequence in which they occurred.
        if (notifying) return
        notifying = true
        let failed = false
        let firstError: unknown
        for (let i = 0; i < changes.length; i++) {
            const [settings, before] = changes[i]
            for (const listener of [...listeners]) {
                // An earlier listener can remove this one or destroy the store.
                if (!listeners.has(listener)) continue
                try {
                    listener(settings, before)
                } catch (error) {
                    // The other listeners must still get the change.
                    if (!failed) firstError = error
                    failed = true
                }
            }
        }
        changes.length = 0
        notifying = false
        if (failed) throw firstError
    }

    /** Returns false when `next` is equal to the current settings. */
    function replace(next: Settings): boolean {
        if (shallowEqual(next.rsvp, current.rsvp)) next.rsvp = current.rsvp
        if (shallowEqual(next.speech, current.speech)) next.speech = current.speech
        if (shallowEqual(next, current)) return false
        current = freeze(next)
        return true
    }

    function update(patch: SettingsPatch): void {
        const previous = current
        const merged = {
            ...mergeDefined<Omit<Settings, 'rsvp' | 'speech'>>(previous, patch),
            rsvp: mergeDefined(previous.rsvp, patch.rsvp),
            speech: mergeDefined(previous.speech, patch.speech),
        }
        if (!replace(normalizeSettings(merged))) return
        if (storage && !destroyed) {
            clearTimeout(saveTimer)
            // A browser can stop a hidden page before a timer runs.
            if (pageIsHidden()) write()
            else saveTimer = setTimeout(write, SETTINGS_SAVE_DELAY_MS)
        }
        notify(previous)
    }

    function onStorage(event: StorageEvent): void {
        // A null key means that the other tab cleared the storage.
        if (event.key !== null && event.key !== SETTINGS_STORAGE_KEY) return
        const previous = current
        if (!replace(parseSettings(event.newValue))) return
        // The other tab has the newer data. A write from this tab would put old values back.
        clearTimeout(saveTimer)
        saveTimer = undefined
        notify(previous)
    }

    if (storage && typeof window !== 'undefined') {
        const { signal } = teardown
        // Mobile browsers can stop a hidden page with no more events, so the two events
        // are the last safe moments to save.
        window.addEventListener('pagehide', flush, { signal })
        document.addEventListener(
            'visibilitychange',
            () => {
                if (pageIsHidden()) flush()
            },
            { signal },
        )
        window.addEventListener('storage', onStorage, { signal })
    }

    return {
        get: () => current,
        update,
        subscribe(listener) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        flush,
        destroy() {
            flush()
            destroyed = true
            teardown.abort()
            listeners.clear()
        },
    }
}

let appStore: SettingsStore | undefined

function app(): SettingsStore {
    return (appStore ??= createSettingsStore())
}

/** The settings of the app. The store is made on the first call, not on import. */
export const settings: SettingsStore = {
    get: () => app().get(),
    update: (patch) => app().update(patch),
    subscribe: (listener) => app().subscribe(listener),
    flush: () => app().flush(),
}
