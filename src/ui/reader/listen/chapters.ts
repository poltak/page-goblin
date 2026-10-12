/** The link between the book and speech: the text of a chapter as the speech controller needs it. */

import { normalizeLanguage, segmentSentences } from '$lib/content'
import type { ContentLoader, Sentence, TextModel } from '$lib/content'
import type { EpubBook } from '$lib/epub/types'
import type { Locator } from '$lib/types'

export interface SpeechChapter {
    spineIndex: number
    /** `TextModel.text` of the chapter. */
    text: string
    sentences: Sentence[]
    /** Language of the chapter, or of the book, or null. */
    lang: string | null
    /** Chapter offset where speech starts. */
    offset: number
    /** The offset is from a text selection, so it can be inside a word. */
    wholeWord?: boolean
}

export interface FindChapterOptions {
    book: Pick<EpubBook, 'spine' | 'metadata'>
    content: Pick<ContentLoader, 'load' | 'loadText'>
    from: Locator
    /** False stops the search, for example after the mode ended. */
    isCurrent?(): boolean
}

/** Index of the next spine item that normal reading shows, or -1 at the end of the book. */
export function nextLinearIndex(book: Pick<EpubBook, 'spine'>, after: number): number {
    for (let index = after + 1; index < book.spine.length; index++) {
        if (book.spine[index].linear) return index
    }
    return -1
}

/** True when a sentence ends after the offset. The sentences are sorted. */
export function hasSentenceAfter(sentences: readonly Sentence[], offset: number): boolean {
    const last = sentences[sentences.length - 1]
    return last !== undefined && last.end > offset
}

/** The first sentence that ends after the offset, or null. */
export function sentenceAt(sentences: readonly Sentence[], offset: number): Sentence | null {
    let low = 0
    let high = sentences.length
    while (low < high) {
        const middle = (low + high) >> 1
        if (sentences[middle].end > offset) high = middle
        else low = middle + 1
    }
    return sentences[low] ?? null
}

/** A start inside a word goes back to the start of the word, but not more than this. */
const WORD_START_LIMIT = 40

export interface SentencesFromOptions {
    text: string
    sentences: Sentence[]
    /** Chapter offset where speech starts. */
    offset: number
    /** The offset can be inside a word. Speech then starts at the start of that word. */
    wholeWord?: boolean
}

/**
 * The sentences for a start at `offset`. A sentence that has the offset inside it starts at
 * the offset, so speech and the marker start at the top of the page, or at the selected word,
 * and not in the text before it. The view would turn back to a marker on the page before.
 *
 * Returns the same list when no sentence has the offset inside it.
 */
export function sentencesFrom({
    text,
    sentences,
    offset,
    wholeWord = false,
}: SentencesFromOptions): Sentence[] {
    let low = 0
    let high = sentences.length
    while (low < high) {
        const middle = (low + high) >> 1
        if (sentences[middle].end > offset) high = middle
        else low = middle + 1
    }
    const sentence = sentences[low]
    if (!sentence || sentence.start >= offset) return sentences

    let start = offset
    if (wholeWord) {
        const limit = Math.max(sentence.start, offset - WORD_START_LIMIT)
        let index = offset
        while (index > limit && !/\s/.test(text.charAt(index - 1))) index--
        // Text with no spaces, such as Chinese, has no word start to go back to.
        if (index === sentence.start || /\s/.test(text.charAt(index - 1))) start = index
    }
    if (start <= sentence.start) return sentences

    const cut = sentences.slice()
    cut[low] = { ...sentence, start }
    return cut
}

function hasTextAfter(model: TextModel, offset: number): boolean {
    const last = model.blocks[model.blocks.length - 1]
    return last !== undefined && last.end > offset
}

async function chapterLanguage({
    book,
    content,
    spineIndex,
}: {
    book: FindChapterOptions['book']
    content: FindChapterOptions['content']
    spineIndex: number
}): Promise<string | null> {
    try {
        // The view shows this chapter now or in a moment, so the chapter is in the cache of the
        // loader or goes there for the view.
        const { lang } = await content.load(spineIndex)
        if (lang) return lang
    } catch {
        // The book language is sufficient.
    }
    return normalizeLanguage(book.metadata.language)
}

/**
 * The chapter of `from` when it has a sentence after the offset. If not, the next linear
 * chapter that has sentences, from its start. Null at the end of the book, and when
 * `isCurrent` gives false. Never rejects: a chapter that does not load is skipped.
 */
export async function findSpeechChapter({
    book,
    content,
    from,
    isCurrent = () => true,
}: FindChapterOptions): Promise<SpeechChapter | null> {
    let spineIndex = from.spineIndex
    let offset = Number.isFinite(from.offset) ? Math.max(0, from.offset) : 0

    while (spineIndex >= 0 && spineIndex < book.spine.length) {
        let model: TextModel | null = null
        try {
            model = await content.loadText(spineIndex)
        } catch {
            // A chapter that does not load has no text to speak.
        }
        if (!isCurrent()) return null

        // Only a chapter with text gets a full load for its language. A row of picture pages
        // must not push the chapters of the view out of the loader cache.
        if (model && hasTextAfter(model, offset)) {
            const lang = await chapterLanguage({ book, content, spineIndex })
            if (!isCurrent()) return null
            const sentences = segmentSentences({ model, locale: lang })
            if (hasSentenceAfter(sentences, offset)) {
                return { spineIndex, text: model.text, sentences, lang, offset }
            }
        }

        spineIndex = nextLinearIndex(book, spineIndex)
        offset = 0
    }
    return null
}
