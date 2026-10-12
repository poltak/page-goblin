import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from './schema'
import {
    createSettingsStore,
    loadSettings,
    SETTINGS_SAVE_DELAY_MS,
    SETTINGS_STORAGE_KEY,
} from './store'
import type { OwnedSettingsStore, SettingsStorage } from './store'

function createStorage(initial: string | null = null) {
    let value = initial
    return {
        getItem: vi.fn((_key: string) => value),
        setItem: vi.fn((_key: string, next: string) => {
            value = next
        }),
        read: () => (value === null ? null : JSON.parse(value)),
    }
}

const blockedStorage: SettingsStorage = {
    getItem() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
    },
    setItem() {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    },
}

function storageEvent(newValue: string | null, key: string | null = SETTINGS_STORAGE_KEY) {
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
}

function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
}

const stores: OwnedSettingsStore[] = []

function createStore(storage: SettingsStorage | null) {
    const store = createSettingsStore({ storage })
    stores.push(store)
    return store
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    for (const store of stores.splice(0)) store.destroy()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(document, 'visibilityState')
    localStorage.clear()
})

describe('loadSettings', () => {
    it('gives the defaults when nothing is saved', () => {
        expect(loadSettings(createStorage())).toEqual(DEFAULT_SETTINGS)
    })

    it('reads the saved settings from the storage key', () => {
        const storage = createStorage(JSON.stringify({ version: 1, theme: 'sepia', fontSize: 22 }))
        expect(loadSettings(storage)).toEqual({ ...DEFAULT_SETTINGS, theme: 'sepia', fontSize: 22 })
        expect(storage.getItem).toHaveBeenCalledWith('page-goblin:settings')
    })

    it('normalises the saved settings', () => {
        const storage = createStorage(JSON.stringify({ theme: 'neon', fontSize: 500 }))
        expect(loadSettings(storage)).toEqual({ ...DEFAULT_SETTINGS, fontSize: 40 })
    })

    it.each(['{not-json', '', 'null', '"text"', '[]', '12'])(
        'gives the defaults for the saved text %j',
        (text) => {
            expect(loadSettings(createStorage(text))).toEqual(DEFAULT_SETTINGS)
        },
    )

    it('gives the defaults when the storage throws', () => {
        expect(loadSettings(blockedStorage)).toEqual(DEFAULT_SETTINGS)
    })

    it('gives the defaults when there is no storage', () => {
        expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
    })

    it('reads localStorage when no storage is given', () => {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ layout: 'scroll' }))
        expect(loadSettings().layout).toBe('scroll')
    })

    it('gives the defaults when access to localStorage throws', () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get() {
                throw new DOMException('The operation is insecure.', 'SecurityError')
            },
        })
        try {
            expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
            const store = createSettingsStore()
            stores.push(store)
            store.update({ fontSize: 30 })
            vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS)
            expect(store.get().fontSize).toBe(30)
        } finally {
            Object.defineProperty(globalThis, 'localStorage', original)
        }
    })
})

