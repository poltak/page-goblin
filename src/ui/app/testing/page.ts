/** Test helpers: the markup of index.html, and the dialog and popover methods that jsdom lacks. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let markup: string | undefined

/** The content of the body element of index.html, without its script elements. */
export function pageMarkup(): string {
    if (markup === undefined) {
        const html = readFileSync(join(import.meta.dirname, '../../../../index.html'), 'utf8')
        const body = /<body>([\s\S]*)<\/body>/.exec(html)
        if (!body) throw new Error('index.html has no body element')
        markup = body[1].replace(/<script[\s\S]*?<\/script>/g, '')
    }
    return markup
}

/** Replaces the body of the test document with the body of index.html. */
export function mountPage(): void {
    document.body.innerHTML = pageMarkup()
}

type DialogMethods = Pick<HTMLDialogElement, 'showModal' | 'close'>
type PopoverMethods = Pick<HTMLElement, 'showPopover' | 'hidePopover'>

function toggleEvent(type: string, newState: 'open' | 'closed'): Event {
    return Object.assign(new Event(type), { newState })
}

/**
 * Gives dialogs and popovers the methods of a browser. A dialog sends its close event at
 * once, not in a later task. An open popover has the attribute `data-open` and loses its
 * `popover` attribute for that time, because jsdom gives no focus to an element in a popover.
 */
export function installOverlayMethods(): void {
    const dialog = HTMLDialogElement.prototype as DialogMethods
    dialog.showModal = function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
    }
    dialog.close = function (this: HTMLDialogElement, value?: string) {
        if (!this.hasAttribute('open')) return
        this.removeAttribute('open')
        if (value !== undefined) this.returnValue = value
        this.dispatchEvent(new Event('close'))
    }

    const element = HTMLElement.prototype as PopoverMethods
    element.showPopover = function (this: HTMLElement) {
        if ('open' in this.dataset) return
        this.dispatchEvent(toggleEvent('beforetoggle', 'open'))
        this.dataset.open = ''
        this.removeAttribute('popover')
    }
    element.hidePopover = function (this: HTMLElement) {
        if (!('open' in this.dataset)) return
        this.dispatchEvent(toggleEvent('beforetoggle', 'closed'))
        delete this.dataset.open
        this.setAttribute('popover', '')
    }
}

/** Lets the promises that are ready now run, and the tasks that they start. */
export async function settle(rounds = 5): Promise<void> {
    for (let round = 0; round < rounds; round++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
}
