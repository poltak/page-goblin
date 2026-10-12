/**
 * Public types of the content module.
 *
 * The content module turns one EPUB content document into safe DOM that the reader views can
 * put into a shadow root. It also gives the text of a chapter with stable character offsets.
 */

/**
 * The text of one chapter.
 *
 * COUNTED TEXT RULE. `text` is the concatenation, in document order, of the `data` of each Text
 * node below the chapter body, but not Text nodes that have an ancestor (below the body) that is
 * one of: `svg`, `math`, `rt`, `rp`, `script`, `style`, `template`, or an element with the
 * attribute `data-rd-skip`. Offsets are UTF-16 code units into `text`. Whitespace is counted as
 * written (it is not collapsed). `<mark>` wrappers that the reader adds for highlights do not
 * change the text, so offsets stay stable.
 */
export interface TextModel {
    text: string
    /**
     * Runs of text that belong to one block (paragraph, heading, list item, table cell, or the
     * text between two `<br>` elements). Sorted by `start`. Blocks do not overlap. A block that
     * has only whitespace is left out. `start` and `end` are trimmed to non-whitespace characters.
     */
    blocks: TextBlock[]
}

export interface TextBlock {
    start: number
    /** Exclusive. */
    end: number
    /** True for h1 to h6 blocks. The speed reader and speech pause longer after a heading. */
    heading: boolean
}

export interface WordToken {
    /** The word with its punctuation, as shown by the speed reader. Never has whitespace. */
    text: string
    start: number
    /** Exclusive. */
    end: number
    /** Index into `TextModel.blocks`. */
    block: number
    /** True for the last word of its block. */
    endsBlock: boolean
}

export interface Sentence {
    start: number
    /** Exclusive. Trailing whitespace is not included. */
    end: number
    /** Index into `TextModel.blocks`. A sentence never crosses a block boundary. */
    block: number
}

/** A DOM position inside a chapter body. */
export interface DomPoint {
    node: Text
    offset: number
}

/**
 * Maps chapter offsets to DOM positions and back for one chapter body.
 *
 * The index holds references to the Text nodes that were below the body when it was made.
 * Make a new index after each change to the Text nodes (for example after highlight marks are
 * added or removed).
 */
export interface TextIndex {
    /** Chapter length. Equal to `TextModel.text.length`. */
    readonly length: number
    /**
     * DOM position of a chapter offset. `offset === length` gives the end of the last Text node.
     * When the offset is on the boundary between two Text nodes, the result is the start of the
     * second node, except for `offset === length`. Returns null when the chapter has no text.
     */
    locate(offset: number): DomPoint | null
    /**
     * Chapter offset of a DOM position. `node` can be a Text node or an element (then
     * `nodeOffset` is a child index, as in the Range interface). A position in text that is not
     * counted gives the offset of the next counted character. Returns -1 when `node` is not
     * below the body.
     */
    offsetOf(node: Node, nodeOffset: number): number
    /** A live Range for [start, end), with both values clamped to [0, length]. Null if no text. */
    range(start: number, end: number): Range | null
    /** Chapter offset of the first counted character at or after the start of `element`. */
    offsetOfElement(element: Element): number
}

/** One prepared chapter. The DOM is detached. Only one owner can attach it at a time. */
export interface ChapterContent {
    readonly spineIndex: number
    /** Container path of the content document. */
    readonly path: string
    /** An `<rd-html>` element. Its only child is `body`. Carries `lang`, `dir` and `class`. */
    readonly root: HTMLElement
    /** An `<rd-body>` element with the sanitised chapter markup. */
    readonly body: HTMLElement
    /**
     * Book stylesheets for this chapter in cascade order: linked stylesheets, then `<style>`
     * blocks. Selectors are rewritten (`html` to `rd-html`, `body` to `rd-body`). Sheets of
     * linked files are shared between chapters of the same book.
     */
    readonly styles: readonly CSSStyleSheet[]
    /** Chapter text length under the counted text rule. */
    readonly length: number
    /** Element `id` (and `a[name]`) to the chapter offset of the element start. */
    readonly anchors: ReadonlyMap<string, number>
    readonly lang: string | null
    readonly dir: 'ltr' | 'rtl' | null
    /**
     * Resolves when all images of the chapter are loaded or failed. Never rejects. The views
     * wait for this (with a time limit) before they measure the layout.
     */
    readonly imagesReady: Promise<void>
}

/** Link data that the sanitiser puts on internal `<a>` elements. */
export const INTERNAL_LINK_PATH_ATTR = 'data-rd-path'
export const INTERNAL_LINK_FRAGMENT_ATTR = 'data-rd-fragment'

export interface ContentLoader {
    /**
     * Load the manifest stylesheets and register the embedded fonts of the book with
     * `document.fonts`. Call one time after the book opens. Never rejects for a bad stylesheet.
     */
    prepare(): Promise<void>
    /** Family names of the embedded fonts, sorted, with no duplicates. Empty before `prepare`. */
    readonly bookFonts: readonly string[]
    /**
     * Load and prepare a chapter. Keeps a small least-recently-used cache. Concurrent calls for
     * the same index share one promise.
     */
    load(spineIndex: number): Promise<ChapterContent>
    /** The text model of a chapter. Uses the chapter cache and keeps its own small cache. */
    loadText(spineIndex: number): Promise<TextModel>
    /** Revoke all object URLs, remove the registered fonts and clear the caches. */
    dispose(): void
}
