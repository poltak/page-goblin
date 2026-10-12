import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMenu } from './menu'
import type { Menu } from './menu'
import { installOverlayMethods } from './testing/page'

let menu: HTMLElement
let buttonA: HTMLElement
let buttonB: HTMLElement
let onSelect: ReturnType<typeof vi.fn<(item: HTMLElement, anchor: HTMLElement) => void>>

const isOpen = () => 'open' in menu.dataset
const item = (action: string) => menu.querySelector<HTMLElement>(`[data-action="${action}"]`)!

function key(name: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    ;(document.activeElement ?? menu).dispatchEvent(event)
    return event
}

beforeEach(() => {
    installOverlayMethods()
    document.body.innerHTML = `
        <button id="a" popovertarget="menu" aria-expanded="false">A</button>
        <button id="b" popovertarget="menu" aria-expanded="false">B</button>
        <div class="menu" id="menu" popover role="menu">
            <button class="menu-item" data-action="open">Open</button>
            <button class="menu-item" data-action="details">Details</button>
            <button class="menu-item" data-action="gone" hidden>Gone</button>
            <button class="menu-item" data-action="off" disabled>Off</button>
            <hr class="menu-separator" />
            <button class="menu-item" data-action="remove">Remove</button>
        </div>`
    menu = document.getElementById('menu')!
    buttonA = document.getElementById('a')!
    buttonB = document.getElementById('b')!
    onSelect = vi.fn<(item: HTMLElement, anchor: HTMLElement) => void>()
})

