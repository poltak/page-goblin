import type { ReadingTheme } from '$lib/types'
import type { DarkTheme, ThemeChoice } from './schema'

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

/** Sets `data-theme` on the root element and the colour of the browser interface. */
export function applyTheme(resolved: ReadingTheme): void {
    document.documentElement.dataset.theme = resolved
    document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_PAGE_COLORS[resolved])
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
