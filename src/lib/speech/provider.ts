/** One voice of the speech engine. */
export interface VoiceInfo {
    /** The `voiceURI` of the browser voice, or its name when the URI is empty. */
    id: string
    name: string
    /** A BCP 47 tag with hyphens, for example "en-GB". */
    lang: string
    /** True when the voice runs on the device and needs no network. */
    local: boolean
    isDefault: boolean
}

export interface SpeechBoundary {
    /** Index of the word in the spoken text. */
    charIndex: number
    /** Length of the word, or 0 when the browser does not give it. */
    charLength: number
}

/**
 * An error from the speech engine. `code` is the error name of the Web Speech API (for example
 * "interrupted", "canceled", "not-allowed", "synthesis-failed"), or "unsupported", or
 * "no-response" when the engine sent no events.
 */
export class SpeechError extends Error {
    readonly code: string

    constructor(code: string) {
        super(messageForCode(code))
        this.name = 'SpeechError'
        this.code = code
    }
}

export interface SpeakOptions {
    text: string
    /** A `VoiceInfo.id`, or null for the default voice of the browser. */
    voice: string | null
    rate: number
    pitch: number
    /** Language of the text. The browser uses it to select a voice when `voice` is null. */
    lang: string | null
    onStart(): void
    onEnd(): void
    onError(error: SpeechError): void
    /** Called for word boundaries only. Some voices send no boundary events. */
    onBoundary(boundary: SpeechBoundary): void
}

/** The speech engine as the controller uses it. Tests replace it with a fake. */
export interface SpeechProvider {
    isSupported(): boolean
    /** All voices as the engine gives them. Can be empty until `onVoicesChanged` reports. */
    getVoices(): VoiceInfo[]
    /** Returns a function that removes the listener. */
    onVoicesChanged(listener: () => void): () => void
    /** Speaks one utterance. Only the last utterance gets events after a `cancel`. */
    speak(options: SpeakOptions): void
    pause(): void
    /**
     * Continues the paused utterance. Returns false when the engine did not keep it (some
     * Android browsers end the utterance on pause). The caller must then speak the text again.
     */
    resume(): boolean
    /** Stops speech and also ends the paused state. */
    cancel(): void
}

/** The part of `window.speechSynthesis` that the provider uses. */
export interface SpeechSynthesisLike {
    readonly paused?: boolean
    speak(utterance: SpeechSynthesisUtterance): void
    pause(): void
    resume(): void
    cancel(): void
    getVoices(): SpeechSynthesisVoice[]
    addEventListener?(type: 'voiceschanged', listener: () => void): void
    removeEventListener?(type: 'voiceschanged', listener: () => void): void
}

export interface BrowserSpeechProviderOptions {
    /** Defaults to `window.speechSynthesis`. */
    synthesis?: SpeechSynthesisLike
    /** Defaults to the global `SpeechSynthesisUtterance`. */
    Utterance?: typeof SpeechSynthesisUtterance
}

/** Delays for a new read of the voice list when the browser sends no voiceschanged event. */
const VOICE_RETRY_DELAYS = [250, 1000, 2500]

function messageForCode(code: string): string {
    switch (code) {
        case 'unsupported':
            return 'Text to speech is not available in this browser.'
        case 'not-allowed':
            return 'The browser did not permit speech. Select play again.'
        case 'no-response':
            return 'Speech did not start. If a different tab uses speech, stop it there. Then select play again.'
        case 'network':
            return 'This voice needs a network connection.'
        case 'language-unavailable':
        case 'voice-unavailable':
            return 'The selected voice is not available. Select a different voice.'
        case 'audio-busy':
        case 'audio-hardware':
            return 'The audio output is not available.'
        default:
            return 'Text to speech failed.'
    }
}

function defaultSynthesis(): SpeechSynthesisLike | undefined {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
        ? window.speechSynthesis
        : undefined
}

function defaultUtterance(): typeof SpeechSynthesisUtterance | undefined {
    return typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : undefined
}

function toVoiceInfo(voice: SpeechSynthesisVoice): VoiceInfo {
    return {
        id: voice.voiceURI || voice.name,
        name: voice.name,
        // Android gives tags with an underscore, for example "en_US".
        lang: voice.lang.replaceAll('_', '-'),
        local: voice.localService,
        isDefault: voice.default,
    }
}