describe('createSettingsStore', () => {
    it('starts with the saved settings', () => {
        const store = createStore(createStorage(JSON.stringify({ theme: 'dark' })))
        expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' })
    })

    it('starts with the defaults when the storage is empty, blocked or absent', () => {
        expect(createStore(createStorage()).get()).toEqual(DEFAULT_SETTINGS)
        expect(createStore(blockedStorage).get()).toEqual(DEFAULT_SETTINGS)
        expect(createStore(null).get()).toEqual(DEFAULT_SETTINGS)
    })

    it('does not write when it starts', () => {
        const storage = createStorage()
        createStore(storage)
        vi.advanceTimersByTime(10_000)
        expect(storage.setItem).not.toHaveBeenCalled()
    })

    describe('update', () => {
        it('merges the patch into the settings', () => {
            const store = createStore(createStorage())
            store.update({ theme: 'sepia', fontSize: 24 })
            store.update({ fontSize: 26 })
            expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, theme: 'sepia', fontSize: 26 })
        })

        it('merges the rsvp and speech groups field by field', () => {
            const store = createStore(createStorage())
            store.update({ rsvp: { wpm: 400 }, speech: { rate: 1.5 } })
            store.update({ rsvp: { rampUp: false }, speech: { voiceId: 'Daniel' } })
            expect(store.get().rsvp).toEqual({ ...DEFAULT_SETTINGS.rsvp, wpm: 400, rampUp: false })
            expect(store.get().speech).toEqual({
                ...DEFAULT_SETTINGS.speech,
                rate: 1.5,
                voiceId: 'Daniel',
            })
        })

        it('normalises the result', () => {
            const store = createStore(createStorage())
            store.update({ fontSize: 500, lineHeight: 1.53, rsvp: { wpm: 256 } })
            expect(store.get().fontSize).toBe(40)
            expect(store.get().lineHeight).toBe(1.55)
            expect(store.get().rsvp.wpm).toBe(260)
        })

        it('accepts null for the values that can be null', () => {
            const store = createStore(createStorage())
            store.update({ lineHeight: null, speech: { voiceId: 'Daniel' } })
            store.update({ speech: { voiceId: null } })
            expect(store.get().lineHeight).toBeNull()
            expect(store.get().speech.voiceId).toBeNull()
        })

        it('ignores undefined values in the patch', () => {
            const store = createStore(createStorage())
            store.update({ fontSize: 24, rsvp: { wpm: 400 } })
            store.update({ fontSize: undefined, rsvp: undefined, speech: { rate: undefined } })
            store.update({ rsvp: { wpm: undefined } })
            expect(store.get().fontSize).toBe(24)
            expect(store.get().rsvp.wpm).toBe(400)
            expect(store.get().speech.rate).toBe(1)
        })

        it('gives a new frozen object and keeps the groups that did not change', () => {
            const store = createStore(createStorage())
            const before = store.get()
            store.update({ rsvp: { wpm: 400 } })
            const after = store.get()
            expect(after).not.toBe(before)
            expect(after.rsvp).not.toBe(before.rsvp)
            expect(after.speech).toBe(before.speech)
            expect(before.rsvp.wpm).toBe(250)
            expect(Object.isFrozen(after)).toBe(true)
            expect(Object.isFrozen(after.rsvp)).toBe(true)
            expect(Object.isFrozen(after.speech)).toBe(true)
        })

        it('keeps the same object when the patch changes nothing', () => {
            const storage = createStorage()
            const store = createStore(storage)
            const listener = vi.fn()
            store.subscribe(listener)
            const before = store.get()
            store.update({})
            store.update({ fontSize: 19, rsvp: { wpm: 250 }, speech: {} })
            store.update({ fontSize: 19.2 })
            vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS)
            expect(store.get()).toBe(before)
            expect(listener).not.toHaveBeenCalled()
            expect(storage.setItem).not.toHaveBeenCalled()
        })
    })

    describe('subscribe', () => {
        it('calls the listener after a change with the new and the previous settings', () => {
            const store = createStore(createStorage())
            const listener = vi.fn()
            const before = store.get()
            store.subscribe(listener)
            expect(listener).not.toHaveBeenCalled()
            store.update({ theme: 'black' })
            expect(listener).toHaveBeenCalledTimes(1)
            expect(listener).toHaveBeenCalledWith(store.get(), before)
            expect(listener.mock.calls[0][0].theme).toBe('black')
            expect(listener.mock.calls[0][1].theme).toBe('auto')
        })

        it('stops the calls after unsubscribe', () => {
            const store = createStore(createStorage())
            const first = vi.fn()
            const second = vi.fn()
            const unsubscribe = store.subscribe(first)
            store.subscribe(second)
            unsubscribe()
            unsubscribe()
            store.update({ theme: 'black' })
            expect(first).not.toHaveBeenCalled()
            expect(second).toHaveBeenCalledTimes(1)
        })

        it('lets a listener unsubscribe during a call', () => {
            const store = createStore(createStorage())
            const second = vi.fn()
            const unsubscribe = store.subscribe(() => unsubscribe())
            store.subscribe(second)
            store.update({ theme: 'black' })
            store.update({ theme: 'sepia' })
            expect(second).toHaveBeenCalledTimes(2)
        })

        it('gives each listener the changes in sequence when a listener calls update', () => {
            const store = createStore(createStorage())
            const seen: string[] = []
            store.subscribe((settings) => {
                if (settings.theme === 'black') store.update({ darkTheme: 'black' })
            })
            store.subscribe((settings, previous) => {
                seen.push(
                    `${previous.theme}/${previous.darkTheme} to ${settings.theme}/${settings.darkTheme}`,
                )
            })
            store.update({ theme: 'black' })
            expect(seen).toEqual(['auto/dark to black/dark', 'black/dark to black/black'])
            expect(store.get().darkTheme).toBe('black')
        })

        it('continues to work after a listener throws', () => {
            const storage = createStorage()
            const store = createStore(storage)
            const unsubscribe = store.subscribe(() => {
                throw new Error('listener error')
            })
            expect(() => store.update({ theme: 'black' })).toThrow('listener error')
            unsubscribe()
            const listener = vi.fn()
            store.subscribe(listener)
            store.update({ theme: 'sepia' })
            expect(listener).toHaveBeenCalledTimes(1)
            expect(listener.mock.calls[0][1].theme).toBe('black')
            vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS)
            expect(storage.read().theme).toBe('sepia')
        })

        it('does not call a listener that an earlier listener removed for the same change', () => {
            const store = createStore(createStorage())
            const removed = vi.fn()
            const kept = vi.fn()
            let remove = () => {}
            store.subscribe(() => remove())
            remove = store.subscribe(removed)
            store.subscribe(kept)
            store.update({ theme: 'black' })
            expect(removed).not.toHaveBeenCalled()
            expect(kept).toHaveBeenCalledTimes(1)
        })

        it('does not call a new listener for the change that added it', () => {
            const store = createStore(createStorage())
            const added = vi.fn()
            store.subscribe(() => {
                store.subscribe(added)
            })
            store.update({ theme: 'black' })
            expect(added).not.toHaveBeenCalled()
            store.update({ theme: 'sepia' })
            expect(added).toHaveBeenCalledTimes(1)
        })

        it('calls the other listeners when a listener throws, then throws the error', () => {
            const store = createStore(createStorage())
            const before = vi.fn()
            const after = vi.fn()
            store.subscribe(before)
            store.subscribe(() => {
                throw new Error('first error')
            })
            store.subscribe(() => {
                throw new Error('second error')
            })
            store.subscribe(after)
            expect(() => store.update({ theme: 'black' })).toThrow('first error')
            expect(before).toHaveBeenCalledTimes(1)
            expect(after).toHaveBeenCalledTimes(1)
            expect(after.mock.calls[0][0].theme).toBe('black')
        })

        it('gives a change from a listener to all listeners when a listener throws', () => {
            const store = createStore(createStorage())
            const seen: string[] = []
            store.subscribe((settings) => {
                if (settings.theme === 'black') store.update({ darkTheme: 'black' })
            })
            store.subscribe((settings) => {
                if (settings.darkTheme === 'dark') throw new Error('listener error')
            })
            store.subscribe((settings) => seen.push(`${settings.theme}/${settings.darkTheme}`))
            expect(() => store.update({ theme: 'black' })).toThrow('listener error')
            expect(seen).toEqual(['black/dark', 'black/black'])
        })

        it('tells the listeners of a storage event when a listener throws', () => {
            const store = createStore(createStorage())
            const after = vi.fn()
            store.subscribe(() => {
                throw new Error('listener error')
            })
            store.subscribe(after)
            // jsdom reports the error of an event listener to the window. It does not throw.
            const onError = vi.fn((event: ErrorEvent) => event.preventDefault())
            window.addEventListener('error', onError)
            try {
                storageEvent(JSON.stringify({ theme: 'sepia' }))
            } finally {
                window.removeEventListener('error', onError)
            }
            expect(after).toHaveBeenCalledTimes(1)
            expect(onError).toHaveBeenCalledTimes(1)
            expect(store.get().theme).toBe('sepia')
        })
    })

    describe('saving', () => {
        it('writes one time, 250 ms after the last change', () => {
            const storage = createStorage()
            const store = createStore(storage)
            store.update({ fontSize: 20 })
            vi.advanceTimersByTime(200)
            store.update({ fontSize: 21 })
            vi.advanceTimersByTime(200)
            store.update({ fontSize: 22 })
            vi.advanceTimersByTime(249)
            expect(storage.setItem).not.toHaveBeenCalled()
            vi.advanceTimersByTime(1)
            expect(storage.setItem).toHaveBeenCalledTimes(1)
            expect(storage.setItem.mock.calls[0][0]).toBe('page-goblin:settings')
            vi.advanceTimersByTime(10_000)
            expect(storage.setItem).toHaveBeenCalledTimes(1)
        })

        it('writes the version and all settings as JSON', () => {
            const storage = createStorage()
            const store = createStore(storage)
            store.update({ fontSize: 22, rsvp: { wpm: 400 } })
            vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS)
            expect(storage.read()).toEqual({
                version: 1,
                ...DEFAULT_SETTINGS,
                fontSize: 22,
                rsvp: { ...DEFAULT_SETTINGS.rsvp, wpm: 400 },
            })
            expect(loadSettings(storage)).toEqual(store.get())
        })

        it('flush writes a waiting change immediately and stops the timer', () => {
            const storage = createStorage()
            const store = createStore(storage)
            store.update({ fontSize: 22 })
            store.flush()
            expect(storage.setItem).toHaveBeenCalledTimes(1)
            expect(storage.read().fontSize).toBe(22)
            vi.advanceTimersByTime(10_000)
            expect(storage.setItem).toHaveBeenCalledTimes(1)
        })

        it('flush does nothing when no change waits', () => {
            const storage = createStorage()
            const store = createStore(storage)
            store.flush()
            store.update({ fontSize: 22 })
            vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS)
            store.flush()
            expect(storage.setItem).toHaveBeenCalledTimes(1)
        })

        it('writes on pagehide', () => {
            const storage = createStorage()
            const store = createStore(storage)
            store.update({ fontSize: 22 })
            window.dispatchEvent(new Event('pagehide'))
            expect(storage.read().fontSize).toBe(22)
        })

        it('writes when the page becomes hidden, not when it becomes visible', () => {
            const storage = createStorage()
            const store = createStore(storage)
            store.update({ fontSize: 22 })
            setVisibility('visible')
            expect(storage.setItem).not.toHaveBeenCalled()
            setVisibility('hidden')
            expect(storage.read().fontSize).toBe(22)
        })

        it('writes a change immediately while the page is hidden', () => {
            const storage = createStorage()
            const store = createStore(storage)
            setVisibility('hidden')
            store.update({ fontSize: 22 })
            expect(storage.read().fontSize).toBe(22)
            expect(vi.getTimerCount()).toBe(0)
            store.update({ fontSize: 23 })
            expect(storage.read().fontSize).toBe(23)
            expect(storage.setItem).toHaveBeenCalledTimes(2)

            setVisibility('visible')
            store.update({ fontSize: 24 })
            expect(storage.read().fontSize).toBe(23)
            vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS)
            expect(storage.read().fontSize).toBe(24)
        })

        it('ignores a write error and tries again after the next change', () => {
            const storage = createStorage()
            storage.setItem.mockImplementationOnce(() => {
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
            })
            const store = createStore(storage)
            store.update({ fontSize: 22 })
            expect(() => vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS)).not.toThrow()
            expect(store.get().fontSize).toBe(22)
            expect(storage.read()).toBeNull()
            store.update({ fontSize: 23 })
            store.flush()
            expect(storage.read().fontSize).toBe(23)
        })

        it('keeps the settings in memory when the storage is blocked', () => {
            const store = createStore(blockedStorage)
            const listener = vi.fn()
            store.subscribe(listener)
            store.update({ fontSize: 22 })
            expect(() => vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS)).not.toThrow()
            expect(() => store.flush()).not.toThrow()
            expect(store.get().fontSize).toBe(22)
            expect(listener).toHaveBeenCalledTimes(1)
        })

        it('starts no timer when there is no storage', () => {
            const store = createStore(null)
            store.update({ fontSize: 22 })
            expect(vi.getTimerCount()).toBe(0)
            expect(store.get().fontSize).toBe(22)
        })
    })

    describe('storage event from a different tab', () => {
        it('updates the store and tells the listeners', () => {
            const storage = createStorage()
            const store = createStore(storage)
            const listener = vi.fn()
            store.subscribe(listener)
            storageEvent(JSON.stringify({ version: 1, theme: 'sepia', rsvp: { wpm: 400 } }))
            expect(store.get().theme).toBe('sepia')
            expect(store.get().rsvp.wpm).toBe(400)
            expect(listener).toHaveBeenCalledTimes(1)
            expect(listener.mock.calls[0][1].theme).toBe('auto')
        })

        it('does not write the settings back', () => {
            const storage = createStorage()
            const store = createStore(storage)
            storageEvent(JSON.stringify({ theme: 'sepia' }))
            vi.advanceTimersByTime(10_000)
            store.flush()
            expect(storage.setItem).not.toHaveBeenCalled()
        })

        it('drops a waiting write, because the other tab has newer data', () => {
            const storage = createStorage()
            const store = createStore(storage)
            store.update({ fontSize: 22 })
            storageEvent(JSON.stringify({ theme: 'sepia' }))
            vi.advanceTimersByTime(10_000)
            expect(storage.setItem).not.toHaveBeenCalled()
            expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, theme: 'sepia' })
        })

        it('normalises the data of the other tab', () => {
            const store = createStore(createStorage(JSON.stringify({ theme: 'dark' })))
            storageEvent(JSON.stringify({ theme: 'neon', fontSize: 500 }))
            expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, fontSize: 40 })
            storageEvent('{not-json')
            expect(store.get()).toEqual(DEFAULT_SETTINGS)
        })

        it('goes back to the defaults when the other tab removed the settings', () => {
            const store = createStore(createStorage(JSON.stringify({ theme: 'dark' })))
            storageEvent(null)
            expect(store.get()).toEqual(DEFAULT_SETTINGS)
            store.update({ theme: 'dark' })
            storageEvent(null, null)
            expect(store.get()).toEqual(DEFAULT_SETTINGS)
        })

        it('ignores other keys', () => {
            const store = createStore(createStorage())
            const listener = vi.fn()
            store.subscribe(listener)
            storageEvent(JSON.stringify({ theme: 'sepia' }), 'theme')
            expect(store.get()).toEqual(DEFAULT_SETTINGS)
            expect(listener).not.toHaveBeenCalled()
        })

        it('does not tell the listeners when the data is the same', () => {
            const store = createStore(createStorage())
            const listener = vi.fn()
            const before = store.get()
            store.subscribe(listener)
            storageEvent(JSON.stringify({ version: 1, ...DEFAULT_SETTINGS }))
            expect(listener).not.toHaveBeenCalled()
            expect(store.get()).toBe(before)
        })
    })

    describe('destroy', () => {
        it('writes a waiting change and removes all listeners', () => {
            const storage = createStorage()
            const store = createStore(storage)
            const listener = vi.fn()
            store.subscribe(listener)
            store.update({ fontSize: 22 })
            listener.mockClear()
            store.destroy()
            expect(storage.read().fontSize).toBe(22)
            storageEvent(JSON.stringify({ theme: 'sepia' }))
            expect(store.get().theme).toBe('auto')
            store.update({ fontSize: 23 })
            window.dispatchEvent(new Event('pagehide'))
            expect(storage.read().fontSize).toBe(22)
            expect(listener).not.toHaveBeenCalled()
        })

        it('starts no timer and writes nothing after destroy', () => {
            const storage = createStorage()
            const store = createStore(storage)
            store.destroy()
            store.update({ fontSize: 23 })
            expect(vi.getTimerCount()).toBe(0)
            vi.advanceTimersByTime(10_000)
            store.flush()
            store.destroy()
            expect(storage.setItem).not.toHaveBeenCalled()
            // The value stays in memory, as with a store that has no storage.
            expect(store.get().fontSize).toBe(23)
        })

        it('can run in a listener, and the listeners after it get no call', () => {
            const storage = createStorage()
            const store = createStore(storage)
            const after = vi.fn()
            store.subscribe(() => store.destroy())
            store.subscribe(after)
            store.update({ fontSize: 22 })
            expect(after).not.toHaveBeenCalled()
            expect(storage.read().fontSize).toBe(22)
            expect(vi.getTimerCount()).toBe(0)
        })
    })
})

