/**
 * The text of a chapter body and the map between character offsets and DOM positions.
 *
 * All functions here use the counted text rule of `TextModel` in `./types`.
 */

import type { DomPoint, Sentence, TextBlock, TextIndex, TextModel, WordToken } from './types'
import { wordSet } from './util'

/** The reader puts this attribute on elements that it adds. Their text is not counted. */
export const SKIP_ATTR = 'data-rd-skip'

const SKIPPED = wordSet('svg math rt rp script style template')
const BLOCKS = wordSet(
    'address article aside blockquote dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 ' +
        'header hr li main nav ol p pre section table td th tr ul rd-body caption details summary',
)
const HEADINGS = wordSet('h1 h2 h3 h4 h5 h6')

const PRECEDING = 2
const FOLLOWING = 4
const CONTAINED_BY = 16

function isSkipped(element: Element): boolean {
    return SKIPPED.has(element.localName) || element.hasAttribute(SKIP_ATTR)
}

/** The same characters as `\s` in a regular expression. */
function isSpace(code: number): boolean {
    if (code <= 32) return code === 32 || (code >= 9 && code <= 13)
    if (code < 160) return false
    return (
        code === 160 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff
    )
}

interface Visitor {
    /** Called for each counted Text node. Return true to stop the walk. */
    text(node: Text): boolean | void
    /** Called for each element. The walk does not go into a skipped element. */
    enter?(element: Element, skipped: boolean): void
    /** Called one time for each `enter` call, after the children. */
    leave?(element: Element): void
}

/** Visit the nodes below `body` in document order. */
function walk(body: Node, visitor: Visitor): void {
    let node: Node | null = body.firstChild
    while (node) {
        if (node.nodeType === 3) {
            if (visitor.text(node as Text)) return
        } else if (node.nodeType === 1) {
            const element = node as Element
            const skipped = isSkipped(element)
            visitor.enter?.(element, skipped)
            if (!skipped && element.firstChild) {
                node = element.firstChild
                continue
            }
            visitor.leave?.(element)
        }

        while (!node.nextSibling) {
            node = node.parentNode
            if (!node || node === body) return
            visitor.leave?.(node as Element)
        }
        node = node.nextSibling
    }
}

export function buildTextModel(body: Element): TextModel {
    const parts: string[] = []
    const untrimmed: TextBlock[] = []
    let offset = 0
    let blockStart = -1
    let blockIsHeading = false
    let headingDepth = 0

    const endBlock = () => {
        if (blockStart < 0) return
        untrimmed.push({ start: blockStart, end: offset, heading: blockIsHeading })
        blockStart = -1
    }

    walk(body, {
        text(node) {
            const data = node.data
            if (!data) return
            if (blockStart < 0) {
                blockStart = offset
                blockIsHeading = headingDepth > 0
            }
            parts.push(data)
            offset += data.length
        },
        enter(element) {
            const name = element.localName
            if (name === 'br' || BLOCKS.has(name)) endBlock()
            if (HEADINGS.has(name)) headingDepth++
        },
        leave(element) {
            const name = element.localName
            if (BLOCKS.has(name)) endBlock()
            if (HEADINGS.has(name)) headingDepth--
        },
    })
    endBlock()

    const text = parts.join('')
    const blocks: TextBlock[] = []
    for (const block of untrimmed) {
        let { start, end } = block
        while (start < end && isSpace(text.charCodeAt(start))) start++
        while (end > start && isSpace(text.charCodeAt(end - 1))) end--
        if (start < end) blocks.push({ start, end, heading: block.heading })
    }
    return { text, blocks }
}

/**
 * The text length of a chapter body and the offset of each link target (`id`, and `name` on
 * `<a>`), in one pass. When two elements have the same name, the map has the first one.
 */
export function measureChapter(body: Element): { length: number; anchors: Map<string, number> } {
    const anchors = new Map<string, number>()
    let length = 0

    const add = (element: Element) => {
        const id = element.id
        if (id && !anchors.has(id)) anchors.set(id, length)
        if (element.localName === 'a') {
            const name = element.getAttribute('name')
            if (name && !anchors.has(name)) anchors.set(name, length)
        }
    }

    add(body)
    walk(body, {
        text(node) {
            length += node.data.length
        },
        enter(element, skipped) {
            add(element)
            if (skipped && element.firstElementChild) {
                for (const inner of element.querySelectorAll('[id]')) add(inner)
            }
        },
    })
    return { length, anchors }
}

/**
 * Make the offset map for a chapter body.
 *
 * The index keeps the Text nodes that are below the body now. Make a new index after each
 * change to the Text nodes, for example after the reader adds or removes highlight marks.
 * `locate`, `range` and `offsetOfElement` are correct only for the DOM that the index was
 * made from. `offsetOf` also accepts a counted Text node that is not in the index, such as a
 * node inside a mark that the reader added later. It then counts the text before the node,
 * which is slower.
 */
