import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMenu } from './menu'
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
