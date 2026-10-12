/**
 * Word and block data for tests, in the shape that the content module gives to the engine.
 */

import type { TextBlock, WordToken } from '$lib/content/types'

export interface FakeChapter {
    text: string
    words: WordToken[]
    blocks: TextBlock[]
}

/**
 * Each entry is one block. An entry that starts with '# ' is a heading. One line break
 * separates the blocks in the chapter text.
 */
export function makeChapter(blockTexts: string[]): FakeChapter {
    const words: WordToken[] = []
    const blocks: TextBlock[] = []
    let text = ''

    for (const entry of blockTexts) {
        const heading = entry.startsWith('# ')
        const blockText = heading ? entry.slice(2) : entry
        if (text) text += '\n'
        const blockStart = text.length
        text += blockText

        const firstWord = words.length
        for (const match of blockText.matchAll(/\S+/g)) {
            words.push({
                text: match[0],
                start: blockStart + match.index,
                end: blockStart + match.index + match[0].length,
                block: blocks.length,
                endsBlock: false,
            })
        }
        if (words.length === firstWord) continue

        words[words.length - 1].endsBlock = true
        blocks.push({
            start: words[firstWord].start,
            end: words[words.length - 1].end,
            heading,
        })
    }

    return { text, words, blocks }
}

/** One word with no block data, for tests of the delay rules. */
export function makeWord(text: string, endsBlock = false): WordToken {
    return { text, start: 0, end: text.length, block: 0, endsBlock }
}
