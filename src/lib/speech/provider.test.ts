import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    SpeechError,
    createBrowserSpeechProvider,
    type SpeakOptions,
    type SpeechSynthesisLike,
} from './provider'

class FakeUtterance {
    voice: unknown = null
    lang = ''
    rate = 1
    pitch = 1
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    onerror: ((event: { error?: string }) => void) | null = null
    onboundary:
        ((event: { name?: string; charIndex: number; charLength?: number }) => void) | null = null

    constructor(public text: string) {}
}

/** Makes a browser voice from a label of the form "name lang", for example "Daniel en_GB". */
function browserVoice(label: string, extra: Partial<SpeechSynthesisVoice> = {}) {
    const [name, lang] = label.split(' ')
    return {
        name,
        lang,
        voiceURI: `uri:${name}`,
        localService: true,
        default: false,
        ...extra,
    } as SpeechSynthesisVoice
}

function setup(voices: SpeechSynthesisVoice[] = []) {
    const calls: string[] = []
    const spoken: FakeUtterance[] = []
    const voiceListeners: (() => void)[] = []
    const synthesis = {
        paused: false,
        voices,
        speak(utterance: SpeechSynthesisUtterance) {
            calls.push('speak')
            spoken.push(utterance as unknown as FakeUtterance)
        },
        pause() {
            calls.push('pause')
        },
        resume() {
            calls.push('resume')
        },
        cancel() {
            calls.push('cancel')
        },
        getVoices(): SpeechSynthesisVoice[] {
            calls.push('getVoices')
            return synthesis.voices
        },
        addEventListener(_type: 'voiceschanged', listener: () => void) {
            voiceListeners.push(listener)
        },
        removeEventListener(_type: 'voiceschanged', listener: () => void) {
            const index = voiceListeners.indexOf(listener)
            if (index >= 0) voiceListeners.splice(index, 1)
        },
    }
    const provider = createBrowserSpeechProvider({
        synthesis: synthesis satisfies SpeechSynthesisLike,
        Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    })
    const emitVoicesChanged = () => [...voiceListeners].forEach((listener) => listener())
    return { provider, synthesis, calls, spoken, emitVoicesChanged, voiceListeners }
}

