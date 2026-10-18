/**
 * Shows the note of a note reference link next to the link, so the reader stays on the page.
 * On a narrow screen the note is in a small sheet at the bottom.
 *
 * The note is safe DOM from the content module. It goes into a shadow root as an element, so
 * the stylesheets of the book apply to the note and not to the app.
 */

import './note-popover.css'
import { SCALE_PROPERTY } from '$lib/content/css'
import { INTERNAL_LINK_FRAGMENT_ATTR, INTERNAL_LINK_PATH_ATTR } from '$lib/content/types'
import { resolveFontStack } from '$lib/fonts'
import type { LinkTarget } from '$lib/reader/types'
import { settings } from '$lib/settings/store'
import { resolveTheme, systemPrefersDark } from '$lib/settings/theme'
import { showToast } from '../../app/toast'
import { on, qs } from '../../dom'
import type { Part, PartOptions } from '../parts'
import {
    watchScreenArea,
    focusedElement,
    isFloatOpen,
    moveFloat,
    setFloatOpen,
    startedIn,
} from './floating'
import { isGhostClick } from './ghost-click'
import { getNoteBaseSheet } from './note-style'
import { placeFloating, roomAround } from './place'
import type { Box, Side } from './place'
import { onPositionChange } from './position-change'
import { iconMarkup, templateOf } from './template'

type NoteTarget = Extract<LinkTarget, { kind: 'internal' }>

interface LoadedNote {
    element: HTMLElement
    styles: readonly CSSStyleSheet[]
}

/** Below this viewport width the note is a sheet at the bottom of the screen. */
export const NOTE_SHEET_BELOW = 600

/** The card is never made lower than this, also when the link has less room on each side. */
const CARD_MIN_HEIGHT = 120

const INTERNAL_LINK = `a[${INTERNAL_LINK_PATH_ATTR}]`

const createCard = templateOf(`
<div class="float note-pop" role="dialog" aria-label="Note">
    <div class="float-surface note-card">
        <div class="note-head">
            <span class="note-title">Note</span>
            <button type="button" class="icon-btn icon-btn-sm" data-action="close" aria-label="Close">
                ${iconMarkup('x')}
            </button>
        </div>
        <div class="note-body" tabindex="0"></div>
        <div class="note-foot">
            <button type="button" class="btn btn-quiet btn-sm" data-action="go">Go to note</button>
        </div>
    </div>
</div>`)

/** True when the press is on a link in the book text. The view then sends its own event. */
function isOnBookLink(event: Event): boolean {
    return event
        .composedPath()
        .some((target) => target instanceof Element && target.matches(INTERNAL_LINK))
}

/** With the publisher styles off, the reader view also ignores the style attributes. */
function removeInlineStyles(element: HTMLElement): void {
    element.removeAttribute('style')
    for (const styled of element.querySelectorAll('[style]')) styled.removeAttribute('style')
}

