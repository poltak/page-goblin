import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupServerOptions, SyncClientOptions } from '$lib/sync/client'
import { SyncError } from '$lib/sync/types'
import type { SyncConfig, SyncStatus } from '$lib/sync/types'
import { installOverlayMethods, mountPage } from '../app/testing/page'
import { createSyncDialog, statusText } from './dialog'
import type { SyncDialog } from './dialog'
import type { SyncHost } from './host'

const mocks = vi.hoisted(() => ({
    setupServer: vi.fn<(options: SetupServerOptions) => Promise<{ account: string }>>(),
    status: vi.fn<() => Promise<{ account: string }>>(),
    clients: [] as SyncClientOptions[],
}))

vi.mock('$lib/sync/client', () => ({
    setupServer: mocks.setupServer,
    createSyncClient: (options: SyncClientOptions) => {
        mocks.clients.push(options)
        return { status: mocks.status }
    },
}))

const SERVER = 'https://sync.name.workers.dev'
const CODE = '7K3Q-M9XA-0000-1111-2222-3333'

let config: SyncConfig | null
let statusListeners: Array<(status: SyncStatus) => void>
let host: SyncHost & {
    turnOn: ReturnType<typeof vi.fn<(config: SyncConfig) => Promise<void>>>
    turnOff: ReturnType<typeof vi.fn<() => Promise<void>>>
    syncNow: ReturnType<typeof vi.fn<() => Promise<void>>>
}
let dialog: HTMLDialogElement
let syncDialog: SyncDialog

const el = <T extends HTMLElement = HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!
const shownView = () =>
    Array.from(dialog.querySelectorAll<HTMLElement>('.sync-view')).find((view) => !view.hidden)
        ?.dataset.view
const errorText = () =>
    Array.from(dialog.querySelectorAll<HTMLElement>('.sync-error'))
        .filter((error) => !error.hidden)
        .map((error) => error.textContent)[0] ?? ''

function type(selector: string, value: string): void {
    el<HTMLInputElement>(selector).value = value
}

