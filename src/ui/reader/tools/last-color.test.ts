import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HIGHLIGHT_COLOR_KEY, readLastColor, saveLastColor } from './last-color'

beforeEach(() => {
    localStorage.clear()
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('the last highlight colour', () => {
    it('is yellow when nothing is saved', () => {
        expect(readLastColor()).toBe('yellow')
    })

    it('is saved under the key of the app', () => {
        saveLastColor('pink')

        expect(HIGHLIGHT_COLOR_KEY).toBe('web-ereader:highlight-color')
        expect(localStorage.getItem(HIGHLIGHT_COLOR_KEY)).toBe('pink')
        expect(readLastColor()).toBe('pink')
    })

    it('ignores a saved value that is not a colour', () => {
        localStorage.setItem(HIGHLIGHT_COLOR_KEY, 'red')

        expect(readLastColor()).toBe('yellow')
    })

    it('gives the default when the read throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError')
        })

        expect(readLastColor()).toBe('yellow')
    })

    it('does not throw when the write throws', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('full', 'QuotaExceededError')
        })

        expect(() => saveLastColor('green')).not.toThrow()
    })

    it('works when access to localStorage throws', () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get() {
                throw new DOMException('blocked', 'SecurityError')
            },
        })

        try {
            expect(readLastColor()).toBe('yellow')
            expect(() => saveLastColor('blue')).not.toThrow()
        } finally {
            if (original) Object.defineProperty(globalThis, 'localStorage', original)
            else Reflect.deleteProperty(globalThis, 'localStorage')
        }
    })
})
