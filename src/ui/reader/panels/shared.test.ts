import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToasts, TOAST_ACTION_DURATION_MS, TOAST_DURATION_MS } from '../../app/toast'
import {
    centerInScroller,
    createKeyedList,
    createNotice,
    parseMarkup,
    percentText,
    renderKeepingFocus,
    rowFactory,
    whenIdle,
} from './shared'
import { mountHost } from './testing/fake-session'

afterEach(() => {
    clearToasts()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

// jsdom has no layout and does not apply nested CSS, so these tests read the source text.
// They do not show how a browser draws a panel. They keep a rule in its file when the reason
// for the rule is not visible in jsdom.
describe('the panel stylesheets', () => {
    function read(path: string): string {
        return readFileSync(join(import.meta.dirname, path), 'utf8').replace(
            /\/\*[\s\S]*?\*\//g,
            '',
        )
    }

    const tokens = read('../../../styles/tokens.css')
    const sheets = ['shared.css', 'contents.css', 'appearance.css', 'search.css'].map(read)
    const [, contents, appearance, search] = sheets

    /** The text from the selector to the end of the file, without white space runs. */
    function from(css: string, selector: string): string {
        const start = css.indexOf(`${selector} {`)
        if (start < 0) throw new Error(`No rule for ${selector}`)
        return css.slice(start).replace(/\s+/g, ' ')
    }

    // A custom property with a wrong name fails with no error in the browser.
    it('use only custom properties that are tokens', () => {
        const known = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]))
        for (const css of sheets) {
            const used = [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1])
            expect(used.filter((name) => !known.has(name))).toEqual([])
        }
    })

    it('take each colour from a token', () => {
        for (const css of sheets) {
            expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi)).toBeNull()
        }
    })

    // The two halves of the Auto swatch cover an inset shadow of the swatch.
    it('draw the edge of a theme swatch as a border', () => {
        const chip = from(appearance, '.appearance-chip').split('}')[0]

        expect(chip).toContain('border: 1px solid var(--border-strong);')
        expect(chip).toContain('overflow: hidden;')
        expect(chip).not.toContain('box-shadow')
    })

    // A bar in the flow of the status line moves the list when a search starts and ends.
    it('keep the search progress bar out of the flow', () => {
        const status = from(search, '.search-status')
        const bar = from(status, '& > .progress').split('}')[0]

        expect(status.split('{')[1]).toContain('position: relative;')
        expect(bar).toContain('position: absolute;')
    })

    // The keyboard of a phone covers the buttons of a dialog in the middle of the screen.
    it('put the note dialog near the top on a touch screen', () => {
        const touch = from(contents, '@media (pointer: coarse)')

        expect(touch).toMatch(/\.contents-note-dialog \{ margin-top: [^;]+; \}/)
    })
})

describe('percentText', () => {
    it('gives a whole percent', () => {
        expect(percentText(0)).toBe('0%')
        expect(percentText(0.414)).toBe('41%')
        expect(percentText(0.415)).toBe('42%')
        expect(percentText(1)).toBe('100%')
    })

    it('stays in the range for a value that is not a fraction', () => {
        expect(percentText(-0.2)).toBe('0%')
        expect(percentText(1.4)).toBe('100%')
        expect(percentText(Number.NaN)).toBe('0%')
    })
})

describe('rowFactory', () => {
    it('makes a new copy of the row template for each call', () => {
        const markup = parseMarkup('<template data-row="a"><li><b>x</b></li></template>')
        const make = rowFactory(markup, 'a')
        const first = make()
        const second = make()

        expect(first.outerHTML).toBe('<li><b>x</b></li>')
        expect(second).not.toBe(first)
        expect(first.ownerDocument).toBe(document)
    })

    it('throws for a template that is not there', () => {
        expect(() => rowFactory(parseMarkup('<p></p>'), 'a')).toThrow()
        expect(() => rowFactory(parseMarkup('<template data-row="a"></template>'), 'a')).toThrow()
    })
})

