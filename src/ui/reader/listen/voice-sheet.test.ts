import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsStore, type OwnedSettingsStore } from '$lib/settings'
import type { VoiceInfo } from '$lib/speech'
import { installOverlayMethods } from '../../app/testing/page'
import { qs, qsa } from '../../dom'
import { createVoiceSheet, type VoiceSheet } from './voice-sheet'

const ALICE: VoiceInfo = { id: 'alice', name: 'Alice', lang: 'en-US', local: true, isDefault: true }
const BRIAN: VoiceInfo = {
    id: 'brian',
    name: 'Brian',
    lang: 'en-GB',
    local: false,
    isDefault: false,
}
const CHLOE: VoiceInfo = {
    id: 'chloe',
    name: 'Chloe',
    lang: 'fr-FR',
    local: true,
    isDefault: false,
}
const DIETER: VoiceInfo = {
    id: 'dieter',
    name: 'Dieter',
    lang: 'de-DE',
    local: false,
    isDefault: false,
}

let settings: OwnedSettingsStore
let sheet: VoiceSheet | null = null
let opener: HTMLButtonElement

interface SheetSetup {
    voices?: VoiceInfo[]
    selectedId?: string | null
    language?: string | null
}

function make({
    voices = [ALICE, BRIAN, CHLOE, DIETER],
    selectedId = 'alice',
    language = 'en',
}: SheetSetup = {}) {
    const state = { voices, selectedId }
    const onSelect = vi.fn<(voice: VoiceInfo) => void>((voice) => {
        state.selectedId = voice.id
    })
    sheet = createVoiceSheet({
        host: qs('#host'),
        settings,
        language,
        getVoices: () => state.voices,
        getSelectedId: () => state.selectedId,
        onSelect,
    })
    return { sheet, state, onSelect }
}

function row(name: string): HTMLElement {
    const found = qsa('.listen-voice').find(
        (item) => qs('.list-row-title', item).textContent === name,
    )
    if (!found) throw new Error(`No row for the voice ${name}`)
    return found
}

function names(group: string): (string | null)[] {
    return qsa(`[data-group="${group}"] .list-row-title`).map((item) => item.textContent)
}

function key(target: Element, name: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
}

function more(): HTMLDetailsElement {
    return qs<HTMLDetailsElement>('.listen-voice-more')
}

beforeEach(() => {
    installOverlayMethods()
    document.body.innerHTML = '<button id="opener"></button><div id="host"></div>'
    opener = qs<HTMLButtonElement>('#opener')
    settings = createSettingsStore({ storage: null })
})

afterEach(() => {
    sheet?.destroy()
    sheet = null
    settings.destroy()
    document.body.innerHTML = ''
})

