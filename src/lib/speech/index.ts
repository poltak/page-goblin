/**
 * Read-aloud with the speech synthesis of the browser.
 *
 * Load this module with a dynamic `import()` when the user opens the speech controls, so that
 * the first load of the application stays small.
 *
 *     const provider = createBrowserSpeechProvider()
 *     const controller = createSpeechController({ provider, callbacks })
 *     controller.load({ text, sentences, lang, offset })
 *     controller.play() // Call this in the click handler.
 */

export {
    MAX_UTTERANCE_LENGTH,
    buildUtterances,
    chunkOffsetAt,
    speechLength,
    wordRangeAt,
} from './chunks'
export type { BuildUtterancesOptions, SpeechChunk, WordRangeOptions } from './chunks'
export { createSpeechController, speechWatchdogDelay } from './controller'
export type {
    SpeechCallbacks,
    SpeechController,
    SpeechControllerOptions,
    SpeechLoadOptions,
    SpeechRange,
    SpeechRangeKind,
    SpeechState,
    SpeechStatus,
    SpeechTimers,
} from './controller'
export { SpeechError, createBrowserSpeechProvider } from './provider'
export type {
    BrowserSpeechProviderOptions,
    SpeakOptions,
    SpeechBoundary,
    SpeechProvider,
    SpeechSynthesisLike,
    VoiceInfo,
} from './provider'
export {
    DEFAULT_SPEECH_SETTINGS,
    SPEECH_PITCH_MAX,
    SPEECH_PITCH_MIN,
    SPEECH_RATE_MAX,
    SPEECH_RATE_MIN,
    clampSpeechPitch,
    clampSpeechRate,
    normalizeSpeechSettings,
} from './settings'
export type { NormalizedSpeechSettings } from './settings'
export { listVoices, pickVoice, primaryLanguage } from './voices'
export type { ListVoicesOptions, PickVoiceOptions } from './voices'