/** A `SpeechProvider` on `window.speechSynthesis`. */
export function createBrowserSpeechProvider({
    synthesis = defaultSynthesis(),
    Utterance = defaultUtterance(),
}: BrowserSpeechProviderOptions = {}): SpeechProvider {
    const engine = synthesis && Utterance ? { synthesis, Utterance } : null
    const listeners = new Set<() => void>()
    // Chromium can garbage collect an utterance that has no other reference, and then its end
    // event does not arrive. This reference keeps the current utterance.
    let current: SpeechSynthesisUtterance | null = null
    // `getVoices()` makes a new list of objects on each call, so keep the last list that was
    // not empty. The kept list is correct only while the voiceschanged listener is on.
    let browserVoices: SpeechSynthesisVoice[] = []
    let voiceInfos: VoiceInfo[] = []
    let watching = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryStep = 0

    function readVoices(): SpeechSynthesisVoice[] {
        if (engine && (!watching || browserVoices.length === 0)) {
            browserVoices = engine.synthesis.getVoices()
            voiceInfos = browserVoices.map(toVoiceInfo)
        }
        return browserVoices
    }

    // The listener is on only while the provider has listeners. A listener that stays on
    // `window.speechSynthesis` keeps the provider in memory for the life of the page.
    function watch(): void {
        if (watching || !engine?.synthesis.addEventListener) return
        engine.synthesis.addEventListener('voiceschanged', voicesChanged)
        watching = true
    }

    function unwatch(): void {
        if (!watching || !engine?.synthesis.removeEventListener) return
        engine.synthesis.removeEventListener('voiceschanged', voicesChanged)
        watching = false
    }

    function stopRetry(): void {
        if (retryTimer !== null) clearTimeout(retryTimer)
        retryTimer = null
    }

    function voicesChanged(): void {
        stopRetry()
        browserVoices = []
        voiceInfos = []
        for (const listener of [...listeners]) listener()
    }

    // The voice list can be empty at page load. Most browsers then send voiceschanged. These
    // timers read the list again for a browser that does not.
    function scheduleRetry(): void {
        if (retryTimer !== null || retryStep >= VOICE_RETRY_DELAYS.length) return
        retryTimer = setTimeout(() => {
            retryTimer = null
            retryStep += 1
            if (listeners.size === 0) return
            if (readVoices().length > 0) voicesChanged()
            else scheduleRetry()
        }, VOICE_RETRY_DELAYS[retryStep])
    }

    return {
        isSupported: () => engine !== null,

        getVoices() {
            readVoices()
            return voiceInfos
        },

        onVoicesChanged(listener) {
            listeners.add(listener)
            watch()
            if (engine && readVoices().length === 0) scheduleRetry()
            return () => {
                listeners.delete(listener)
                if (listeners.size > 0) return
                stopRetry()
                unwatch()
            }
        },

        speak({ text, voice, rate, pitch, lang, onStart, onEnd, onError, onBoundary }) {
            if (!engine) {
                onError(new SpeechError('unsupported'))
                return
            }

            const utterance = new engine.Utterance(text)
            utterance.rate = rate
            utterance.pitch = pitch
            const browserVoice =
                voice === null
                    ? undefined
                    : readVoices().find((item) => (item.voiceURI || item.name) === voice)
            if (browserVoice) {
                utterance.voice = browserVoice
                // Android ignores `voice` and selects the voice from `lang`.
                utterance.lang = browserVoice.lang
            } else if (lang) {
                // A book can give a tag with an underscore, which matches no voice.
                utterance.lang = lang.replaceAll('_', '-')
            }

            utterance.onstart = () => onStart()
            utterance.onboundary = (event) => {
                if (event.name !== 'word') return
                onBoundary({ charIndex: event.charIndex, charLength: event.charLength || 0 })
            }
            utterance.onend = () => {
                if (current === utterance) current = null
                onEnd()
            }
            utterance.onerror = (event) => {
                if (current === utterance) current = null
                onError(new SpeechError(event.error || 'synthesis-failed'))
            }

            current = utterance
            engine.synthesis.speak(utterance)
        },

        pause() {
            engine?.synthesis.pause()
        },

        resume() {
            if (!engine) return false
            const kept = current !== null && engine.synthesis.paused !== false
            engine.synthesis.resume()
            return kept
        },

        cancel() {
            current = null
            if (!engine) return
            engine.synthesis.cancel()
            // `cancel()` does not end the paused state. Without `resume()`, speech that starts
            // after a pause and a stop makes no sound.
            engine.synthesis.resume()
        },
    }
}
