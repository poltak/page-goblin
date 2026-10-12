/** The two menus of the library header: the theme menu and the app menu. */

import { canInstall, isIos, isStandalone, promptInstall } from '$lib/pwa/install'
import type { ThemeChoice } from '$lib/settings/schema'
import type { SettingsStore } from '$lib/settings/store'
import type { LibraryStorage } from '$lib/storage/types'
import { openDialog } from '../app/dialog'
import { createMenu } from '../app/menu'
import { on, qs, qsa } from '../dom'
import type { AppActions } from './app-actions'
import { lazy, reportLoadError } from './lazy'

export interface LibraryHeaderOptions {
    settings: SettingsStore
    storage: LibraryStorage
    bookCount(): number
    /** A restored backup changed reading positions. */
    onRestored(): void
}

export function connectLibraryHeader(options: LibraryHeaderOptions): void {
    const { settings } = options

    // ---------- Theme menu ----------

    const themeButton = qs('#theme-button')
    const themeMenu = createMenu({
        menu: qs('#theme-menu'),
        onOpen() {
            const { theme } = settings.get()
            for (const item of qsa('[data-theme-choice]', qs('#theme-menu'))) {
                item.setAttribute('aria-checked', String(item.dataset.themeChoice === theme))
            }
        },
        onSelect(item) {
            const theme = item.dataset.themeChoice as ThemeChoice
            // The dark theme that the user chose last is also the one that Auto uses at night.
            if (theme === 'dark' || theme === 'black') settings.update({ theme, darkTheme: theme })
            else settings.update({ theme })
        },
    })
    on(themeButton, 'click', (event) => {
        event.preventDefault()
        themeMenu.toggle(themeButton)
    })

    // ---------- App menu ----------

    const loadActions = lazy<AppActions>(async () => {
        const { createAppActions } = await import('./app-actions')
        return createAppActions(options)
    })
    // Only a failed load gets the load message. An error of the action itself is not caught.
    const withActions = (use: (actions: AppActions) => unknown): void => {
        void loadActions().then(use, reportLoadError)
    }

    const backupInput = qs<HTMLInputElement>('#backup-file')
    on(backupInput, 'change', () => {
        const file = backupInput.files?.[0]
        // Without the reset, the same file gives no change event the next time.
        backupInput.value = ''
        if (file) withActions((actions) => actions.importBackup(file))
    })

    const appButton = qs('#app-menu-button')
    const appMenuElement = qs('#app-menu')
    const installItem = qs('[data-action="install"]', appMenuElement)
    const appMenu = createMenu({
        menu: appMenuElement,
        onOpen() {
            // iOS has no install prompt. There the item shows how to install by hand.
            installItem.hidden = !(canInstall() || (isIos() && !isStandalone()))
        },
        onSelect(item, anchor) {
            switch (item.dataset.action) {
                case 'install':
                    if (canInstall()) void promptInstall()
                    else openDialog(qs<HTMLDialogElement>('#install-dialog'), anchor)
                    break
                case 'import-backup':
                    // The file dialog opens only from inside the handler of the user action.
                    backupInput.click()
                    break
                case 'storage':
                    withActions((actions) => actions.showStorage(anchor))
                    break
                case 'export-backup':
                    withActions((actions) => actions.exportBackup())
                    break
                case 'about':
                    withActions((actions) => actions.showAbout(anchor))
                    break
            }
        },
    })
    on(appButton, 'click', (event) => {
        event.preventDefault()
        appMenu.toggle(appButton)
    })
}