export function createTextIndex(body: Element): TextIndex {
    const nodes: Text[] = []
    const starts: number[] = []
    let length = 0
    walk(body, {
        text(node) {
            const size = node.data.length
            if (!size) return
            nodes.push(node)
            starts.push(length)
            length += size
        },
    })

    let positions: Map<Text, number> | null = null

    function positionOf(node: Text): number | undefined {
        if (!positions) {
            positions = new Map()
            for (let i = 0; i < nodes.length; i++) positions.set(nodes[i], i)
        }
        return positions.get(node)
    }

    const clamp = (offset: number) => Math.max(0, Math.min(length, Math.floor(offset) || 0))

    /** Position of the last node that starts at or before the offset. */
    function nodeAt(offset: number): number {
        let low = 0
        let high = nodes.length - 1
        while (low < high) {
            const middle = (low + high + 1) >>> 1
            if (starts[middle] <= offset) low = middle
            else high = middle - 1
        }
        return low
    }

    /** Offset of the first indexed node that passes the test. The test must be monotonic. */
    function firstOffset(test: (node: Text) => boolean): number {
        let low = 0
        let high = nodes.length
        while (low < high) {
            const middle = (low + high) >>> 1
            if (test(nodes[middle])) high = middle
            else low = middle + 1
        }
        return low < nodes.length ? starts[low] : length
    }

    const offsetAtStart = (node: Node) =>
        firstOffset((text) => !(node.compareDocumentPosition(text) & PRECEDING))

    const offsetAtEnd = (node: Node) =>
        firstOffset((text) => {
            const position = node.compareDocumentPosition(text)
            return (position & FOLLOWING) !== 0 && !(position & CONTAINED_BY)
        })

    function isCounted(node: Text): boolean {
        for (let parent = node.parentNode; parent && parent !== body; parent = parent.parentNode) {
            if (parent.nodeType === 1 && isSkipped(parent as Element)) return false
        }
        return true
    }

    function countBefore(target: Text): number {
        let total = 0
        walk(body, {
            text(node) {
                if (node === target) return true
                total += node.data.length
            },
        })
        return total
    }

    function point(position: number, offset: number): DomPoint {
        const node = nodes[position]
        // The node is shorter than the index has it when the DOM changed after the index was made.
        return { node, offset: Math.min(offset - starts[position], node.data.length) }
    }

    function locate(offset: number): DomPoint | null {
        if (!nodes.length) return null
        const clamped = clamp(offset)
        return point(nodeAt(clamped), clamped)
    }

    function offsetOf(node: Node, nodeOffset: number): number {
        if (!body.contains(node)) return -1

        if (node.nodeType === 3) {
            const text = node as Text
            const inNode = Math.max(0, Math.min(nodeOffset, text.data.length))
            const position = positionOf(text)
            if (position !== undefined) return starts[position] + inNode
            if (isCounted(text)) return countBefore(text) + inNode
            return offsetAtStart(text)
        }

        const child = node.childNodes[nodeOffset]
        if (child) return child.nodeType === 3 ? offsetOf(child, 0) : offsetAtStart(child)
        return node === body ? length : offsetAtEnd(node)
    }

    function range(start: number, end: number): Range | null {
        if (!nodes.length) return null
        const from = clamp(Math.min(start, end))
        const to = clamp(Math.max(start, end))

        const first = point(nodeAt(from), from)
        let lastPosition = nodeAt(to)
        // End in the node that has the last character, not at the start of the next node.
        if (to > from && to === starts[lastPosition] && lastPosition > 0) lastPosition--
        const last = point(lastPosition, to)

        const result = body.ownerDocument.createRange()
        result.setStart(first.node, first.offset)
        result.setEnd(last.node, last.offset)
        return result
    }

    function offsetOfElement(element: Element): number {
        if (element === body) return 0
        return body.contains(element) ? offsetAtStart(element) : -1
    }

    return { length, locate, offsetOf, range, offsetOfElement }
}

/** Split each block at white space. A word never crosses a block boundary. */
export function tokenizeWords(model: TextModel): WordToken[] {
    const { text, blocks } = model
    const words: WordToken[] = []

    for (let block = 0; block < blocks.length; block++) {
        const end = blocks[block].end
        let index = blocks[block].start
        let last: WordToken | null = null
        while (index < end) {
            while (index < end && isSpace(text.charCodeAt(index))) index++
            if (index >= end) break
            const start = index
            while (index < end && !isSpace(text.charCodeAt(index))) index++
            last = { text: text.slice(start, index), start, end: index, block, endsBlock: false }
            words.push(last)
        }
        if (last) last.endsBlock = true
    }
    return words
}

function createSentenceSegmenter(locale: string | null | undefined): Intl.Segmenter | null {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null
    // The language of a book can be a bad tag, such as `en_US`.
    for (const tag of [locale, locale?.replace(/_/g, '-'), undefined]) {
        try {
            return new Intl.Segmenter(tag || undefined, { granularity: 'sentence' })
        } catch {
            // Try the next tag.
        }
    }
    return null
}

export interface SentenceOptions {
    model: TextModel
    /** A BCP 47 language tag. The default is the language of the browser. */
    locale?: string | null
}

/** Split each block into sentences. A sentence never crosses a block boundary. */
export function segmentSentences({ model, locale }: SentenceOptions): Sentence[] {
    const { text, blocks } = model
    const segmenter = createSentenceSegmenter(locale)
    const sentences: Sentence[] = []

    let block = 0

    const add = (from: number, to: number) => {
        let start = from
        let end = to
        while (start < end && isSpace(text.charCodeAt(start))) start++
        while (end > start && isSpace(text.charCodeAt(end - 1))) end--
        if (start < end) sentences.push({ start, end, block })
    }

    for (; block < blocks.length; block++) {
        const { start, end } = blocks[block]
        const slice = text.slice(start, end)
        if (segmenter) {
            for (const part of segmenter.segment(slice)) {
                add(start + part.index, start + part.index + part.segment.length)
            }
            continue
        }

        let from = 0
        // One end mark, not a run of them. With a run, each mark in a long row of full
        // stops would scan the row again.
        for (const match of slice.matchAll(/[.!?]["'”’)\]]*\s+/g)) {
            const to = match.index + match[0].length
            add(start + from, start + to)
            from = to
        }
        add(start + from, end)
    }
    return sentences
}