describe('createMenu', () => {
    it('opens the menu for a button and marks the button as expanded', () => {
        const control = createMenu({ menu, onSelect })

        control.toggle(buttonA)

        expect(isOpen()).toBe(true)
        expect(buttonA.getAttribute('aria-expanded')).toBe('true')
        expect(control.anchor).toBe(buttonA)
    })

    /** jsdom has no layout, so the test gives the sizes. The window is 1024 by 768. */
    function setSizes(button: DOMRect, size = { width: 200, height: 150 }): void {
        vi.spyOn(buttonA, 'getBoundingClientRect').mockReturnValue(button)
        Object.defineProperty(menu, 'offsetWidth', { configurable: true, value: size.width })
        Object.defineProperty(menu, 'offsetHeight', { configurable: true, value: size.height })
    }

    it('opens below the button, with the left edges in line', () => {
        setSizes(new DOMRect(10, 20, 44, 44))

        createMenu({ menu, onSelect }).toggle(buttonA)

        expect(menu.style.left).toBe('10px')
        expect(menu.style.top).toBe('68px')
    })

    it('puts the right edges in line when the menu does not fit to the right', () => {
        setSizes(new DOMRect(900, 20, 44, 44))

        createMenu({ menu, onSelect }).toggle(buttonA)

        // The right edge of the button is at 944, and the menu is 200 wide.
        expect(menu.style.left).toBe('744px')
        expect(menu.style.top).toBe('68px')
    })

    it('stays out of the space that the page keeps for a scroll bar', () => {
        // With scrollbar-gutter, the root element is 24 less wide than the window here.
        Object.defineProperty(document.documentElement, 'offsetWidth', {
            configurable: true,
            value: 1000,
        })
        setSizes(new DOMRect(800, 20, 44, 44))

        try {
            createMenu({ menu, onSelect }).toggle(buttonA)
        } finally {
            Reflect.deleteProperty(document.documentElement, 'offsetWidth')
        }

        // The menu would end at 1000 with the left edges in line, so the right edges are.
        expect(menu.style.left).toBe('644px')
    })

    it('opens above the button when the menu does not fit below', () => {
        setSizes(new DOMRect(10, 700, 44, 44))

        createMenu({ menu, onSelect }).toggle(buttonA)

        // The top of the button is at 700, and the menu is 150 high.
        expect(menu.style.top).toBe('546px')
    })

    it('keeps a menu on screen that fits in no place', () => {
        setSizes(new DOMRect(500, 300, 44, 44), { width: 2000, height: 2000 })

        createMenu({ menu, onSelect }).toggle(buttonA)

        expect(menu.style.left).toBe('4px')
        expect(menu.style.top).toBe('4px')
    })

    it('measures the menu after it is open, because a closed popover has no size', () => {
        const order: string[] = []
        menu.addEventListener('beforetoggle', () => order.push('open'))
        vi.spyOn(buttonA, 'getBoundingClientRect').mockImplementation(() => {
            order.push('measure')
            return new DOMRect(10, 20, 44, 44)
        })

        createMenu({ menu, onSelect }).toggle(buttonA)

        expect(order).toEqual(['open', 'measure'])
    })

    it('closes the menu on a second toggle for the same button', () => {
        const control = createMenu({ menu, onSelect })

        control.toggle(buttonA)
        control.toggle(buttonA)

        expect(isOpen()).toBe(false)
        expect(buttonA.getAttribute('aria-expanded')).toBe('false')
    })

    it('moves the open menu to a different button', () => {
        const control = createMenu({ menu, onSelect })

        control.toggle(buttonA)
        control.toggle(buttonB)

        expect(isOpen()).toBe(true)
        expect(buttonA.getAttribute('aria-expanded')).toBe('false')
        expect(buttonB.getAttribute('aria-expanded')).toBe('true')
        expect(control.anchor).toBe(buttonB)
    })

    it('follows a close that the browser does', () => {
        const control = createMenu({ menu, onSelect })
        control.toggle(buttonA)

        // Escape or a press outside.
        menu.hidePopover()
        expect(buttonA.getAttribute('aria-expanded')).toBe('false')

        control.toggle(buttonA)
        expect(isOpen()).toBe(true)
    })

    it('closes when the page scrolls, and not when the menu itself scrolls', () => {
        const control = createMenu({ menu, onSelect })
        control.toggle(buttonA)

        menu.dispatchEvent(new Event('scroll'))
        expect(isOpen()).toBe(true)

        document.dispatchEvent(new Event('scroll'))
        expect(isOpen()).toBe(false)
        expect(buttonA.getAttribute('aria-expanded')).toBe('false')
    })

    it('does not listen for a scroll while the menu is closed', () => {
        const add = vi.spyOn(window, 'addEventListener')
        const remove = vi.spyOn(window, 'removeEventListener')
        const control = createMenu({ menu, onSelect })
        expect(add).not.toHaveBeenCalled()

        control.toggle(buttonA)
        expect(add).toHaveBeenCalledTimes(1)
        control.toggle(buttonA)

        expect(remove).toHaveBeenCalledTimes(1)
        expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1])
        add.mockRestore()
        remove.mockRestore()
    })

    it('runs onOpen before the menu shows', () => {
        const onOpen = vi.fn(() => expect(isOpen()).toBe(false))

        createMenu({ menu, onSelect, onOpen }).toggle(buttonA)

        expect(onOpen).toHaveBeenCalledWith(buttonA)
    })

    it('closes the menu, then reports the chosen item with the button', () => {
        const control = createMenu({
            menu,
            onSelect: (chosen, anchor) => {
                expect(isOpen()).toBe(false)
                onSelect(chosen, anchor)
            },
        })
        control.toggle(buttonB)

        item('details').click()

        expect(onSelect).toHaveBeenCalledWith(item('details'), buttonB)
        expect(buttonB.getAttribute('aria-expanded')).toBe('false')
    })

    it('reports the item for a click on a child of the item', () => {
        item('open').innerHTML = '<svg class="icon"></svg>Open'
        createMenu({ menu, onSelect }).toggle(buttonA)

        item('open')
            .querySelector('svg')!
            .dispatchEvent(new Event('click', { bubbles: true }))

        expect(onSelect).toHaveBeenCalledWith(item('open'), buttonA)
    })

    it('ignores a click on the menu that is not on an item', () => {
        createMenu({ menu, onSelect }).toggle(buttonA)

        menu.querySelector('hr')!.dispatchEvent(new Event('click', { bubbles: true }))

        expect(onSelect).not.toHaveBeenCalled()
        expect(isOpen()).toBe(true)
    })

    it('puts the focus on the first item, or on the checked item', () => {
        const control = createMenu({ menu, onSelect })

        control.toggle(buttonA)
        expect(document.activeElement).toBe(item('open'))
        control.close()

        item('details').setAttribute('aria-checked', 'true')
        control.toggle(buttonA)
        expect(document.activeElement).toBe(item('details'))
    })

    it('moves the focus with the arrow keys and skips hidden and disabled items', () => {
        createMenu({ menu, onSelect }).toggle(buttonA)

        expect(key('ArrowDown').defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(item('details'))
        key('ArrowDown')
        expect(document.activeElement).toBe(item('remove'))
        key('ArrowDown')
        expect(document.activeElement).toBe(item('open'))
        key('ArrowUp')
        expect(document.activeElement).toBe(item('remove'))
        key('Home')
        expect(document.activeElement).toBe(item('open'))
        key('End')
        expect(document.activeElement).toBe(item('remove'))
    })

    it('leaves other keys to the browser', () => {
        createMenu({ menu, onSelect }).toggle(buttonA)

        expect(key('Escape').defaultPrevented).toBe(false)
        expect(key('a').defaultPrevented).toBe(false)
    })
})

