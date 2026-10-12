/**
 * One mounted chapter: a host element with a shadow root that holds the chapter DOM.
 *
 * The shadow root keeps the book stylesheets away from the app, and the app stylesheets away
 * from the book.
 */

import { createTextIndex } from '$lib/content'
import type { ChapterContent, TextIndex } from '$lib/content/types'
import { ACTIVE_CLASS, HIGHLIGHT_CLASS, applyHighlights, highlightKey, unwrapMarks } from './marks'
import type { HighlightMark } from './types'

export const STYLE_OFF_ATTR = 'data-rd-style-off'
export const FRAME_ATTR = 'data-rd-frame'
/** The spine index of the chapter, on the host element. */
export const SPINE_ATTR = 'data-rd-spine'
/** On a block that has an image and no text. The override sheet removes its indent. */
export const MEDIA_BLOCK_ATTR = 'data-rd-media'

const INLINE_NAMES = new Set(
    (
        'a abbr b bdi bdo cite code del dfn em font i ins kbd label mark picture q s samp ' +
        'small span strong sub sup u var'
    ).split(' '),
)

export interface FrameOptions {
    content: ChapterContent
    baseSheet: CSSStyleSheet
    overrideSheet: CSSStyleSheet
    /** False leaves out the book stylesheets and the style attributes. */
    publisherStyles: boolean
}

export interface Frame {
    readonly id: number
    readonly content: ChapterContent
    readonly spineIndex: number
    /** The element that the view puts into its own DOM. */
    readonly host: HTMLDivElement
    readonly shadow: ShadowRoot
    /** The `rd-html` element of the chapter. */
    readonly root: HTMLElement
    readonly body: HTMLElement
    /** The offset map for the Text nodes as they are now. */
    readonly index: TextIndex
    rebuildIndex(): void
    setPublisherStyles(enabled: boolean): void
    /** Paint the highlights of this chapter. Returns true when the marks changed. */
    setHighlights(highlights: readonly HighlightMark[]): boolean
    /** Remove all changes from the chapter DOM and give it back to the content cache. */
    dispose(): void
}

let nextId = 1

/**
 * An `!important` declaration in a style attribute wins over each stylesheet, also over the
 * reader overrides. Without the flag the declaration still wins over the book stylesheets.
 */
function removeImportantFlags(root: HTMLElement): void {
    for (const element of root.querySelectorAll<HTMLElement>('[style*="important"]')) {
        const style = element.style
        if (!style) continue
        for (let i = 0; i < style.length; i++) {
            const name = style[i]
            if (style.getPropertyPriority(name)) {
                style.setProperty(name, style.getPropertyValue(name), '')
            }
        }
    }
}

function hasText(element: Element): boolean {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/\S/.test((node as Text).data)) return true
    }
    return false
}

/**
 * The first-line indent of a block also moves an image that is alone in the block. An image
 * as wide as the column then sticks out of the column. A block with no text has no line
 * that needs the indent, so the mark changes nothing else.
 */
function markMediaBlocks(body: HTMLElement): void {
    for (const media of body.querySelectorAll('img, svg')) {
        let block = media.parentElement
        while (block && block !== body && INLINE_NAMES.has(block.localName)) {
            block = block.parentElement
        }
        if (!block || block === body || block.hasAttribute(MEDIA_BLOCK_ATTR)) continue
        if (!hasText(block)) block.setAttribute(MEDIA_BLOCK_ATTR, '')
    }
}

function disableStyleAttributes(root: HTMLElement): void {
    const styled: Element[] = [...root.querySelectorAll('[style]')]
    if (root.hasAttribute('style')) styled.push(root)
    for (const element of styled) {
        element.setAttribute(STYLE_OFF_ATTR, element.getAttribute('style') ?? '')
        element.removeAttribute('style')
    }
}

function restoreStyleAttributes(root: HTMLElement): void {
    const styled: Element[] = [...root.querySelectorAll(`[${STYLE_OFF_ATTR}]`)]
    if (root.hasAttribute(STYLE_OFF_ATTR)) styled.push(root)
    for (const element of styled) {
        element.setAttribute('style', element.getAttribute(STYLE_OFF_ATTR) ?? '')
        element.removeAttribute(STYLE_OFF_ATTR)
    }
}

export function createFrame({
    content,
    baseSheet,
    overrideSheet,
    publisherStyles,
}: FrameOptions): Frame {
    const id = nextId++
    const host = document.createElement('div')
    host.setAttribute(FRAME_ATTR, String(id))
    host.setAttribute(SPINE_ATTR, String(content.spineIndex))
    // A book can still make a fixed position with a custom property. The containment keeps
    // such a box inside the host.
    host.style.contain = 'layout paint'
    const shadow = host.attachShadow({ mode: 'open' })

    const { root, body } = content
    let index: TextIndex | null = null
    let stylesOn: boolean | null = null
    let marksKey = ''
    let disposed = false

    removeImportantFlags(root)
    markMediaBlocks(body)

    function setPublisherStyles(enabled: boolean): void {
        if (disposed || stylesOn === enabled) return
        stylesOn = enabled
        shadow.adoptedStyleSheets = enabled
            ? [baseSheet, ...content.styles, overrideSheet]
            : [baseSheet, overrideSheet]
        if (enabled) restoreStyleAttributes(root)
        else disableStyleAttributes(root)
    }

    function rebuildIndex(): void {
        index = createTextIndex(body)
    }

    function setHighlights(highlights: readonly HighlightMark[]): boolean {
        if (disposed) return false
        const key = highlightKey(content.spineIndex, highlights)
        if (key === marksKey) return false
        marksKey = key
        applyHighlights({ frame, highlights })
        return true
    }

    function dispose(): void {
        if (disposed) return
        disposed = true
        // When the next owner of the chapter attached the DOM already, the marks and the
        // style attributes are its own.
        if (root.parentNode === shadow) {
            unwrapMarks(body, HIGHLIGHT_CLASS)
            unwrapMarks(body, ACTIVE_CLASS)
            restoreStyleAttributes(root)
            shadow.removeChild(root)
        }
        shadow.adoptedStyleSheets = []
        host.remove()
        index = null
    }

    const frame: Frame = {
        id,
        content,
        spineIndex: content.spineIndex,
        host,
        shadow,
        root,
        body,
        get index() {
            index ??= createTextIndex(body)
            return index
        },
        rebuildIndex,
        setPublisherStyles,
        setHighlights,
        dispose,
    }

    setPublisherStyles(publisherStyles)
    shadow.appendChild(root)
    return frame
}
