import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsStore } from '$lib/settings/store'
import type { OwnedSettingsStore } from '$lib/settings/store'
import type { LibraryStorage } from '$lib/storage/types'
import { installOverlayMethods, mountPage, settle } from '../app/testing/page'
import { clearToasts } from '../app/toast'
import { connectLibraryHeader } from './header'

const mocks = vi.hoisted(() => ({
    canInstall: vi.fn(() => false),
    isIos: vi.fn(() => false),
    isStandalone: vi.fn(() => false),
    promptInstall: vi.fn(async () => 'accepted' as const),
    actions: {
        showStorage: vi.fn(async () => {}),
        showAbout: vi.fn(),
        exportBackup: vi.fn(async () => {}),
        importBackup: vi.fn(async () => {}),
    },
}))

vi.mock('$lib/pwa/install', () => ({
    canInstall: mocks.canInstall,
    isIos: mocks.isIos,
    isStandalone: mocks.isStandalone,
    promptInstall: mocks.promptInstall,
}))
vi.mock('./app-actions', () => ({ createAppActions: () => mocks.actions }))

let settings: OwnedSettingsStore

const el = <T extends HTMLElement = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)!
const isOpen = (selector: string) => 'open' in el(selector).dataset

function press(selector: string): MouseEvent {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    el(selector).dispatchEvent(event)
    return event
}

function checkedThemes(): string[] {
    return Array.from(
        document.querySelectorAll<HTMLElement>('#theme-menu [aria-checked="true"]'),
    ).map((item) => item.dataset.themeChoice ?? '')
}

beforeEach(() => {
    mountPage()
    installOverlayMethods()
    settings = createSettingsStore({ storage: null })
    vi.clearAllMocks()
    mocks.canInstall.mockReturnValue(false)
    mocks.isIos.mockReturnValue(false)
    mocks.isStandalone.mockReturnValue(false)
    connectLibraryHeader({
        settings,
        storage: {} as LibraryStorage,
        bookCount: () => 3,
        onRestored() {},
    })
})

afterEach(() => {
    clearToasts()
    settings.destroy()
})

describe('the library header', () => {
    it('has the name as text and labels for the icon buttons', () => {
        expect(el('.library-name').textContent).toBe('Web eReader')
        expect(el('.library-header').querySelector('img')).toBeNull()
        expect(el('#theme-button').getAttribute('aria-label')).toBe('Theme')
        expect(el('#app-menu-button').getAttribute('aria-label')).toBe('More')
        expect(el('.library-add').textContent?.trim()).toBe('Add books')
    })
})

describe('the theme menu', () => {
    it('offers the five themes', () => {
        const items = Array.from(document.querySelectorAll<HTMLElement>('#theme-menu .menu-item'))

        expect(items.map((item) => [item.dataset.themeChoice, item.textContent?.trim()])).toEqual([
            ['auto', 'Auto'],
            ['light', 'Light'],
            ['sepia', 'Sepia'],
            ['dark', 'Dark'],
            ['black', 'Black'],
        ])
    })

    it('opens from the theme button with the current theme checked', () => {
        settings.update({ theme: 'sepia' })

        const event = press('#theme-button')

        expect(isOpen('#theme-menu')).toBe(true)
        expect(event.defaultPrevented).toBe(true)
        expect(el('#theme-button').getAttribute('aria-expanded')).toBe('true')
        expect(checkedThemes()).toEqual(['sepia'])
    })

    it('checks "Auto" for the default settings', () => {
        press('#theme-button')

        expect(checkedThemes()).toEqual(['auto'])
    })

    it('saves the chosen theme and closes', () => {
        press('#theme-button')
        press('#theme-menu [data-theme-choice="sepia"]')

        expect(settings.get().theme).toBe('sepia')
        expect(isOpen('#theme-menu')).toBe(false)

        press('#theme-button')
        expect(checkedThemes()).toEqual(['sepia'])
    })

    it('also makes a chosen dark theme the one that "Auto" uses', () => {
        press('#theme-button')
        press('#theme-menu [data-theme-choice="black"]')
        expect(settings.get().theme).toBe('black')
        expect(settings.get().darkTheme).toBe('black')

        press('#theme-button')
        press('#theme-menu [data-theme-choice="auto"]')
        expect(settings.get().theme).toBe('auto')
        expect(settings.get().darkTheme).toBe('black')

        press('#theme-button')
        press('#theme-menu [data-theme-choice="light"]')
        expect(settings.get().darkTheme).toBe('black')
    })
})

