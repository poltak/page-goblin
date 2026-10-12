import { afterEach, describe, expect, it } from 'vitest'
import { keyCommand, repeats, targetContext } from './keyboard'
import type { KeyCommand, KeyContext, KeyInput } from './keyboard'

const PAGED: KeyContext = {
    mode: 'read',
    layout: 'paged',
    typing: false,
    onControl: false,
    dialogOpen: false,
    focusInPage: false,
}
const SCROLL: KeyContext = { ...PAGED, layout: 'scroll' }
/** The scroll view with the keyboard focus in the book text, for example on a link. */
const SCROLL_FOCUSED: KeyContext = { ...SCROLL, focusInPage: true }

function input(key: string, modifiers: Partial<KeyInput> = {}): KeyInput {
    return { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }
}

describe('keyCommand', () => {
    it.each<[string, Partial<KeyInput>, KeyCommand]>([
        ['ArrowRight', {}, 'next'],
        ['PageDown', {}, 'next'],
        [' ', {}, 'next'],
        ['ArrowLeft', {}, 'prev'],
        ['PageUp', {}, 'prev'],
        [' ', { shiftKey: true }, 'prev'],
        ['t', {}, 'contents'],
        ['b', {}, 'bookmark'],
        ['a', {}, 'appearance'],
        ['/', {}, 'search'],
        ['s', {}, 'speed'],
        ['l', {}, 'listen'],
        ['f', {}, 'fullscreen'],
        ['+', { shiftKey: true }, 'font-larger'],
        ['=', {}, 'font-larger'],
        ['-', {}, 'font-smaller'],
        ['Backspace', {}, 'back'],
        ['?', { shiftKey: true }, 'shortcuts'],
        ['Escape', {}, 'hide-bars'],
    ])('maps %j with %j to %s in the paged view', (key, modifiers, command) => {
        expect(keyCommand(input(key, modifiers), PAGED)).toBe(command)
    })

    it('reads a capital letter as the same key', () => {
        expect(keyCommand(input('T', { shiftKey: true }), PAGED)).toBe('contents')
        expect(keyCommand(input('B'), PAGED)).toBe('bookmark')
    })

    it.each(['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'x', '1', 'F5', 'Shift'])(
        'has no command for %s',
        (key) => {
            expect(keyCommand(input(key), PAGED)).toBeNull()
        },
    )

    it('leaves the scroll keys to the browser when the focus is in the text of the scroll view', () => {
        expect(keyCommand(input(' '), SCROLL_FOCUSED)).toBeNull()
        expect(keyCommand(input(' ', { shiftKey: true }), SCROLL_FOCUSED)).toBeNull()
        expect(keyCommand(input('PageDown'), SCROLL_FOCUSED)).toBeNull()
        expect(keyCommand(input('PageUp'), SCROLL_FOCUSED)).toBeNull()
        expect(keyCommand(input('ArrowDown'), SCROLL_FOCUSED)).toBeNull()
        expect(keyCommand(input('ArrowUp'), SCROLL_FOCUSED)).toBeNull()
    })

    it('moves the scroll view itself when the browser has no text to scroll', () => {
        // With the focus on the body, the browser scrolls the page, and the page has no scroll.
        expect(keyCommand(input(' '), SCROLL)).toBe('next')
        expect(keyCommand(input('PageDown'), SCROLL)).toBe('next')
        expect(keyCommand(input(' ', { shiftKey: true }), SCROLL)).toBe('prev')
        expect(keyCommand(input('PageUp'), SCROLL)).toBe('prev')
        expect(keyCommand(input('ArrowDown'), SCROLL)).toBe('line-down')
        expect(keyCommand(input('ArrowUp'), SCROLL)).toBe('line-up')
        // Also from a button of a bar, which does not use these keys.
        expect(keyCommand(input('ArrowDown'), { ...SCROLL, onControl: true })).toBe('line-down')
    })

    it('leaves Shift with the up and down arrows to the browser', () => {
        expect(keyCommand(input('ArrowDown', { shiftKey: true }), SCROLL)).toBeNull()
        expect(keyCommand(input('ArrowUp', { shiftKey: true }), SCROLL)).toBeNull()
    })

    it('does not use the focus in the text in the paged view', () => {
        const focused = { ...PAGED, focusInPage: true }
        expect(keyCommand(input(' '), focused)).toBe('next')
        expect(keyCommand(input('PageUp'), focused)).toBe('prev')
    })

    it('leaves Shift with an arrow key to the browser, which changes the selection', () => {
        expect(keyCommand(input('ArrowRight', { shiftKey: true }), PAGED)).toBeNull()
        expect(keyCommand(input('ArrowLeft', { shiftKey: true }), PAGED)).toBeNull()
        expect(keyCommand(input('ArrowRight', { shiftKey: true }), SCROLL)).toBeNull()
    })

    it('keeps the left and right arrows and the other keys in the scroll view', () => {
        expect(keyCommand(input('ArrowRight'), SCROLL)).toBe('next')
        expect(keyCommand(input('ArrowLeft'), SCROLL)).toBe('prev')
        expect(keyCommand(input('t'), SCROLL)).toBe('contents')
        expect(keyCommand(input('Escape'), SCROLL)).toBe('hide-bars')
    })

    it('does nothing when the target takes the keys itself', () => {
        const typing = { ...PAGED, typing: true }
        for (const key of ['ArrowRight', ' ', 't', '/', 'Backspace', 'Escape', '?']) {
            expect(keyCommand(input(key), typing)).toBeNull()
        }
        expect(keyCommand(input('f', { ctrlKey: true }), typing)).toBeNull()
    })

    it('does nothing while a dialog is open', () => {
        const dialog = { ...PAGED, dialogOpen: true }
        for (const key of ['ArrowRight', ' ', 't', '/', 'Backspace', 'Escape', '?']) {
            expect(keyCommand(input(key), dialog)).toBeNull()
        }
        expect(keyCommand(input('f', { metaKey: true }), dialog)).toBeNull()
    })

    it('does nothing in the speed mode', () => {
        const context = { ...PAGED, mode: 'speed' as const }
        for (const key of ['ArrowRight', ' ', 't', 's', 'l', 'Escape', '?']) {
            expect(keyCommand(input(key), context)).toBeNull()
        }
        expect(keyCommand(input('f', { ctrlKey: true }), context)).toBeNull()
    })

    it('keeps its keys in the listen mode', () => {
        const context = { ...PAGED, mode: 'listen' as const }
        expect(keyCommand(input('t'), context)).toBe('contents')
        expect(keyCommand(input('a'), context)).toBe('appearance')
        expect(keyCommand(input('s'), context)).toBe('speed')
        expect(keyCommand(input('+'), context)).toBe('font-larger')
        expect(keyCommand(input('f', { ctrlKey: true }), context)).toBe('search')
    })

    it('does nothing with a modifier key other than Shift', () => {
        for (const key of ['ArrowRight', ' ', 't', 'b', 's', '-', '=', 'Backspace', 'Escape']) {
            expect(keyCommand(input(key, { ctrlKey: true }), PAGED)).toBeNull()
            expect(keyCommand(input(key, { metaKey: true }), PAGED)).toBeNull()
            expect(keyCommand(input(key, { altKey: true }), PAGED)).toBeNull()
        }
    })

    it('opens the search for Ctrl+F and Cmd+F', () => {
        expect(keyCommand(input('f', { ctrlKey: true }), PAGED)).toBe('search')
        expect(keyCommand(input('f', { metaKey: true }), PAGED)).toBe('search')
        expect(keyCommand(input('F', { metaKey: true }), SCROLL)).toBe('search')
    })

    it('leaves Ctrl+Shift+F and Alt+F to the browser', () => {
        // Ctrl+Cmd+F is the full screen key of macOS.
        expect(keyCommand(input('f', { ctrlKey: true, metaKey: true }), PAGED)).toBeNull()
        expect(keyCommand(input('f', { ctrlKey: true, shiftKey: true }), PAGED)).toBeNull()
        expect(keyCommand(input('f', { ctrlKey: true, altKey: true }), PAGED)).toBeNull()
        expect(keyCommand(input('f', { altKey: true }), PAGED)).toBeNull()
    })

    it('leaves Space to a button that has the focus', () => {
        const onControl = { ...PAGED, onControl: true }
        expect(keyCommand(input(' '), onControl)).toBeNull()
        expect(keyCommand(input(' ', { shiftKey: true }), onControl)).toBeNull()
        // The other keys do not use the button.
        expect(keyCommand(input('ArrowRight'), onControl)).toBe('next')
        expect(keyCommand(input('t'), onControl)).toBe('contents')
    })
})

describe('repeats', () => {
    it('lets a held key turn pages and change the text size', () => {
        expect(repeats('next')).toBe(true)
        expect(repeats('prev')).toBe(true)
        expect(repeats('line-down')).toBe(true)
        expect(repeats('line-up')).toBe(true)
        expect(repeats('font-larger')).toBe(true)
        expect(repeats('font-smaller')).toBe(true)
    })

    it('runs each other command one time for a press', () => {
        expect(repeats('bookmark')).toBe(false)
        expect(repeats('contents')).toBe(false)
        expect(repeats('fullscreen')).toBe(false)
        expect(repeats('back')).toBe(false)
    })
})

describe('targetContext', () => {
    afterEach(() => {
        document.body.replaceChildren()
    })

    function contextOf(markup: string, selector: string) {
        document.body.innerHTML = markup
        let context = { typing: false, onControl: false }
        const target = document.querySelector(selector)!
        target.addEventListener('keydown', (event) => (context = targetContext(event)), {
            once: true,
        })
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
        return context
    }

    it.each([
        ['<input type="text" />', 'input'],
        ['<input type="range" />', 'input'],
        ['<textarea></textarea>', 'textarea'],
        ['<select><option>One</option></select>', 'select'],
        ['<div contenteditable="true"><p>Text</p></div>', 'p'],
        ['<div contenteditable><span>Text</span></div>', 'span'],
    ])('finds a field in %s', (markup, selector) => {
        expect(contextOf(markup, selector).typing).toBe(true)
    })

    it('finds a menu', () => {
        const markup = '<div role="menu"><button type="button">Item</button></div>'
        expect(contextOf(markup, 'button')).toEqual({ typing: true, onControl: true })
        expect(contextOf('<div popover><p>Text</p></div>', 'p').typing).toBe(true)
    })

    it('does not count text that is not editable', () => {
        expect(contextOf('<div contenteditable="false"><p>Text</p></div>', 'p').typing).toBe(false)
        expect(contextOf('<p>Text</p>', 'p')).toEqual({ typing: false, onControl: false })
    })

    it.each([
        ['<button type="button"><span>Go</span></button>', 'span'],
        ['<details><summary>More</summary></details>', 'summary'],
        ['<div role="button" tabindex="0">Go</div>', 'div'],
    ])('finds a control in %s', (markup, selector) => {
        expect(contextOf(markup, selector)).toEqual({ typing: false, onControl: true })
    })

    it('does not count a link as a control, because Space does not use a link', () => {
        expect(contextOf('<a href="#x">Link</a>', 'a')).toEqual({
            typing: false,
            onControl: false,
        })
    })

    it('reads the element in a shadow root, not its host', () => {
        const host = document.createElement('div')
        document.body.append(host)
        const shadow = host.attachShadow({ mode: 'open' })
        shadow.innerHTML = '<button type="button">1</button>'
        let context = { typing: false, onControl: false }
        window.addEventListener('keydown', (event) => (context = targetContext(event)), {
            once: true,
        })
        shadow
            .querySelector('button')!
            .dispatchEvent(
                new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }),
            )
        expect(context.onControl).toBe(true)
    })

    it('gives no context for an event on the window', () => {
        let context = { typing: true, onControl: true }
        window.addEventListener('keydown', (event) => (context = targetContext(event)), {
            once: true,
        })
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
        expect(context).toEqual({ typing: false, onControl: false })
    })
})
