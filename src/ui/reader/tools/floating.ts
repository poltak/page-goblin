/** What the selection toolbar and the note popover share: the screen size and the open state. */

import './floating.css'
import { on } from '../../dom'
import type { Insets, Size } from './place'

export interface ScreenArea {
    viewport: Size
    safe: Insets
}

export interface ScreenAreaWatch {
    /** The size of the viewport and its safe-area insets. Read one time, and again after a resize. */
    get(): ScreenArea
    destroy(): void
}

/**
 * CSS has the safe-area insets only as env() values. A hidden element gets them as its
 * padding, and the script reads the padding in pixels.
 */
export function watchScreenArea(host: HTMLElement, onResize?: () => void): ScreenAreaWatch {
    const probe = document.createElement('div')
    probe.className = 'float-probe'
    probe.setAttribute('aria-hidden', 'true')
    host.append(probe)

    let area: ScreenArea | null = null
    const stop = on(window, 'resize', () => {
        area = null
        onResize?.()
    })

    return {
        get() {
            if (area) return area
            const style = getComputedStyle(probe)
            const inset = (value: string): number => parseFloat(value) || 0
            area = {
                viewport: { width: window.innerWidth, height: window.innerHeight },
                safe: {
                    top: inset(style.paddingTop),
                    right: inset(style.paddingRight),
                    bottom: inset(style.paddingBottom),
                    left: inset(style.paddingLeft),
                },
            }
            return area
        },
        destroy() {
            stop()
            probe.remove()
        },
    }
}

/** Moves a `.float` element. Its top left corner is at the top left corner of the viewport. */
export function moveFloat(element: HTMLElement, position: { x: number; y: number }): void {
    element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
}

export function setFloatOpen(element: HTMLElement, open: boolean): void {
    element.classList.toggle('is-open', open)
}

export function isFloatOpen(element: HTMLElement): boolean {
    return element.classList.contains('is-open')
}

/** True when the event started in the element. */
export function startedIn(event: Event, element: HTMLElement): boolean {
    return event.target instanceof Node && element.contains(event.target)
}

/** The element that has the focus, also when it is in a shadow root (the book text). */
export function focusedElement(): Element | null {
    let element = document.activeElement
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
    return element
}