describe('the app menu', () => {
    const installItem = () => el('#app-menu [data-action="install"]')

    it('hides "Install app" when the browser cannot install the app', () => {
        press('#app-menu-button')

        expect(isOpen('#app-menu')).toBe(true)
        expect(installItem().hidden).toBe(true)
    })

    it('shows "Install app" when the browser can install, and starts the prompt', () => {
        mocks.canInstall.mockReturnValue(true)
        press('#app-menu-button')
        expect(installItem().hidden).toBe(false)

        press('#app-menu [data-action="install"]')

        expect(mocks.promptInstall).toHaveBeenCalledTimes(1)
        expect(el<HTMLDialogElement>('#install-dialog').open).toBe(false)
    })

    it('shows how to install on iOS, where there is no prompt', () => {
        mocks.isIos.mockReturnValue(true)
        press('#app-menu-button')
        expect(installItem().hidden).toBe(false)

        press('#app-menu [data-action="install"]')

        const dialog = el<HTMLDialogElement>('#install-dialog')
        expect(dialog.open).toBe(true)
        expect(dialog.textContent?.replace(/\s+/g, ' ')).toContain(
            'To install: tap Share, then Add to Home Screen',
        )
        expect(mocks.promptInstall).not.toHaveBeenCalled()
    })

    it('hides "Install app" on iOS when the app is installed already', () => {
        mocks.isIos.mockReturnValue(true)
        mocks.isStandalone.mockReturnValue(true)

        press('#app-menu-button')

        expect(installItem().hidden).toBe(true)
    })

    it('loads the actions at the first use and runs them', async () => {
        press('#app-menu-button')
        press('#app-menu [data-action="storage"]')
        await settle()
        expect(mocks.actions.showStorage).toHaveBeenCalledWith(el('#app-menu-button'))

        press('#app-menu-button')
        press('#app-menu [data-action="about"]')
        await settle()
        expect(mocks.actions.showAbout).toHaveBeenCalledWith(el('#app-menu-button'))

        press('#app-menu-button')
        press('#app-menu [data-action="export-backup"]')
        await settle()
        expect(mocks.actions.exportBackup).toHaveBeenCalledTimes(1)
    })

    it('opens the file dialog for "Import backup" inside the click', () => {
        const input = el<HTMLInputElement>('#backup-file')
        const open = vi.spyOn(input, 'click').mockImplementation(() => {})
        press('#app-menu-button')

        press('#app-menu [data-action="import-backup"]')

        expect(open).toHaveBeenCalledTimes(1)
    })

    it('restores the chosen backup file and resets the input', async () => {
        const input = el<HTMLInputElement>('#backup-file')
        const file = new File(['{}'], 'backup.json', { type: 'application/json' })
        Object.defineProperty(input, 'files', { configurable: true, get: () => [file] })
        const setValue = vi.spyOn(input, 'value', 'set')

        input.dispatchEvent(new Event('change', { bubbles: true }))
        await settle()

        expect(setValue).toHaveBeenCalledWith('')
        expect(mocks.actions.importBackup).toHaveBeenCalledWith(file)
    })

    it('does nothing when the file dialog closes with no file', async () => {
        el('#backup-file').dispatchEvent(new Event('change', { bubbles: true }))
        await settle()

        expect(mocks.actions.importBackup).not.toHaveBeenCalled()
    })
})
