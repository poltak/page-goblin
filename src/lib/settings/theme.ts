import type { ReadingTheme } from '$lib/types'
import type { BlackTint, DarkTheme, ThemeChoice } from './schema'

/** The page background of each theme. `public/theme-init.js` has a copy of these values. */
export const THEME_PAGE_COLORS: Readonly<Record<ReadingTheme, string>> = {
    light: '#fbfaf8',
    sepia: '#f4ecd8',
    dark: '#1d1d1b',
    black: '#000000',
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

export interface ResolveThemeOptions {
    theme: ThemeChoice
    darkTheme: DarkTheme
    /** True when the system prefers a dark colour scheme. */
    systemDark: boolean
}

/** The theme to show. `public/theme-init.js` applies the same rule before the first paint. */
export function resolveTheme({ theme, darkTheme, systemDark }: ResolveThemeOptions): ReadingTheme {
    if (theme !== 'auto') return theme
    return systemDark ? darkTheme : 'light'
}

export interface ApplyThemeOptions {
    /** The result of `resolveTheme`. */
    theme: ReadingTheme
    /** Used only by the black theme. */
    blackBrightness: number
    /** Used only by the black theme. */
    blackTint: BlackTint
}

/**
 * Sets `data-theme` on the root element and the colour of the browser interface. In the black
 * theme it also sets these, and removes them in each other theme:
 *   data-black-dim and --black-brightness   when the brightness is below 100
 *   data-black-tint                         when the tint is not neutral
 * `public/theme-init.js` applies the same rule before the first paint.
 */
export function applyTheme({ theme, blackBrightness, blackTint }: ApplyThemeOptions): void {
    const root = document.documentElement
    root.dataset.theme = theme
    const dim = theme === 'black' && blackBrightness < 100
    const tint = theme === 'black' && blackTint !== 'neutral'
    root.toggleAttribute('data-black-dim', dim)
    if (dim) root.style.setProperty('--black-brightness', String(blackBrightness / 100))
    else root.style.removeProperty('--black-brightness')
    if (tint) root.dataset.blackTint = blackTint
    else delete root.dataset.blackTint
    document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_PAGE_COLORS[theme])
}

/** False when the browser has no `matchMedia` (the test environment). */
export function systemPrefersDark(): boolean {
    return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches
}

/**
 * Calls the listener when the colour scheme of the system changes, not at the time of the
 * call. Returns the function that stops the watch.
 */
export function watchSystemTheme(listener: (systemDark: boolean) => void): () => void {
    if (typeof matchMedia !== 'function') return () => {}
    const query = matchMedia(DARK_QUERY)
    const onChange = (event: MediaQueryListEvent) => listener(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
}
