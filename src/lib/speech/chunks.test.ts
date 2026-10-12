import { describe, expect, it } from 'vitest'
import {
    MAX_UTTERANCE_LENGTH,
    buildUtterances,
    chunkOffsetAt,
    speechLength,
    wordRangeAt,
    type SpeechChunk,
} from './chunks'
import { sentencesOf } from './testing/fake-provider'

const EM_DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)
const EMOJI = String.fromCodePoint(0x1f600)

function collapse(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function texts(chunks: SpeechChunk[]): string[] {
    return chunks.map((chunk) => chunk.text)
}

/** Each chunk range gives the chunk text, and each character maps back to the same character. */
function expectOffsetsToMatch(text: string, chunks: SpeechChunk[]): void {
    for (const chunk of chunks) {
        const source = text.slice(chunk.start, chunk.end)
        expect(collapse(source)).toBe(chunk.text)
        expect(source).toBe(source.trim())
        for (let index = 0; index < chunk.text.length; index++) {
            if (chunk.text[index] === ' ') continue
            expect(text[chunkOffsetAt(chunk, index)]).toBe(chunk.text[index])
        }
    }
}

function oneSentence(text: string): { start: number; end: number }[] {
    return [{ start: 0, end: text.length }]
}

describe('buildUtterances', () => {
    it('makes one chunk for each sentence with chapter offsets', () => {
        const text = 'First sentence. Second one!  Third?'
        const chunks = buildUtterances({ text, sentences: sentencesOf(text) })

        expect(chunks).toMatchObject([
            { text: 'First sentence.', start: 0, end: 15, sentence: 0 },
            { text: 'Second one!', start: 16, end: 27, sentence: 1 },
            { text: 'Third?', start: 29, end: 35, sentence: 2 },
        ])
        expectOffsetsToMatch(text, chunks)
    })

    it('returns no chunks for empty input', () => {
        expect(buildUtterances({ text: '', sentences: [] })).toEqual([])
        expect(buildUtterances({ text: '   ', sentences: [{ start: 0, end: 3 }] })).toEqual([])
    })

    it('collapses and trims white space and keeps the offsets of the source', () => {
        const text = '  One\n   two\tthree.\n\nFour  five. '
        const chunks = buildUtterances({
            text,
            sentences: [
                { start: 0, end: 19 },
                { start: 19, end: text.length },
            ],
        })

        expect(texts(chunks)).toEqual(['One two three.', 'Four five.'])
        expect(chunks[0]).toMatchObject({ start: 2, end: 19 })
        expect(chunks[1]).toMatchObject({ start: 21, end: 32 })
        expectOffsetsToMatch(text, chunks)
    })

    it('maps an index after collapsed white space to the chapter offset', () => {
        const text = 'One\n   two\tthree.'
        const [chunk] = buildUtterances({ text, sentences: oneSentence(text) })

        expect(chunk.text).toBe('One two three.')
        expect(chunkOffsetAt(chunk, 0)).toBe(0)
        // The collapsed space maps to the first white space character of its run.
        expect(chunkOffsetAt(chunk, 3)).toBe(3)
        expect(chunkOffsetAt(chunk, 4)).toBe(text.indexOf('two'))
        expect(chunkOffsetAt(chunk, 8)).toBe(text.indexOf('three'))
    })

    it('clamps sentence bounds to the text', () => {
        const text = 'Short text.'
        const chunks = buildUtterances({ text, sentences: [{ start: -5, end: 500 }] })

        expect(chunks).toMatchObject([{ text: 'Short text.', start: 0, end: 11, sentence: 0 }])
    })

    it('cuts a long sentence after the last comma or semicolon before the limit', () => {
        const text = 'When the rain stopped, the two of them walked home; nobody spoke at all.'
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 30 })

        expect(texts(chunks)).toEqual([
            'When the rain stopped,',
            'the two of them walked home;',
            'nobody spoke at all.',
        ])
        expect(chunks.every((chunk) => chunk.sentence === 0)).toBe(true)
        expect(chunks.every((chunk) => chunk.text.length <= 30)).toBe(true)
        expectOffsetsToMatch(text, chunks)
    })

    it('keeps a closing quote with the comma before it', () => {
        const text = '"Come in," she said and then she closed the door behind us.'
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 30 })

        expect(texts(chunks)).toEqual([
            '"Come in,"',
            'she said and then she closed',
            'the door behind us.',
        ])
        expectOffsetsToMatch(text, chunks)
    })

    it('cuts after a dash', () => {
        const text = `He waited${EM_DASH}longer than anyone expected${EM_DASH}and then left.`
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 30 })

        expect(texts(chunks)).toEqual([
            `He waited${EM_DASH}`,
            `longer than anyone expected${EM_DASH}`,
            'and then left.',
        ])
        expectOffsetsToMatch(text, chunks)
    })

    it('cuts after a hyphen between spaces but not inside a word', () => {
        const spaced = 'It was late - far too late for visitors to arrive now.'
        expect(
            texts(buildUtterances({ text: spaced, sentences: oneSentence(spaced), maxLength: 24 })),
        ).toEqual(['It was late -', 'far too late for', 'visitors to arrive now.'])

        const joined = 'It was a well-known and often-told story of the town.'
        expect(
            texts(buildUtterances({ text: joined, sentences: oneSentence(joined), maxLength: 24 })),
        ).toEqual(['It was a well-known and', 'often-told story of the', 'town.'])
    })

    it('does not cut inside a number, a time or a range of numbers', () => {
        const price = 'The price was 1,000 dollars at 12:30 today and nobody cared.'
        expect(
            texts(buildUtterances({ text: price, sentences: oneSentence(price), maxLength: 24 })),
        ).toEqual(['The price was 1,000', 'dollars at 12:30 today', 'and nobody cared.'])

        const years = `The war of 1914${EN_DASH}1918 changed the map of the continent.`
        const chunks = buildUtterances({
            text: years,
            sentences: oneSentence(years),
            maxLength: 24,
        })
        expect(chunks[0].text).toBe(`The war of 1914${EN_DASH}1918`)
    })

    it('cuts at the last white space when there is no clause mark', () => {
        const text = 'alpha beta gamma delta epsilon zeta'
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 12 })

        expect(texts(chunks)).toEqual(['alpha beta', 'gamma delta', 'epsilon zeta'])
        expectOffsetsToMatch(text, chunks)
    })

    it('fills a chunk to the limit when the next character is a space', () => {
        const text = 'abcdefghijkl mnop'
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 12 })

        expect(texts(chunks)).toEqual(['abcdefghijkl', 'mnop'])
    })

    it('cuts at the limit when there is no white space', () => {
        const text = 'a'.repeat(25)
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 10 })

        expect(texts(chunks)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
        expect(chunks.map((chunk) => [chunk.start, chunk.end])).toEqual([
            [0, 10],
            [10, 20],
            [20, 25],
        ])
    })

    it('does not cut a surrogate pair', () => {
        const text = `${'a'.repeat(9)}${EMOJI}bbbb`
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 10 })

        expect(texts(chunks)).toEqual(['a'.repeat(9), `${EMOJI}bbbb`])
    })

    it('counts a Chinese, Japanese or Korean character as three characters', () => {
        expect(speechLength('abc d')).toBe(5)
        expect(speechLength('\u4e2d\u6587')).toBe(6)
        expect(speechLength('\u3053\u3093\u306b\u3061\u306f')).toBe(15)
        expect(speechLength('\ud55c\uae00 ab')).toBe(9)

        // 200 of these characters take about 45 seconds to speak. Chrome stops an utterance of
        // a network voice after 15 seconds.
        const clause = `${'\u4e2d'.repeat(30)}\uff0c`
        const end = `${'\u6587'.repeat(20)}\u3002`
        const text = clause.repeat(4) + end
        const chunks = buildUtterances({ text, sentences: oneSentence(text) })

        expect(text.length).toBeLessThan(MAX_UTTERANCE_LENGTH)
        expect(texts(chunks)).toEqual([clause.repeat(2), clause.repeat(2), end])
        expect(chunks.every((chunk) => speechLength(chunk.text) <= MAX_UTTERANCE_LENGTH)).toBe(true)
        expectOffsetsToMatch(text, chunks)

        const plain = '\u4e2d'.repeat(100)
        expect(
            texts(buildUtterances({ text: plain, sentences: oneSentence(plain) })).map(
                (part) => part.length,
            ),
        ).toEqual([66, 34])

        const short = '\u4e2d'.repeat(66)
        expect(buildUtterances({ text: short, sentences: oneSentence(short) })).toHaveLength(1)
    })

    it('uses a limit of 200 characters by default', () => {
        const text = `${'lorem ipsum '.repeat(60).trim()}. Short end.`
        const chunks = buildUtterances({ text, sentences: sentencesOf(text) })

        expect(MAX_UTTERANCE_LENGTH).toBe(200)
        expect(chunks.length).toBeGreaterThan(3)
        expect(chunks.every((chunk) => chunk.text.length <= 200)).toBe(true)
        expect(chunks.at(-1)).toMatchObject({ text: 'Short end.', sentence: 1 })
        expect(texts(chunks).join(' ')).toBe(text)
        expectOffsetsToMatch(text, chunks)
    })

    it('makes progress with a limit that is not valid', () => {
        const text = 'ab'
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 0 })

        expect(texts(chunks)).toEqual(['a', 'b'])
    })

    it('skips chunks with no letter or digit', () => {
        const text = 'First.\n\n* * *\n\nSecond. ...'
        const chunks = buildUtterances({
            text,
            sentences: [
                { start: 0, end: 6 },
                { start: 8, end: 13 },
                { start: 15, end: 22 },
                { start: 23, end: 26 },
            ],
        })

        expect(chunks).toMatchObject([
            { text: 'First.', sentence: 0 },
            { text: 'Second.', sentence: 2 },
        ])
    })

    it('keeps the offset pairs of a later part of a long sentence', () => {
        const text = 'alpha  beta,   gamma  delta'
        const chunks = buildUtterances({ text, sentences: oneSentence(text), maxLength: 12 })

        expect(chunks).toMatchObject([
            { text: 'alpha beta,', start: 0, end: 12 },
            { text: 'gamma delta', start: 15, end: 27 },
        ])
        expect(chunkOffsetAt(chunks[1], 6)).toBe(text.indexOf('delta'))
        expectOffsetsToMatch(text, chunks)
    })
})

