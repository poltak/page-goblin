/**
 * Behaviour of a `.menu` popover: position at its button, keyboard, and the choice of an item.
 *
 * Give each button that opens the menu the `popovertarget` attribute with the id of the menu.
 * The browser then does not close the open menu on a press of that button, so `toggle` gets
 * the correct state. The click handler of the button must call `preventDefault()`, because
 * this script opens the menu and sets its position.
 *
 * A press outside the open menu only closes it. The click of that press does not reach the
 * page, except on a button that has `popovertarget`.
 */

/** Space between the menu and its button, and between the menu and the screen edge. */
const GAP = 4

export interface MenuOptions {
    menu: HTMLElement
    /** The user chose an item. The menu is closed at this time. */
    onSelect(item: HTMLElement, anchor: HTMLElement): void
    /** Runs before the menu opens. Set the state of the items here. */
    onOpen?(anchor: HTMLElement): void
}

export interface Menu {
    /** The button that the menu is open for, or the last one. */
    readonly anchor: HTMLElement | null
    /** Opens the menu at the button. Closes it when it is open for this button. */
    toggle(anchor: HTMLElement): void
    close(): void
}

// The browser closes an open menu for a press outside it, and then sends the click of that
// press to the element below the pointer. In the library that element is a book, so the
// press that closes the menu would also open a book. The menus share this state and its two
// listeners, because only one menu is open at a time.
let openMenu: HTMLElement | null = null
let pressedOutside = false
let watchesPresses = false

function watchPresses(): void {
    if (watchesPresses) return
    watchesPresses = true
    document.addEventListener(
        'pointerdown',
        ({ target }) => {
            // A button that opens a menu keeps its action. The browser does not close the
            // menu for a press on its own button, and a different button opens its menu.
            pressedOutside =
                openMenu !== null &&
                target instanceof Element &&
                !openMenu.contains(target) &&
                target.closest('[popovertarget]') === null
        },
        true,
    )
    document.addEventListener(
        'click',
        (event) => {
            if (!pressedOutside) return
            pressedOutside = false
            // A click from the keyboard has no press before it. The press was a different one.
            if (event.detail === 0) return
            event.preventDefault()
            event.stopPropagation()
        },
        true,
    )
}

function items(menu: HTMLElement): HTMLElement[] {
    return Array.from(menu.querySelectorAll<HTMLElement>('.menu-item')).filter(
        (item) => !item.hidden && !(item as HTMLButtonElement).disabled,
    )
}

export function createMenu({ menu, onSelect, onOpen }: MenuOptions): Menu {
    let anchor: HTMLElement | null = null
    let open = false
    watchPresses()

    // The menu is open and has its size at this time. The reads come before the writes, so
    // one open costs one layout. The browser paints the menu only after this function.
    function place(target: HTMLElement): void {
        const box = target.getBoundingClientRect()
        const width = menu.offsetWidth
        const height = menu.offsetHeight
        // The width of the root element is the width that a fixed element can use. It does
        // not include a classic scroll bar, and also not the space that scrollbar-gutter
        // keeps for one, which clientWidth includes. innerHeight follows the address bar of a
        // phone browser, as the fixed position of the menu does.
        const viewWidth = document.documentElement.offsetWidth || window.innerWidth
        const viewHeight = window.innerHeight

        // Below the button with the left edges in line. When that does not fit: the right
        // edges in line, and above the button.
        let left = box.left
        if (left + width > viewWidth - GAP) left = box.right - width
        let top = box.bottom + GAP
        if (top + height > viewHeight - GAP && box.top - GAP - height >= GAP) {
            top = box.top - GAP - height
        }

        // A menu that fits in no place stays on screen.
        left = Math.max(GAP, Math.min(left, viewWidth - width - GAP))
        top = Math.max(GAP, Math.min(top, viewHeight - height - GAP))
        menu.style.left = `${Math.round(left)}px`
        menu.style.top = `${Math.round(top)}px`
    }

    function close(): void {
        if (open) menu.hidePopover?.()
    }

    // The menu has a fixed position. When the page scrolls, the button moves away from it.
    // A scroll of a long menu itself is not a reason to close.
    const onScroll = (event: Event): void => {
        if (event.target instanceof Node && menu.contains(event.target)) return
        close()
    }

    // This event comes before each change of the menu, also when the browser closes the menu
    // (Escape, or a press outside). It comes at once, not in a later task.
    menu.addEventListener('beforetoggle', (event) => {
        open = (event as ToggleEvent).newState === 'open'
        if (open) openMenu = menu
        else if (openMenu === menu) openMenu = null
        anchor?.setAttribute('aria-expanded', String(open))
        if (open) window.addEventListener('scroll', onScroll, { capture: true, passive: true })
        else window.removeEventListener('scroll', onScroll, { capture: true })
    })

    menu.addEventListener('click', (event) => {
        const item = (event.target as Element).closest<HTMLElement>('.menu-item')
        const opener = anchor
        if (!item || !opener) return
        // Close first. The focus goes back to the button, and a dialog that the item opens
        // then gives the focus back to that button too.
        close()
        onSelect(item, opener)
    })

    menu.addEventListener('keydown', (event) => {
        const { key } = event
        if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
        const list = items(menu)
        if (list.length === 0) return
        event.preventDefault()
        const current = list.indexOf(document.activeElement as HTMLElement)
        let next = 0
        if (key === 'End') next = list.length - 1
        else if (key === 'ArrowDown') next = (current + 1) % list.length
        else if (key === 'ArrowUp') next = current <= 0 ? list.length - 1 : current - 1
        list[next].focus()
    })

    return {
        get anchor() {
            return anchor
        },
        toggle(target) {
            const wasOpenHere = open && anchor === target
            close()
            if (wasOpenHere) return

            anchor = target
            onOpen?.(target)
            menu.showPopover?.()
            place(target)

            const list = items(menu)
            const first = list.find((item) => item.getAttribute('aria-checked') === 'true')
            ;(first ?? list[0])?.focus({ preventScroll: true })
        },
        close,
    }
}
