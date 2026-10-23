import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    applyTheme,
    resolveTheme,
    systemPrefersDark,
    THEME_PAGE_COLORS,
    watchSystemTheme,
} from './theme'

/** A stand-in for the MediaQueryList of `matchMedia`, which jsdom does not have. */
function stubMatchMedia(matches: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const query = {
        matches,
        addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) =>
            listeners.add(listener),
        ),
        removeEventListener: vi.fn(
            (_type: string, listener: (event: MediaQueryListEvent) => void) =>
                listeners.delete(listener),
        ),
    }
    const matchMedia = vi.fn((_query: string) => query)
    vi.stubGlobal('matchMedia', matchMedia)
    return {
        matchMedia,
        query,
        change(next: boolean) {
            query.matches = next
            for (const listener of [...listeners]) {
                listener({ matches: next } as MediaQueryListEvent)
            }
        },
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    document.head.innerHTML = ''
    delete document.documentElement.dataset.theme
})

describe('resolveTheme', () => {
    it.each([
        ['light', 'dark', false, 'light'],
        ['light', 'black', true, 'light'],
        ['sepia', 'dark', false, 'sepia'],
        ['sepia', 'black', true, 'sepia'],
        ['dark', 'black', false, 'dark'],
        ['dark', 'black', true, 'dark'],
        ['black', 'dark', false, 'black'],
        ['black', 'dark', true, 'black'],
        ['auto', 'dark', false, 'light'],
        ['auto', 'black', false, 'light'],
        ['auto', 'dark', true, 'dark'],
        ['auto', 'black', true, 'black'],
    ] as const)(
        'theme %s with dark theme %s and system dark %s gives %s',
        (theme, darkTheme, systemDark, expected) => {
            expect(resolveTheme({ theme, darkTheme, systemDark })).toBe(expected)
        },
    )
})

describe('THEME_PAGE_COLORS', () => {
    it('has the page colour of each theme', () => {
        expect(THEME_PAGE_COLORS).toEqual({
            light: '#fbfaf8',
            sepia: '#f4ecd8',
            dark: '#1d1d1b',
            black: '#000000',
        })
    })
})

describe('applyTheme', () => {
    it.each(['light', 'sepia', 'dark', 'black'] as const)(
        'sets data-theme and the theme colour for %s',
        (theme) => {
            document.head.innerHTML = '<meta name="theme-color" content="#123456" />'
            applyTheme({ theme, blackBrightness: 100, blackTint: 'neutral' })
            expect(document.documentElement.getAttribute('data-theme')).toBe(theme)
            expect(
                document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
            ).toBe(THEME_PAGE_COLORS[theme])
        },
    )

    it('sets data-theme when the page has no theme-color tag', () => {
        expect(() =>
            applyTheme({ theme: 'dark', blackBrightness: 100, blackTint: 'neutral' }),
        ).not.toThrow()
        expect(document.documentElement.dataset.theme).toBe('dark')
    })

    it('does not change other meta tags', () => {
        document.head.innerHTML =
            '<meta name="color-scheme" content="light dark" /><meta name="theme-color" content="" />'
        applyTheme({ theme: 'sepia', blackBrightness: 100, blackTint: 'neutral' })
        expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe(
            'light dark',
        )
    })

    describe('black brightness and tint', () => {
        const root = document.documentElement
        const state = () => ({
            dim: root.hasAttribute('data-black-dim'),
            brightness: root.style.getPropertyValue('--black-brightness'),
            tint: root.dataset.blackTint,
        })

        afterEach(() => {
            for (const name of ['data-theme', 'data-black-dim', 'data-black-tint', 'style']) {
                root.removeAttribute(name)
            }
        })

        it('dims and tints the black theme', () => {
            applyTheme({ theme: 'black', blackBrightness: 40, blackTint: 'amber' })
            expect(state()).toEqual({ dim: true, brightness: '0.4', tint: 'amber' })
        })

        it('does not dim at 100 and does not tint with neutral', () => {
            applyTheme({ theme: 'black', blackBrightness: 100, blackTint: 'neutral' })
            expect(state()).toEqual({ dim: false, brightness: '', tint: undefined })
        })

        it.each(['light', 'sepia', 'dark'] as const)('removes both in the %s theme', (theme) => {
            applyTheme({ theme: 'black', blackBrightness: 30, blackTint: 'red' })
            applyTheme({ theme, blackBrightness: 30, blackTint: 'red' })
            expect(state()).toEqual({ dim: false, brightness: '', tint: undefined })
        })

        it('keeps other inline styles of the root element', () => {
            root.style.setProperty('--other', '1')
            applyTheme({ theme: 'black', blackBrightness: 30, blackTint: 'red' })
            applyTheme({ theme: 'black', blackBrightness: 100, blackTint: 'red' })
            expect(root.style.getPropertyValue('--other')).toBe('1')
        })
    })
})

describe('systemPrefersDark', () => {
    it('reads the prefers-color-scheme media query', () => {
        const { matchMedia } = stubMatchMedia(true)
        expect(systemPrefersDark()).toBe(true)
        expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
        stubMatchMedia(false)
        expect(systemPrefersDark()).toBe(false)
    })

    it('is false when the browser has no matchMedia', () => {
        vi.stubGlobal('matchMedia', undefined)
        expect(systemPrefersDark()).toBe(false)
    })
})

describe('watchSystemTheme', () => {
    it('calls the listener on each change, not at the start', () => {
        const media = stubMatchMedia(false)
        const listener = vi.fn()
        watchSystemTheme(listener)
        expect(media.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
        expect(listener).not.toHaveBeenCalled()
        media.change(true)
        media.change(false)
        expect(listener.mock.calls).toEqual([[true], [false]])
    })

    it('stops the calls after the returned function runs', () => {
        const media = stubMatchMedia(false)
        const listener = vi.fn()
        const stop = watchSystemTheme(listener)
        stop()
        media.change(true)
        expect(listener).not.toHaveBeenCalled()
        expect(media.query.removeEventListener).toHaveBeenCalledTimes(1)
    })

    it('does nothing when the browser has no matchMedia', () => {
        vi.stubGlobal('matchMedia', undefined)
        const stop = watchSystemTheme(vi.fn())
        expect(() => stop()).not.toThrow()
    })
})
