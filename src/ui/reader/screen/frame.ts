/**
 * The elements of the reader screen, and the two states that show before a book is on
 * screen: the loading state and the message for a book that did not open.
 */

import './screen.css'
import { qs } from '../../dom'
import markup from './screen.html?raw'

export interface ScreenFrame {
    root: HTMLElement
    /** Gets the focus and shows the bars. It is the way to the bars for the keyboard. */
    showBars: HTMLButtonElement
    /** The two buttons that turn the page for a screen reader, which sends no pointer events. */
    prevPage: HTMLButtonElement
    nextPage: HTMLButtonElement
    topBar: HTMLElement
    bottomBar: HTMLElement
    bookTitle: HTMLElement
    bookAuthor: HTMLElement
    bookmarkButton: HTMLButtonElement
    moreButton: HTMLButtonElement
    moreMenu: HTMLElement
    fullscreenItem: HTMLButtonElement
    headText: HTMLElement
    /** The reader view fills this element. */
    stage: HTMLElement
    /** The place for the listen bar, between the page and the running foot. */
    dock: HTMLElement
    footPage: HTMLElement
    footProgress: HTMLElement
    /** Shows and hides the text of the running foot. It lies over the right half of the foot. */
    footToggle: HTMLButtonElement
    backButton: HTMLButtonElement
    slider: HTMLInputElement
    /** The label above the thumb during a drag: the contents entry, then the percent. */
    sliderLabel: HTMLElement
    sliderLabelTitle: HTMLElement
    sliderLabelPercent: HTMLElement
    percent: HTMLElement
    /** The layer that the parts of the screen put their elements in. */
    overlay: HTMLElement
    showLoading(): void
    /** Shows the message for a book that did not open, with a button back to the library. */
    showOpenError(onExit: () => void): void
    clearStatus(): void
}

const LOADING_MARKUP = `
<div class="reader-opening" role="status">
    <span class="spinner spinner-lg" aria-hidden="true"></span>
    <span class="visually-hidden">Opening the book</span>
</div>`

const OPEN_ERROR_MARKUP = `
<div class="empty-state" role="alert">
    <svg class="icon" aria-hidden="true"><use href="#i-info" /></svg>
    <h2 class="empty-state-title">This book did not open.</h2>
    <button class="btn btn-primary" type="button">Back to the library</button>
</div>`

let template: HTMLTemplateElement | undefined

function parse(html: string): HTMLTemplateElement {
    const element = document.createElement('template')
    element.innerHTML = html.trim()
    return element
}

export function createFrame(): ScreenFrame {
    template ??= parse(markup)
    const root = document.importNode(template.content.firstElementChild!, true) as HTMLElement
    const status = qs('.reader-status', root)

    function setStatus(html: string): HTMLElement {
        status.replaceChildren(parse(html).content)
        status.hidden = false
        return status
    }

    return {
        root,
        showBars: qs('.reader-show-bars', root),
        prevPage: qs('.reader-page-prev', root),
        nextPage: qs('.reader-page-next', root),
        topBar: qs('.reader-bar-top', root),
        bottomBar: qs('.reader-bar-bottom', root),
        bookTitle: qs('.reader-book-title', root),
        bookAuthor: qs('.reader-book-author', root),
        bookmarkButton: qs('[data-screen-action="bookmark"]', root),
        moreButton: qs('[data-screen-action="more"]', root),
        moreMenu: qs('.menu', root),
        fullscreenItem: qs('[data-screen-action="fullscreen"]', root),
        headText: qs('.reader-head-text', root),
        stage: qs('.reader-stage', root),
        dock: qs('.reader-dock', root),
        footPage: qs('.reader-foot-page', root),
        footProgress: qs('.reader-foot-progress', root),
        footToggle: qs('.reader-foot-toggle', root),
        backButton: qs('.reader-back', root),
        slider: qs('.reader-slider .slider', root),
        sliderLabel: qs('.reader-slider-label', root),
        sliderLabelTitle: qs('.reader-slider-label-title', root),
        sliderLabelPercent: qs('.reader-slider-label-percent', root),
        percent: qs('.reader-percent', root),
        overlay: qs('.reader-overlay', root),
        showLoading() {
            setStatus(LOADING_MARKUP)
        },
        showOpenError(onExit) {
            const button = qs<HTMLButtonElement>('button', setStatus(OPEN_ERROR_MARKUP))
            button.addEventListener('click', onExit)
            // The bars are not there, so this button is the only control of the screen.
            button.focus({ preventScroll: true })
        },
        clearStatus() {
            status.hidden = true
            status.replaceChildren()
        },
    }
}
