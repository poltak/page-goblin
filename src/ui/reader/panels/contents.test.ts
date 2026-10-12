import { afterEach, describe, expect, it, vi } from 'vitest'
import { settle } from '../../app/testing/page'
import { clearToasts } from '../../app/toast'
import type { ContentsPanel, ContentsTab } from '../parts'
import type { TocEntry } from '../types'
import { createContentsPanel } from './contents'
import { fileNameStem } from './contents-highlights'
import { TOC_LONG_LIST, TOC_ROWS_PER_STEP } from './contents-toc'
import {
    createFakeSession,
    focusOpener,
    HOSTILE,
    makeBookmark,
    makeHighlight,
    mountHost,
    TOC,
} from './testing/fake-session'
import type { FakeSession, FakeSessionOptions } from './testing/fake-session'

const mocks = vi.hoisted(() => ({
    highlightsToMarkdown: vi.fn(() => '# Markdown'),
    highlightsToKindleClippings: vi.fn(() => 'Clippings'),
    downloadTextFile: vi.fn(),
    copyText: vi.fn(async () => true),
}))

vi.mock('$lib/annotations', () => mocks)

let host: HTMLElement
let session: FakeSession
let panel: ContentsPanel | null = null

function mount(options: FakeSessionOptions = {}): ContentsPanel {
    host = mountHost()
    session = createFakeSession(options)
    panel = createContentsPanel({ session, host })
    return panel
}

const sheet = () => host.querySelector<HTMLDialogElement>('.contents-panel')!
const noteDialog = () => host.querySelector<HTMLDialogElement>('.contents-note-dialog')!
const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    sheet().querySelector<T>(selector)!
const tab = (name: ContentsTab) => q<HTMLButtonElement>(`[data-tab="${name}"]`)
const pane = (name: ContentsTab) => q(`[data-pane="${name}"]`)
const rows = (name: ContentsTab) =>
    Array.from(pane(name).querySelectorAll<HTMLElement>('.list > li'))
const rowButtons = (name: ContentsTab) =>
    rows(name).map((row) => row.querySelector<HTMLElement>('.list-row')!)
const emptyText = (name: ContentsTab) =>
    pane(name).querySelector<HTMLElement>('.empty-state')!.textContent!.replace(/\s+/g, ' ').trim()
const isEmptyShown = (name: ContentsTab) =>
    !pane(name).querySelector<HTMLElement>('.empty-state')!.hidden
const notice = () => sheet().querySelector<HTMLElement>('.panel-notice .toast')
const appToast = () => document.querySelector<HTMLElement>('#toasts .toast')
const rowMenu = () => q('#contents-highlight-menu')
const exportMenu = () => q('#contents-export-menu')
const isOpen = (menu: HTMLElement) => 'open' in menu.dataset

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
}

/** Opens the menu of a highlight row and returns the item or swatch that matches. */
function openRowMenu(index: number): void {
    rows('highlights')[index].querySelector<HTMLElement>('[data-menu]')!.click()
}

function menuItem(action: string): HTMLElement {
    return rowMenu().querySelector<HTMLElement>(`[data-action="${action}"]`)!
}

afterEach(() => {
    panel?.destroy()
    panel = null
    clearToasts()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const mock of Object.values(mocks)) mock.mockClear()
    mocks.copyText.mockImplementation(async () => true)
})

describe('the contents panel', () => {
    it('is a closed sheet in the overlay layer until it opens', () => {
        const contents = mount()

        expect(sheet().parentElement).toBe(host)
        expect(sheet().classList.contains('sheet')).toBe(true)
        expect(sheet().open).toBe(false)

        contents.open()
        expect(sheet().open).toBe(true)

        contents.close()
        expect(sheet().open).toBe(false)
    })

    it('shows the title of the book as text', () => {
        mount({ record: { title: HOSTILE } }).open()

        expect(q('.sheet-title').textContent).toBe(HOSTILE)
        expect(sheet().querySelector('img')).toBeNull()
        expect(sheet().getAttribute('aria-labelledby')).toBe(q('.sheet-title').id)
    })

    it('gives the focus back to the control that opened it', () => {
        const contents = mount()
        const opener = focusOpener()
        // The panel puts the focus on its tab only for a user of the keyboard.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))

        contents.open()
        expect(document.activeElement).toBe(tab('contents'))

        contents.close()
        expect(document.activeElement).toBe(opener)
    })

    it('does not put the focus on a tab after a press, so a touch screen shows no focus ring', () => {
        const contents = mount()
        window.dispatchEvent(new Event('pointerdown'))

        contents.open()

        expect(document.activeElement).not.toBe(tab('contents'))
    })

    it('closes with its close button', () => {
        mount().open()
        q('[data-close]').click()

        expect(sheet().open).toBe(false)
    })
})