describe('a press outside the open menu', () => {
    let link: HTMLAnchorElement
    let onLink: ReturnType<typeof vi.fn<(event: Event) => void>>

    /** The events of one press with a pointer. The browser closes the menu before the click. */
    function press(target: Element, { closes = true } = {}): MouseEvent {
        target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        if (closes) menu.hidePopover()
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
        target.dispatchEvent(click)
        return click
    }

    beforeEach(() => {
        link = document.createElement('a')
        link.href = '#/book/1'
        document.body.append(link)
        onLink = vi.fn<(event: Event) => void>()
        link.addEventListener('click', onLink)
    })

    it('does not activate the element below the pointer', () => {
        createMenu({ menu, onSelect }).toggle(buttonA)

        const click = press(link)

        expect(isOpen()).toBe(false)
        expect(onLink).not.toHaveBeenCalled()
        expect(click.defaultPrevented).toBe(true)
    })

    it('stops only that one click', () => {
        createMenu({ menu, onSelect }).toggle(buttonA)
        press(link)

        const click = press(link, { closes: false })

        expect(onLink).toHaveBeenCalledTimes(1)
        expect(click.defaultPrevented).toBe(false)
    })

    it('leaves a click alone while the menu is closed', () => {
        createMenu({ menu, onSelect })

        press(link, { closes: false })

        expect(onLink).toHaveBeenCalledTimes(1)
    })

    it('leaves a press on a button that opens a menu alone', () => {
        const control = createMenu({ menu, onSelect })
        control.toggle(buttonA)
        const onButton = vi.fn<(event: Event) => void>()
        buttonB.addEventListener('click', onButton)

        // The browser does not close the menu for a press on such a button.
        const click = press(buttonB, { closes: false })

        expect(onButton).toHaveBeenCalledTimes(1)
        expect(click.defaultPrevented).toBe(false)
    })

    it('leaves a press on an item of the menu alone', () => {
        createMenu({ menu, onSelect }).toggle(buttonA)

        press(item('details'), { closes: false })

        expect(onSelect).toHaveBeenCalledWith(item('details'), buttonA)
    })

    it('leaves a click from the keyboard alone after a press that gave no click', () => {
        createMenu({ menu, onSelect }).toggle(buttonA)
        // A touch that scrolls the page: the press has no click.
        link.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        menu.hidePopover()

        link.click()

        expect(onLink).toHaveBeenCalledTimes(1)
    })
})