describe('whenIdle', () => {
    it('uses the idle callback of the browser', () => {
        const cancel = vi.fn()
        const request = vi.fn((_work: () => void, _options: { timeout: number }) => 7)
        vi.stubGlobal('requestIdleCallback', request)
        vi.stubGlobal('cancelIdleCallback', cancel)
        const work = vi.fn()

        const stop = whenIdle(work)
        expect(request).toHaveBeenCalledTimes(1)
        request.mock.calls[0][0]()
        expect(work).toHaveBeenCalledTimes(1)

        stop()
        expect(cancel).toHaveBeenCalledWith(7)
    })

    it('uses a timer in a browser with no idle callback', () => {
        vi.stubGlobal('requestIdleCallback', undefined)
        vi.useFakeTimers()
        const work = vi.fn()

        whenIdle(work)
        expect(work).not.toHaveBeenCalled()
        vi.advanceTimersByTime(20)
        expect(work).toHaveBeenCalledTimes(1)

        const stop = whenIdle(work)
        stop()
        vi.advanceTimersByTime(100)
        expect(work).toHaveBeenCalledTimes(1)
    })
})

describe('centerInScroller', () => {
    it('puts the row in the middle of the scroll area', () => {
        const scroller = document.createElement('div')
        const row = document.createElement('div')
        scroller.append(row)
        scroller.scrollTop = 100
        scroller.getBoundingClientRect = () => ({ top: 50, height: 400 }) as DOMRect
        row.getBoundingClientRect = () => ({ top: 650, height: 40 }) as DOMRect

        centerInScroller(scroller, row)

        // The row is 600 below the top of the area. Its centre must be 200 below it.
        expect(scroller.scrollTop).toBe(100 + 600 - 180)
    })
})

interface Item {
    id: string
    text: string
}

function makeList() {
    const list = document.createElement('ul')
    document.body.append(list)
    const create = vi.fn(() => {
        const row = document.createElement('li')
        row.append(document.createElement('button'), document.createElement('button'))
        return row
    })
    const fill = vi.fn((row: HTMLElement, item: Item) => {
        row.firstElementChild!.textContent = item.text
    })
    const keyed = createKeyedList<Item>({ list, key: (item) => item.id, create, fill })
    const texts = () => Array.from(list.children, (row) => row.firstElementChild!.textContent)
    return { list, create, fill, keyed, texts }
}

describe('createKeyedList', () => {
    beforeEach(() => {
        document.body.replaceChildren()
    })

    it('makes one row for each item, in the order of the items', () => {
        const { keyed, texts, list } = makeList()
        keyed.render([
            { id: 'a', text: 'A' },
            { id: 'b', text: 'B' },
        ])

        expect(texts()).toEqual(['A', 'B'])
        expect(keyed.itemOf(list.children[1].firstElementChild!)).toEqual({ id: 'b', text: 'B' })
        expect(keyed.itemOf(document.body)).toBeNull()
    })

    it('keeps the row of an item that did not change, and writes a row only for a new record', () => {
        const { keyed, list, create, fill } = makeList()
        const a = { id: 'a', text: 'A' }
        const b = { id: 'b', text: 'B' }
        keyed.render([a, b])
        const [rowA, rowB] = Array.from(list.children)
        create.mockClear()
        fill.mockClear()

        const changed = { id: 'b', text: 'B2' }
        keyed.render([a, changed])

        expect(create).not.toHaveBeenCalled()
        expect(fill).toHaveBeenCalledTimes(1)
        expect(fill).toHaveBeenCalledWith(rowB, changed)
        expect(Array.from(list.children)).toEqual([rowA, rowB])
        expect(keyed.itemOf(rowB)).toBe(changed)
    })

    it('removes the rows of removed items and puts new and moved rows in their place', () => {
        const { keyed, texts, list } = makeList()
        const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id.toUpperCase() }))
        keyed.render(items)
        const rowD = list.children[3]

        keyed.render([items[3], { id: 'x', text: 'X' }, items[0], items[2]])

        expect(texts()).toEqual(['D', 'X', 'A', 'C'])
        expect(list.children[0]).toBe(rowD)

        keyed.render([])
        expect(list.children).toHaveLength(0)
    })

    it('does not move a row that has the focus when a different row goes', () => {
        const { keyed, list } = makeList()
        const items = ['a', 'b', 'c'].map((id) => ({ id, text: id }))
        keyed.render(items)
        const button = list.children[2].querySelector('button')!
        button.focus()

        keyed.render([items[0], items[2]])

        expect(document.activeElement).toBe(button)
    })
})

