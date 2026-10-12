export const SPEECH_RATE_MIN = 0.5
export const SPEECH_RATE_MAX = 2
export const SPEECH_PITCH_MIN = 0.5
export const SPEECH_PITCH_MAX = 2

/** The speech values that the controller uses. */
export interface NormalizedSpeechSettings {
    /** A voice id from `listVoices`, or null for the default voice of the browser. */
    voiceId: string | null
    rate: number
    pitch: number
}

export const DEFAULT_SPEECH_SETTINGS: Readonly<NormalizedSpeechSettings> = Object.freeze({
    voiceId: null,
    rate: 1,
    pitch: 1,
})

export function clampSpeechRate(rate: number): number {
    if (!Number.isFinite(rate)) return DEFAULT_SPEECH_SETTINGS.rate
    return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate))
}

export function clampSpeechPitch(pitch: number): number {
    if (!Number.isFinite(pitch)) return DEFAULT_SPEECH_SETTINGS.pitch
    return Math.min(SPEECH_PITCH_MAX, Math.max(SPEECH_PITCH_MIN, pitch))
}

/** Makes valid speech values from stored data of unknown shape. */
export function normalizeSpeechSettings(raw: unknown): NormalizedSpeechSettings {
    const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
    const voiceId = source?.voiceId
    const rate = source?.rate
    const pitch = source?.pitch

    return {
        voiceId: typeof voiceId === 'string' && voiceId !== '' ? voiceId : null,
        rate: typeof rate === 'number' ? clampSpeechRate(rate) : DEFAULT_SPEECH_SETTINGS.rate,
        pitch: typeof pitch === 'number' ? clampSpeechPitch(pitch) : DEFAULT_SPEECH_SETTINGS.pitch,
    }
}