// Safari 16 and Firefox 115 have no Popover API. No menu opened there.
describe('in a browser with no Popover API', () => {
    let control: Menu
    let link: HTMLAnchorElement

    const shows = () => !menu.hidden && menu.classList.contains('is-open')

    beforeEach(() => {
        // A menu that a test before left open still listens on the window. A scroll closes it
        // while the page has the methods of the Popover API.
        document.dispatchEvent(new Event('scroll'))
        const prototype = HTMLElement.prototype as Partial<HTMLElement>
        delete prototype.showPopover
        delete prototype.hidePopover
        // Such a browser does not know the attribute. jsdom knows it, and gives no focus to
        // an element in a popover.
        menu.removeAttribute('popover')
        link = document.createElement('a')
        link.href = '#/book/1'
        document.body.append(link)
        control = createMenu({ menu, onSelect })
    })

    afterEach(() => {
        control.close()
        installOverlayMethods()
    })

    it('hides the closed menu, so its items are not in the order of the Tab key', () => {
        expect(menu.hidden).toBe(true)
        expect(shows()).toBe(false)
    })

    it('opens the menu with a class, at the button, with the focus on the first item', () => {
        vi.spyOn(buttonA, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 44, 44))

        control.toggle(buttonA)

        expect(shows()).toBe(true)
        expect(buttonA.getAttribute('aria-expanded')).toBe('true')
        expect(menu.style.left).toBe('10px')
        expect(menu.style.top).toBe('68px')
        expect(document.activeElement).toBe(item('open'))
    })

    it('closes on a second toggle and gives the focus back to the button', () => {
        control.toggle(buttonA)
        control.toggle(buttonA)

        expect(shows()).toBe(false)
        expect(menu.hidden).toBe(true)
        expect(buttonA.getAttribute('aria-expanded')).toBe('false')
        expect(document.activeElement).toBe(buttonA)
    })

    it('moves the open menu to a different button', () => {
        control.toggle(buttonA)
        control.toggle(buttonB)

        expect(shows()).toBe(true)
        expect(buttonA.getAttribute('aria-expanded')).toBe('false')
        expect(buttonB.getAttribute('aria-expanded')).toBe('true')
    })

    it('closes the menu, then reports the chosen item', () => {
        control.toggle(buttonB)

        item('details').click()

        expect(shows()).toBe(false)
        expect(onSelect).toHaveBeenCalledWith(item('details'), buttonB)
    })

    it('closes on a press outside, and that press does not activate the element below', () => {
        const onLink = vi.fn<(event: Event) => void>()
        link.addEventListener('click', onLink)
        control.toggle(buttonA)

        // As a popover, the menu is open until the end of the press. The reader screen keeps
        // the press from the page while its menu is open.
        const seenByPage: boolean[] = []
        link.addEventListener('pointerdown', () => seenByPage.push(shows()), { once: true })
        link.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        expect(seenByPage).toEqual([true])

        link.dispatchEvent(new Event('pointerup', { bubbles: true }))
        expect(shows()).toBe(false)
        expect(buttonA.getAttribute('aria-expanded')).toBe('false')

        const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
        link.dispatchEvent(click)
        expect(onLink).not.toHaveBeenCalled()
        expect(click.defaultPrevented).toBe(true)
    })

    it('stays open for a press on an item and for a press on its button', () => {
        control.toggle(buttonA)

        item('details').dispatchEvent(new Event('pointerdown', { bubbles: true }))
        item('details').dispatchEvent(new Event('pointerup', { bubbles: true }))
        expect(shows()).toBe(true)
        // The click of the button closes the menu with toggle().
        buttonA.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        buttonA.dispatchEvent(new Event('pointerup', { bubbles: true }))
        expect(shows()).toBe(true)
    })

    it('closes on Escape, and the key does no more', () => {
        control.toggle(buttonA)

        const event = key('Escape')

        expect(shows()).toBe(false)
        expect(event.defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(buttonA)
        // The listener is there only while the menu is open.
        expect(key('Escape').defaultPrevented).toBe(false)
    })

    it('closes when the page scrolls', () => {
        control.toggle(buttonA)

        document.dispatchEvent(new Event('scroll'))

        expect(shows()).toBe(false)
    })

    it('closes the open menu when a different menu opens', () => {
        const other = menu.cloneNode(true) as HTMLElement
        other.id = 'other-menu'
        document.body.append(other)
        const otherControl = createMenu({ menu: other, onSelect })
        control.toggle(buttonA)

        otherControl.toggle(buttonB)

        expect(shows()).toBe(false)
        expect(buttonA.getAttribute('aria-expanded')).toBe('false')
        expect(other.classList.contains('is-open')).toBe(true)
        otherControl.close()
    })

    // The reader screen listens for this event of its menu.
    it('sends the event of the Popover API before each change', () => {
        const states: unknown[] = []
        menu.addEventListener('beforetoggle', (event) => {
            states.push((event as ToggleEvent).newState)
        })

        control.toggle(buttonA)
        control.toggle(buttonA)

        expect(states).toEqual(['open', 'closed'])
    })

    // The component rule keeps a menu with the popover attribute at opacity 0.
    it('has a rule that shows the menu for the class', () => {
        const css = readFileSync(join(import.meta.dirname, 'shell.css'), 'utf8').replace(
            /\s+/g,
            ' ',
        )

        expect(css).toContain(
            '.menu.is-open { opacity: 1; pointer-events: auto; transform: none; }',
        )
    })
})
