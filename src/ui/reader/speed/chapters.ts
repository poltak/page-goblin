/** Finds the chapters that the speed reader can show. They are the spine items that have words. */

import { tokenizeWords } from '$lib/content'
import type { ContentLoader, TextBlock, WordToken } from '$lib/content'
import type { SpineItem } from '$lib/epub/types'

export interface LoadedChapter {
    spineIndex: number
    words: readonly WordToken[]
    blocks: readonly TextBlock[]
}

export interface FindChapterOptions {
    content: Pick<ContentLoader, 'loadText'>
    spine: readonly Pick<SpineItem, 'linear'>[]
    /** The first spine index to examine. */
    from: number
    /** 1 searches to the end of the book, and -1 to its start. */
    step: 1 | -1
    /** Take the item at `from` also when it is not linear. The user is in that item. */
    acceptFirst?: boolean
}

/**
 * The first spine item from `from` that is linear and has words. Cover and image pages have
 * no words. Null when there is none. Rejects when a chapter does not load.
 */
export async function findChapter(options: FindChapterOptions): Promise<LoadedChapter | null> {
    const { content, spine, from, step, acceptFirst = false } = options
    if (!Number.isInteger(from)) return null

    for (let spineIndex = from; spineIndex >= 0 && spineIndex < spine.length; spineIndex += step) {
        if (!spine[spineIndex].linear && !(acceptFirst && spineIndex === from)) continue
        const model = await content.loadText(spineIndex)
        const words = tokenizeWords(model)
        if (words.length > 0) return { spineIndex, words, blocks: model.blocks }
    }
    return null
}
