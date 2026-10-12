import type { Sentence } from '$lib/content/types'

/** One utterance: a sentence, or a part of a long sentence. */
export interface SpeechChunk {
    /** The text to speak. White space is collapsed and trimmed. */
    text: string
    /** Chapter offset of the first spoken character. */
    start: number
    /** Chapter offset after the last spoken character. */
    end: number
    /** Index into the `sentences` input. */
    sentence: number
    /**
     * Pairs of (index in `text`, chapter offset), sorted by index. From each pair to the next
     * pair the two values increase together. Most chunks have one pair. Read it with
     * `chunkOffsetAt`.
     */
    offsets: readonly number[]
}

export interface BuildUtterancesOptions {
    /** `TextModel.text` of the chapter. */
    text: string
    sentences: readonly Pick<Sentence, 'start' | 'end'>[]
    /** The longest utterance as a `speechLength`. The default is `MAX_UTTERANCE_LENGTH`. */
    maxLength?: number
}

export interface WordRangeOptions {
    chunk: SpeechChunk
    /** Index in `chunk.text` from a boundary event. */
    charIndex: number
    /** Length from a boundary event, or 0 when the browser does not give it. */
    charLength: number
}

/**
 * Chrome stops a long utterance of a network voice after about 15 seconds and sends no end
 * event. An utterance of 200 characters ends before that limit at normal rates.
 */
export const MAX_UTTERANCE_LENGTH = 200

/**
 * A Chinese, Japanese or Korean character is a syllable or a word. It takes about as long to
 * speak as 3 letters. Without this, an utterance of 200 such characters is 45 seconds long.
 */
const WIDE_CHARACTER_START = 0x2e80
const WIDE_CHARACTER_LENGTH = 3

/**
 * A run of white space that is not one plain space: two or more characters, or one character
 * such as a line break. A single plain space needs no change, so the pattern does not match it.
 */
const IRREGULAR_SPACE = /\s{2,}|[^\S ]/g
const SPEAKABLE = /[\p{L}\p{N}]/u
const DIGIT = /\d/
/** These need a space after them, so that "1,000" and "12:30" stay in one piece. */
const SPACED_MARKS = ',;:'
/** Dashes and full-width marks have no space after them. */
const BARE_MARKS = '\u2014\u2013\u2015\uFF0C\uFF1B\uFF1A\u3001'
const CLOSERS = '"\'\u201D\u2019)]\u00BB'

interface Spoken {
    text: string
    offsets: number[]
}

/**
 * Cuts a chapter into utterances. Each sentence gives one chunk. A sentence that is longer than
 * `maxLength` gives two or more chunks.
 */
export function buildUtterances({
    text,
    sentences,
    maxLength = MAX_UTTERANCE_LENGTH,
}: BuildUtterancesOptions): SpeechChunk[] {
    const limit = Math.max(1, Math.trunc(maxLength) || 1)
    const chunks: SpeechChunk[] = []

    for (let sentence = 0; sentence < sentences.length; sentence++) {
        const start = Math.max(0, sentences[sentence].start)
        const end = Math.min(text.length, sentences[sentence].end)
        if (!(start < end)) continue

        const spoken = collapse(text.slice(start, end), start)
        const length = spoken.text.length
        // The first test is true for most sentences, and then the text is not read.
        if (length * WIDE_CHARACTER_LENGTH <= limit || fitLength(spoken.text, limit) >= length) {
            if (SPEAKABLE.test(spoken.text)) {
                chunks.push({
                    text: spoken.text,
                    start: spoken.offsets[1],
                    end: offsetAt(spoken.offsets, length - 1) + 1,
                    sentence,
                    offsets: spoken.offsets,
                })
            }
            continue
        }

        const { offsets } = spoken
        let from = 0
        // The pair that applies at `from`. It only moves forward, so the time for one sentence
        // is linear in its length, also when the sentence has many pairs.
        let pair = 0
        while (from < length) {
            const rest = spoken.text.slice(from)
            const fit = fitLength(rest, limit)
            const to = from + (fit >= rest.length ? rest.length : cutLength(rest, fit))
            const part = spoken.text.slice(from, to)

            while (pair + 2 < offsets.length && offsets[pair + 2] <= from) pair += 2
            const partOffsets = [0, offsets[pair + 1] + (from - offsets[pair])]
            while (pair + 2 < offsets.length && offsets[pair + 2] < to) {
                pair += 2
                partOffsets.push(offsets[pair] - from, offsets[pair + 1])
            }

            if (SPEAKABLE.test(part)) {
                chunks.push({
                    text: part,
                    start: partOffsets[1],
                    end: offsetAt(partOffsets, part.length - 1) + 1,
                    sentence,
                    offsets: partOffsets,
                })
            }
            // The collapsed text has no two spaces in sequence.
            from = spoken.text.charCodeAt(to) === 32 ? to + 1 : to
        }
    }

    return chunks
}

