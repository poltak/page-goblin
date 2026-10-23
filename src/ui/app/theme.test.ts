import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsStore } from '$lib/settings/store'
import type { OwnedSettingsStore } from '$lib/settings/store'
import { connectTheme } from './theme'

type ChangeListener = (event: { matches: boolean }) => void

/** A `matchMedia` for the dark colour scheme query, with a switch for the test. */
function stubSystemTheme(dark: boolean) {
    const listeners = new Set<ChangeListener>()
    const query = {
        matches: dark,
        addEventListener: (_type: string, listener: ChangeListener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: ChangeListener) =>
            listeners.delete(listener),
    }
    vi.stubGlobal('matchMedia', () => query)
    return {
        set(next: boolean) {
            query.matches = next
            for (const listener of [...listeners]) listener({ matches: next })
        },
        listenerCount: () => listeners.size,
    }
}

const root = document.documentElement
let store: OwnedSettingsStore

beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#fbfaf8" />'
    for (const name of ['data-theme', 'data-black-dim', 'data-black-tint', 'style']) {
        root.removeAttribute(name)
    }
    store = createSettingsStore({ storage: null })
})

afterEach(() => {
    store.destroy()
    vi.unstubAllGlobals()
})

describe('connectTheme', () => {
    it('applies the theme of the settings at the start', () => {
        stubSystemTheme(false)
        store.update({ theme: 'sepia' })

        connectTheme(store)

        expect(root.dataset.theme).toBe('sepia')
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
            '#f4ecd8',
        )
    })

    it('follows the system when the theme is auto', () => {
        const system = stubSystemTheme(true)
        store.update({ theme: 'auto', darkTheme: 'black' })

        connectTheme(store)
        expect(root.dataset.theme).toBe('black')

        system.set(false)
        expect(root.dataset.theme).toBe('light')

        system.set(true)
        expect(root.dataset.theme).toBe('black')
    })

    it('applies a change of the black brightness and tint', () => {
        stubSystemTheme(false)
        store.update({ theme: 'black' })
        connectTheme(store)
        expect(root.hasAttribute('data-black-dim')).toBe(false)

        store.update({ blackBrightness: 40, blackTint: 'amber' })
        expect(root.hasAttribute('data-black-dim')).toBe(true)
        expect(root.style.getPropertyValue('--black-brightness')).toBe('0.4')
        expect(root.dataset.blackTint).toBe('amber')

        store.update({ theme: 'sepia' })
        expect(root.hasAttribute('data-black-dim')).toBe(false)
        expect(root.dataset.blackTint).toBeUndefined()
    })

    it('applies a change of the theme setting', () => {
        stubSystemTheme(false)
        connectTheme(store)
        expect(root.dataset.theme).toBe('light')

        store.update({ theme: 'dark' })
        expect(root.dataset.theme).toBe('dark')

        store.update({ theme: 'auto' })
        expect(root.dataset.theme).toBe('light')
    })

    it('applies a change of the dark theme setting while the system is dark', () => {
        stubSystemTheme(true)
        connectTheme(store)
        expect(root.dataset.theme).toBe('dark')

        store.update({ darkTheme: 'black' })
        expect(root.dataset.theme).toBe('black')
    })

    it('does not touch the page for a change of a different setting', () => {
        stubSystemTheme(false)
        connectTheme(store)
        root.dataset.theme = 'changed-by-the-test'

        store.update({ fontSize: 22 })

        expect(root.dataset.theme).toBe('changed-by-the-test')
    })

    it('ignores the system when the user chose a fixed theme', () => {
        const system = stubSystemTheme(false)
        store.update({ theme: 'sepia' })
        connectTheme(store)

        system.set(true)

        expect(root.dataset.theme).toBe('sepia')
    })

    it('stops when the returned function runs', () => {
        const system = stubSystemTheme(false)
        const stop = connectTheme(store)
        expect(system.listenerCount()).toBe(1)

        stop()
        store.update({ theme: 'dark' })

        expect(system.listenerCount()).toBe(0)
        expect(root.dataset.theme).toBe('light')
    })
})