describe('renderKeepingFocus', () => {
    beforeEach(() => {
        document.body.replaceChildren()
    })

    it('gives the focus to the same control of the row that took the place of a removed row', () => {
        const { keyed, list } = makeList()
        const items = ['a', 'b', 'c'].map((id) => ({ id, text: id }))
        const fallback = document.createElement('button')
        document.body.append(fallback)
        keyed.render(items)
        list.children[1].querySelectorAll('button')[1].focus()

        renderKeepingFocus({ list, render: () => keyed.render([items[0], items[2]]), fallback })

        expect(document.activeElement).toBe(list.children[1].querySelectorAll('button')[1])
    })

    it('uses the last row when the removed row was the last one', () => {
        const { keyed, list } = makeList()
        const items = ['a', 'b'].map((id) => ({ id, text: id }))
        const fallback = document.createElement('button')
        document.body.append(fallback)
        keyed.render(items)
        list.children[1].querySelector('button')!.focus()

        renderKeepingFocus({ list, render: () => keyed.render([items[0]]), fallback })

        expect(document.activeElement).toBe(list.children[0].querySelector('button'))
    })

    it('uses the fallback when the list is empty', () => {
        const { keyed, list } = makeList()
        const fallback = document.createElement('button')
        document.body.append(fallback)
        keyed.render([{ id: 'a', text: 'a' }])
        list.querySelector('button')!.focus()

        renderKeepingFocus({ list, render: () => keyed.render([]), fallback })

        expect(document.activeElement).toBe(fallback)
    })

    it('leaves the focus alone when it is not in the list', () => {
        const { keyed, list } = makeList()
        const fallback = document.createElement('button')
        const other = document.createElement('button')
        document.body.append(fallback, other)
        keyed.render([{ id: 'a', text: 'a' }])
        other.focus()

        renderKeepingFocus({ list, render: () => keyed.render([]), fallback })

        expect(document.activeElement).toBe(other)
    })
})

