/**
 * Reads the table of contents from an NCX file (EPUB 2).
 */

import { addTocEntry, type TocContext } from './toc'
import type { TocItem } from './types'
import {
    attribute,
    childrenNamed,
    firstDescendant,
    localName,
    parseHtml,
    parseXml,
    textOf,
} from './xml'

export function parseNcx(text: string, context: TocContext): TocItem[] {
    // The HTML parser is the last fallback. It changes the nesting (see `readPoints`).
    const document = parseXml(text) ?? parseHtml(text)
    const root = firstDescendant(document, 'navmap') ?? document.documentElement
    const items: TocItem[] = []
    if (root) readPoints(root, items, context)
    return items
}

/**
 * Collect the navPoint elements whose nearest navPoint ancestor is `parent`. In a document
 * from the HTML parser the nested navPoint elements are inside `content`, so the search goes
 * into the elements that are not navPoint elements.
 */
function readPoints(parent: Element, items: TocItem[], context: TocContext): void {
    for (const child of parent.children) {
        const name = localName(child)
        if (name === 'navlabel') continue
        if (name !== 'navpoint') {
            readPoints(child, items, context)
            continue
        }

        const label = childrenNamed(child, 'navlabel')[0]
        const content = childrenNamed(child, 'content')[0]
        const children: TocItem[] = []
        readPoints(child, children, context)
        addTocEntry(
            items,
            {
                title: textOf(label ? (firstDescendant(label, 'text') ?? label) : null),
                href: content ? attribute(content, 'src') : null,
                children,
            },
            context,
        )
    }
}
