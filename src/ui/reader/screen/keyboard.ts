/**
 * The keyboard map of the reader screen. `keyCommand` is pure. `targetContext` reads the
 * element that got the key.
 */

import type { LayoutMode } from '$lib/types'
import type { ReaderMode } from '../types'

export type KeyCommand =
    | 'next'
    | 'prev'
    | 'line-down'
    | 'line-up'
    | 'contents'
    | 'bookmark'
    | 'appearance'
    | 'search'
    | 'speed'
    | 'listen'
    | 'fullscreen'
    | 'font-larger'
    | 'font-smaller'
    | 'back'
    | 'shortcuts'
    | 'hide-bars'

export type KeyInput = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

export interface TargetContext {
    /** The target takes the keys itself: a form field, editable text or a menu. */
    typing: boolean
    /** The target is a button. Space is the key that uses it. */
    onControl: boolean
}

export interface KeyContext extends TargetContext {
    mode: ReaderMode
    layout: LayoutMode
    dialogOpen: boolean
    /**
     * The keyboard focus is in the book text, for example on a link. Only then does the
     * browser scroll the text of the scroll view for Space, Page Down and Page Up. With the
     * focus on the body it scrolls the page, and the page of the reader has no scroll.
     */
    focusInPage: boolean
}

const LETTERS: ReadonlyMap<string, KeyCommand> = new Map([
    ['t', 'contents'],
    ['b', 'bookmark'],
    ['a', 'appearance'],
    ['s', 'speed'],
    ['l', 'listen'],
    ['f', 'fullscreen'],
])

/** Held keys repeat these commands. Each other command runs one time for a press. */
const REPEATING: ReadonlySet<KeyCommand> = new Set([
    'next',
    'prev',
    'line-down',
    'line-up',
    'font-larger',
    'font-smaller',
])

export function repeats(command: KeyCommand): boolean {
    return REPEATING.has(command)
}

/** The command of a key, or null when the reader screen must not use the key. */
export function keyCommand(input: KeyInput, context: KeyContext): KeyCommand | null {
    // The speed reader covers the page and has its own keys. The listen bar takes its keys
    // before the screen gets them, and the other keys stay in use while the book is read aloud.
    if (context.typing || context.dialogOpen || context.mode === 'speed') return null
    if (input.altKey) return null

    const { key } = input
    if (input.ctrlKey || input.metaKey) {
        // The search of the browser cannot see the other pages of the book. Ctrl+Cmd+F is
        // the full screen key of macOS.
        const find = input.ctrlKey !== input.metaKey && !input.shiftKey
        return find && key.toLowerCase() === 'f' ? 'search' : null
    }

    // The scroll view keeps the scroll keys of the browser while the browser has text to
    // scroll. With the focus on the body or on a button, the browser scrolls nothing, so the
    // screen moves the text.
    const turns = context.layout === 'paged' || !context.focusInPage
    const lines = context.layout === 'scroll' && !context.focusInPage && !input.shiftKey
    switch (key) {
        case 'ArrowDown':
            return lines ? 'line-down' : null
        case 'ArrowUp':
            return lines ? 'line-up' : null
        // Shift with an arrow key changes the text selection.
        case 'ArrowRight':
            return input.shiftKey ? null : 'next'
        case 'ArrowLeft':
            return input.shiftKey ? null : 'prev'
        case 'PageDown':
            return turns ? 'next' : null
        case 'PageUp':
            return turns ? 'prev' : null
        case ' ':
            if (!turns || context.onControl) return null
            return input.shiftKey ? 'prev' : 'next'
        case 'Backspace':
            return 'back'
        case 'Escape':
            return 'hide-bars'
        case '/':
            return 'search'
        case '?':
            return 'shortcuts'
        case '+':
        case '=':
            return 'font-larger'
        case '-':
            return 'font-smaller'
    }
    // Caps Lock and Shift give the capital letter.
    return LETTERS.get(key.toLowerCase()) ?? null
}

const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
const MENU = '[role="menu"], [popover]'
// Not a link: Space does not use a link, and a link of the book can have the focus.
const CONTROL = 'button, summary, [role="button"]'

/** Reads the element that got the key. An event from the book text has the text as its target. */
export function targetContext(event: Event): TargetContext {
    const target = event.composedPath()[0] ?? event.target
    if (!(target instanceof Element)) return { typing: false, onControl: false }
    return {
        typing: target.closest(TYPING) !== null || target.closest(MENU) !== null,
        onControl: target.closest(CONTROL) !== null,
    }
}
