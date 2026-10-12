/**
 * The language of a book or a content document as a BCP 47 tag that the browser accepts for
 * the `lang` attribute, hyphenation, speech and `Intl.Segmenter`.
 */

// Books often have the three-letter code of ISO 639-2. Browsers know the two-letter code.
const TWO_LETTER_CODES = new Map(
    Object.entries({
        eng: 'en',
        fra: 'fr',
        fre: 'fr',
        deu: 'de',
        ger: 'de',
        spa: 'es',
        ita: 'it',
        por: 'pt',
        nld: 'nl',
        dut: 'nl',
        rus: 'ru',
        jpn: 'ja',
        zho: 'zh',
        chi: 'zh',
        kor: 'ko',
        ara: 'ar',
        heb: 'he',
        vie: 'vi',
        ind: 'id',
        pol: 'pl',
        swe: 'sv',
        tur: 'tr',
    }),
)
// Undetermined, no language content, and more than one language.
const NO_LANGUAGE = new Set(['und', 'zxx', 'mul'])
// The language subtag of a real book has two or three letters. `Intl` also accepts a word
// of five to eight letters, such as "english".
const TAG_SHAPE = /^[a-z]{2,3}(?:-[a-z\d]{1,8})*$/i
// No real tag is longer. The cache must not keep a large attribute value of a bad book.
const MAX_LENGTH = 100
const CACHE_LIMIT = 64

const cache = new Map<string, string | null>()

function isValidTag(tag: string): boolean {
    if (typeof Intl === 'undefined' || typeof Intl.getCanonicalLocales !== 'function') return true
    try {
        Intl.getCanonicalLocales(tag)
        return true
    } catch {
        return false
    }
}

function normalize(value: string): string | null {
    const tag = value.trim().replace(/_/g, '-')
    if (!TAG_SHAPE.test(tag)) return null

    const end = tag.indexOf('-')
    const written = (end < 0 ? tag : tag.slice(0, end)).toLowerCase()
    const primary = TWO_LETTER_CODES.get(written) ?? written
    if (NO_LANGUAGE.has(primary)) return null

    const result = end < 0 ? primary : primary + tag.slice(end)
    return isValidTag(result) ? result : null
}

/**
 * Make a language value of a book ready for use. Real values include `EN-US`, `en_US`, `eng`
 * and `UND`. The result has a lower-case language subtag, and the rest of the tag is as
 * written. The result is null when the value names no language or is not a language tag.
 */
export function normalizeLanguage(value: string | null | undefined): string | null {
    if (!value || value.length > MAX_LENGTH) return null
    const known = cache.get(value)
    if (known !== undefined) return known

    const result = normalize(value)
    // A book has few different values, so the cache stays small.
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(value, result)
    return result
}