function speakOptions(overrides: Partial<SpeakOptions> = {}): SpeakOptions {
    return {
        text: 'Hello there.',
        voice: null,
        rate: 1,
        pitch: 1,
        lang: null,
        onStart: vi.fn(),
        onEnd: vi.fn(),
        onError: vi.fn(),
        onBoundary: vi.fn(),
        ...overrides,
    }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('createBrowserSpeechProvider', () => {
    it('is not supported in an environment with no speech synthesis', () => {
        const provider = createBrowserSpeechProvider()
        const onError = vi.fn()

        expect(provider.isSupported()).toBe(false)
        expect(provider.getVoices()).toEqual([])
        expect(provider.resume()).toBe(false)
        provider.pause()
        provider.cancel()
        provider.onVoicesChanged(() => {})()
        provider.speak(speakOptions({ onError }))

        expect(onError).toHaveBeenCalledOnce()
        expect(onError.mock.calls[0][0]).toBeInstanceOf(SpeechError)
        expect(onError.mock.calls[0][0]).toMatchObject({ code: 'unsupported' })
    })

    it('ends the paused state when it cancels speech', () => {
        const { provider, calls } = setup()

        provider.pause()
        provider.cancel()
        provider.speak(speakOptions())

        expect(calls).toEqual(['pause', 'cancel', 'resume', 'speak'])
    })

    it('sets the text, rate, pitch and language of the utterance', () => {
        const { provider, spoken } = setup()

        provider.speak(speakOptions({ rate: 1.5, pitch: 0.8, lang: 'fr-FR' }))

        expect(spoken[0]).toMatchObject({
            text: 'Hello there.',
            rate: 1.5,
            pitch: 0.8,
            lang: 'fr-FR',
            voice: null,
        })
    })

    it('finds the voice by its id and uses the language of the voice', () => {
        const daniel = browserVoice('Daniel en_GB')
        const { provider, spoken } = setup([browserVoice('Anna de-DE'), daniel])

        provider.speak(speakOptions({ voice: 'uri:Daniel', lang: 'fr-FR' }))

        expect(spoken[0].voice).toBe(daniel)
        expect(spoken[0].lang).toBe('en_GB')
    })

    it('uses the language of the text when the voice is not in the list', () => {
        const { provider, spoken } = setup([browserVoice('Anna de-DE')])

        provider.speak(speakOptions({ voice: 'uri:Gone', lang: 'fr-FR' }))

        expect(spoken[0].voice).toBeNull()
        expect(spoken[0].lang).toBe('fr-FR')
    })

    it('changes an underscore in the language of the text to a hyphen', () => {
        const { provider, spoken } = setup([browserVoice('Anna de-DE')])

        provider.speak(speakOptions({ lang: 'fr_FR' }))

        expect(spoken[0].lang).toBe('fr-FR')
    })

    it('passes the start and end events', () => {
        const { provider, spoken } = setup()
        const options = speakOptions()
        provider.speak(options)

        spoken[0].onstart?.()
        spoken[0].onend?.()

        expect(options.onStart).toHaveBeenCalledOnce()
        expect(options.onEnd).toHaveBeenCalledOnce()
    })

    it('reports word boundaries only', () => {
        const { provider, spoken } = setup()
        const onBoundary = vi.fn()
        provider.speak(speakOptions({ onBoundary }))

        spoken[0].onboundary?.({ name: 'sentence', charIndex: 0, charLength: 12 })
        spoken[0].onboundary?.({ name: 'word', charIndex: 6, charLength: 5 })
        // Safari gives no length.
        spoken[0].onboundary?.({ name: 'word', charIndex: 0 })

        expect(onBoundary.mock.calls).toEqual([
            [{ charIndex: 6, charLength: 5 }],
            [{ charIndex: 0, charLength: 0 }],
        ])
    })

    it('reports an error event as a SpeechError with the error code', () => {
        const { provider, spoken } = setup()
        const onError = vi.fn()
        provider.speak(speakOptions({ onError }))

        spoken[0].onerror?.({ error: 'interrupted' })
        spoken[0].onerror?.({})

        expect(onError.mock.calls[0][0]).toBeInstanceOf(SpeechError)
        expect(onError.mock.calls[0][0]).toMatchObject({ code: 'interrupted' })
        expect(onError.mock.calls[1][0]).toMatchObject({
            code: 'synthesis-failed',
            message: 'Text to speech failed.',
        })
    })

    it('has a message for each error that the user can correct', () => {
        expect(new SpeechError('no-response').message).toMatch(/^Speech did not start\./)
        expect(new SpeechError('not-allowed').message).toMatch(/Select play again\.$/)
        expect(new SpeechError('network').message).toBe('This voice needs a network connection.')
        expect(new SpeechError('other').message).toBe('Text to speech failed.')
    })

    it('reports on resume if the browser kept the paused utterance', () => {
        const { provider, synthesis, spoken, calls } = setup()

        // No utterance.
        synthesis.paused = true
        expect(provider.resume()).toBe(false)

        provider.speak(speakOptions())
        provider.pause()
        expect(provider.resume()).toBe(true)

        // Android: the browser is not paused after `pause()`.
        synthesis.paused = false
        expect(provider.resume()).toBe(false)

        // The utterance ended during the pause.
        synthesis.paused = true
        spoken[0].onend?.()
        expect(provider.resume()).toBe(false)

        // The utterance was cancelled.
        provider.speak(speakOptions())
        provider.cancel()
        expect(provider.resume()).toBe(false)
        expect(calls.filter((call) => call === 'resume')).toHaveLength(6)
    })

    it('keeps the newer utterance when an old utterance ends late', () => {
        const { provider, synthesis, spoken } = setup()
        provider.speak(speakOptions())
        provider.cancel()
        provider.speak(speakOptions())
        synthesis.paused = true

        spoken[0].onend?.()

        expect(provider.resume()).toBe(true)
    })

    it('maps the browser voices', () => {
        const { provider } = setup([
            browserVoice('Daniel en_GB', { default: true }),
            browserVoice('Online en-US', { localService: false, voiceURI: '' }),
        ])

        expect(provider.getVoices()).toEqual([
            { id: 'uri:Daniel', name: 'Daniel', lang: 'en-GB', local: true, isDefault: true },
            { id: 'Online', name: 'Online', lang: 'en-US', local: false, isDefault: false },
        ])
    })

    it('reads the voice list one time until the browser reports a change', () => {
        const { provider, synthesis, calls, emitVoicesChanged } = setup([
            browserVoice('Anna de-DE'),
        ])
        const listener = vi.fn()
        const remove = provider.onVoicesChanged(listener)

        provider.getVoices()
        provider.getVoices()
        provider.speak(speakOptions({ voice: 'uri:Anna' }))
        expect(calls.filter((call) => call === 'getVoices')).toHaveLength(1)

        synthesis.voices = [browserVoice('Anna de-DE'), browserVoice('Daniel en-GB')]
        emitVoicesChanged()
        expect(listener).toHaveBeenCalledOnce()
        expect(provider.getVoices().map((voice) => voice.name)).toEqual(['Anna', 'Daniel'])

        remove()
        emitVoicesChanged()
        expect(listener).toHaveBeenCalledOnce()
    })

    it('keeps a listener on the browser only while it has listeners', () => {
        const { provider, voiceListeners } = setup([browserVoice('Anna de-DE')])
        // A provider with no listeners must not stay in memory through the browser object.
        expect(voiceListeners).toHaveLength(0)

        const removeFirst = provider.onVoicesChanged(() => {})
        const removeSecond = provider.onVoicesChanged(() => {})
        expect(voiceListeners).toHaveLength(1)

        removeFirst()
        expect(voiceListeners).toHaveLength(1)
        removeSecond()
        removeSecond()
        expect(voiceListeners).toHaveLength(0)

        const listener = vi.fn()
        provider.onVoicesChanged(listener)
        expect(voiceListeners).toHaveLength(1)
        voiceListeners[0]()
        expect(listener).toHaveBeenCalledOnce()
    })

    it('reads a new voice list when it has no listener for changes', () => {
        const { provider, synthesis, spoken } = setup([browserVoice('Anna de-DE')])
        const daniel = browserVoice('Daniel en-GB')

        expect(provider.getVoices().map((voice) => voice.name)).toEqual(['Anna'])
        synthesis.voices = [browserVoice('Anna de-DE'), daniel]

        // No change event can arrive, so the provider does not keep the first list.
        expect(provider.getVoices().map((voice) => voice.name)).toEqual(['Anna', 'Daniel'])
        provider.speak(speakOptions({ voice: 'uri:Daniel' }))
        expect(spoken[0].voice).toBe(daniel)

        const remove = provider.onVoicesChanged(() => {})
        remove()
        synthesis.voices = [daniel]
        expect(provider.getVoices().map((voice) => voice.name)).toEqual(['Daniel'])
    })

    it('reads the voice list again while it is empty', () => {
        const { provider, synthesis } = setup()

        expect(provider.getVoices()).toEqual([])
        synthesis.voices = [browserVoice('Anna de-DE')]

        expect(provider.getVoices()).toHaveLength(1)
    })

    it('finds voices that load late when the browser sends no change event', () => {
        vi.useFakeTimers()
        const { provider, synthesis } = setup()
        const listener = vi.fn()
        provider.onVoicesChanged(listener)

        vi.advanceTimersByTime(250)
        expect(listener).not.toHaveBeenCalled()

        synthesis.voices = [browserVoice('Anna de-DE')]
        vi.advanceTimersByTime(1000)

        expect(listener).toHaveBeenCalledOnce()
        expect(provider.getVoices()).toHaveLength(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('stops the reads of an empty voice list after three times', () => {
        vi.useFakeTimers()
        const { provider, calls } = setup()
        provider.onVoicesChanged(() => {})

        vi.advanceTimersByTime(60_000)

        // One read at the subscription and three later reads.
        expect(calls.filter((call) => call === 'getVoices')).toHaveLength(4)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('stops the reads when the last listener is removed', () => {
        vi.useFakeTimers()
        const { provider } = setup()

        const remove = provider.onVoicesChanged(() => {})
        expect(vi.getTimerCount()).toBe(1)
        remove()

        expect(vi.getTimerCount()).toBe(0)
    })

    it('works with a speech synthesis object that has no event methods', () => {
        const synthesis: SpeechSynthesisLike = {
            speak: () => {},
            pause: () => {},
            resume: () => {},
            cancel: () => {},
            getVoices: () => [browserVoice('Anna de-DE')],
        }
        const provider = createBrowserSpeechProvider({
            synthesis,
            Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
        })

        expect(provider.isSupported()).toBe(true)
        expect(provider.getVoices()).toHaveLength(1)
        provider.speak(speakOptions())
        // With no `paused` property, the provider trusts its own utterance reference.
        expect(provider.resume()).toBe(true)
    })
})