describe('the tabs', () => {
    it('shows Contents first, with one pane on screen', () => {
        mount().open()

        expect(q('.tabs').getAttribute('role')).toBe('tablist')
        expect(tab('contents').getAttribute('aria-selected')).toBe('true')
        expect(tab('bookmarks').getAttribute('aria-selected')).toBe('false')
        expect(pane('contents').hidden).toBe(false)
        expect(pane('bookmarks').hidden).toBe(true)
        expect(pane('highlights').hidden).toBe(true)
        expect(pane('contents').getAttribute('aria-labelledby')).toBe(tab('contents').id)
        expect(tab('contents').getAttribute('aria-controls')).toBe(pane('contents').id)
    })

    it('selects the tab that open() names', () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
        mount().open('highlights')

        expect(tab('highlights').getAttribute('aria-selected')).toBe('true')
        expect(pane('highlights').hidden).toBe(false)
        expect(pane('contents').hidden).toBe(true)
        expect(document.activeElement).toBe(tab('highlights'))
    })

    it('opens at the tab that was open last', () => {
        const contents = mount()
        contents.open()
        tab('bookmarks').click()
        contents.close()

        contents.open()
        expect(tab('bookmarks').getAttribute('aria-selected')).toBe('true')

        contents.close()
        contents.open('contents')
        contents.close()
        contents.open()
        expect(tab('contents').getAttribute('aria-selected')).toBe('true')
    })

    it('changes the pane on a click', () => {
        mount({ bookmarks: [makeBookmark()] }).open()
        q('.sheet-body').scrollTop = 300

        tab('bookmarks').click()

        expect(pane('bookmarks').hidden).toBe(false)
        expect(pane('contents').hidden).toBe(true)
        expect(rows('bookmarks')).toHaveLength(1)
        expect(q('.sheet-body').scrollTop).toBe(0)
    })

    it('moves between the tabs with the arrow keys, Home and End', () => {
        mount().open()

        expect(press(tab('contents'), 'ArrowRight').defaultPrevented).toBe(true)
        expect(tab('bookmarks').getAttribute('aria-selected')).toBe('true')
        expect(document.activeElement).toBe(tab('bookmarks'))

        press(tab('bookmarks'), 'ArrowRight')
        press(tab('highlights'), 'ArrowRight')
        expect(document.activeElement).toBe(tab('contents'))

        press(tab('contents'), 'ArrowLeft')
        expect(document.activeElement).toBe(tab('highlights'))
        expect(pane('highlights').hidden).toBe(false)

        press(tab('highlights'), 'Home')
        expect(document.activeElement).toBe(tab('contents'))
        press(tab('contents'), 'End')
        expect(document.activeElement).toBe(tab('highlights'))

        expect(press(tab('highlights'), 'a').defaultPrevented).toBe(false)
    })

    it('makes only the selected tab a stop of the Tab key', () => {
        mount().open('bookmarks')

        expect(tab('bookmarks').tabIndex).toBe(0)
        expect(tab('contents').tabIndex).toBe(-1)
        expect(tab('highlights').tabIndex).toBe(-1)
    })
})

describe('the Contents tab', () => {
    it('lists the entries with their indent and the percent where each starts', () => {
        mount().open()

        const buttons = rowButtons('contents')
        expect(buttons.map((row) => row.querySelector('.list-row-title')!.textContent)).toEqual(
            TOC.map((entry) => entry.title),
        )
        expect(buttons.map((row) => row.style.getPropertyValue('--level'))).toEqual([
            '',
            '1',
            '1',
            '2',
            '',
        ])
        expect(buttons.map((row) => row.querySelector('.list-row-trail')!.textContent)).toEqual([
            '10%',
            '10%',
            '20%',
            '20%',
            '50%',
        ])
    })

    it('puts a title into the page as text, and gives an empty title a name', () => {
        const toc: TocEntry[] = [
            { title: HOSTILE, depth: 0, spineIndex: 0, fragment: null },
            { title: '  ', depth: 0, spineIndex: 1, fragment: null },
            { title: 'Deep', depth: 9, spineIndex: 2, fragment: null },
        ]
        mount({ toc }).open()

        const buttons = rowButtons('contents')
        expect(buttons[0].querySelector('.list-row-title')!.textContent).toBe(HOSTILE)
        expect(pane('contents').querySelector('img')).toBeNull()
        expect(buttons[1].querySelector('.list-row-title')!.textContent).toBe('Untitled')
        // The indent has a limit, so a deep entry keeps room for its title.
        expect(buttons[2].style.getPropertyValue('--level')).toBe('5')
    })

    it('marks the entry of the current position and scrolls it to the centre', () => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: Element,
        ) {
            if (this.matches('.sheet-body')) return { top: 100, height: 400 } as DOMRect
            if (this.matches('[aria-current]')) return { top: 900, height: 40 } as DOMRect
            return { top: 0, height: 0 } as DOMRect
        })
        const contents = mount({ currentTocEntry: TOC[2] })
        contents.open()

        const buttons = rowButtons('contents')
        expect(buttons.map((row) => row.getAttribute('aria-current'))).toEqual([
            null,
            null,
            'true',
            null,
            null,
        ])
        expect(q('.sheet-body').scrollTop).toBe(800 - 180)
    })

    it('marks the new entry at the next open', () => {
        const contents = mount({ currentTocEntry: TOC[0] })
        contents.open()
        contents.close()
        // The session can give an equal entry that is a different object.
        session.setCurrentTocEntry({ ...TOC[3] })

        contents.open()

        expect(rowButtons('contents').map((row) => row.hasAttribute('aria-current'))).toEqual([
            false,
            false,
            false,
            true,
            false,
        ])
    })

    it('marks the new entry when the position changes while the tab is on screen', () => {
        const contents = mount({ currentTocEntry: TOC[0] })
        contents.open()
        session.setCurrentTocEntry(TOC[1])
        session.emit('relocate', {} as never)

        expect(rowButtons('contents')[1].getAttribute('aria-current')).toBe('true')
        expect(rowButtons('contents')[0].hasAttribute('aria-current')).toBe(false)

        session.setCurrentTocEntry(null)
        session.emit('relocate', {} as never)
        expect(pane('contents').querySelector('[aria-current]')).toBeNull()
    })

    it('goes to an entry and closes on a click', () => {
        mount().open()

        rowButtons('contents')[3].querySelector<HTMLElement>('.list-row-title')!.click()

        expect(session.goToTocEntry).toHaveBeenCalledTimes(1)
        expect(session.goToTocEntry).toHaveBeenCalledWith(TOC[3])
        expect(sheet().open).toBe(false)
    })

    it('does not fail when the jump rejects', async () => {
        mount().open()
        session.goToTocEntry.mockRejectedValueOnce(new Error('no chapter'))

        rowButtons('contents')[0].click()
        await settle()

        expect(sheet().open).toBe(false)
    })

    it('shows a message for a book with no contents list', () => {
        mount({ toc: [] }).open()

        expect(isEmptyShown('contents')).toBe(true)
        expect(emptyText('contents')).toContain('This book has no table of contents.')
        expect(pane('contents').querySelector<HTMLElement>('.list')!.hidden).toBe(true)
    })

    it('makes the rows one time', () => {
        const contents = mount()
        contents.open()
        const first = rowButtons('contents')[0]
        contents.close()
        contents.open()
        tab('bookmarks').click()
        tab('contents').click()

        expect(rowButtons('contents')).toHaveLength(TOC.length)
        expect(rowButtons('contents')[0]).toBe(first)
    })

    describe('with a long list', () => {
        const count = TOC_LONG_LIST + 600
        const longToc: TocEntry[] = Array.from({ length: count }, (_, index) => ({
            title: `Entry ${index + 1}`,
            depth: 0,
            spineIndex: index,
            fragment: null,
        }))
        let idle: (() => void)[]

        function stubIdle(): void {
            idle = []
            vi.stubGlobal('requestIdleCallback', (work: () => void) => idle.push(work))
            vi.stubGlobal('cancelIdleCallback', (handle: number) => {
                idle[handle - 1] = () => {}
            })
        }

        function runIdle(): void {
            const work = idle
            idle = []
            for (const run of work) run()
        }

        it('makes the first rows at once and the rest in idle time', () => {
            stubIdle()
            mount({ toc: longToc }).open()

            expect(rowButtons('contents')).toHaveLength(TOC_ROWS_PER_STEP)
            expect(pane('contents').querySelector('.list')!.classList.contains('list-long')).toBe(
                true,
            )

            runIdle()
            expect(rowButtons('contents')).toHaveLength(TOC_ROWS_PER_STEP * 2)

            while (idle.length > 0) runIdle()
            const buttons = rowButtons('contents')
            expect(buttons).toHaveLength(count)
            expect(buttons[count - 1].querySelector('.list-row-title')!.textContent).toBe(
                `Entry ${count}`,
            )

            buttons[count - 1].click()
            expect(session.goToTocEntry).toHaveBeenCalledWith(longToc[count - 1])
        })

        it('makes the row of the current position in the first step', () => {
            stubIdle()
            mount({ toc: longToc, currentTocEntry: longToc[700] }).open()

            const buttons = rowButtons('contents')
            expect(buttons.length).toBeGreaterThan(700)
            expect(buttons.length).toBeLessThan(count)
            expect(buttons[700].getAttribute('aria-current')).toBe('true')
        })

        it('marks a current entry that a later step makes', () => {
            stubIdle()
            const contents = mount({ toc: longToc })
            contents.open()
            session.setCurrentTocEntry(longToc[count - 1])

            while (idle.length > 0) runIdle()

            expect(rowButtons('contents')[count - 1].getAttribute('aria-current')).toBe('true')
        })

        it('stops the work when the panel is destroyed', () => {
            stubIdle()
            const contents = mount({ toc: longToc })
            contents.open()
            contents.destroy()
            panel = null

            runIdle()

            expect(idle).toHaveLength(0)
        })

        it('makes a list of the limit size in one step, with no skipped rendering', () => {
            stubIdle()
            mount({ toc: longToc.slice(0, TOC_LONG_LIST) }).open()

            expect(rowButtons('contents')).toHaveLength(TOC_LONG_LIST)
            expect(idle).toHaveLength(0)
            expect(pane('contents').querySelector('.list')!.classList.contains('list-long')).toBe(
                false,
            )
        })
    })
})

