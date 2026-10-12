/**
 * A position in a book that does not depend on layout, font or reading mode.
 *
 * `offset` counts UTF-16 code units through the counted text nodes of the chapter body in
 * document order. See `$lib/content/text-model` for the exact rule. All features that keep a
 * position (progress, bookmarks, highlights, speed reader, speech) use this type.
 */
export interface Locator {
    /** Index into `EpubBook.spine`. Non-linear items also have an index. */
    spineIndex: number
    /** Character offset into the chapter text. 0 is the start of the chapter. */
    offset: number
}

/** A run of text in one chapter. `end` is exclusive. */
export interface TextRange {
    spineIndex: number
    start: number
    end: number
}

export type ReadingTheme = 'light' | 'sepia' | 'dark' | 'black'

export type LayoutMode = 'paged' | 'scroll'

export type PageTurnAnimation = 'slide' | 'fade' | 'none'

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
    'yellow',
    'green',
    'blue',
    'pink',
    'purple',
]

export function compareLocators(a: Locator, b: Locator): number {
    return a.spineIndex - b.spineIndex || a.offset - b.offset
}

export function isLocatorInRange(locator: Locator, range: TextRange): boolean {
    return (
        locator.spineIndex === range.spineIndex &&
        locator.offset >= range.start &&
        locator.offset < range.end
    )
}
