/**
 * The sync dialog: connect this device to a sync server, show the sync code, and turn the
 * sync off. The markup is `dialog#sync-dialog` in index.html. The host loads this file when
 * the user opens the dialog the first time.
 */

import { copyText } from '$lib/annotations/download'
import { createSyncClient, setupServer } from '$lib/sync/client'
import {
    createSyncCode,
    createSyncLink,
    deriveToken,
    normalizeServerUrl,
    normalizeSyncCode,
} from '$lib/sync/code'
import { SyncError } from '$lib/sync/types'
import type { SyncConfig, SyncStatus } from '$lib/sync/types'
import { openDialog } from '../app/dialog'
import { on, qs, qsa } from '../dom'
import type { SyncHost } from './host'

type View = 'connect' | 'exists' | 'on' | 'turn-off'

/** The control that gets the focus when a view shows after an action of the user. */
const FOCUS: Record<View, string> = {
    connect: '#sync-server',
    exists: '[data-sync-action="back"]',
    on: '[data-close]',
    'turn-off': '[data-sync-action="back"]',
}

export interface SyncDialogOptions {
    dialog: HTMLDialogElement
    host: SyncHost
}

export interface SyncDialog {
    /** With `link`, the form shows the server and the code of a sync link. */
    show(options: { opener: Element | null; link?: SyncConfig }): void
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** The text of the status line. */
export function statusText(status: SyncStatus): string {
    if (status.phase === 'syncing') return 'Syncing now.'
    if (status.phase === 'error' && status.error) {
        return `The last sync did not complete. ${status.error.message}`
    }
    if (status.syncedAt === null) return 'Sync is on.'
    return `Sync is on. Last sync at ${TIME_FORMAT.format(status.syncedAt)}.`
}

function messageOf(error: unknown): string {
    if (error instanceof SyncError) return error.message
    console.error(error)
    return 'The sync did not start. Try again.'
}

export function createSyncDialog({ dialog, host }: SyncDialogOptions): SyncDialog {
    const form = qs<HTMLFormElement>('[data-view="connect"]', dialog)
    const serverInput = qs<HTMLInputElement>('#sync-server', dialog)
    const codeInput = qs<HTMLInputElement>('#sync-code', dialog)
    const setupInput = qs<HTMLInputElement>('#sync-setup-code', dialog)
    const submit = qs<HTMLButtonElement>('.sync-submit', dialog)
    const statusLine = qs('.sync-status', dialog)
    const note = qs('.sync-note', dialog)
    let view: View = 'connect'
    let busy = false
    let focusTarget: HTMLElement | null = null
    /** The server and the setup code of a setup that found a sync code on the server. */
    let pending: { server: string; setupCode: string } | null = null

    function mode(): 'join' | 'setup' {
        return qs<HTMLInputElement>('input[name="sync-mode"]:checked', dialog).value as
            'join' | 'setup'
    }

    function applyMode(): void {
        for (const field of qsa('[data-mode]', form)) {
            field.hidden = field.dataset.mode !== mode()
        }
    }

    function setError(text: string): void {
        for (const error of qsa('.sync-error', dialog)) {
            error.textContent = text
            error.hidden = text === ''
        }
    }

    function setBusy(next: boolean): void {
        busy = next
        submit.disabled = next
        for (const button of qsa<HTMLButtonElement>('[data-sync-action]', dialog)) {
            button.disabled = next
        }
    }

    /**
     * The focus must not stay on a control of the view that is now hidden. During an action
     * the buttons are disabled, so the focus moves when the action ends.
     */
    function showView(next: View, { focus = true } = {}): void {
        view = next
        for (const section of qsa('.sync-view', dialog)) {
            section.hidden = section.dataset.view !== next
            if (!section.hidden && focus) focusTarget = qs(FOCUS[next], section)
        }
        setError('')
        note.textContent = ''
        if (!busy) applyFocus()
    }

    function applyFocus(): void {
        focusTarget?.focus()
        focusTarget = null
    }

    function renderOn(): void {
        const config = host.config()
        if (!config) return
        qs('.sync-code', dialog).textContent = config.code
        qs('.sync-address', dialog).textContent = config.server
        statusLine.textContent = statusText(host.status())
    }

    async function turnOn(config: SyncConfig): Promise<void> {
        await host.turnOn(config)
        // A secret must not stay in the page.
        setupInput.value = ''
        codeInput.value = ''
        pending = null
        renderOn()
        showView('on')
    }

    async function setUpNew(target: { server: string; setupCode: string }, replace: boolean) {
        const code = createSyncCode()
        const token = await deriveToken(code)
        try {
            await setupServer({ ...target, token, replace })
        } catch (error) {
            if (error instanceof SyncError && error.code === 'exists') {
                pending = target
                showView('exists')
                return
            }
            throw error
        }
        await turnOn({ server: target.server, code })
        note.textContent = 'Save this code now. Your other devices need it.'
    }

    async function connect(): Promise<void> {
        let server: string
        try {
            server = normalizeServerUrl(serverInput.value)
        } catch (error) {
            setError(messageOf(error))
            serverInput.focus()
            return
        }
        if (mode() === 'setup') {
            const setupCode = setupInput.value
            if (setupCode === '') {
                setError('Enter the setup code of your Worker.')
                setupInput.focus()
                return
            }
            await setUpNew({ server, setupCode }, false)
            return
        }
        const code = normalizeSyncCode(codeInput.value)
        if (!code) {
            setError('This is not a sync code. A sync code has 24 letters and digits.')
            codeInput.focus()
            return
        }
        // The status call checks the address and the code before the sync turns on.
        await createSyncClient({ server, token: await deriveToken(code) }).status()
        await turnOn({ server, code })
    }

    /** Runs one action of the user. The dialog shows its error. */
    async function act(work: () => Promise<void>): Promise<void> {
        if (busy) return
        setBusy(true)
        setError('')
        try {
            await work()
        } catch (error) {
            setError(messageOf(error))
        } finally {
            setBusy(false)
            applyFocus()
        }
    }

    async function copy(text: string, done: string): Promise<void> {
        note.textContent = (await copyText(text))
            ? done
            : 'The browser did not let the app copy. Select the code and copy it.'
    }

    on(form, 'submit', (event) => {
        event.preventDefault()
        void act(connect)
    })
    for (const input of qsa<HTMLInputElement>('input[name="sync-mode"]', dialog)) {
        on(input, 'change', applyMode)
    }

    on(dialog, 'click', (event) => {
        const action = (event.target as Element).closest<HTMLElement>('[data-sync-action]')?.dataset
            .syncAction
        const config = host.config()
        switch (action) {
            case 'back':
                showView(host.isOn() ? 'on' : 'connect')
                break
            case 'replace':
                if (pending) {
                    const target = pending
                    void act(() => setUpNew(target, true))
                }
                break
            case 'copy-code':
                if (config) void copy(config.code, 'The code is copied.')
                break
            case 'copy-link':
                if (config) {
                    const link = createSyncLink({ appUrl: location.href, config })
                    void copy(link, 'The link is copied. Open it on your other device.')
                }
                break
            case 'sync-now':
                void act(() => host.syncNow())
                break
            case 'turn-off':
                showView('turn-off')
                break
            case 'confirm-off':
                void act(async () => {
                    await host.turnOff()
                    showView('connect')
                })
                break
        }
    })

    host.onStatus((status) => {
        if (view === 'on') statusLine.textContent = statusText(status)
    })

    return {
        show({ opener, link }) {
            // `openDialog` gives the first focus.
            if (host.isOn()) {
                renderOn()
                showView('on', { focus: false })
            } else {
                showView('connect', { focus: false })
                if (link) {
                    serverInput.value = link.server
                    codeInput.value = link.code
                    qs<HTMLInputElement>('input[value="join"]', dialog).checked = true
                }
                applyMode()
            }
            openDialog(dialog, opener)
        },
    }
}
