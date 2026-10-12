import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTimer } from '$lib/rsvp/testing/fake-timer'
import type { FakeTimer } from '$lib/rsvp/testing/fake-timer'
import {
    DEFAULT_SETTINGS,
    RSVP_CONTEXT_WORDS_MAX,
    RSVP_FONT_SIZE_MAX,
    RSVP_FONT_SIZE_MIN,
    RSVP_MULTIPLIER_MAX,
    RSVP_MULTIPLIER_MIN,
    RSVP_WPM_MAX,
    RSVP_WPM_MIN,
    SETTINGS_STORAGE_KEY,
    createSettingsStore,
} from '$lib/settings'
import type { OwnedSettingsStore, RsvpSettings } from '$lib/settings'
import { installOverlayMethods } from '../../app/testing/page'
import { HOLD_DELAY_MS, HOLD_INTERVAL_MS } from './hold-repeat'
import { WPM_PRESETS, createSettingsSheet } from './settings-sheet'
import type { SettingsSheet } from './settings-sheet'
import { fakeStorage, pointer } from './testing/fixtures'

let parent: HTMLElement
let opener: HTMLButtonElement
let storage: ReturnType<typeof fakeStorage>
let settings: OwnedSettingsStore
let timer: FakeTimer
let sheet: SettingsSheet
const onRestart = vi.fn()

function rsvp(): RsvpSettings {
    return settings.get().rsvp
}

function find<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = parent.querySelector<T>(selector)
    if (!element) throw new Error(`No element matches "${selector}"`)
    return element
}

function dialog(name: 'sheet' | 'confirm'): HTMLDialogElement {
    return find<HTMLDialogElement>(`dialog.speed-${name}`)
}

function slider(key: string): HTMLInputElement {
    return find<HTMLInputElement>(`.slider[data-setting="${key}"]`)
}

function slide(key: string, value: string): void {
    const input = slider(key)
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
}

function stepper(key: string): HTMLElement {
    return find(`.stepper[data-setting="${key}"]`)
}

function stepButton(key: string, direction: 1 | -1): HTMLButtonElement {
    return find<HTMLButtonElement>(`.stepper[data-setting="${key}"] [data-step="${direction}"]`)
}

function toggle(key: string): HTMLInputElement {
    const input = find<HTMLInputElement>(`.switch[data-setting="${key}"]`)
    input.click()
    return input
}

function action(name: string): HTMLButtonElement {
    return find<HTMLButtonElement>(`[data-action="${name}"]`)
}

beforeEach(() => {
    installOverlayMethods()
    parent = document.createElement('div')
    opener = document.createElement('button')
    document.body.append(opener, parent)
    storage = fakeStorage()
    settings = createSettingsStore({ storage })
    timer = createFakeTimer()
    onRestart.mockClear()
    sheet = createSettingsSheet({ parent, settings, timer, onRestart })
})

afterEach(() => {
    sheet.destroy()
    settings.destroy()
    document.body.innerHTML = ''
})