function chooseMode(mode: 'join' | 'setup'): void {
    const input = el<HTMLInputElement>(`input[name="sync-mode"][value="${mode}"]`)
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

function submit(): void {
    el<HTMLFormElement>('[data-view="connect"]').requestSubmit()
}

function act(action: string): void {
    el(`[data-sync-action="${action}"]`).click()
}

beforeEach(() => {
    mountPage()
    installOverlayMethods()
    dialog = document.querySelector<HTMLDialogElement>('#sync-dialog')!
    config = null
    statusListeners = []
    mocks.setupServer.mockReset().mockResolvedValue({ account: 'acc' })
    mocks.status.mockReset().mockResolvedValue({ account: 'acc' })
    mocks.clients.length = 0
    host = {
        tracker: { isOn: () => config !== null, onChange: () => {} },
        isOn: () => config !== null,
        connectStorage: () => {},
        start: () => {},
        config: () => config,
        status: () => ({ phase: 'idle', syncedAt: null, error: null }),
        onStatus(listener) {
            statusListeners.push(listener)
            return () => {}
        },
        turnOn: vi.fn(async (next: SyncConfig) => {
            config = next
        }),
        turnOff: vi.fn(async () => {
            config = null
        }),
        syncNow: vi.fn(async () => {}),
        downloadFile: async () => {},
        removeDownload: async () => true,
        openDialog: () => {},
    }
    syncDialog = createSyncDialog({ dialog, host })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('statusText', () => {
    it('describes each state of the sync', () => {
        expect(statusText({ phase: 'syncing', syncedAt: null, error: null })).toBe('Syncing now.')
        expect(statusText({ phase: 'idle', syncedAt: null, error: null })).toBe('Sync is on.')
        expect(statusText({ phase: 'idle', syncedAt: 0, error: null })).toMatch(
            /^Sync is on\. Last sync at .+\.$/,
        )
        const error = new SyncError('offline', 'The sync server did not answer.')
        expect(statusText({ phase: 'error', syncedAt: null, error })).toBe(
            'The last sync did not complete. The sync server did not answer.',
        )
    })
})

describe('createSyncDialog', () => {
    it('shows the connect form while the sync is off', () => {
        syncDialog.show({ opener: null })

        expect(dialog.open).toBe(true)
        expect(shownView()).toBe('connect')
        expect(el('[data-mode="join"]').hidden).toBe(false)
        expect(el('[data-mode="setup"]').hidden).toBe(true)
    })

    it('fills in the server and the code of a sync link', () => {
        syncDialog.show({ opener: null, link: { server: SERVER, code: CODE } })

        expect(el<HTMLInputElement>('#sync-server').value).toBe(SERVER)
        expect(el<HTMLInputElement>('#sync-code').value).toBe(CODE)
    })

    it('joins with a sync code after the server accepts it', async () => {
        syncDialog.show({ opener: null })
        type('#sync-server', 'sync.name.workers.dev/')
        type('#sync-code', CODE.toLowerCase())
        submit()

        await vi.waitFor(() => expect(shownView()).toBe('on'))
        expect(mocks.clients[0].server).toBe(SERVER)
        expect(mocks.clients[0].token).toMatch(/^[0-9a-f]{64}$/)
        expect(host.turnOn).toHaveBeenCalledWith({ server: SERVER, code: CODE })
        expect(el('.sync-code').textContent).toBe(CODE)
        expect(el('.sync-address').textContent).toBe(SERVER)
        // A secret must not stay in the form.
        expect(el<HTMLInputElement>('#sync-code').value).toBe('')
        // The Connect button is hidden now, so the focus goes to Done.
        expect(document.activeElement).toBe(el('[data-view="on"] [data-close]'))
    })

    it('shows the reason when the server refuses the code', async () => {
        mocks.status.mockRejectedValue(
            new SyncError('unauthorized', 'The sync code is not correct.'),
        )
        syncDialog.show({ opener: null })
        type('#sync-server', SERVER)
        type('#sync-code', CODE)
        submit()

        await vi.waitFor(() => expect(errorText()).toBe('The sync code is not correct.'))
        expect(host.turnOn).not.toHaveBeenCalled()
        expect(shownView()).toBe('connect')
    })

    it('checks the address and the code before it calls the server', async () => {
        syncDialog.show({ opener: null })
        type('#sync-server', 'https://example.com')
        submit()
        await vi.waitFor(() => expect(errorText()).toContain('workers.dev'))

        type('#sync-server', SERVER)
        type('#sync-code', 'not a code')
        submit()
        await vi.waitFor(() => expect(errorText()).toContain('This is not a sync code'))

        expect(mocks.status).not.toHaveBeenCalled()
    })

    it('sets up a new server and shows the new code', async () => {
        syncDialog.show({ opener: null })
        chooseMode('setup')
        expect(el('[data-mode="setup"]').hidden).toBe(false)
        type('#sync-server', SERVER)
        type('#sync-setup-code', 'my-long-setup-code')
        submit()

        await vi.waitFor(() => expect(shownView()).toBe('on'))
        const [options] = mocks.setupServer.mock.calls[0]
        expect(options).toMatchObject({ server: SERVER, setupCode: 'my-long-setup-code' })
        expect(options.replace).toBe(false)
        const code = host.turnOn.mock.calls[0][0].code
        expect(code).toMatch(/^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/)
        expect(el('.sync-code').textContent).toBe(code)
        expect(el('.sync-note').textContent).toContain('Save this code')
        expect(el<HTMLInputElement>('#sync-setup-code').value).toBe('')
    })

    it('asks before it replaces the code of a server that has one', async () => {
        mocks.setupServer.mockRejectedValueOnce(new SyncError('exists', 'It has a code.'))
        syncDialog.show({ opener: null })
        chooseMode('setup')
        type('#sync-server', SERVER)
        type('#sync-setup-code', 'my-long-setup-code')
        submit()

        await vi.waitFor(() => expect(shownView()).toBe('exists'))
        expect(host.turnOn).not.toHaveBeenCalled()

        act('replace')
        await vi.waitFor(() => expect(shownView()).toBe('on'))
        expect(mocks.setupServer.mock.calls[1][0].replace).toBe(true)
    })

    it('shows the code, the status and the address while the sync is on', () => {
        config = { server: SERVER, code: CODE }
        syncDialog.show({ opener: null })

        expect(shownView()).toBe('on')
        expect(el('.sync-code').textContent).toBe(CODE)
        expect(el('.sync-status').textContent).toBe('Sync is on.')

        for (const listener of statusListeners) {
            listener({ phase: 'syncing', syncedAt: null, error: null })
        }
        expect(el('.sync-status').textContent).toBe('Syncing now.')
    })

    it('copies the code and a link that adds a device', async () => {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
        config = { server: SERVER, code: CODE }
        syncDialog.show({ opener: null })

        act('copy-code')
        await vi.waitFor(() => expect(el('.sync-note').textContent).toBe('The code is copied.'))
        act('copy-link')
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))

        expect(writeText).toHaveBeenNthCalledWith(1, CODE)
        const link = new URL(String(writeText.mock.calls[1]))
        expect(link.hash.startsWith('#sync&')).toBe(true)
        expect(link.hash).toContain(encodeURIComponent(SERVER))
    })

    it('syncs now', async () => {
        config = { server: SERVER, code: CODE }
        syncDialog.show({ opener: null })

        act('sync-now')

        await vi.waitFor(() => expect(host.syncNow).toHaveBeenCalledTimes(1))
    })

    it('asks before it turns the sync off', async () => {
        config = { server: SERVER, code: CODE }
        syncDialog.show({ opener: null })

        act('turn-off')
        expect(shownView()).toBe('turn-off')
        expect(document.activeElement).toBe(el('[data-view="turn-off"] [data-sync-action="back"]'))
        act('back')
        expect(shownView()).toBe('on')

        act('turn-off')
        act('confirm-off')
        await vi.waitFor(() => expect(shownView()).toBe('connect'))
        expect(host.turnOff).toHaveBeenCalledTimes(1)
    })
})