describe('buildUtterances with unusual input', () => {
    /** A random number generator with a fixed sequence, so that a failure occurs again. */
    function createRandom(seed: number): () => number {
        let state = seed
        return () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0
            return state / 0x100000000
        }
    }

    const PIECES = [
        ...['a', 'bb', 'word', 'longerword', '1', '1,000', '12:30', '\u00e9', '\u4e2d\u6587'],
        ...[',', ';', ':', '.', '!', '?', '-', ' - ', '"', ')', '*', '...', EM_DASH, EN_DASH],
        ...[' ', ' ', '  ', '\n', '\t', '\r\n', '\n\n   ', '\u00a0', ' \u2028 ', '\ufeff'],
        ...[EMOJI, '\u3001', '\uff0c', '\u201d'],
    ]

    it('keeps the offsets and the limit for random text', () => {
        const random = createRandom(2026)
        const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]
        let total = 0

        for (let round = 0; round < 400; round++) {
            let text = ''
            for (let count = 1 + Math.floor(random() * 80); count > 0; count--) text += pick(PIECES)
            // Two sentences. The cut is not inside a surrogate pair.
            let cut = Math.floor(random() * text.length)
            if (text.charCodeAt(cut) >= 0xdc00 && text.charCodeAt(cut) <= 0xdfff) cut++
            const sentences = [
                { start: 0, end: cut },
                { start: cut, end: text.length },
            ]
            const maxLength = pick([2, 3, 5, 8, 12, 20, 40, 200])

            const chunks = buildUtterances({ text, sentences, maxLength })

            expectOffsetsToMatch(text, chunks)
            let lastEnd = 0
            for (const chunk of chunks) {
                expect(chunk.text.length).toBeGreaterThan(0)
                expect(chunk.text.length).toBeLessThanOrEqual(maxLength)
                expect(chunk.start).toBeGreaterThanOrEqual(lastEnd)
                expect(chunk.start).toBeGreaterThanOrEqual(sentences[chunk.sentence].start)
                expect(chunk.end).toBeLessThanOrEqual(sentences[chunk.sentence].end)
                lastEnd = chunk.end
                for (const match of chunk.text.matchAll(/\S+/g)) {
                    const range = wordRangeAt({
                        chunk,
                        charIndex: match.index,
                        charLength: match[0].length,
                    })
                    expect(range && text.slice(range.start, range.end)).toBe(match[0])
                }
            }
            // No letter or digit is lost.
            const spoken = texts(chunks)
                .join('')
                .replace(/[^\p{L}\p{N}]/gu, '')
            expect(spoken).toBe(text.replace(/[^\p{L}\p{N}]/gu, ''))
            total += chunks.length
        }

        expect(total).toBeGreaterThan(1000)
    })

    it('needs linear time for a long sentence with many runs of white space', () => {
        // An earlier version read all offset pairs of the sentence for each chunk. That took
        // some seconds for this text and stopped the page.
        const text = 'word  other\n'.repeat(200_000)
        const started = performance.now()

        const chunks = buildUtterances({ text, sentences: oneSentence(text) })

        expect(performance.now() - started).toBeLessThan(1500)
        expect(chunks.length).toBeGreaterThan(10_000)
        const last = chunks.at(-1)!
        expect(collapse(text.slice(last.start, last.end))).toBe(last.text)
        expect(last.end).toBe(text.length - 1)
        expect(text.slice(chunkOffsetAt(last, last.text.length - 5), last.end)).toBe('other')
    })
})

