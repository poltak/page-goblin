import { describe, expect, it, vi } from 'vitest'
import type { SpeakOptions } from '$lib/speech'
import { SpeechError } from '$lib/speech'
import { createFakeSpeechProvider } from '$lib/speech/testing/fake-provider'
import { observeProvider } from './observe-provider'

function utterance(text: string): SpeakOptions {
    return {
        text,
        voice: null,
        rate: 1,
        pitch: 1,
        lang: null,
        onStart: vi.fn<() => void>(),
        onEnd: vi.fn<() => void>(),
        onError: vi.fn<(error: SpeechError) => void>(),
        onBoundary: vi.fn<SpeakOptions['onBoundary']>(),
    }
}

describe('observeProvider', () => {
    it('gives each call to the provider', () => {
        const fake = createFakeSpeechProvider({
            voices: [{ id: 'a', name: 'A', lang: 'en', local: true, isDefault: true }],
        })
        const provider = observeProvider(fake, () => {})
        const listener = vi.fn<() => void>()

        expect(provider.isSupported()).toBe(true)
        expect(provider.getVoices()).toBe(fake.voices)
        const remove = provider.onVoicesChanged(listener)
        fake.emitVoicesChanged()
        remove()
        fake.emitVoicesChanged()
        expect(listener).toHaveBeenCalledTimes(1)

        provider.speak(utterance('One.'))
        provider.pause()
        expect(provider.resume()).toBe(true)
        provider.cancel()
        expect(fake.calls).toEqual(['speak', 'pause', 'resume', 'cancel'])
        expect(fake.last().text).toBe('One.')
        expect(provider.speakCount).toBe(1)
    })

    it('tells each start, word and end event, then gives it to the caller', () => {
        const fake = createFakeSpeechProvider()
        const onSound = vi.fn<() => void>()
        const provider = observeProvider(fake, onSound)
        const options = utterance('One.')
        provider.speak(options)

        fake.last().onStart()
        expect(onSound).toHaveBeenCalledTimes(1)
        expect(options.onStart).toHaveBeenCalledTimes(1)

        fake.last().onBoundary({ charIndex: 0, charLength: 3 })
        expect(onSound).toHaveBeenCalledTimes(2)
        expect(options.onBoundary).toHaveBeenCalledWith({ charIndex: 0, charLength: 3 })

        fake.last().onEnd()
        expect(onSound).toHaveBeenCalledTimes(3)
        expect(options.onEnd).toHaveBeenCalledTimes(1)
    })

    it('does not take an error as sound', () => {
        const fake = createFakeSpeechProvider()
        const onSound = vi.fn<() => void>()
        const provider = observeProvider(fake, onSound)
        const options = utterance('One.')
        provider.speak(options)
        fake.fail('not-allowed')
        expect(onSound).not.toHaveBeenCalled()
        expect(options.onError).toHaveBeenCalledTimes(1)
    })

    it('does not take a late event of an older utterance as sound', () => {
        const fake = createFakeSpeechProvider()
        const onSound = vi.fn<() => void>()
        const provider = observeProvider(fake, onSound)
        const first = utterance('One.')
        provider.speak(first)
        const old = fake.last()
        provider.cancel()
        provider.speak(utterance('Two.'))

        old.onEnd()
        expect(onSound).not.toHaveBeenCalled()
        // The caller still gets the event and decides itself.
        expect(first.onEnd).toHaveBeenCalledTimes(1)
    })
})
