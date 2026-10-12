import { settings } from '$lib/settings/store'
import type { SettingsStore } from '$lib/settings/store'
import { applyTheme, resolveTheme, systemPrefersDark, watchSystemTheme } from '$lib/settings/theme'

/**
 * Keeps the theme of the page equal to the settings. `public/theme-init.js` sets the first
 * theme before the first paint. This function applies it again at the start, then after each
 * change of the settings and of the colour scheme of the system. Returns the stop function.
 */
export function connectTheme(store: SettingsStore = settings): () => void {
    const apply = (): void => {
        const { theme, darkTheme } = store.get()
        applyTheme(resolveTheme({ theme, darkTheme, systemDark: systemPrefersDark() }))
    }

    // subscribe and watchSystemTheme do not call their listener at the start.
    apply()
    const stopSettings = store.subscribe((next, previous) => {
        if (next.theme !== previous.theme || next.darkTheme !== previous.darkTheme) apply()
    })
    const stopSystem = watchSystemTheme(apply)

    return () => {
        stopSettings()
        stopSystem()
    }
}