describe('wordRangeAt', () => {
    const text = 'One\n   two\tthree.'
    const [chunk] = buildUtterances({ text, sentences: oneSentence(text) })

    function word(charIndex: number, charLength: number): string | null {
        const range = wordRangeAt({ chunk, charIndex, charLength })
        return range && text.slice(range.start, range.end)
    }

    it('gives the chapter range of a word', () => {
        expect(word(0, 3)).toBe('One')
        expect(word(4, 3)).toBe('two')
        expect(word(8, 5)).toBe('three')
    })

    it('finds the end of the word when the browser gives no length', () => {
        expect(word(4, 0)).toBe('two')
        expect(word(8, 0)).toBe('three.')
        expect(word(4, Number.NaN)).toBe('two')
    })

    it('clamps a length that is too large', () => {
        expect(word(8, 50)).toBe('three.')
    })

    it('returns null for an index that is not on a word of the chunk', () => {
        expect(word(-1, 3)).toBeNull()
        expect(word(chunk.text.length, 1)).toBeNull()
        expect(word(Number.NaN, 3)).toBeNull()
        expect(word(3, 0)).toBeNull()
    })

    it('gives ranges in a later part of a long sentence', () => {
        const long = 'alpha  beta,   gamma  delta'
        const parts = buildUtterances({ text: long, sentences: oneSentence(long), maxLength: 12 })

        expect(wordRangeAt({ chunk: parts[1], charIndex: 6, charLength: 5 })).toEqual({
            start: 22,
            end: 27,
        })
    })
})
