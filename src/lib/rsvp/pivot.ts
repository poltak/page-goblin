/**
 * The optimal recognition point of a word. The view puts the pivot character at a fixed
 * position, so that the eye does not move between words.
 */

export interface PivotParts {
    before: string
    pivot: string
    after: string
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
/** Below U+0300 there are no combining marks and no surrogates, so each code unit is one character. */
const NEEDS_SEGMENTATION = /[\u0300-\uFFFF]/
/** More letters than this do not move the pivot. */
const MAX_COUNTED_LETTERS = 14
/** Number of UTF-16 code units at the start of a long token that `splitAtPivot` examines first. */
const HEAD_LENGTH = 64

let segmenter: Intl.Segmenter | null | undefined

function getSegmenter(): Intl.Segmenter | null {
    if (segmenter === undefined) {
        segmenter =
            typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
                ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
                : null
    }
    return segmenter
}

/** Split text into characters as the reader sees them. */
function splitCharacters(text: string): string[] {
    if (!NEEDS_SEGMENTATION.test(text)) return text.split('')
    const graphemes = getSegmenter()
    // A grapheme keeps a letter together with its combining accents. Code points are the fallback.
    if (graphemes) return Array.from(graphemes.segment(text), (part) => part.segment)
    return Array.from(text)
}

/** Pivot position in a word that has this number of letters and digits. */
export function pivotIndexForLength(letterCount: number): number {
    if (letterCount <= 1) return 0
    if (letterCount <= 5) return 1
    if (letterCount <= 9) return 2
    if (letterCount <= 13) return 3
    return 4
}

/**
 * The pivot index in `characters`, or -1 when `isComplete` is false and the characters do not
 * have enough letters to give the same result as the full word.
 */
function findPivotIndex(characters: string[], isComplete: boolean): number {
    let leading = 0
    let letterCount = 0
    for (const character of characters) {
        if (LETTER_OR_DIGIT.test(character)) {
            letterCount++
            if (letterCount === MAX_COUNTED_LETTERS) break
        } else if (letterCount === 0) {
            leading++
        }
    }
    if (!isComplete && letterCount < MAX_COUNTED_LETTERS) return -1
    // A word with no letter or digit has no leading punctuation to skip.
    return letterCount === 0 ? 0 : leading + pivotIndexForLength(letterCount)
}

export function splitAtPivot(word: string): PivotParts {
    // The pivot is near the start of the word. For a very long token (a URL, or text with no
    // spaces) the function splits only the start, if the start has enough letters to fix the pivot.
    const isShort = word.length <= HEAD_LENGTH
    let characters = splitCharacters(isShort ? word : word.slice(0, HEAD_LENGTH))
    let index = findPivotIndex(characters, isShort)
    if (index < 0) {
        characters = splitCharacters(word)
        index = findPivotIndex(characters, true)
    }

    const before = characters.slice(0, index).join('')
    const pivot = characters[index] ?? ''
    return { before, pivot, after: word.slice(before.length + pivot.length) }
}
