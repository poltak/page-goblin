import { describe, expect, it } from 'vitest'
import type { VoiceInfo } from './provider'
import { createFakeSpeechProvider } from './testing/fake-provider'
import { listVoices, pickVoice, primaryLanguage } from './voices'

/** Makes a voice from a label of the form "name lang", for example "Daniel en-GB". */
function voice(label: string, extra: Partial<VoiceInfo> = {}): VoiceInfo {
    const split = label.lastIndexOf(' ')
    const name = label.slice(0, split)
    const lang = label.slice(split + 1)
    return { id: `${name}:${lang}`, name, lang, local: true, isDefault: false, ...extra }
}

function names(voices: VoiceInfo[]): string[] {
    return voices.map((item) => `${item.name} ${item.lang}`)
}

describe('primaryLanguage', () => {
    it('gives the first subtag in lower case', () => {
        expect(primaryLanguage('en-GB')).toBe('en')
        expect(primaryLanguage('EN_us')).toBe('en')
        expect(primaryLanguage('fr')).toBe('fr')
        expect(primaryLanguage('')).toBe('')
        expect(primaryLanguage(null)).toBe('')
    })
})

describe('listVoices', () => {
    it('puts the book language first, then the browser language, then the other voices', () => {
        const provider = createFakeSpeechProvider({
            voices: [
                voice('Zira en-US'),
                voice('Anna de-DE'),
                voice('Thomas fr-FR'),
                voice('Amelie fr-CA'),
                voice('Daniel en-GB'),
                voice('Kyoko ja-JP'),
                voice('Aaron en-US'),
            ],
        })

        const voices = listVoices({ provider, bookLanguage: 'fr', browserLanguage: 'en-AU' })

        expect(names(voices)).toEqual([
            'Amelie fr-CA',
            'Thomas fr-FR',
            'Daniel en-GB',
            'Aaron en-US',
            'Zira en-US',
            'Anna de-DE',
            'Kyoko ja-JP',
        ])
    })

    it('sorts by language and name when the book has no language', () => {
        const provider = createFakeSpeechProvider({
            voices: [voice('Zira en-US'), voice('Anna de-DE'), voice('Aaron en-US')],
        })

        const voices = listVoices({ provider, bookLanguage: null, browserLanguage: null })

        expect(names(voices)).toEqual(['Anna de-DE', 'Aaron en-US', 'Zira en-US'])
    })

    it('uses the language of the browser by default', () => {
        const provider = createFakeSpeechProvider({
            voices: [voice('Anna de-DE'), voice(`Zira ${navigator.language}`)],
        })

        const voices = listVoices({ provider, bookLanguage: null })

        expect(voices[0].name).toBe('Zira')
    })

    it('removes voices with the same name and language', () => {
        const first = voice('Hindi India hi-IN', { id: 'first' })
        const provider = createFakeSpeechProvider({
            voices: [
                first,
                voice('Hindi India hi-IN', { id: 'second' }),
                voice('Hindi India hi-in', { id: 'third' }),
                voice('Reader en-GB'),
            ],
        })

        const voices = listVoices({ provider, bookLanguage: null, browserLanguage: null })

        expect(voices.map((item) => item.id)).toEqual(['Reader:en-GB', 'first'])
    })

    it('keeps voices with the same name and a different language', () => {
        const provider = createFakeSpeechProvider({
            voices: [voice('Google en-US'), voice('Google en-GB')],
        })

        const voices = listVoices({ provider, bookLanguage: null, browserLanguage: null })

        expect(names(voices)).toEqual(['Google en-GB', 'Google en-US'])
    })

    it('keeps the default voice of two equal voices', () => {
        const provider = createFakeSpeechProvider({
            voices: [
                voice('Samantha en-US', { id: 'plain' }),
                voice('Samantha en-US', { id: 'default', isDefault: true }),
            ],
        })

        const voices = listVoices({ provider, bookLanguage: null, browserLanguage: null })

        expect(voices).toHaveLength(1)
        expect(voices[0]).toMatchObject({ id: 'default', isDefault: true })
    })

    it('returns an empty list when the provider has no voices', () => {
        const provider = createFakeSpeechProvider()

        expect(listVoices({ provider, bookLanguage: 'en' })).toEqual([])
    })
})

describe('pickVoice', () => {
    const english = voice('Daniel en-GB')
    const american = voice('Zira en-US')
    const french = voice('Thomas fr-FR')
    const canadian = voice('Amelie fr-CA')
    const german = voice('Anna de-DE', { isDefault: true })

    it('keeps the preferred voice when it is in the list', () => {
        const voices = [german, english, french]

        expect(pickVoice({ voices, preferredId: french.id, bookLanguage: 'en' })).toBe(french)
    })

    it('uses the default voice when it has the book language', () => {
        const voices = [voice('Aaron de-AT'), german, english]

        expect(pickVoice({ voices, preferredId: 'gone', bookLanguage: 'de' })).toBe(german)
    })

    it('uses a voice with the book language when the default voice has a different one', () => {
        const voices = [german, english, american, french]

        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'en' })).toBe(english)
        expect(pickVoice({ voices, preferredId: 'gone', bookLanguage: 'FR_fr' })).toBe(french)
    })

    it('prefers the region of the book among the voices with the book language', () => {
        const voices = [german, canadian, french, english, american]

        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'fr-FR' })).toBe(french)
        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'en-US' })).toBe(american)
        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'fr-BE' })).toBe(canadian)
    })

    it('uses a default voice with the book language when more than one voice is a default', () => {
        // Safari marks more than one voice as the default.
        const arabic = voice('Majed ar-001', { isDefault: true })
        const australian = voice('Karen en-AU', { isDefault: true })
        const british = voice('Daniel en-GB', { isDefault: true })
        const plain = voice('Fred en-US')
        const voices = [arabic, plain, australian, british]

        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'en' })).toBe(australian)
        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'en-GB' })).toBe(british)
        // A default voice is better than a voice with the region of the book.
        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'en-US' })).toBe(australian)
        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'ja' })).toBe(arabic)
    })

    it('uses the default voice when no voice has the book language', () => {
        const voices = [english, german, french]

        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'ja' })).toBe(german)
        expect(pickVoice({ voices, preferredId: null, bookLanguage: null })).toBe(german)
    })

    it('uses the first voice when there is no default voice', () => {
        const voices = [english, french]

        expect(pickVoice({ voices, preferredId: null, bookLanguage: 'ja' })).toBe(english)
    })

    it('returns null when there are no voices', () => {
        expect(pickVoice({ voices: [], preferredId: 'gone', bookLanguage: 'en' })).toBeNull()
    })
})