describe('createNotice', () => {
    let dialog: HTMLDialogElement

    beforeEach(() => {
        vi.useFakeTimers()
        const host = mountHost()
        dialog = document.createElement('dialog')
        host.append(dialog)
        dialog.showModal()
    })

    const inSheet = () => dialog.querySelector('.panel-notice .toast')
    const appToast = () => document.querySelector('#toasts .toast')

    it('shows a message in the open sheet and removes it after its time', () => {
        const notice = createNotice(dialog)
        const options = { message: 'Highlights copied' }
        notice.show(options)

        expect(inSheet()?.textContent).toBe('Highlights copied')
        expect(notice.current).toBe(options)
        expect(appToast()).toBeNull()

        vi.advanceTimersByTime(TOAST_DURATION_MS)
        expect(inSheet()).toBeNull()
        expect(notice.current).toBeNull()
    })

    it('puts the message into the page as text', () => {
        const notice = createNotice(dialog)
        notice.show({ message: '<img src=x>' })

        expect(inSheet()?.querySelector('img')).toBeNull()
        expect(inSheet()?.textContent).toBe('<img src=x>')
    })

    it('gives an error the error look', () => {
        const notice = createNotice(dialog)
        notice.show({ message: 'It failed.', tone: 'error' })

        expect(inSheet()?.classList.contains('toast-error')).toBe(true)
    })

    it('runs the action one time and removes the message', () => {
        const notice = createNotice(dialog)
        const onSelect = vi.fn()
        notice.show({ message: 'Highlight removed', action: { label: 'Undo', onSelect } })
        const button = inSheet()!.querySelector('button')!
        expect(button.textContent).toBe('Undo')

        // A message with an action stays for a longer time.
        vi.advanceTimersByTime(TOAST_DURATION_MS + 1)
        expect(inSheet()).not.toBeNull()

        button.click()
        button.click()
        expect(onSelect).toHaveBeenCalledTimes(1)
        expect(inSheet()).toBeNull()

        vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS)
        expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it('replaces the message that is on screen', () => {
        const notice = createNotice(dialog)
        notice.show({ message: 'One' })
        vi.advanceTimersByTime(TOAST_DURATION_MS - 1)
        notice.show({ message: 'Two' })

        expect(dialog.querySelectorAll('.toast')).toHaveLength(1)
        // The timer of the first message does not remove the second one.
        vi.advanceTimersByTime(TOAST_DURATION_MS - 1)
        expect(inSheet()?.textContent).toBe('Two')
    })

    it('moves a message that is on screen to the toasts of the app when the sheet closes', () => {
        const notice = createNotice(dialog)
        const onSelect = vi.fn()
        notice.show({ message: 'Highlight removed', action: { label: 'Undo', onSelect } })

        dialog.close()

        expect(inSheet()).toBeNull()
        expect(notice.current).toBeNull()
        expect(appToast()?.textContent).toContain('Highlight removed')
        appToast()!.querySelector('button')!.click()
        expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it('moves nothing when the message left before the close', () => {
        const notice = createNotice(dialog)
        notice.show({ message: 'One' })
        vi.advanceTimersByTime(TOAST_DURATION_MS)

        dialog.close()

        expect(appToast()).toBeNull()
    })

    it('uses the toasts of the app when the sheet is closed', () => {
        const notice = createNotice(dialog)
        dialog.close()
        notice.show({ message: 'The note was not saved.', tone: 'error' })

        expect(inSheet()).toBeNull()
        expect(appToast()?.textContent).toContain('The note was not saved.')
    })

    it('moves no message after destroy', () => {
        const notice = createNotice(dialog)
        notice.show({ message: 'One' })

        notice.destroy()
        dialog.close()

        expect(dialog.querySelector('.panel-notice')).toBeNull()
        expect(appToast()).toBeNull()
    })

    it('shows no message after destroy, in the sheet or as a toast of the app', () => {
        const notice = createNotice(dialog)
        notice.destroy()

        notice.show({ message: 'Late, in the open sheet' })
        dialog.close()
        notice.show({ message: 'Late, after the close' })

        expect(inSheet()).toBeNull()
        expect(appToast()).toBeNull()
    })

    it('gives an error the same icon as an error toast of the app', () => {
        const notice = createNotice(dialog)
        notice.show({ message: 'It failed.', tone: 'error' })

        const icon = inSheet()!.querySelector('svg.icon')!
        expect(icon.getAttribute('aria-hidden')).toBe('true')
        expect(icon.querySelector('use')!.getAttribute('href')).toBe('#i-info')
        expect(inSheet()!.textContent).toBe('It failed.')

        notice.show({ message: 'It worked.' })
        expect(inSheet()!.querySelector('svg')).toBeNull()
    })

    describe('isLive', () => {
        const undo = () => ({
            message: 'Highlight removed',
            action: { label: 'Undo', onSelect: () => {} },
        })

        it('is true while the message is on screen in the sheet', () => {
            const notice = createNotice(dialog)
            const options = undo()
            expect(notice.isLive(options)).toBe(false)

            notice.show(options)
            expect(notice.isLive(options)).toBe(true)
            expect(notice.isLive(undo())).toBe(false)

            vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS)
            expect(notice.isLive(options)).toBe(false)
        })

        it('is false for a message that a different one replaced', () => {
            const notice = createNotice(dialog)
            const options = undo()
            notice.show(options)
            notice.show({ message: 'Highlights copied' })

            expect(notice.isLive(options)).toBe(false)
        })

        it('stays true for the time of the toast of the app after the sheet closes', () => {
            const notice = createNotice(dialog)
            const options = undo()
            notice.show(options)
            vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS - 1)

            dialog.close()
            // The toast of the app gets its full time again.
            vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS - 1)
            expect(appToast()).not.toBeNull()
            expect(notice.isLive(options)).toBe(true)

            vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS)
            expect(appToast()).toBeNull()
            expect(notice.isLive(options)).toBe(false)
        })

        it('is true for a message that went to the toasts of the app directly', () => {
            const notice = createNotice(dialog)
            const options = undo()
            dialog.close()

            notice.show(options)

            expect(notice.isLive(options)).toBe(true)
        })
    })
})