describe('the Bookmarks tab', () => {
    const first = makeBookmark({ id: 'm1', chapterTitle: 'The Shadow', fraction: 0.414 })
    const second = makeBookmark({
        id: 'm2',
        locator: { spineIndex: 4, offset: 7 },
        chapterTitle: HOSTILE,
        excerpt: HOSTILE,
        fraction: 0.8,
    })

    it('shows the empty state with no bookmarks', () => {
        mount().open('bookmarks')

        expect(isEmptyShown('bookmarks')).toBe(true)
        expect(emptyText('bookmarks')).toBe(
            'No bookmarks yet Use the bookmark button in the top bar to mark a page.',
        )
        expect(rows('bookmarks')).toHaveLength(0)
    })

    it('lists the chapter title, the excerpt and the percent of each bookmark', () => {
        mount({ bookmarks: [first, second] }).open('bookmarks')

        const [one, two] = rows('bookmarks')
        expect(isEmptyShown('bookmarks')).toBe(false)
        expect(one.querySelector('.list-row-title')!.textContent).toBe('The Shadow')
        expect(one.querySelector('.list-row-meta')!.textContent).toBe(first.excerpt)
        expect(one.querySelector('.list-row-trail')!.textContent).toBe('41%')
        expect(one.querySelector('[data-remove]')!.getAttribute('aria-label')).toBe(
            'Remove bookmark',
        )

        expect(two.querySelector('.list-row-title')!.textContent).toBe(HOSTILE)
        expect(two.querySelector('.list-row-meta')!.textContent).toBe(HOSTILE)
        expect(pane('bookmarks').querySelector('img')).toBeNull()
    })

    it('uses the excerpt as the title when the bookmark has no chapter title', () => {
        mount({
            bookmarks: [
                makeBookmark({ id: 'a', chapterTitle: '', excerpt: 'First words' }),
                makeBookmark({ id: 'b', chapterTitle: '', excerpt: '' }),
            ],
        }).open('bookmarks')

        const [one, two] = rows('bookmarks')
        expect(one.querySelector('.list-row-title')!.textContent).toBe('First words')
        expect(one.querySelector<HTMLElement>('.list-row-meta')!.hidden).toBe(true)
        expect(two.querySelector('.list-row-title')!.textContent).toBe('Bookmark')
    })

    it('goes to the bookmark with a place on the back stack, and closes', () => {
        mount({ bookmarks: [first, second] }).open('bookmarks')

        rowButtons('bookmarks')[1].click()

        expect(session.goTo).toHaveBeenCalledTimes(1)
        expect(session.goTo).toHaveBeenCalledWith(second.locator, { remember: true })
        expect(sheet().open).toBe(false)
    })

    it('removes a bookmark and stays open', async () => {
        mount({ bookmarks: [first, second] }).open('bookmarks')

        rows('bookmarks')[0]
            .querySelector<HTMLElement>('[data-remove] .icon')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await settle()

        expect(session.removeBookmark).toHaveBeenCalledWith('m1')
        expect(session.goTo).not.toHaveBeenCalled()
        expect(sheet().open).toBe(true)
        expect(rows('bookmarks')).toHaveLength(1)
        expect(rows('bookmarks')[0].querySelector('.list-row-title')!.textContent).toBe(HOSTILE)
    })

    it('keeps the focus in the list after a removal, and shows the empty state at the end', async () => {
        mount({ bookmarks: [first, second] }).open('bookmarks')
        const removeButtons = () =>
            rows('bookmarks').map((row) => row.querySelector<HTMLElement>('[data-remove]')!)

        removeButtons()[0].focus()
        removeButtons()[0].click()
        await settle()
        expect(document.activeElement).toBe(removeButtons()[0])

        removeButtons()[0].click()
        await settle()
        expect(isEmptyShown('bookmarks')).toBe(true)
        expect(document.activeElement).toBe(tab('bookmarks'))
    })

    it('shows a message when the removal fails', async () => {
        mount({ bookmarks: [first] }).open('bookmarks')
        session.removeBookmark.mockRejectedValueOnce(new Error('storage'))

        rows('bookmarks')[0].querySelector<HTMLElement>('[data-remove]')!.click()
        await settle()

        expect(rows('bookmarks')).toHaveLength(1)
        expect(notice()?.textContent).toBe('The bookmark was not removed.')
        expect(notice()?.classList.contains('toast-error')).toBe(true)
    })

    it('follows the bookmarks event while it is on screen', () => {
        mount().open('bookmarks')

        session.setBookmarks([first])
        expect(rows('bookmarks')).toHaveLength(1)
        expect(isEmptyShown('bookmarks')).toBe(false)

        session.setBookmarks([])
        expect(rows('bookmarks')).toHaveLength(0)
        expect(isEmptyShown('bookmarks')).toBe(true)
    })

    it('shows a change that came while the panel was closed or on a different tab', () => {
        const contents = mount()
        session.setBookmarks([first])
        contents.open()
        expect(rows('bookmarks')).toHaveLength(0)

        tab('bookmarks').click()
        expect(rows('bookmarks')).toHaveLength(1)

        contents.close()
        session.setBookmarks([first, second])
        contents.open()
        expect(rows('bookmarks')).toHaveLength(2)
    })
})

