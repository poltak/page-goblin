/**
 * Pause rules for the punctuation at the end of a word.
 *
 * A closing quote, a bracket, a dash or a citation mark such as [12] frequently follows
 * sentence punctuation. These functions remove that tail before they examine the last
 * character, so `you?"`, `hello!')` and `test.[1]` all get the correct pause.
 */

export interface PunctuationMultipliers {
    periodMultiplier: number
    commaMultiplier: number
    /** Also for the colon. */
    semicolonMultiplier: number
    /** Also for the question mark. */
    exclamationMultiplier: number
}

export const DEFAULT_PUNCTUATION_MULTIPLIERS: Readonly<PunctuationMultipliers> = {
    periodMultiplier: 3,
    commaMultiplier: 2,
    semicolonMultiplier: 2.5,
    exclamationMultiplier: 3,
}

const ELLIPSIS = '\u2026'

const TRAILING_SKIPPABLE = new Set([
    '"',
    "'",
    '\u201C', // left double quote
    '\u201D', // right double quote
    '\u2018', // left single quote
    '\u2019', // right single quote
    ')',
    ']',
    '}',
    '\u203A', // right single angle quote
    '\u2039', // left single angle quote
    '\u00BB', // right double angle quote
    '\u00AB', // left double angle quote
    '\u2010', // hyphen
    '-',
    '\u2014', // em dash
    '\u2013', // en dash
    ELLIPSIS,
])

/** A citation such as [12] or (12), and the non-word characters after it. */
const CITATION_PATTERN = /(\[[0-9]+\]|\([0-9]+\))([^\w]*?)$/
/** A bracket group at the end that is not a citation, for example [abc], (Smith) or [1). */
const BRACKET_GROUP_PATTERN = /(\[[^\]]*[\]\)]|\([^\)]*[\)\]])$/
const ENDS_WITH_WORD_CHARACTER = /\w$/

/**
 * Only the end of a word decides the result. The limit keeps the patterns fast on a very long
 * token, for example a URL or a run of text with no spaces.
 */
const MAX_TAIL_LENGTH = 128

/** The end of the word with the skippable tail removed. The callers examine its last character. */
function removeTail(word: string, keepEllipsis: boolean): string {
    let rest = word.length > MAX_TAIL_LENGTH ? word.slice(-MAX_TAIL_LENGTH) : word
    // The patterns and the skippable set can only match a tail that ends with a non-word character.
    if (ENDS_WITH_WORD_CHARACTER.test(rest)) return rest

    let changed = true
    while (changed) {
        changed = false

        const citation = CITATION_PATTERN.exec(rest)
        if (citation) {
            // Keep the characters after the citation. A later pass examines them.
            rest = rest.slice(0, citation.index) + citation[2]
            changed = true
            continue
        }

        const group = BRACKET_GROUP_PATTERN.exec(rest)
        if (group) {
            rest = rest.slice(0, group.index)
            changed = true
            continue
        }

        while (rest.length > 0) {
            const last = rest[rest.length - 1]
            if (!TRAILING_SKIPPABLE.has(last) || (keepEllipsis && last === ELLIPSIS)) break
            rest = rest.slice(0, -1)
            changed = true
        }
    }
    return rest
}

/** The delay multiplier for a word. 1 when the word does not end with a pause mark. */
export function getPunctuationMultiplier(
    word: string,
    multipliers: PunctuationMultipliers = DEFAULT_PUNCTUATION_MULTIPLIERS,
): number {
    const rest = removeTail(word, false)
    const last = rest.length > 0 ? rest[rest.length - 1] : ''

    if (last === '.') return multipliers.periodMultiplier
    if (last === ',') return multipliers.commaMultiplier
    if (last === ';' || last === ':') return multipliers.semicolonMultiplier
    if (last === '!' || last === '?') return multipliers.exclamationMultiplier
    return 1
}

/** True when the next word starts a new sentence. */
export function endsSentence(word: string): boolean {
    const rest = removeTail(word, true)
    const last = rest.length > 0 ? rest[rest.length - 1] : ''
    return last === '.' || last === '!' || last === '?' || last === ELLIPSIS
}