describe('createVoiceSheet', () => {
    it('puts a closed sheet with the title in the overlay layer', () => {
        const { sheet } = make()
        expect(sheet.element.parentElement).toBe(qs('#host'))
        expect(sheet.element.classList.contains('sheet')).toBe(true)
        expect(sheet.element.open).toBe(false)
        expect(qs('.sheet-title').textContent).toBe('Voice')
        expect(sheet.element.getAttribute('aria-labelledby')).toBe(qs('.sheet-title').id)
        // The list is not made before the sheet opens.
        expect(qsa('.listen-voice')).toHaveLength(0)
    })

    it('groups the voices by the language of the book', () => {
        const { sheet } = make()
        sheet.open(opener)
        expect(names('book')).toEqual(['Alice', 'Brian'])
        expect(names('other')).toEqual(['Chloe', 'Dieter'])
        expect(more().open).toBe(false)
        expect(qs('.listen-voice-groups').getAttribute('role')).toBe('radiogroup')
        expect(qs('.listen-voice-empty').hidden).toBe(true)
    })

    it('uses the language of the browser for a book with no language', () => {
        const { sheet } = make({ language: null })
        sheet.open(opener)
        // The language of jsdom is en-US.
        expect(names('book')).toEqual(['Alice', 'Brian'])
    })

    it('shows the language and the device mark of each voice', () => {
        const { sheet } = make()
        sheet.open(opener)
        expect(qs('.list-row-meta', row('Alice')).textContent).toBe('en-US · On this device')
        expect(qs('.list-row-meta', row('Brian')).textContent).toBe('en-GB')
    })

    it('marks one voice when two voices have the same id', () => {
        const twin = { ...BRIAN, id: 'alice' }
        const { sheet } = make({ voices: [ALICE, twin] })
        sheet.open(opener)
        expect(qsa('.listen-voice[aria-checked="true"]')).toHaveLength(1)
        expect(row('Alice').getAttribute('aria-checked')).toBe('true')
    })

    it('gives the first row the Tab key when no voice is selected', () => {
        const { sheet } = make({ selectedId: null })
        sheet.open(opener)
        expect(qsa('.listen-voice[aria-checked="true"]')).toHaveLength(0)
        expect(row('Alice').tabIndex).toBe(0)
        expect(qsa('.listen-voice[tabindex="0"]')).toHaveLength(1)
    })

    it('shows a text when the browser gives no voices', () => {
        const { sheet } = make({ voices: [] })
        sheet.open(opener)
        expect(qs('.listen-voice-empty').hidden).toBe(false)
        expect(qs('.listen-voice-empty').textContent).toBe('This browser has no speech voices.')
        expect(qs('.listen-voice-groups').hidden).toBe(true)
    })

    it('gives the selected voice to the caller and marks it', () => {
        const { sheet, onSelect } = make()
        sheet.open(opener)
        row('Brian').click()
        expect(onSelect).toHaveBeenCalledWith(BRIAN)
        expect(row('Brian').getAttribute('aria-checked')).toBe('true')
        expect(row('Alice').getAttribute('aria-checked')).toBe('false')
        expect(row('Brian').tabIndex).toBe(0)
        expect(row('Alice').tabIndex).toBe(-1)
    })

    it('moves the focus through the rows that are in sight', () => {
        const { sheet, onSelect } = make()
        // The sheet puts the focus on the selected voice only for a user of the keyboard.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
        sheet.open(opener)
        expect(document.activeElement).toBe(row('Alice'))

        expect(key(row('Alice'), 'ArrowDown').defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(row('Brian'))
        // The group of the other languages is closed.
        key(row('Brian'), 'ArrowDown')
        expect(document.activeElement).toBe(row('Brian'))
        key(row('Brian'), 'Home')
        expect(document.activeElement).toBe(row('Alice'))
        key(row('Alice'), 'ArrowUp')
        expect(document.activeElement).toBe(row('Alice'))

        more().open = true
        key(row('Alice'), 'End')
        expect(document.activeElement).toBe(row('Dieter'))
        key(row('Dieter'), 'ArrowUp')
        expect(document.activeElement).toBe(row('Chloe'))
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('leaves the other keys to the browser', () => {
        const { sheet } = make()
        sheet.open(opener)
        expect(key(row('Alice'), 'Enter').defaultPrevented).toBe(false)
        expect(key(row('Alice'), 'Tab').defaultPrevented).toBe(false)
        expect(key(qs('summary'), 'ArrowDown').defaultPrevented).toBe(false)
    })

    it('draws the list again when the voices change, and keeps the focus in the list', () => {
        const { sheet, state } = make({ voices: [ALICE] })
        // A closed sheet does no work.
        sheet.refreshVoices()
        expect(qsa('.listen-voice')).toHaveLength(0)

        sheet.open(opener)
        expect(document.activeElement).toBe(row('Alice'))
        state.voices = [ALICE, BRIAN, CHLOE]
        sheet.refreshVoices()
        expect(names('book')).toEqual(['Alice', 'Brian'])
        expect(names('other')).toEqual(['Chloe'])
        expect(document.activeElement).toBe(row('Alice'))
    })

    it('opens the other group when the selected voice comes into it', () => {
        const { sheet, state } = make()
        sheet.open(opener)
        state.selectedId = 'chloe'
        sheet.refreshVoices()
        expect(more().open).toBe(true)
        expect(row('Chloe').tabIndex).toBe(0)
    })

    it('shows the settings when it opens and when they change', () => {
        settings.update({ speech: { pitch: 1.3, highlightWords: false } })
        const { sheet, state } = make()
        sheet.open(opener)
        const pitch = qs<HTMLInputElement>('[data-setting="pitch"]')
        const words = qs<HTMLInputElement>('[data-setting="highlight-words"]')
        expect(pitch.value).toBe('1.3')
        expect(pitch.step).toBe('0.1')
        expect(qs('.slider-value').textContent).toBe('1.3')
        // The filled part of the track: (1.3 - 0.5) / (2 - 0.5).
        expect(Number(pitch.style.getPropertyValue('--value'))).toBeCloseTo(0.5333, 3)
        expect(words.checked).toBe(false)
        expect(words.getAttribute('role')).toBe('switch')

        settings.update({ speech: { pitch: 2, highlightWords: true } })
        state.selectedId = 'brian'
        sheet.syncSettings()
        expect(pitch.value).toBe('2')
        expect(qs('.slider-value').textContent).toBe('2.0')
        expect(words.checked).toBe(true)
        expect(row('Brian').getAttribute('aria-checked')).toBe('true')
    })

    it('gives the focus back to the opener when it closes', () => {
        const { sheet } = make()
        opener.focus()
        sheet.open(opener)
        sheet.close()
        expect(sheet.element.open).toBe(false)
        expect(document.activeElement).toBe(opener)
    })

    it('removes the sheet at destroy', () => {
        const { sheet } = make()
        sheet.open(opener)
        sheet.destroy()
        expect(document.querySelector('dialog')).toBeNull()
    })
})
