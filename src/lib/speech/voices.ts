import type { SpeechProvider, VoiceInfo } from './provider'

export type { VoiceInfo } from './provider'

export interface ListVoicesOptions {
    provider: SpeechProvider
    /** `dc:language` of the book, or null. */
    bookLanguage: string | null
    /** Defaults to `navigator.language`. */
    browserLanguage?: string | null
}

export interface PickVoiceOptions {
    /** The result of `listVoices`. */
    voices: readonly VoiceInfo[]
    /** The saved voice id, or null. */
    preferredId: string | null
    bookLanguage: string | null
}

/** The primary subtag in lower case: "en" for "en-GB" and for "en_US". Empty if there is none. */
export function primaryLanguage(tag: string | null | undefined): string {
    if (!tag) return ''
    const end = tag.search(/[-_]/)
    return (end < 0 ? tag : tag.slice(0, end)).trim().toLowerCase()
}

function defaultBrowserLanguage(): string | null {
    return typeof navigator !== 'undefined' ? navigator.language : null
}

/**
 * The voices for the voice list. Voices for the book language come first, then voices for the
 * browser language, then all others. Each group is sorted by language and name.
 */
export function listVoices({
    provider,
    bookLanguage,
    browserLanguage = defaultBrowserLanguage(),
}: ListVoicesOptions): VoiceInfo[] {
    // Android gives the same voice more than one time.
    const unique = new Map<string, VoiceInfo>()
    for (const voice of provider.getVoices()) {
        const key = `${voice.name}\n${voice.lang.toLowerCase()}`
        const kept = unique.get(key)
        // Keep the default voice of two equal voices, so that the list has a default voice.
        if (!kept || (voice.isDefault && !kept.isDefault)) unique.set(key, voice)
    }

    const bookPrimary = primaryLanguage(bookLanguage)
    const browserPrimary = primaryLanguage(browserLanguage)
    const group = (voice: VoiceInfo): number => {
        const primary = primaryLanguage(voice.lang)
        if (bookPrimary && primary === bookPrimary) return 0
        if (browserPrimary && primary === browserPrimary) return 1
        return 2
    }

    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
    return [...unique.values()]
        .map((voice) => ({ voice, group: group(voice) }))
        .sort(
            (a, b) =>
                a.group - b.group ||
                collator.compare(a.voice.lang, b.voice.lang) ||
                collator.compare(a.voice.name, b.voice.name),
        )
        .map((item) => item.voice)
}

/**
 * The voice to use. The order is: the saved voice, the default voice if it has the book
 * language, a voice with the book language, the default voice, the first voice.
 */
export function pickVoice({
    voices,
    preferredId,
    bookLanguage,
}: PickVoiceOptions): VoiceInfo | null {
    if (preferredId !== null) {
        const preferred = voices.find((voice) => voice.id === preferredId)
        if (preferred) return preferred
    }

    const bookPrimary = primaryLanguage(bookLanguage)
    if (bookPrimary) {
        const matches = voices.filter((voice) => primaryLanguage(voice.lang) === bookPrimary)
        // Safari marks more than one voice as the default, so the first default voice of the
        // list can have a different language.
        const defaults = matches.filter((voice) => voice.isDefault)
        const candidates = defaults.length > 0 ? defaults : matches
        // A voice with the same region as the book ("en-GB") is better than the first match.
        const bookTag = (bookLanguage ?? '').replaceAll('_', '-').toLowerCase()
        const match =
            candidates.find((voice) => voice.lang.toLowerCase() === bookTag) ?? candidates[0]
        if (match) return match
    }

    return voices.find((voice) => voice.isDefault) ?? voices[0] ?? null
}