// Keep this group last. The app store has no destroy(), so its listeners stay until the
// test file ends.
describe('settings (the app store)', () => {
    beforeEach(() => {
        vi.resetModules()
    })

    it('does not read storage or add listeners on import', async () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem')
        const addWindowListener = vi.spyOn(window, 'addEventListener')
        const addDocumentListener = vi.spyOn(document, 'addEventListener')
        const { settings } = await import('./store')
        expect(getItem).not.toHaveBeenCalled()
        expect(addWindowListener).not.toHaveBeenCalled()
        expect(addDocumentListener).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
        expect(Object.keys(settings).sort()).toEqual(['flush', 'get', 'subscribe', 'update'])
    })

    it('makes the store on the first use and uses localStorage', async () => {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'sepia' }))
        const getItem = vi.spyOn(Storage.prototype, 'getItem')
        const { settings } = await import('./store')
        expect(settings.get().theme).toBe('sepia')
        expect(settings.get()).toBe(settings.get())
        expect(getItem).toHaveBeenCalledTimes(1)

        const listener = vi.fn()
        const unsubscribe = settings.subscribe(listener)
        settings.update({ fontSize: 30 })
        expect(listener).toHaveBeenCalledTimes(1)
        settings.flush()
        expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toMatchObject({
            version: 1,
            theme: 'sepia',
            fontSize: 30,
        })
        unsubscribe()
    })
})