export function createNotePopover({ session, host }: PartOptions): Part {
    const card = createCard()
    const surface = qs('.note-card', card)
    const body = qs('.note-body', card)
    const shadow = body.attachShadow({ mode: 'open' })
    // As for a chapter frame: a positioned box of the book stays inside the note.
    body.style.contain = 'layout paint'
    host.append(card)

    /** The link that the open note belongs to. */
    let shown: NoteTarget | null = null
    /** Counts the taps, so the result of an old load is not shown. */
    let request = 0
    let returnFocus: Element | null = null
    let openedAt = 0
    /** True when the last press on the page started in the card. */
    let pressedInside = false
    let destroyed = false

    /** The tap on the link opened the note. Its click must not press a button or a link. */
    const isOpeningClick = (event: MouseEvent): boolean =>
        isGhostClick(event, { openedAt, pressedInside })

    const area = watchScreenArea(host, () => {
        // The link moved. A sheet does not depend on the place of the link.
        const keep = card.dataset.layout === 'sheet' && window.innerWidth < NOTE_SHEET_BELOW
        if (!keep) close()
    })

    /**
     * Closes the note and gives the focus back. With `leavesPage`, the reader goes to a
     * different page: the focus then does not go back to a link of the book, because the view
     * shows the page of a link that gets the focus.
     */
    function close({ leavesPage = false } = {}): void {
        if (!shown) return
        shown = null
        const back = returnFocus
        returnFocus = null
        setFloatOpen(card, false)
        if (!card.contains(document.activeElement)) return
        const inBook = back !== null && back.getRootNode() !== document
        if (back instanceof HTMLElement && back.isConnected && !(leavesPage && inBook)) {
            back.focus({ preventScroll: true })
        } else {
            const focused = focusedElement()
            if (focused instanceof HTMLElement) focused.blur()
        }
    }

    function follow(target: NoteTarget): void {
        session.followLink(target).catch(() => {
            showToast({ message: 'The link could not be opened.', tone: 'error' })
        })
    }

    /** Puts the card next to the link: below it when it has room there, else above. */
    function placeCard(anchor: Box): void {
        const { viewport, safe } = area.get()
        const room = roomAround({ anchor, viewport, safe })
        // The reads come before the writes: one layout for each open.
        const width = card.offsetWidth
        let height = card.offsetHeight
        let side: Side = 'below'
        if (height > room.below && (height <= room.above || room.above > room.below)) {
            side = 'above'
        }
        if (height > room[side]) {
            height = Math.max(room[side], CARD_MIN_HEIGHT)
            surface.style.maxHeight = `${height}px`
        }
        moveFloat(
            card,
            placeFloating({ anchor, size: { width, height }, viewport, safe, prefer: side }),
        )
    }

    function applyReaderSettings(note: LoadedNote): void {
        const { publisherStyles, fontSize, lineHeight, fontId, theme, darkTheme } = settings.get()
        if (!publisherStyles) removeInlineStyles(note.element)
        shadow.adoptedStyleSheets = publisherStyles
            ? [getNoteBaseSheet(), ...note.styles]
            : [getNoteBaseSheet()]

        const font = resolveFontStack({
            fontId,
            bookFonts: session.content.bookFonts,
            userFonts: session.fonts.list,
        })
        const resolved = resolveTheme({ theme, darkTheme, systemDark: systemPrefersDark() })
        body.style.setProperty('--note-size', `${fontSize}px`)
        // Book stylesheets multiply their absolute sizes by this value, as in the reader view.
        body.style.setProperty(SCALE_PROPERTY, String(fontSize / 16))
        body.style.setProperty('--note-font', font ?? '')
        body.style.setProperty('--note-leading', lineHeight === null ? '' : String(lineHeight))
        body.toggleAttribute('data-font', font !== null)
        body.toggleAttribute('data-leading', lineHeight !== null)
        body.toggleAttribute('data-dark', resolved === 'dark' || resolved === 'black')
    }

    function show(target: NoteTarget, note: LoadedNote): void {
        applyReaderSettings(note)
        // Book selectors start at rd-html and rd-body, as in the reader view.
        const root = document.createElement('rd-html')
        const page = document.createElement('rd-body')
        page.append(note.element)
        root.append(page)
        shadow.replaceChildren(root)

        const layout = area.get().viewport.width < NOTE_SHEET_BELOW ? 'sheet' : 'card'
        if (card.dataset.layout !== layout) {
            // The browser must apply the closed look of the new layout with no transition.
            // If not, the sheet does not slide in from the bottom at its first open.
            surface.style.transition = 'none'
            card.dataset.layout = layout
            void surface.offsetHeight
            surface.style.transition = ''
        }
        surface.style.maxHeight = ''
        body.scrollTop = 0
        if (layout === 'sheet') card.style.transform = ''
        else placeCard(target.bounds)

        shown = target
        openedAt = Date.now()
        returnFocus = focusedElement()
        setFloatOpen(card, true)
        // With the focus on the note, the arrow keys scroll it.
        body.focus({ preventScroll: true })
    }

    async function open(target: NoteTarget): Promise<void> {
        const id = ++request
        close()
        let note: LoadedNote | null = null
        try {
            note = await session.loadNote({
                spineIndex: target.spineIndex,
                fragment: target.fragment,
            })
        } catch {
            // The link is then followed, and the view reports a chapter that does not load.
        }
        // A newer tap or a page turn came during the load.
        if (destroyed || id !== request) return
        if (note) show(target, note)
        else follow({ ...target, noteref: false })
    }

    /** A click or the Enter key on a link inside the note. */
    function onNoteLink(event: Event): void {
        if (event instanceof MouseEvent && isOpeningClick(event)) {
            // Also for a link to a web address, which the browser opens itself.
            event.preventDefault()
            return
        }
        if (event instanceof KeyboardEvent && event.key !== 'Enter') return
        const link = event.target instanceof Element ? event.target.closest(INTERNAL_LINK) : null
        if (!link) return
        event.preventDefault()
        const path = link.getAttribute(INTERNAL_LINK_PATH_ATTR) ?? ''
        const target: NoteTarget = {
            kind: 'internal',
            path,
            fragment: link.getAttribute(INTERNAL_LINK_FRAGMENT_ATTR) || null,
            spineIndex: session.book.spineIndexOf(path),
            noteref: false,
            bounds: link.getBoundingClientRect(),
        }
        close({ leavesPage: true })
        follow(target)
    }

    /** An image of the note loaded and changed the height of the card. */
    function onNoteMedia(): void {
        if (!shown || card.dataset.layout !== 'card') return
        surface.style.maxHeight = ''
        placeCard(shown.bounds)
    }

    /** The page turned or the mode changed. A note that loads now is not shown. */
    function cancel(): void {
        request++
        close({ leavesPage: true })
    }

    const stops = [
        session.on('note-tap', ({ target }) => void open(target)),
        session.on('mode', cancel),
        onPositionChange(session, cancel),

        on(card, 'click', (event) => {
            const button = (event.target as Element).closest<HTMLElement>('[data-action]')
            const target = shown
            if (!button || !target || isOpeningClick(event)) return
            if (button.dataset.action === 'close') {
                close()
            } else if (button.dataset.action === 'go') {
                close({ leavesPage: true })
                // Not a note reference now, so the session goes to the note. The Back
                // button of the reader then returns to this page.
                follow({ ...target, noteref: false })
            }
        }),
        on(shadow, 'click', onNoteLink),
        on(shadow, 'keydown', onNoteLink),
        // A key in the note must not also turn the page.
        on(card, 'keydown', (event) => event.stopPropagation()),
        // The load event does not bubble.
        on(shadow, 'load', onNoteMedia, true),

        on(
            document,
            'pointerdown',
            (event) => {
                pressedInside = startedIn(event, card)
                if (!shown || pressedInside) return
                close()
                // The press only closes the note. It must not also turn the page. A press on
                // a link goes on to the view, so a second note opens with one tap.
                if (!isOnBookLink(event)) event.stopPropagation()
            },
            true,
        ),
        on(
            document,
            'keydown',
            (event) => {
                if (event.key !== 'Escape' || !isFloatOpen(card)) return
                close()
                // The key closed the note. It must not also close a panel or the book.
                event.stopPropagation()
            },
            true,
        ),
    ]

    return {
        destroy() {
            if (destroyed) return
            destroyed = true
            request++
            shown = null
            returnFocus = null
            for (const stop of stops) stop()
            area.destroy()
            shadow.adoptedStyleSheets = []
            shadow.replaceChildren()
            card.remove()
        },
    }
}