describe('the Highlights tab', () => {
    const plain = makeHighlight({ id: 'h1' })
    const noted = makeHighlight({
        id: 'h2',
        spineIndex: 4,
        start: 10,
        end: 30,
        text: HOSTILE,
        color: 'blue',
        note: HOSTILE,
        chapterTitle: HOSTILE,
    })

    it('shows the empty state and no export with no highlights', () => {
        mount().open('highlights')

        expect(isEmptyShown('highlights')).toBe(true)
        expect(emptyText('highlights')).toBe(
            'No highlights yet Select text in the book to add one.',
        )
        expect(q('.contents-actions').hidden).toBe(true)
    })

    it('lists the colour, the text, the note and the chapter title', () => {
        mount({ highlights: [plain, noted] }).open('highlights')

        const [one, two] = rows('highlights')
        expect(isEmptyShown('highlights')).toBe(false)
        expect(q('.contents-actions').hidden).toBe(false)

        expect(one.querySelector<HTMLElement>('.contents-dot')!.dataset.color).toBe('yellow')
        expect(one.querySelector('.contents-dot')!.getAttribute('aria-label')).toBe('Yellow')
        expect(one.querySelector('.contents-highlight-text')!.textContent).toBe(plain.text)
        expect(one.querySelector<HTMLElement>('.contents-note')!.hidden).toBe(true)
        expect(one.querySelector('.contents-chapter')!.textContent).toBe('The School for Wizards')

        expect(two.querySelector<HTMLElement>('.contents-dot')!.dataset.color).toBe('blue')
        expect(two.querySelector('.contents-highlight-text')!.textContent).toBe(HOSTILE)
        expect(two.querySelector<HTMLElement>('.contents-note')!.hidden).toBe(false)
        expect(two.querySelector('.contents-note')!.textContent).toBe(HOSTILE)
        expect(two.querySelector('.contents-chapter')!.textContent).toBe(HOSTILE)
        expect(pane('highlights').querySelector('img')).toBeNull()
    })

    it('goes to the start of the highlight with a place on the back stack, and closes', () => {
        mount({ highlights: [plain, noted] }).open('highlights')

        rowButtons('highlights')[1].click()

        expect(session.goTo).toHaveBeenCalledWith({ spineIndex: 4, offset: 10 }, { remember: true })
        expect(sheet().open).toBe(false)
    })

    it('follows the highlights event, and writes only the row that changed', () => {
        mount({ highlights: [plain, noted] }).open('highlights')
        const [one, two] = rows('highlights')

        session.setHighlights([plain, { ...noted, color: 'pink' }])

        expect(rows('highlights')).toEqual([one, two])
        expect(two.querySelector<HTMLElement>('.contents-dot')!.dataset.color).toBe('pink')
        expect(two.querySelector('.contents-dot')!.getAttribute('aria-label')).toBe('Pink')
    })

    describe('the menu of a row', () => {
        it('opens at the button of the row and shows the state of that highlight', () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            const button = rows('highlights')[1].querySelector<HTMLElement>('[data-menu]')!
            expect(button.getAttribute('aria-label')).toBe('Highlight actions')
            expect(button.getAttribute('popovertarget')).toBe(rowMenu().id)

            const click = new MouseEvent('click', { bubbles: true, cancelable: true })
            button.dispatchEvent(click)

            expect(click.defaultPrevented).toBe(true)
            expect(isOpen(rowMenu())).toBe(true)
            expect(button.getAttribute('aria-expanded')).toBe('true')
            expect(sheet().open).toBe(true)
            expect(session.goTo).not.toHaveBeenCalled()
            expect(menuItem('note').textContent!.trim()).toBe('Edit note')
            const checked = Array.from(rowMenu().querySelectorAll<HTMLElement>('.swatch'))
                .filter((swatch) => swatch.getAttribute('aria-checked') === 'true')
                .map((swatch) => swatch.dataset.color)
            expect(checked).toEqual(['blue'])
        })

        it('names the note action for a highlight with no note', () => {
            mount({ highlights: [plain] }).open('highlights')
            openRowMenu(0)

            expect(menuItem('note').textContent!.trim()).toBe('Add note')
        })

        it('is inside the sheet, so it takes input while the sheet is modal', () => {
            mount().open('highlights')

            expect(sheet().contains(rowMenu())).toBe(true)
            expect(sheet().contains(exportMenu())).toBe(true)
        })

        // An open menu that the page does not show would take the next press on the page.
        it('closes when the sheet closes', () => {
            const contents = mount({ highlights: [plain] })
            contents.open('highlights')
            openRowMenu(0)
            const button = rows('highlights')[0].querySelector<HTMLElement>('[data-menu]')!

            contents.close()

            expect(isOpen(rowMenu())).toBe(false)
            expect(button.getAttribute('aria-expanded')).toBe('false')

            contents.open('highlights')
            q('[data-action="export"]').click()
            contents.close()
            expect(isOpen(exportMenu())).toBe(false)
        })

        it('has five colour buttons with names', () => {
            mount().open('highlights')
            const swatches = Array.from(rowMenu().querySelectorAll<HTMLElement>('.swatch'))

            expect(swatches.map((swatch) => swatch.dataset.color)).toEqual([
                'yellow',
                'green',
                'blue',
                'pink',
                'purple',
            ])
            expect(swatches.map((swatch) => swatch.getAttribute('aria-label'))).toEqual([
                'Yellow',
                'Green',
                'Blue',
                'Pink',
                'Purple',
            ])
        })

        it('changes the colour', async () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            openRowMenu(0)

            rowMenu().querySelector<HTMLElement>('[data-color="green"]')!.click()
            await settle()

            expect(isOpen(rowMenu())).toBe(false)
            expect(session.updateHighlight).toHaveBeenCalledTimes(1)
            expect(session.updateHighlight).toHaveBeenCalledWith('h1', { color: 'green' })
            expect(
                rows('highlights')[0].querySelector<HTMLElement>('.contents-dot')!.dataset.color,
            ).toBe('green')
        })

        it('does not write the colour that the highlight has already', async () => {
            mount({ highlights: [plain] }).open('highlights')
            openRowMenu(0)

            rowMenu().querySelector<HTMLElement>('[data-color="yellow"]')!.click()
            await settle()

            expect(isOpen(rowMenu())).toBe(false)
            expect(session.updateHighlight).not.toHaveBeenCalled()
        })

        it('shows a message when the colour change fails', async () => {
            mount({ highlights: [plain] }).open('highlights')
            session.updateHighlight.mockRejectedValueOnce(new Error('storage'))
            openRowMenu(0)

            rowMenu().querySelector<HTMLElement>('[data-color="pink"]')!.click()
            await settle()

            expect(notice()?.textContent).toBe('The colour was not changed.')
        })

        it('moves between the colour buttons with the left and right arrow keys', () => {
            mount({ highlights: [plain] }).open('highlights')
            openRowMenu(0)
            const swatches = Array.from(rowMenu().querySelectorAll<HTMLElement>('.swatch'))

            swatches[0].focus()
            expect(press(swatches[0], 'ArrowRight').defaultPrevented).toBe(true)
            expect(document.activeElement).toBe(swatches[1])

            press(swatches[1], 'ArrowLeft')
            press(swatches[0], 'ArrowLeft')
            expect(document.activeElement).toBe(swatches[4])
        })
    })

    describe('the note dialog', () => {
        const field = () => noteDialog().querySelector<HTMLTextAreaElement>('textarea')!
        const save = () => noteDialog().querySelector<HTMLElement>('[data-action="save-note"]')!
        const cancel = () => noteDialog().querySelector<HTMLElement>('[data-action="cancel-note"]')!
        const error = () => noteDialog().querySelector<HTMLElement>('.field-error')!

        function openNote(index: number): void {
            openRowMenu(index)
            menuItem('note').click()
        }

        it('opens with the note of the highlight as the value of the field', () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            openNote(1)

            expect(noteDialog().open).toBe(true)
            expect(noteDialog().classList.contains('modal')).toBe(true)
            expect(isOpen(rowMenu())).toBe(false)
            expect(noteDialog().querySelector('.modal-title')!.textContent).toBe('Edit note')
            expect(field().value).toBe(HOSTILE)
            expect(noteDialog().querySelector('img')).toBeNull()
            expect(document.activeElement).toBe(field())
        })

        it('has the title "Add note" for a highlight with no note', () => {
            mount({ highlights: [plain] }).open('highlights')
            openNote(0)

            expect(noteDialog().querySelector('.modal-title')!.textContent).toBe('Add note')
            expect(field().value).toBe('')
        })

        it('saves the note and closes', async () => {
            mount({ highlights: [plain] }).open('highlights')
            openNote(0)
            field().value = '  A thought about shadows  '

            save().click()
            await settle()

            expect(session.updateHighlight).toHaveBeenCalledWith('h1', {
                note: 'A thought about shadows',
            })
            expect(noteDialog().open).toBe(false)
            expect(sheet().open).toBe(true)
            const note = rows('highlights')[0].querySelector<HTMLElement>('.contents-note')!
            expect(note.textContent).toBe('A thought about shadows')
            expect(note.hidden).toBe(false)
        })

        it('gives the focus back to the menu button of the row', async () => {
            mount({ highlights: [plain] }).open('highlights')
            const button = rows('highlights')[0].querySelector<HTMLElement>('[data-menu]')!
            openNote(0)

            cancel().click()

            expect(document.activeElement).toBe(button)
        })

        it('saves with Ctrl and Enter, and not with Enter alone', async () => {
            mount({ highlights: [plain] }).open('highlights')
            openNote(0)
            field().value = 'Note'

            expect(press(field(), 'Enter').defaultPrevented).toBe(false)
            await settle()
            expect(session.updateHighlight).not.toHaveBeenCalled()

            expect(press(field(), 'Enter', { ctrlKey: true }).defaultPrevented).toBe(true)
            await settle()
            expect(session.updateHighlight).toHaveBeenCalledWith('h1', { note: 'Note' })
        })

        it('writes nothing on Cancel, and nothing when the note did not change', async () => {
            mount({ highlights: [noted] }).open('highlights')
            openNote(0)
            field().value = 'Something else'
            cancel().click()
            await settle()
            expect(noteDialog().open).toBe(false)

            openNote(0)
            expect(field().value).toBe(HOSTILE)
            save().click()
            await settle()

            expect(noteDialog().open).toBe(false)
            expect(session.updateHighlight).not.toHaveBeenCalled()
        })

        it('removes the note when the field is empty', async () => {
            mount({ highlights: [noted] }).open('highlights')
            openNote(0)
            field().value = '   '

            save().click()
            await settle()

            expect(session.updateHighlight).toHaveBeenCalledWith('h2', { note: '' })
            expect(rows('highlights')[0].querySelector<HTMLElement>('.contents-note')!.hidden).toBe(
                true,
            )
        })

        it('stays open with the text when the save fails', async () => {
            mount({ highlights: [plain] }).open('highlights')
            session.updateHighlight.mockRejectedValueOnce(new Error('storage'))
            openNote(0)
            field().value = 'Keep me'

            save().click()
            await settle()

            expect(noteDialog().open).toBe(true)
            expect(field().value).toBe('Keep me')
            expect(error().hidden).toBe(false)
            expect(error().textContent).toBe('The note was not saved. Try again.')

            save().click()
            await settle()
            expect(noteDialog().open).toBe(false)
            expect(session.updateHighlight).toHaveBeenCalledTimes(2)

            openNote(0)
            expect(error().hidden).toBe(true)
        })

        it('does not close for a press outside it', () => {
            mount().open('highlights')

            expect(noteDialog().getAttribute('closedby')).toBe('closerequest')
        })

        it('closes before the sheet when the panel closes, so the focus goes to the opener', () => {
            const contents = mount({ highlights: [plain] })
            const opener = focusOpener()
            contents.open('highlights')
            openNote(0)
            const closed: string[] = []
            noteDialog().addEventListener('close', () => closed.push('note'))
            sheet().addEventListener('close', () => closed.push('sheet'))

            contents.close()

            expect(noteDialog().open).toBe(false)
            expect(sheet().open).toBe(false)
            // A browser sends the close events in this order, and each one moves the focus.
            expect(closed).toEqual(['note', 'sheet'])
            expect(document.activeElement).toBe(opener)
        })

        it('keeps the note of a different highlight open when an old save ends', async () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            let endFirstSave!: () => void
            session.updateHighlight.mockImplementationOnce(
                () => new Promise<void>((resolve) => (endFirstSave = resolve)),
            )
            openNote(0)
            field().value = 'First'
            save().click()
            cancel().click()

            openNote(1)
            field().value = 'Second'
            endFirstSave()
            await settle()

            expect(noteDialog().open).toBe(true)
            expect(field().value).toBe('Second')

            // The second note saves, also when the first save is not complete.
            save().click()
            await settle()
            expect(session.updateHighlight).toHaveBeenLastCalledWith('h2', { note: 'Second' })
            expect(noteDialog().open).toBe(false)
        })

        it('saves a second note while the save of the first one runs', async () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            session.updateHighlight.mockImplementationOnce(() => new Promise<void>(() => {}))
            openNote(0)
            field().value = 'First'
            save().click()
            // A second press on Save for the same note sends nothing.
            save().click()
            cancel().click()

            openNote(1)
            field().value = 'Second'
            save().click()
            await settle()

            expect(session.updateHighlight).toHaveBeenCalledTimes(2)
            expect(session.updateHighlight).toHaveBeenLastCalledWith('h2', { note: 'Second' })
        })

        it('shows a message in the sheet when a save fails after the dialog closed', async () => {
            mount({ highlights: [plain] }).open('highlights')
            session.updateHighlight.mockRejectedValueOnce(new Error('storage'))
            openNote(0)
            field().value = 'Lost'
            save().click()
            cancel().click()
            await settle()

            expect(notice()!.textContent).toBe('The note was not saved.')

            openNote(0)
            expect(error().hidden).toBe(true)
        })
    })

    describe('remove', () => {
        const undoButton = () => notice()!.querySelector('button')!

        async function removeRow(index: number): Promise<void> {
            openRowMenu(index)
            menuItem('remove').click()
            await settle()
        }

        it('removes the highlight with no question and offers Undo in the sheet', async () => {
            mount({ highlights: [plain, noted] }).open('highlights')

            await removeRow(0)

            expect(session.removeHighlight).toHaveBeenCalledWith('h1')
            expect(sheet().open).toBe(true)
            expect(rows('highlights')).toHaveLength(1)
            expect(notice()!.querySelector('span')!.textContent).toBe('Highlight removed')
            expect(undoButton().textContent).toBe('Undo')
            expect(appToast()).toBeNull()
        })

        it('adds the highlight again on Undo', async () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            await removeRow(1)

            undoButton().click()
            await settle()

            expect(session.addHighlight).toHaveBeenCalledTimes(1)
            expect(session.addHighlight).toHaveBeenCalledWith({
                range: { spineIndex: 4, start: 10, end: 30 },
                text: HOSTILE,
                color: 'blue',
                note: HOSTILE,
            })
            expect(rows('highlights')).toHaveLength(2)
            expect(notice()).toBeNull()
        })

        it('sends no note for a highlight that had none', async () => {
            mount({ highlights: [plain] }).open('highlights')
            await removeRow(0)
            expect(isEmptyShown('highlights')).toBe(true)

            undoButton().click()
            await settle()

            expect(session.addHighlight).toHaveBeenCalledWith({
                range: { spineIndex: 3, start: 120, end: 160 },
                text: plain.text,
                color: 'yellow',
            })
            expect(isEmptyShown('highlights')).toBe(false)
        })

        it('covers each removal with one Undo while the message is on screen', async () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            await removeRow(0)
            await removeRow(0)

            expect(sheet().querySelectorAll('.panel-notice .toast')).toHaveLength(1)
            expect(notice()!.querySelector('span')!.textContent).toBe('2 highlights removed')

            undoButton().click()
            await settle()

            expect(session.addHighlight).toHaveBeenCalledTimes(2)
            expect(rows('highlights')).toHaveLength(2)
        })

        it('starts a new Undo after the message of the last one is gone', async () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            await removeRow(0)
            undoButton().click()
            await settle()
            session.addHighlight.mockClear()

            await removeRow(1)
            expect(notice()!.querySelector('span')!.textContent).toBe('Highlight removed')
            undoButton().click()
            await settle()

            expect(session.addHighlight).toHaveBeenCalledTimes(1)
            expect(session.addHighlight.mock.calls[0][0].range).toEqual({
                spineIndex: 4,
                start: 10,
                end: 30,
            })
        })

        it('keeps Undo as a toast of the app when the sheet closes', async () => {
            const contents = mount({ highlights: [plain] })
            contents.open('highlights')
            await removeRow(0)

            contents.close()

            expect(notice()).toBeNull()
            expect(appToast()!.textContent).toContain('Highlight removed')
            appToast()!.querySelector('button')!.click()
            await settle()
            expect(session.addHighlight).toHaveBeenCalledTimes(1)
        })

        // The app shows no second toast with the text of the toast that is on screen. A new
        // removal with its own Undo would thus lose its Undo when the sheet closes again.
        it('covers a removal with the Undo of the last one while that toast can be on screen', async () => {
            const contents = mount({ highlights: [plain, noted] })
            contents.open('highlights')
            await removeRow(0)
            contents.close()
            const firstToast = appToast()!
            expect(firstToast.textContent).toContain('Highlight removed')

            contents.open('highlights')
            await removeRow(0)

            expect(notice()!.querySelector('span')!.textContent).toBe('2 highlights removed')
            undoButton().click()
            await settle()
            expect(session.addHighlight).toHaveBeenCalledTimes(2)
            expect(rows('highlights')).toHaveLength(2)

            // The Undo of the first toast has nothing more to add.
            firstToast.querySelector('button')!.click()
            await settle()
            expect(session.addHighlight).toHaveBeenCalledTimes(2)
        })

        it('starts a new Undo when the toast of the last removal is gone', async () => {
            const contents = mount({ highlights: [plain, noted] })
            contents.open('highlights')
            await removeRow(0)
            contents.close()
            const now = Date.now()
            vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)

            contents.open('highlights')
            await removeRow(0)

            expect(notice()!.querySelector('span')!.textContent).toBe('Highlight removed')
            undoButton().click()
            await settle()
            expect(session.addHighlight).toHaveBeenCalledTimes(1)
            expect(session.addHighlight.mock.calls[0][0].text).toBe(noted.text)
        })

        it('shows no message for a removal that ends after the panel is destroyed', async () => {
            const contents = mount({ highlights: [plain] })
            contents.open('highlights')
            openRowMenu(0)
            menuItem('remove').click()

            contents.destroy()
            panel = null
            await settle()

            expect(session.removeHighlight).toHaveBeenCalledWith('h1')
            expect(appToast()).toBeNull()
        })

        it('moves the focus to the next row', async () => {
            mount({ highlights: [plain, noted] }).open('highlights')
            const button = rows('highlights')[0].querySelector<HTMLElement>('[data-menu]')!
            // A browser gives the focus back to the button when the menu closes. The test
            // page does not.
            const hide = HTMLElement.prototype.hidePopover
            vi.spyOn(HTMLElement.prototype, 'hidePopover').mockImplementation(function (
                this: HTMLElement,
            ) {
                hide.call(this)
                button.focus()
            })

            await removeRow(0)

            expect(button.isConnected).toBe(false)
            expect(document.activeElement).toBe(rows('highlights')[0].querySelector('[data-menu]'))
        })

        it('shows a message and keeps the row when the removal fails', async () => {
            mount({ highlights: [plain] }).open('highlights')
            session.removeHighlight.mockRejectedValueOnce(new Error('storage'))

            await removeRow(0)

            expect(rows('highlights')).toHaveLength(1)
            expect(notice()!.textContent).toBe('The highlight was not removed.')
            expect(notice()!.querySelector('button')).toBeNull()
        })

        it('shows a message when Undo fails', async () => {
            mount({ highlights: [plain] }).open('highlights')
            await removeRow(0)
            session.addHighlight.mockRejectedValueOnce(new Error('storage'))

            undoButton().click()
            await settle()

            expect(notice()!.textContent).toBe('The highlight was not added again.')
        })
    })

    describe('export', () => {
        const exportButton = () => q('[data-action="export"]')
        const exportItem = (kind: string) =>
            exportMenu().querySelector<HTMLElement>(`[data-export="${kind}"]`)!

        async function runExport(kind: string): Promise<void> {
            exportButton().click()
            exportItem(kind).click()
            await settle()
        }

        it('opens a menu with the three choices', () => {
            mount({ highlights: [plain] }).open('highlights')
            const click = new MouseEvent('click', { bubbles: true, cancelable: true })
            exportButton().dispatchEvent(click)

            expect(click.defaultPrevented).toBe(true)
            expect(isOpen(exportMenu())).toBe(true)
            expect(exportButton().textContent!.trim()).toBe('Export')
            expect(
                Array.from(exportMenu().querySelectorAll('.menu-item'), (item) =>
                    item.textContent!.trim(),
                ),
            ).toEqual(['Markdown file', 'Kindle clippings file', 'Copy as Markdown'])
        })

        it('downloads a Markdown file with a safe name', async () => {
            const bookmark = makeBookmark()
            mount({
                highlights: [plain, noted],
                bookmarks: [bookmark],
                record: { title: 'Dune: <Messiah>? / Part 2' },
            }).open('highlights')

            await runExport('markdown')

            expect(mocks.highlightsToMarkdown).toHaveBeenCalledWith({
                book: session.record,
                highlights: [plain, noted],
                bookmarks: [bookmark],
            })
            expect(mocks.downloadTextFile).toHaveBeenCalledTimes(1)
            expect(mocks.downloadTextFile).toHaveBeenCalledWith({
                name: 'Dune-Messiah-Part-2-highlights.md',
                text: '# Markdown',
                type: 'text/markdown;charset=utf-8',
            })
            expect(sheet().open).toBe(true)
        })

        it('downloads a Kindle clippings file', async () => {
            mount({ highlights: [plain] }).open('highlights')

            await runExport('kindle')

            expect(mocks.highlightsToKindleClippings).toHaveBeenCalledWith(
                expect.objectContaining({ book: session.record, highlights: [plain] }),
            )
            expect(mocks.downloadTextFile).toHaveBeenCalledWith({
                name: 'A-Wizard-of-Earthsea-clippings.txt',
                text: 'Clippings',
                type: 'text/plain;charset=utf-8',
            })
        })

        it('copies the Markdown text and shows a message', async () => {
            mount({ highlights: [plain] }).open('highlights')

            await runExport('copy')

            expect(mocks.copyText).toHaveBeenCalledWith('# Markdown')
            expect(mocks.downloadTextFile).not.toHaveBeenCalled()
            expect(notice()!.textContent).toBe('Highlights copied')
        })

        it('shows an error when the browser refuses the copy', async () => {
            mocks.copyText.mockImplementation(async () => false)
            mount({ highlights: [plain] }).open('highlights')

            await runExport('copy')

            expect(notice()!.textContent).toBe('The highlights were not copied.')
            expect(notice()!.classList.contains('toast-error')).toBe(true)
        })

        it('starts the copy in the handler of the tap after the module is loaded', async () => {
            mount({ highlights: [plain] }).open('highlights')
            // The module starts to load when the menu opens.
            exportButton().click()
            await settle()

            exportItem('copy').click()

            expect(mocks.copyText).toHaveBeenCalledTimes(1)
        })

        it('shows a message when the export throws', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            mocks.downloadTextFile.mockImplementationOnce(() => {
                throw new Error('no download')
            })
            mount({ highlights: [plain] }).open('highlights')

            await runExport('markdown')

            expect(notice()!.textContent).toBe('The highlights were not exported.')
        })
    })
})

