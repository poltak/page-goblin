import { describe, expect, it } from 'vitest'
import * as speech from './index'

describe('speech settings', () => {
    it('exports the rate and pitch limits', () => {
        expect(speech.SPEECH_RATE_MIN).toBe(0.5)
        expect(speech.SPEECH_RATE_MAX).toBe(2)
        expect(speech.SPEECH_PITCH_MIN).toBe(0.5)
        expect(speech.SPEECH_PITCH_MAX).toBe(2)
    })

    it('keeps valid stored settings', () => {
        expect(
            speech.normalizeSpeechSettings({ voiceId: 'uri:Daniel', rate: 1.4, pitch: 0.9 }),
        ).toEqual({ voiceId: 'uri:Daniel', rate: 1.4, pitch: 0.9 })
    })

    it('clamps the rate and the pitch', () => {
        expect(speech.normalizeSpeechSettings({ rate: 100, pitch: 0 })).toEqual({
            voiceId: null,
            rate: 2,
            pitch: 0.5,
        })
    })

    it.each([
        undefined,
        null,
        'text',
        42,
        [],
        {},
        { voiceId: 7, rate: '1.5', pitch: null },
        { voiceId: '', rate: Number.NaN, pitch: Number.POSITIVE_INFINITY },
    ])('uses the defaults for %j', (raw) => {
        expect(speech.normalizeSpeechSettings(raw)).toEqual({ voiceId: null, rate: 1, pitch: 1 })
    })

    it('returns a new object each time', () => {
        const settings = speech.normalizeSpeechSettings(null)
        settings.rate = 2

        expect(speech.normalizeSpeechSettings(null).rate).toBe(1)
        expect(speech.DEFAULT_SPEECH_SETTINGS).toEqual({ voiceId: null, rate: 1, pitch: 1 })
    })
})

describe('speech exports', () => {
    it('exports the functions of the module', () => {
        expect(typeof speech.buildUtterances).toBe('function')
        expect(typeof speech.createBrowserSpeechProvider).toBe('function')
        expect(typeof speech.createSpeechController).toBe('function')
        expect(typeof speech.listVoices).toBe('function')
        expect(typeof speech.pickVoice).toBe('function')
        expect(typeof speech.speechLength).toBe('function')
        expect(typeof speech.wordRangeAt).toBe('function')
        expect(speech.SpeechError).toBeTypeOf('function')
    })
})
