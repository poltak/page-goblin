/** The listen bar with a fake provider, a fake session, real settings and a fake wake lock. */

import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { createSettingsStore } from '$lib/settings'
import type { OwnedSettingsStore, SettingsPatch } from '$lib/settings'
import type { VoiceInfo } from '$lib/speech'
import { createFakeSpeechProvider } from '$lib/speech/testing/fake-provider'
import type { FakeSpeechProvider } from '$lib/speech/testing/fake-provider'
import type { Locator } from '$lib/types'
import { installOverlayMethods } from '../../../app/testing/page'
import { qs } from '../../../dom'
import type { ModeController } from '../../parts'
import { createListenBarWith } from '../bar'
import { createFakeSession } from './fake-session'
import type { FakeChapter, FakeSession } from './fake-session'

export const VOICES: VoiceInfo[] = [
    { id: 'en-us-alice', name: 'Alice', lang: 'en-US', local: true, isDefault: true },
    { id: 'en-gb-brian', name: 'Brian', lang: 'en-GB', local: false, isDefault: false },
    { id: 'fr-fr-chloe', name: 'Chloe', lang: 'fr-FR', local: true, isDefault: false },
]

export interface HarnessOptions {
    chapters?: (string | FakeChapter)[]
    voices?: VoiceInfo[]
    supported?: boolean
    language?: string | null
    position?: Locator | null
    settings?: SettingsPatch
}

export interface Harness {
    bar: ModeController
    provider: FakeSpeechProvider
    session: FakeSession
    settings: OwnedSettingsStore
    wakeLock: { request: Mock<() => Promise<void>>; release: Mock<() => Promise<void>> }
    onExit: Mock<() => void>
    dock: HTMLElement
    host: HTMLElement
    /** Calls in sequence: cancel, marker:…, wake:request, wake:release, mode:…, exit. */
    log: string[]
    /** The bar element in the dock, or null. */
    element(): HTMLElement | null
    /** The `data-state` of the bar, or null when the bar is not in the dock. */
    state(): string | null
    button(action: string): HTMLButtonElement
    /** The text of the toast on screen, or null. */
    toast(): string | null
    /** Sends a keydown event. Returns the event. */
    press(key: string, init?: KeyboardEventInit, target?: EventTarget): KeyboardEvent
    /** Starts the mode and sends the start event of the first utterance. */
    play(locator?: Locator): Promise<void>
    /** The texts of all utterances. */
    spoken(): string[]
}

export function createHarness(options: HarnessOptions = {}): Harness {
    installOverlayMethods()
    document.body.innerHTML = '<div id="dock"></div><div id="host"></div><div id="toasts"></div>'
    const dock = qs('#dock')
    const host = qs('#host')
    const log: string[] = []

    const provider = createFakeSpeechProvider({
        voices: options.voices ?? VOICES,
        supported: options.supported ?? true,
    })
    const cancel = provider.cancel
    provider.cancel = () => {
        log.push('cancel')
        cancel()
    }

    const stored = new Map<string, string>()
    const settings = createSettingsStore({
        storage: {
            getItem: (key) => stored.get(key) ?? null,
            setItem: (key, value) => void stored.set(key, value),
        },
    })
    if (options.settings) settings.update(options.settings)

    const session = createFakeSession({
        chapters: options.chapters ?? ['One. Two. Three.', 'Four. Five.'],
        language: options.language,
        position: options.position,
        log,
    })
    const wakeLock = {
        request: vi.fn(async () => void log.push('wake:request')),
        release: vi.fn(async () => void log.push('wake:release')),
    }
    const onExit = vi.fn(() => void log.push('exit'))
    const bar = createListenBarWith({ session, host, dock, onExit, provider, settings, wakeLock })

    const element = (): HTMLElement | null => dock.querySelector<HTMLElement>('.listen-bar')

    return {
        bar,
        provider,
        session,
        settings,
        wakeLock,
        onExit,
        dock,
        host,
        log,
        element,
        state: () => element()?.dataset.state ?? null,
        button: (action) => qs<HTMLButtonElement>(`[data-action="${action}"]`, dock),
        toast: () => document.querySelector('#toasts .toast span')?.textContent ?? null,
        press(key, init = {}, target = document.body) {
            const event = new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
                ...init,
            })
            target.dispatchEvent(event)
            return event
        },
        async play(locator) {
            await bar.start(locator)
            provider.last().onStart()
        },
        spoken: () => provider.utterances.map((utterance) => utterance.text),
    }
}