/**
 * The length of `text` for the utterance limit and for time estimates: 1 for each character,
 * and 3 for each Chinese, Japanese or Korean character.
 */
export function speechLength(text: string): number {
    let length = text.length
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) >= WIDE_CHARACTER_START) length += WIDE_CHARACTER_LENGTH - 1
    }
    return length
}

/** The chapter offset of the character at `index` of `chunk.text`. */
export function chunkOffsetAt(chunk: SpeechChunk, index: number): number {
    return offsetAt(chunk.offsets, index)
}

/**
 * The chapter range of the word that a boundary event reports. Returns null when the event
 * does not point at a word of the chunk.
 */
export function wordRangeAt({
    chunk,
    charIndex,
    charLength,
}: WordRangeOptions): { start: number; end: number } | null {
    const { text } = chunk
    if (!(charIndex >= 0 && charIndex < text.length)) return null

    const from = Math.trunc(charIndex)
    let to = charLength > 0 ? from + Math.trunc(charLength) : text.indexOf(' ', from)
    if (to < 0 || to > text.length) to = text.length
    if (to <= from) return null

    return { start: offsetAt(chunk.offsets, from), end: offsetAt(chunk.offsets, to - 1) + 1 }
}

/**
 * Trims `source` and replaces each run of white space with one space. `base` is the chapter
 * offset of the first character of `source`.
 */
function collapse(source: string, base: number): Spoken {
    const withoutLead = source.trimStart()
    const first = base + source.length - withoutLead.length
    const body = withoutLead.trimEnd()
    const offsets = [0, first]

    IRREGULAR_SPACE.lastIndex = 0
    let match = IRREGULAR_SPACE.exec(body)
    if (!match) return { text: body, offsets }

    let text = ''
    let last = 0
    while (match) {
        text += body.slice(last, match.index) + ' '
        last = match.index + match[0].length
        // A run of one character does not move the two indexes apart.
        if (match[0].length !== 1) offsets.push(text.length, first + last)
        match = IRREGULAR_SPACE.exec(body)
    }
    text += body.slice(last)
    return { text, offsets }
}

/**
 * The number of characters at the start of `text` that have a speech length of `limit` at most.
 * The result is 1 or more, so that a cut always makes progress.
 */
function fitLength(text: string, limit: number): number {
    let length = 0
    let index = 0
    while (index < text.length) {
        length += text.charCodeAt(index) >= WIDE_CHARACTER_START ? WIDE_CHARACTER_LENGTH : 1
        if (length > limit) break
        index++
    }
    // A surrogate pair is one character. Do not cut it.
    const code = text.charCodeAt(0)
    const first = code >= 0xd800 && code <= 0xdbff && text.length > 1 ? 2 : 1
    return Math.max(index, first)
}

function offsetAt(offsets: readonly number[], index: number): number {
    // A chunk has few pairs, so a scan from the end is sufficient.
    let pair = offsets.length - 2
    while (pair > 0 && offsets[pair] > index) pair -= 2
    return offsets[pair + 1] + (index - offsets[pair])
}

/**
 * Where to cut `rest`, which has more than `limit` characters. The result is from 1 to `limit`.
 * A pause between two utterances is least audible after a clause, then between two words.
 */
function cutLength(rest: string, limit: number): number {
    for (let index = limit - 1; index > 0; index--) {
        const cut = clauseEnd(rest, index)
        if (cut > 0 && cut <= limit) return cut
    }

    // The character at `limit` can be the space, and then the chunk has the full length.
    const space = rest.lastIndexOf(' ', limit)
    if (space > 0) return space

    // Text with no white space. Do not cut a surrogate pair.
    const code = rest.charCodeAt(limit - 1)
    return limit > 1 && code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
}

/**
 * If a clause ends with the mark at `index`, returns the index after the mark and its closing
 * quotes. If not, returns 0.
 */
function clauseEnd(rest: string, index: number): number {
    const mark = rest[index]
    const spaced = SPACED_MARKS.includes(mark) || (mark === '-' && rest[index - 1] === ' ')
    if (!spaced && !BARE_MARKS.includes(mark)) return 0

    let end = index + 1
    while (end < rest.length && CLOSERS.includes(rest[end])) end++
    if (spaced) return rest[end] === ' ' ? end : 0
    // A dash between two numbers is a range of numbers, not the end of a clause.
    return end < rest.length && DIGIT.test(rest[end]) ? 0 : end
}
