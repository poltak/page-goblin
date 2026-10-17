/** Small typed helpers for plain DOM code. */

/** The names of the symbols in `src/ui/icons.svg`, without the `i-` prefix. */
export type IconName =
    | 'book'
    | 'book-open'
    | 'library'
    | 'plus'
    | 'upload'
    | 'search'
    | 'x'
    | 'check'
    | 'chevron-left'
    | 'chevron-right'
    | 'chevron-down'
    | 'chevron-up'
    | 'arrow-left'
    | 'list'
    | 'bookmark'
    | 'bookmark-filled'
    | 'highlighter'
    | 'note'
    | 'type'
    | 'sliders'
    | 'sun'
    | 'moon'
    | 'play'
    | 'pause'
    | 'rewind'
    | 'skip-back'
    | 'skip-forward'
    | 'zap'
    | 'headphones'
    | 'volume'
    | 'trash'
    | 'more'
    | 'maximize'
    | 'minimize'
    | 'info'
    | 'download'
    | 'copy'
    | 'columns'
    | 'scroll'
    | 'page'
    | 'minus'
    | 'external-link'
    | 'edit'
    | 'palette'
    | 'rotate-ccw'
    | 'text-size'
    | 'align-left'
    | 'align-justify'
    | 'eye'
    | 'clock'
    | 'cloud'

/** The first element that matches. Throws when there is none. */
export function qs<T extends Element = HTMLElement>(
    selector: string,
    root: ParentNode = document,
): T {
    const element = root.querySelector<T>(selector)
    if (!element) throw new Error(`No element matches "${selector}"`)
    return element
}

/** All elements that match, as an array. */
export function qsa<T extends Element = HTMLElement>(
    selector: string,
    root: ParentNode = document,
): T[] {
    return Array.from(root.querySelectorAll<T>(selector))
}

type Options = boolean | AddEventListenerOptions

/**
 * Adds an event listener and returns the function that removes it.
 * The four inputs are in the order of `addEventListener`.
 */
export function on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: Options,
): () => void
export function on<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    options?: Options,
): () => void
export function on<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: Options,
): () => void
export function on<E extends Event = Event>(
    target: EventTarget,
    type: string,
    listener: (event: E) => void,
    options?: Options,
): () => void
export function on(
    target: EventTarget,
    type: string,
    listener: (event: never) => void,
    options?: Options,
): () => void {
    target.addEventListener(type, listener as EventListener, options)
    return () => target.removeEventListener(type, listener as EventListener, options)
}

/** A copy of the first element in the `<template>` that has this id. */
export function cloneTemplate<T extends Element = HTMLElement>(id: string): T {
    const template = document.getElementById(id)
    if (!(template instanceof HTMLTemplateElement)) {
        throw new Error(`No template has the id "${id}"`)
    }
    const first = template.content.firstElementChild
    if (!first) throw new Error(`The template "${id}" has no element`)
    return document.importNode(first, true) as T
}

/** Points the `<use>` of an icon `<svg>` to a symbol of the sprite. Adds the `<use>` if necessary. */
export function setIcon(svg: SVGElement, name: IconName): void {
    const use =
        svg.querySelector('use') ??
        svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'use'))
    use.setAttribute('href', `#i-${name}`)
}

/**
 * Sets `--value` (0 to 1) on a `.slider` input, so the CSS can draw the filled part of the track.
 * Call it after each change of the value, the minimum or the maximum.
 */
export function setRangeValue(input: HTMLInputElement): void {
    const min = toNumber(input.min, 0)
    const max = toNumber(input.max, 100)
    const fraction = max > min ? (toNumber(input.value, min) - min) / (max - min) : 0
    input.style.setProperty('--value', String(Math.min(1, Math.max(0, fraction))))
}

/** The browser uses a default when an attribute of a range input is empty or not a number. */
function toNumber(text: string, fallback: number): number {
    const number = text.trim() === '' ? NaN : Number(text)
    return Number.isFinite(number) ? number : fallback
}

let keyboardLast = false
if (typeof window !== 'undefined') {
    window.addEventListener('keydown', () => (keyboardLast = true), true)
    window.addEventListener('pointerdown', () => (keyboardLast = false), true)
}

/**
 * True when the last input of the user was a key, not a pointer. Safari shows a focus ring for
 * each focus that a script sets, so a panel that opens by touch moves the focus into its
 * content only when this is true.
 */
export function usedKeyboardLast(): boolean {
    return keyboardLast
}
