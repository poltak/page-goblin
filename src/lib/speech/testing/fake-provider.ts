/**
 * Test doubles for the speech module: a provider that records its calls, timers that a test
 * moves by hand, and a simple sentence splitter.
 */

import type { Sentence } from '$lib/content/types'
import type { SpeechTimers } from '../controller'
import { SpeechError, type SpeakOptions, type SpeechProvider, type VoiceInfo } from '../provider'

export interface FakeSpeechProviderOptions {
    supported?: boolean
    voices?: VoiceInfo[]
    /** False acts as an Android browser: `resume` cannot continue a paused utterance. */
    keepsPausedUtterance?: boolean
}

export interface FakeSpeechProvider extends SpeechProvider {
    /** All `speak` calls in order. */
    readonly utterances: SpeakOptions[]
    /** Names of the provider methods that were called: speak, pause, resume, cancel. */
    readonly calls: string[]
    voices: VoiceInfo[]
    keepsPausedUtterance: boolean
    /** The utterance that the provider speaks now or keeps in a pause, or null. */
    readonly active: SpeakOptions | null
    /** The last `speak` call. */
    last(): SpeakOptions
    /** Sends the end event of the utterance that the provider speaks now. */
    end(): void
    /** Sends an error event of the utterance that the provider speaks now. */
    fail(code: string): void
    emitVoicesChanged(): void
}

export function createFakeSpeechProvider({
    supported = true,
    voices = [],
    keepsPausedUtterance = true,
}: FakeSpeechProviderOptions = {}): FakeSpeechProvider {
    const listeners = new Set<() => void>()
    let active: SpeakOptions | null = null
    let paused = false

    const provider: FakeSpeechProvider = {
        utterances: [],
        calls: [],
        voices,
        keepsPausedUtterance,
        get active() {
            return active
        },
        isSupported: () => supported,
        getVoices: () => provider.voices,
        onVoicesChanged(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        speak(options) {
            provider.calls.push('speak')
            provider.utterances.push(options)
            active = options
        },
        pause() {
            provider.calls.push('pause')
            paused = true
            if (!provider.keepsPausedUtterance) active = null
        },
        resume() {
            provider.calls.push('resume')
            const kept = paused && active !== null
            paused = false
            return kept
        },
        cancel() {
            provider.calls.push('cancel')
            active = null
            paused = false
        },
        last() {
            const utterance = provider.utterances.at(-1)
            if (!utterance) throw new Error('The provider did not speak.')
            return utterance
        },
        end() {
            const utterance = active
            if (!utterance) throw new Error('The provider has no active utterance.')
            active = null
            utterance.onEnd()
        },
        fail(code) {
            const utterance = active
            if (!utterance) throw new Error('The provider has no active utterance.')
            active = null
            utterance.onError(new SpeechError(code))
        },
        emitVoicesChanged() {
            for (const listener of [...listeners]) listener()
        },
    }
    return provider
}

export interface FakeTimers extends SpeechTimers {
    /** Number of timers that wait. */
    readonly pending: number
    /** Delay of the timer that was set last, or null. */
    readonly lastDelay: number | null
    /** Moves the clock and runs the timers that are due. */
    advance(milliseconds: number): void
}

export function createFakeTimers(): FakeTimers {
    const waiting = new Map<number, { at: number; callback: () => void }>()
    let now = 0
    let nextHandle = 1
    let lastDelay: number | null = null

    return {
        get pending() {
            return waiting.size
        },
        get lastDelay() {
            return lastDelay
        },
        setTimeout(callback, delay) {
            const handle = nextHandle++
            lastDelay = delay
            waiting.set(handle, { at: now + delay, callback })
            return handle
        },
        clearTimeout(handle) {
            waiting.delete(handle as number)
        },
        advance(milliseconds) {
            now += milliseconds
            for (const [handle, timer] of [...waiting]) {
                if (timer.at > now || !waiting.has(handle)) continue
                waiting.delete(handle)
                timer.callback()
            }
        },
    }
}

/** Splits at ".", "!" and "?". Sufficient for tests. All sentences are in block 0. */
export function sentencesOf(text: string): Sentence[] {
    const sentences: Sentence[] = []
    for (const match of text.matchAll(/[^.!?]+[.!?]*/g)) {
        const trimmed = match[0].trim()
        if (!trimmed) continue
        const start = match.index + match[0].indexOf(trimmed)
        sentences.push({ start, end: start + trimmed.length, block: 0 })
    }
    return sentences
}