describe('the settings sheet', () => {
    it('is closed until it is opened, and has the title "Speed reader"', () => {
        expect(sheet.isOpen).toBe(false)
        expect(dialog('sheet').open).toBe(false)
        sheet.open(opener)
        expect(sheet.isOpen).toBe(true)
        expect(find('.sheet-title').textContent).toBe('Speed reader')
        expect(dialog('sheet').getAttribute('aria-labelledby')).toBe(find('.sheet-title').id)
    })

    it('shows the values of the store when it opens', () => {
        settings.update({
            rsvp: { wpm: 300, fontSize: 60, contextWords: 0, rampUp: false, commaMultiplier: 10 },
        })
        sheet.open(opener)

        expect(slider('wpm').value).toBe('300')
        expect(slider('wpm').min).toBe(String(RSVP_WPM_MIN))
        expect(slider('wpm').max).toBe(String(RSVP_WPM_MAX))
        expect(slider('wpm').step).toBe('10')
        expect(slider('wpm').parentElement?.querySelector('output')?.textContent).toBe('300 wpm')
        expect(slider('fontSize').value).toBe('60')
        expect(slider('fontSize').min).toBe(String(RSVP_FONT_SIZE_MIN))
        expect(slider('fontSize').max).toBe(String(RSVP_FONT_SIZE_MAX))
        expect(slider('fontSize').parentElement?.querySelector('output')?.textContent).toBe('60 px')
        // The filled part of the track follows the value.
        expect(slider('wpm').style.getPropertyValue('--value')).not.toBe('')

        expect(find('[data-wpm="300"]').getAttribute('aria-pressed')).toBe('true')
        expect(find('[data-wpm="200"]').getAttribute('aria-pressed')).toBe('false')
        expect(stepper('contextWords').querySelector('output')?.textContent).toBe('0')
        expect(stepButton('contextWords', -1).getAttribute('aria-disabled')).toBe('true')
        expect(stepButton('contextWords', 1).hasAttribute('aria-disabled')).toBe(false)
        expect(stepper('commaMultiplier').querySelector('output')?.textContent).toBe('10×')
        expect(stepButton('commaMultiplier', 1).getAttribute('aria-disabled')).toBe('true')
        expect(stepper('periodMultiplier').querySelector('output')?.textContent).toBe('3×')
        expect(find<HTMLInputElement>('.switch[data-setting="rampUp"]').checked).toBe(false)
        expect(find<HTMLInputElement>('.switch[data-setting="showPivot"]').checked).toBe(true)
    })

    it('has the six pause controls and the help line', () => {
        const labels = Array.from(parent.querySelectorAll('.stepper'), (element) =>
            element.getAttribute('aria-label'),
        )
        expect(labels).toEqual([
            'Context words',
            'Full stop',
            'Comma',
            'Semicolon and colon',
            'Exclamation and question mark',
            'End of paragraph',
            'End of heading',
        ])
        expect(find('.field-help').textContent).toBe(
            'How many times longer a word stays on screen.',
        )
    })

    it('writes the speed from the slider', () => {
        sheet.open(opener)
        slide('wpm', '430')
        expect(rsvp().wpm).toBe(430)
        expect(slider('wpm').parentElement?.querySelector('output')?.textContent).toBe('430 wpm')
    })

    it('writes the word size from the slider', () => {
        sheet.open(opener)
        slide('fontSize', '72')
        expect(rsvp().fontSize).toBe(72)
    })

    it('has the presets 200, 300, 400, 500 and 600', () => {
        sheet.open(opener)
        expect(WPM_PRESETS).toEqual([200, 300, 400, 500, 600])
        for (const wpm of WPM_PRESETS) {
            const button = find(`[data-wpm="${wpm}"]`)
            expect(button.textContent).toBe(String(wpm))
            button.click()
            expect(rsvp().wpm).toBe(wpm)
            expect(button.getAttribute('aria-pressed')).toBe('true')
            expect(slider('wpm').value).toBe(String(wpm))
        }
    })

    it('writes the context words from the stepper and stops at the limits', () => {
        settings.update({ rsvp: { contextWords: 1 } })
        sheet.open(opener)
        stepButton('contextWords', 1).click()
        expect(rsvp().contextWords).toBe(2)
        stepButton('contextWords', -1).click()
        stepButton('contextWords', -1).click()
        stepButton('contextWords', -1).click()
        expect(rsvp().contextWords).toBe(0)

        settings.update({ rsvp: { contextWords: RSVP_CONTEXT_WORDS_MAX } })
        stepButton('contextWords', 1).click()
        expect(rsvp().contextWords).toBe(RSVP_CONTEXT_WORDS_MAX)
        expect(stepButton('contextWords', 1).getAttribute('aria-disabled')).toBe('true')
    })

    it('repeats a stepper during a hold', () => {
        sheet.open(opener)
        const button = stepButton('contextWords', 1)
        button.dispatchEvent(pointer('pointerdown'))
        timer.advance(HOLD_DELAY_MS + HOLD_INTERVAL_MS * 4)
        button.dispatchEvent(pointer('pointerup'))
        expect(rsvp().contextWords).toBe(DEFAULT_SETTINGS.rsvp.contextWords + 5)
    })

    it.each([
        ['showPivot', 'Highlight the pivot letter'],
        ['rampUp', 'Start slowly after a pause'],
        ['longWordDelay', 'More time for long words'],
        ['pauseAtChapterStart', 'Pause at the start of each chapter'],
    ] as const)('writes the switch %s', (key, label) => {
        sheet.open(opener)
        const input = find<HTMLInputElement>(`.switch[data-setting="${key}"]`)
        expect(input.closest('label')?.textContent?.trim()).toBe(label)
        expect(input.getAttribute('role')).toBe('switch')

        toggle(key)
        expect(rsvp()[key]).toBe(false)
        toggle(key)
        expect(rsvp()[key]).toBe(true)
    })

    it.each([
        'periodMultiplier',
        'commaMultiplier',
        'semicolonMultiplier',
        'exclamationMultiplier',
        'paragraphMultiplier',
        'headingMultiplier',
    ] as const)('writes the pause %s in steps of 0.5', (key) => {
        sheet.open(opener)
        const before = rsvp()[key]
        stepButton(key, 1).click()
        expect(rsvp()[key]).toBe(before + 0.5)
        expect(stepper(key).querySelector('output')?.textContent).toBe(`${before + 0.5}×`)
        stepButton(key, -1).click()
        stepButton(key, -1).click()
        expect(rsvp()[key]).toBe(before - 0.5)
        // No other setting changed.
        expect({ ...rsvp(), [key]: before }).toEqual(DEFAULT_SETTINGS.rsvp)
    })

    it('keeps a pause in its limits', () => {
        settings.update({ rsvp: { commaMultiplier: RSVP_MULTIPLIER_MIN } })
        sheet.open(opener)
        expect(stepButton('commaMultiplier', -1).getAttribute('aria-disabled')).toBe('true')
        stepButton('commaMultiplier', -1).click()
        expect(rsvp().commaMultiplier).toBe(RSVP_MULTIPLIER_MIN)

        settings.update({ rsvp: { commaMultiplier: RSVP_MULTIPLIER_MAX - 0.5 } })
        stepButton('commaMultiplier', 1).click()
        stepButton('commaMultiplier', 1).click()
        expect(rsvp().commaMultiplier).toBe(RSVP_MULTIPLIER_MAX)
    })

    it('saves a change to storage', () => {
        sheet.open(opener)
        slide('wpm', '500')
        settings.flush()
        const saved = JSON.parse(storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')
        expect(saved.rsvp.wpm).toBe(500)
    })

    it('does not write a slider value that is not a number', () => {
        sheet.open(opener)
        const input = slider('wpm')
        Object.defineProperty(input, 'valueAsNumber', { value: Number.NaN })
        input.dispatchEvent(new Event('input', { bubbles: true }))
        expect(rsvp().wpm).toBe(DEFAULT_SETTINGS.rsvp.wpm)
    })

    it('resets the speed reader settings and no other setting', () => {
        settings.update({
            fontSize: 30,
            rsvp: { wpm: 700, contextWords: 12, showPivot: false, headingMultiplier: 9 },
        })
        sheet.open(opener)
        expect(action('reset').textContent?.trim()).toBe('Reset speed reader settings')
        action('reset').click()
        expect(rsvp()).toEqual(DEFAULT_SETTINGS.rsvp)
        expect(settings.get().fontSize).toBe(30)
        expect(slider('wpm').value).toBe(String(DEFAULT_SETTINGS.rsvp.wpm))
        expect(find<HTMLInputElement>('.switch[data-setting="showPivot"]').checked).toBe(true)
    })

    it('asks before it starts the book again', () => {
        sheet.open(opener)
        expect(action('restart').textContent?.trim()).toBe('Start the book again')
        action('restart').click()

        const confirm = dialog('confirm')
        expect(confirm.open).toBe(true)
        expect(confirm.querySelector('.modal-title')?.textContent).toBe(
            'Go to the first word of the book?',
        )
        const buttons = Array.from(confirm.querySelectorAll('button'), (button) =>
            button.textContent?.trim(),
        )
        expect(buttons).toEqual(['Cancel', 'Start again'])
        expect(onRestart).not.toHaveBeenCalled()
        expect(sheet.isOpen).toBe(true)
    })

    it('does nothing when the user cancels', () => {
        sheet.open(opener)
        action('restart').click()
        find<HTMLButtonElement>('.speed-confirm [value="cancel"]').click()
        expect(dialog('confirm').open).toBe(false)
        expect(dialog('sheet').open).toBe(true)
        expect(onRestart).not.toHaveBeenCalled()
    })

    it('does nothing when Escape closes the dialog', () => {
        sheet.open(opener)
        action('restart').click()
        // The browser closes the dialog with no return value for the Escape key.
        dialog('confirm').close()
        expect(onRestart).not.toHaveBeenCalled()
        expect(dialog('sheet').open).toBe(true)
    })

    it('does not use the answer of an earlier confirmation', () => {
        sheet.open(opener)
        action('restart').click()
        find<HTMLButtonElement>('.speed-confirm [value="confirm"]').click()
        expect(onRestart).toHaveBeenCalledTimes(1)

        sheet.open(opener)
        action('restart').click()
        dialog('confirm').close()
        expect(onRestart).toHaveBeenCalledTimes(1)
    })

    it('closes the sheet and restarts when the user confirms', () => {
        sheet.open(opener)
        action('restart').click()
        find<HTMLButtonElement>('.speed-confirm [value="confirm"]').click()
        expect(onRestart).toHaveBeenCalledTimes(1)
        expect(sheet.isOpen).toBe(false)
    })

    it('shows a change that comes from a different place while it is open', () => {
        sheet.open(opener)
        settings.update({ rsvp: { wpm: 610 } })
        expect(slider('wpm').value).toBe('610')
        expect(find('[data-wpm="600"]').getAttribute('aria-pressed')).toBe('false')
    })

    it('stops to follow the store when it closes', () => {
        sheet.open(opener)
        find<HTMLButtonElement>('.sheet-header [data-close]').click()
        expect(sheet.isOpen).toBe(false)
        settings.update({ rsvp: { wpm: 610 } })
        expect(slider('wpm').value).toBe(String(DEFAULT_SETTINGS.rsvp.wpm))

        sheet.open(opener)
        expect(slider('wpm').value).toBe('610')
    })

    it('gives the focus back to the element that opened it', () => {
        opener.focus()
        sheet.open(opener)
        find<HTMLButtonElement>('.sheet-header [data-close]').focus()
        sheet.close()
        expect(document.activeElement).toBe(opener)
    })

    it('closes the confirmation dialog too', () => {
        sheet.open(opener)
        action('restart').click()
        sheet.close()
        expect(dialog('confirm').open).toBe(false)
        expect(dialog('sheet').open).toBe(false)
        expect(onRestart).not.toHaveBeenCalled()
    })

    it('removes its dialogs and its hold timers on destroy', () => {
        sheet.open(opener)
        stepButton('contextWords', 1).dispatchEvent(pointer('pointerdown'))
        sheet.destroy()
        expect(parent.querySelector('dialog')).toBeNull()
        expect(timer.pending()).toEqual([])
        settings.update({ rsvp: { wpm: 610 } })
    })
})