describe('fileNameStem', () => {
    it('keeps letters and digits and puts one hyphen for each run of other characters', () => {
        expect(fileNameStem('A Wizard of Earthsea')).toBe('A-Wizard-of-Earthsea')
        expect(fileNameStem('  Dune: Messiah (2nd ed.)  ')).toBe('Dune-Messiah-2nd-ed')
        expect(fileNameStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
        expect(fileNameStem('../../etc/passwd')).toBe('etc-passwd')
    })

    it('keeps letters of each script', () => {
        expect(fileNameStem('Les Misérables')).toBe('Les-Misérables')
        expect(fileNameStem('戦争と平和 1')).toBe('戦争と平和-1')
        expect(fileNameStem('Война и мир')).toBe('Война-и-мир')
    })

    it('gives a name for a title with no letters or digits', () => {
        expect(fileNameStem('')).toBe('book')
        expect(fileNameStem('?!...')).toBe('book')
    })

    it('has a length limit and no hyphen at the end', () => {
        const stem = fileNameStem(`${'word '.repeat(40)}`)

        expect(stem.length).toBeLessThanOrEqual(80)
        expect(stem.endsWith('-')).toBe(false)
        expect(/^[\p{L}\p{N}-]+$/u.test(stem)).toBe(true)
    })
})

describe('destroy', () => {
    it('removes the elements and the listeners', () => {
        const contents = mount({ highlights: [makeHighlight()] })
        contents.open('highlights')
        openRowMenu(0)
        const menu = rowMenu()

        contents.destroy()
        panel = null

        expect(host.children).toHaveLength(0)
        expect(isOpen(menu)).toBe(false)
        expect(session.listenerCount()).toBe(0)
        expect(() => session.setHighlights([])).not.toThrow()
    })

    it('does not move a message to the toasts of the app', async () => {
        const contents = mount({ highlights: [makeHighlight()] })
        contents.open('highlights')
        openRowMenu(0)
        menuItem('remove').click()
        await settle()
        expect(notice()).not.toBeNull()

        contents.destroy()
        panel = null

        expect(appToast()).toBeNull()
    })
})
