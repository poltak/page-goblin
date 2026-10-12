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
            applyTheme(theme)
            expect(document.documentElement.getAttribute('data-theme')).toBe(theme)
            expect(
                document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
            ).toBe(THEME_PAGE_COLORS[theme])
        },
    )

    it('sets data-theme when the page has no theme-color tag', () => {
        expect(() => applyTheme('dark')).not.toThrow()
        expect(document.documentElement.dataset.theme).toBe('dark')
    })

    it('does not change other meta tags', () => {
        document.head.innerHTML =
            '<meta name="color-scheme" content="light dark" /><meta name="theme-color" content="" />'
        applyTheme('sepia')
        expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe(
            'light dark',
        )
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
