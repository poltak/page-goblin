import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupFile, RestoreResult } from '$lib/annotations/types'
import type { LibraryStorage } from '$lib/storage/types'
import { installOverlayMethods, mountPage } from '../app/testing/page'
import { clearToasts } from '../app/toast'
import { createAppActions } from './app-actions'
import type { AppActions } from './app-actions'

const backup: BackupFile = {
    format: 'web-ereader-backup',
    version: 1,
    exportedAt: '2026-10-12T10:00:00.000Z',
    books: [],
}

const restored: RestoreResult = {
    booksMatched: 2,
    booksMissing: 0,
    bookmarksAdded: 3,
    highlightsAdded: 0,
    highlightsUpdated: 0,
    progressUpdated: 1,
}

const mocks = vi.hoisted(() => ({
    getStorageEstimate: vi.fn<() => Promise<{ usage: number; quota: number } | null>>(),
    createBackup: vi.fn(),
    parseBackup: vi.fn(),
    restoreBackup: vi.fn(),
    downloadTextFile: vi.fn(),
}))

vi.mock('$lib/storage/storage-info', () => ({ getStorageEstimate: mocks.getStorageEstimate }))
vi.mock('$lib/annotations', () => ({
    createBackup: mocks.createBackup,
    parseBackup: mocks.parseBackup,
    restoreBackup: mocks.restoreBackup,
    downloadTextFile: mocks.downloadTextFile,
}))

const storage = { name: 'the storage' } as unknown as LibraryStorage
let actions: AppActions
let onRestored: ReturnType<typeof vi.fn<() => void>>
let opener: HTMLButtonElement

const el = <T extends HTMLElement = HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)!
const toasts = () =>
    Array.from(document.querySelectorAll<HTMLElement>('#toasts .toast')).map((toast) => ({
        text: toast.querySelector('span')?.textContent,
        error: toast.classList.contains('toast-error'),
    }))

beforeEach(() => {
    mountPage()
    installOverlayMethods()
    vi.clearAllMocks()
    mocks.createBackup.mockResolvedValue(backup)
    mocks.parseBackup.mockImplementation(() => backup)
    mocks.restoreBackup.mockResolvedValue(restored)
    onRestored = vi.fn<() => void>()
    opener = document.createElement('button')
    document.body.append(opener)
    actions = createAppActions({ storage, bookCount: () => 12, onRestored })
})

afterEach(() => {
    clearToasts()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('storage dialog', () => {
    it('shows the number of books and the space in megabytes', async () => {
        mocks.getStorageEstimate.mockResolvedValue({ usage: 45_678_000, quota: 2_000_000_000 })

        await actions.showStorage(opener)

        const dialog = el<HTMLDialogElement>('#storage-dialog')
        expect(dialog.open).toBe(true)
        expect(el('.storage-books').textContent).toBe('12 books')
        expect(el('.storage-usage').textContent).toBe('45.7 MB used')
    })

    it('says when the browser gives no number', async () => {
        mocks.getStorageEstimate.mockResolvedValue(null)

        await actions.showStorage(opener)

        expect(el('.storage-usage').textContent).toBe(
            'This browser does not tell how much space is in use.',
        )
    })

    it('gives the focus back to the opener at the close', async () => {
        mocks.getStorageEstimate.mockResolvedValue(null)
        await actions.showStorage(opener)

        el<HTMLDialogElement>('#storage-dialog').close()

        expect(document.activeElement).toBe(opener)
    })
})

describe('about dialog', () => {
    it('shows the name and that the data stays on the device', () => {
        actions.showAbout(opener)

        const dialog = el<HTMLDialogElement>('#about-dialog')
        expect(dialog.open).toBe(true)
        expect(dialog.querySelector('.modal-title')?.textContent).toBe('Web eReader')
        // The markup can break a sentence over two lines.
        expect(dialog.textContent?.replace(/\s+/g, ' ')).toContain('stay on this device')
    })

    it('hides the version line when the build has no version', () => {
        vi.stubEnv('VITE_APP_VERSION', '')

        actions.showAbout(opener)

        expect(el('.about-version').hidden).toBe(true)
    })

    it('shows the version of the build', () => {
        vi.stubEnv('VITE_APP_VERSION', '1.4.0')

        actions.showAbout(opener)

        expect(el('.about-version').hidden).toBe(false)
        expect(el('.about-version').textContent).toBe('Version 1.4.0')
    })
})

describe('export backup', () => {
    it('downloads the backup as a JSON file with the date in its name', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(2026, 9, 12, 15, 30))

        await actions.exportBackup()

        const options = mocks.createBackup.mock.calls[0][0]
        expect(options.storage).toBe(storage)
        expect(options.now()).toBe(new Date(2026, 9, 12, 15, 30).getTime())
        expect(mocks.downloadTextFile).toHaveBeenCalledWith({
            name: 'web-ereader-backup-2026-10-12.json',
            text: JSON.stringify(backup),
            type: 'application/json',
        })
        expect(toasts()).toEqual([])
    })

    it('shows a toast when the backup fails', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        mocks.createBackup.mockRejectedValue(new Error('The database is closed.'))

        await actions.exportBackup()

        expect(mocks.downloadTextFile).not.toHaveBeenCalled()
        expect(toasts()).toEqual([{ text: 'The backup was not made.', error: true }])
        expect(error).toHaveBeenCalled()
    })
})

describe('import backup', () => {
    const file = (text: string) => new File([text], 'backup.json', { type: 'application/json' })

    it('restores the file and shows the numbers in one sentence', async () => {
        await actions.importBackup(file('{"format":"web-ereader-backup"}'))

        expect(mocks.parseBackup).toHaveBeenCalledWith('{"format":"web-ereader-backup"}')
        expect(mocks.restoreBackup).toHaveBeenCalledWith({ storage, backup })
        expect(toasts()).toEqual([
            {
                text: 'Restored 1 reading position and 3 bookmarks for 2 books.',
                error: false,
            },
        ])
        expect(onRestored).toHaveBeenCalledTimes(1)
    })

    it('says when the file is not a backup, and writes nothing', async () => {
        mocks.parseBackup.mockImplementation(() => {
            throw new Error('This file is not a Web eReader backup.')
        })

        await actions.importBackup(file('<html>'))

        expect(mocks.restoreBackup).not.toHaveBeenCalled()
        expect(toasts()).toEqual([{ text: 'This file is not a Web eReader backup.', error: true }])
        expect(onRestored).not.toHaveBeenCalled()
    })

    it('says when a write fails, and reads the progress again', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        mocks.restoreBackup.mockRejectedValue(new Error('The transaction was aborted.'))

        await actions.importBackup(file('{}'))

        expect(toasts()).toEqual([
            { text: 'The backup was not restored completely. You can try again.', error: true },
        ])
        // The writes before the error stay in storage.
        expect(onRestored).toHaveBeenCalledTimes(1)
        expect(error).toHaveBeenCalled()
    })

    it('says when the file cannot be read', async () => {
        const broken = { text: () => Promise.reject(new Error('gone')) } as unknown as File

        await actions.importBackup(broken)

        expect(mocks.parseBackup).not.toHaveBeenCalled()
        expect(toasts()).toEqual([{ text: 'This file is not a Web eReader backup.', error: true }])
    })
})
