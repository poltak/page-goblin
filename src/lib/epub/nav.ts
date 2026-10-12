/**
 * Reads the table of contents from an EPUB 3 navigation document.
 */

import { addTocEntry, type TocContext } from './toc'
import type { TocItem } from './types'
import {
    attribute,
    collapseWhitespace,
    descendants,
    firstDescendant,
    localName,
    parseContentDocument,
    textOf,
} from './xml'

const EPUB_NAMESPACE = 'http://www.idpf.org/2007/ops'

export function parseNav(text: string, context: TocContext): TocItem[] {
    // A nav document that is not well-formed XHTML is still readable as HTML.
    const document = parseContentDocument(text)
    const nav = descendants(document, 'nav').find(isTocNav)
    const list = nav ? firstList(nav) : undefined
    return list ? readList(list, context) : []
}

/**
 * The value of `epub:type`. The attribute has a namespace in an XML document and a plain
 * name with a colon in an HTML document, and some books use another prefix.
 */
function epubTypeOf(element: Element): string {
    for (const candidate of element.attributes) {
        const name = candidate.name.toLowerCase()
        if (
            name === 'epub:type' ||
            name.endsWith(':type') ||
            (candidate.namespaceURI === EPUB_NAMESPACE &&
                candidate.localName.toLowerCase() === 'type')
        ) {
            const value = candidate.value.trim().toLowerCase()
            if (value) return value
        }
    }
    return ''
}

function isTocNav(nav: Element): boolean {
    return (
        epubTypeOf(nav).split(/\s+/).includes('toc') ||
        nav.getAttribute('role')?.trim().toLowerCase() === 'doc-toc' ||
        nav.getAttribute('type')?.trim().toLowerCase() === 'toc'
    )
}

function isList(element: Element): boolean {
    const name = localName(element)
    return name === 'ol' || name === 'ul'
}

function firstList(parent: Element): Element | undefined {
    for (const element of parent.getElementsByTagName('*')) {
        if (isList(element)) return element
    }
    return undefined
}

function readList(list: Element, context: TocContext): TocItem[] {
    const items: TocItem[] = []

    for (const li of list.children) {
        if (localName(li) !== 'li') continue

        let label: Element | undefined
        let anchor: Element | undefined
        let sublist: Element | undefined
        for (const child of li.children) {
            if (isList(child)) sublist ??= child
            else {
                label ??= child
                if (localName(child) === 'a') anchor ??= child
            }
        }

        // The label is an `a` or a `span`. Some books put the link in a wrapper element, or
        // put a different element (a chapter number) before the link.
        const link = anchor ?? (label && (firstDescendant(label, 'a') ?? label))
        const title =
            textOf(link) || (link && attribute(link, 'title')) || ownText(li) || textOf(label)

        addTocEntry(
            items,
            {
                title,
                href: link && localName(link) === 'a' ? attribute(link, 'href') : null,
                children: sublist ? readList(sublist, context) : [],
            },
            context,
        )
    }

    return items
}

/** The text that is a direct child of an element, for an `li` with no label element. */
function ownText(element: Element): string {
    let text = ''
    for (const node of element.childNodes) {
        if (node.nodeType === 3) text += node.nodeValue ?? ''
    }
    return collapseWhitespace(text)
}
