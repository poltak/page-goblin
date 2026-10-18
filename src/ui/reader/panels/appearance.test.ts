import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupedFontEntries } from '$lib/fonts'
import { createFakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import type { FakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import {
    settings as appSettings,
    COLUMN_CHOICES,
    createSettingsStore,
    DARK_THEMES,
    DEFAULT_SETTINGS,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    LAYOUT_MODES,
    LINE_HEIGHT_MAX,
    LINE_HEIGHT_MIN,
    LINE_HEIGHT_STEP,
    MARGIN_SIZES,
    PAGE_TURN_ANIMATIONS,
    SETTINGS_STORAGE_KEY,
    TEXT_ALIGN_CHOICES,
    THEME_CHOICES,
} from '$lib/settings'
import type { OwnedSettingsStore, Settings, SettingsStorage } from '$lib/settings'
import type { FontRecord } from '$lib/storage/types'
import { clearToasts } from '../../app/toast'
import type { AppearancePanel } from '../parts'
import { APPEARANCE_KEYS, createAppearancePanel } from './appearance'
import { createFakeSession, focusOpener, HOSTILE, mountHost } from './testing/fake-session'
import type { FakeSession } from './testing/fake-session'

function fakeStorage(saved?: Partial<Settings>): SettingsStorage {
    const data = new Map<string, string>()
    if (saved) data.set(SETTINGS_STORAGE_KEY, JSON.stringify(saved))
    return {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => void data.set(key, value),
    }
}

let host: HTMLElement
let session: FakeSession
let store: OwnedSettingsStore
let panel: AppearancePanel | null = null
let frames: FrameRequestCallback[]

let userFonts: FakeUserFonts

interface MountOptions {
    saved?: Partial<Settings>
    bookFonts?: string[]
    userFonts?: FontRecord[]
}

function makeUserFont(id: string, name: string): FontRecord {
    return { id, name, fallback: 'serif', faces: [], addedAt: 1, updatedAt: 1 }
}

/** Makes the panel on a real settings store and opens it. */
function mount({ saved, bookFonts, userFonts: list }: MountOptions = {}): AppearancePanel {
    host = mountHost()
    userFonts = createFakeUserFonts({ list })
    session = createFakeSession({ bookFonts, fonts: userFonts })
    store = createSettingsStore({ storage: fakeStorage(saved) })
    panel = createAppearancePanel({ session, host, settings: store })
    panel.open()
    return panel
}

function runFrames(): void {
    const waiting = frames
    frames = []
    for (const run of waiting) run(0)
}

const sheet = () => host.querySelector<HTMLDialogElement>('.appearance-panel')!
const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    sheet().querySelector<T>(selector)!
const radios = (key: string) =>
    Array.from(sheet().querySelectorAll<HTMLInputElement>(`input[name="appearance-${key}"]`))
const radio = (key: string, value: string) =>
    q<HTMLInputElement>(`input[name="appearance-${key}"][value="${value}"]`)
const checkedValue = (key: string) => radios(key).find((input) => input.checked)?.value
const labelOf = (input: HTMLInputElement) =>
    input.closest('label')!.textContent!.replace(/\s+/g, ' ').trim()
const toggle = (name: string) => q<HTMLInputElement>(`[data-switch="${name}"]`)
const rowOf = (name: string) => q(`[data-row="${name}"]`)
const fontSelect = () => q<HTMLSelectElement>('#appearance-font')
const sizeSlider = () => q<HTMLInputElement>('[data-slider="fontSize"]')
const sizeOutput = () => q('[data-output="fontSize"]')
const lineSlider = () => q<HTMLInputElement>('[data-slider="lineHeight"]')
const lineOutput = () => q('[data-output="lineHeight"]')
const smaller = () => q('[data-step="-1"]')
const larger = () => q('[data-step="1"]')
const resetButton = () => q('[data-action="reset"]')
const notice = () => sheet().querySelector<HTMLElement>('.panel-notice .toast')

function slide(input: HTMLInputElement, value: number): void {
    input.value = String(value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
}

function release(input: HTMLInputElement): void {
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

function selectFont(id: string): void {
    fontSelect().value = id
    fontSelect().dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run))
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
        frames[handle - 1] = () => {}
    })
})

afterEach(() => {
    panel?.destroy()
    panel = null
    store?.destroy()
    clearToasts()
    vi.unstubAllGlobals()
})

describe('the reading settings panel', () => {
    it('is a sheet in the overlay layer that opens and closes', () => {
        const appearance = mount()

        expect(sheet().parentElement).toBe(host)
        expect(sheet().classList.contains('sheet')).toBe(true)
        expect(sheet().open).toBe(true)
        expect(q('.sheet-title').textContent).toBe('Reading settings')
        expect(sheet().getAttribute('aria-labelledby')).toBe(q('.sheet-title').id)

        appearance.close()
        expect(sheet().open).toBe(false)
    })

    it('gives the focus back to the control that opened it', () => {
        host = mountHost()
        session = createFakeSession()
        store = createSettingsStore({ storage: fakeStorage() })
        panel = createAppearancePanel({ session, host, settings: store })
        const opener = focusOpener()

        panel.open()
        q('[data-close]').click()

        expect(sheet().open).toBe(false)
        expect(document.activeElement).toBe(opener)
    })

    it('stays open after a change, so the reader sees the page change', () => {
        mount()
        radio('theme', 'sepia').click()
        radio('layout', 'scroll').click()

        expect(sheet().open).toBe(true)
    })

    it('has one radio input for each choice of each list', () => {
        mount()
        const lists: Record<string, readonly unknown[]> = {
            theme: THEME_CHOICES,
            darkTheme: DARK_THEMES,
            margin: MARGIN_SIZES,
            textAlign: TEXT_ALIGN_CHOICES,
            layout: LAYOUT_MODES,
            columns: COLUMN_CHOICES,
            pageTurn: PAGE_TURN_ANIMATIONS,
        }

        for (const [key, choices] of Object.entries(lists)) {
            expect(
                radios(key).map((input) => input.value),
                key,
            ).toEqual(choices.map(String))
        }
    })

    it('uses the store of the app when it gets no store', () => {
        host = mountHost()
        session = createFakeSession()
        const before = appSettings.get().margin
        panel = createAppearancePanel({ session, host })
        panel.open()

        radio('margin', 'wide').click()
        expect(appSettings.get().margin).toBe('wide')

        appSettings.update({ margin: before })
    })
})

describe('theme', () => {
    it('has five swatches in one group, with the stored theme selected', () => {
        mount({ saved: { theme: 'sepia' } })

        // The letters in a swatch are decoration. The name is the label.
        expect(
            radios('theme').map(
                (input) =>
                    input.closest('label')!.querySelector('.appearance-theme-name')!.textContent,
            ),
        ).toEqual(['Auto', 'Light', 'Sepia', 'Dark', 'Black'])
        expect(sheet().querySelectorAll('.appearance-chip:not([aria-hidden="true"])')).toHaveLength(
            0,
        )
        expect(checkedValue('theme')).toBe('sepia')
        expect(q('.appearance-themes').getAttribute('role')).toBe('radiogroup')
        // Each swatch has the colours of its own theme.
        expect(
            radios('theme')
                .slice(1)
                .map(
                    (input) =>
                        input.closest('label')!.querySelector<HTMLElement>('.appearance-chip')!
                            .dataset.theme,
                ),
        ).toEqual(['light', 'sepia', 'dark', 'black'])
    })

    it('writes the theme', () => {
        mount()
        for (const theme of ['light', 'sepia', 'dark', 'black', 'auto'] as const) {
            radio('theme', theme).click()
            expect(store.get().theme).toBe(theme)
            expect(checkedValue('theme')).toBe(theme)
        }
    })

    it('shows the dark theme control only for Auto', () => {
        mount({ saved: { theme: 'auto' } })
        expect(rowOf('darkTheme').hidden).toBe(false)
        expect(radios('darkTheme').map(labelOf)).toEqual(['Dark', 'Black'])
        expect(rowOf('darkTheme').querySelector('.segmented')).not.toBeNull()

        radio('theme', 'dark').click()
        expect(rowOf('darkTheme').hidden).toBe(true)

        radio('theme', 'auto').click()
        expect(rowOf('darkTheme').hidden).toBe(false)
    })

    it('writes the dark theme and shows it in the Auto swatch', () => {
        mount({ saved: { theme: 'auto', darkTheme: 'dark' } })
        const darkHalf = () => q('.appearance-chip-auto > :last-child')
        expect(checkedValue('darkTheme')).toBe('dark')
        expect(darkHalf().dataset.theme).toBe('dark')

        radio('darkTheme', 'black').click()

        expect(store.get().darkTheme).toBe('black')
        expect(store.get().theme).toBe('auto')
        expect(darkHalf().dataset.theme).toBe('black')
    })
})

describe('font', () => {
    it('lists the font groups, with the fonts of the book in the first group', () => {
        mount({ bookFonts: ['Book Serif'] })

        const groups = Array.from(fontSelect().querySelectorAll('optgroup'))
        const expected = groupedFontEntries(['Book Serif'])
        expect(groups.map((group) => group.label)).toEqual(expected.map((group) => group.label))
        expect(
            groups.map((group) =>
                Array.from(group.querySelectorAll('option'), (option) => [
                    option.value,
                    option.textContent,
                ]),
            ),
        ).toEqual(expected.map((group) => group.entries.map((entry) => [entry.id, entry.label])))
        expect(groups[0].querySelector<HTMLOptionElement>('option:last-child')!.value).toBe(
            'book:Book Serif',
        )
    })

    it('puts the name of a book font into the page as text', () => {
        mount({ bookFonts: [HOSTILE] })

        const option = fontSelect().querySelector<HTMLOptionElement>('optgroup option:last-child')!
        expect(option.textContent).toBe(HOSTILE)
        expect(option.value).toBe(`book:${HOSTILE}`)
        expect(fontSelect().querySelector('img, b')).toBeNull()
    })

    it('loads no font to show the menu', () => {
        mount({ saved: { fontId: 'literata' } })

        expect(fontSelect().value).toBe('literata')
        expect(userFonts.loads).toEqual([])
        expect(fontSelect().querySelector('[style]')).toBeNull()
    })

    it('writes the font and loads it', () => {
        mount({ bookFonts: ['Book Serif'] })

        selectFont('lora')
        expect(store.get().fontId).toBe('lora')
        expect(userFonts.loads.at(-1)).toBe('lora')

        selectFont('book:Book Serif')
        expect(store.get().fontId).toBe('book:Book Serif')
        expect(userFonts.loads.at(-1)).toBe('book:Book Serif')
        expect(fontSelect().value).toBe('book:Book Serif')
    })

    it('lists the fonts of the user in their own group, as text', () => {
        mount({ userFonts: [makeUserFont('b', 'Zed'), makeUserFont('a', HOSTILE)] })

        const group = fontSelect().querySelectorAll('optgroup')[1]
        expect(group.label).toBe('Your fonts')
        const options = Array.from(group.querySelectorAll('option'))
        expect(options.map((option) => option.value)).toEqual(['user:a', 'user:b'])
        expect(options[0].textContent).toBe(HOSTILE)
        expect(fontSelect().querySelector('img, b')).toBeNull()
    })

    it('writes a font of the user and loads it', () => {
        mount({ userFonts: [makeUserFont('a', 'Mine')] })

        selectFont('user:a')
        expect(store.get().fontId).toBe('user:a')
        expect(userFonts.loads.at(-1)).toBe('user:a')
    })

    it('shows "Publisher font" for a font of the user that is not on this device', () => {
        mount({ saved: { fontId: 'user:gone' }, userFonts: [makeUserFont('a', 'Mine')] })

        expect(fontSelect().value).toBe('publisher')
        expect(store.get().fontId).toBe('user:gone')
    })

    it('changes the menu when the fonts of the user change, and keeps the selection', () => {
        mount({ saved: { fontId: 'user:a' } })
        expect(fontSelect().value).toBe('publisher')

        userFonts.setList([makeUserFont('a', 'Arrived')])
        expect(fontSelect().value).toBe('user:a')
        expect(fontSelect().selectedOptions[0].textContent).toBe('Arrived')

        userFonts.setList([])
        expect(fontSelect().value).toBe('publisher')
        expect(fontSelect().querySelector('option[value="user:a"]')).toBeNull()
    })

    it('shows a stored font of this book as selected', () => {
        mount({ saved: { fontId: 'book:Book Serif' }, bookFonts: ['Book Serif'] })

        expect(fontSelect().value).toBe('book:Book Serif')
    })

    it('shows "Publisher font" for a stored font that this book does not have', () => {
        mount({ saved: { fontId: 'book:Other Family' }, bookFonts: ['Book Serif'] })

        expect(fontSelect().value).toBe('publisher')
        expect(fontSelect().selectedOptions[0].textContent).toBe('Publisher font')
        // The setting stays, because the book of that font can open again.
        expect(store.get().fontId).toBe('book:Other Family')
    })

    it('shows "Publisher font" for a stored id that is not known', () => {
        mount({ saved: { fontId: 'comic-sans' } })

        expect(fontSelect().value).toBe('publisher')
    })
})

describe('size', () => {
    it('shows the size in pixels and steps by one', () => {
        mount({ saved: { fontSize: 19 } })
        expect(sizeOutput().textContent).toBe('19 px')
        expect(q('.stepper').getAttribute('role')).toBe('group')
        expect(smaller().getAttribute('aria-label')).toBe('Smaller')
        expect(larger().getAttribute('aria-label')).toBe('Larger')

        larger().click()
        expect(store.get().fontSize).toBe(20)
        expect(sizeOutput().textContent).toBe('20 px')
        expect(sizeSlider().value).toBe('20')

        smaller().click()
        smaller().click()
        expect(store.get().fontSize).toBe(18)
        expect(sizeSlider().value).toBe('18')
    })

    it('stops at the limits', () => {
        mount({ saved: { fontSize: FONT_SIZE_MAX } })
        expect(larger().getAttribute('aria-disabled')).toBe('true')
        expect(smaller().getAttribute('aria-disabled')).toBe('false')

        larger().click()
        expect(store.get().fontSize).toBe(FONT_SIZE_MAX)

        store.update({ fontSize: FONT_SIZE_MIN })
        expect(smaller().getAttribute('aria-disabled')).toBe('true')
        expect(larger().getAttribute('aria-disabled')).toBe('false')
        smaller().click()
        expect(store.get().fontSize).toBe(FONT_SIZE_MIN)
    })

    it('has a slider over the full range', () => {
        mount()

        expect(sizeSlider().classList.contains('slider')).toBe(true)
        expect(sizeSlider().min).toBe(String(FONT_SIZE_MIN))
        expect(sizeSlider().max).toBe(String(FONT_SIZE_MAX))
        expect(sizeSlider().step).toBe('1')
        expect(sizeSlider().style.getPropertyValue('--value')).not.toBe('')
    })

    it('shows a slider value at once and sends one change for each frame', () => {
        mount({ saved: { fontSize: 19 } })
        const listener = vi.fn()
        store.subscribe(listener)

        slide(sizeSlider(), 22)
        slide(sizeSlider(), 24)
        slide(sizeSlider(), 25)

        expect(sizeOutput().textContent).toBe('25 px')
        expect(store.get().fontSize).toBe(19)
        expect(frames).toHaveLength(1)

        runFrames()
        expect(store.get().fontSize).toBe(25)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(sizeSlider().value).toBe('25')
    })

    it('sends the last slider value at once when the drag ends', () => {
        mount({ saved: { fontSize: 19 } })

        slide(sizeSlider(), 30)
        release(sizeSlider())

        expect(store.get().fontSize).toBe(30)
        runFrames()
        expect(store.get().fontSize).toBe(30)
    })

    it('sends a slider value before a step of the stepper', () => {
        mount({ saved: { fontSize: 19 } })

        slide(sizeSlider(), 30)
        larger().click()

        expect(store.get().fontSize).toBe(31)
        runFrames()
        expect(store.get().fontSize).toBe(31)
    })

    it('sends the value at once in a page with no animation frames', () => {
        vi.stubGlobal('requestAnimationFrame', undefined)
        mount({ saved: { fontSize: 19 } })

        slide(sizeSlider(), 21)

        expect(store.get().fontSize).toBe(21)
    })
})

describe('line height', () => {
    it('shows the stored value on an enabled slider', () => {
        mount({ saved: { lineHeight: 1.8 } })

        expect(toggle('lineHeight').checked).toBe(false)
        expect(toggle('lineHeight').getAttribute('role')).toBe('switch')
        expect(labelOf(toggle('lineHeight'))).toBe('Publisher line height')
        expect(lineSlider().disabled).toBe(false)
        expect(lineSlider().value).toBe('1.8')
        expect(lineOutput().textContent).toBe('1.80')
        expect(lineSlider().min).toBe(String(LINE_HEIGHT_MIN))
        expect(lineSlider().max).toBe(String(LINE_HEIGHT_MAX))
        expect(lineSlider().step).toBe(String(LINE_HEIGHT_STEP))
    })

    it('writes null for the publisher line height and disables the slider', () => {
        mount({ saved: { lineHeight: 1.8 } })

        toggle('lineHeight').click()

        expect(store.get().lineHeight).toBeNull()
        expect(toggle('lineHeight').checked).toBe(true)
        expect(lineSlider().disabled).toBe(true)
        // The slider keeps its value for the time when the switch goes off again.
        expect(lineSlider().value).toBe('1.8')

        toggle('lineHeight').click()
        expect(store.get().lineHeight).toBe(1.8)
        expect(lineSlider().disabled).toBe(false)
    })

    it('starts with the default on the slider when the store has no line height', () => {
        mount({ saved: { lineHeight: null } })

        expect(toggle('lineHeight').checked).toBe(true)
        expect(lineSlider().disabled).toBe(true)
        expect(lineSlider().value).toBe(String(DEFAULT_SETTINGS.lineHeight))

        toggle('lineHeight').click()
        expect(store.get().lineHeight).toBe(DEFAULT_SETTINGS.lineHeight)
    })

    it('writes the slider value', () => {
        mount({ saved: { lineHeight: 1.5 } })

        slide(lineSlider(), 2.05)
        expect(lineOutput().textContent).toBe('2.05')
        runFrames()

        expect(store.get().lineHeight).toBe(2.05)
        expect(lineSlider().value).toBe('2.05')
    })

    it('sends the two sliders of one frame as one change', () => {
        mount({ saved: { lineHeight: 1.5, fontSize: 19 } })
        const listener = vi.fn()
        store.subscribe(listener)

        slide(lineSlider(), 2)
        slide(sizeSlider(), 23)
        runFrames()

        expect(store.get().lineHeight).toBe(2)
        expect(store.get().fontSize).toBe(23)
        expect(listener).toHaveBeenCalledTimes(1)
    })
})

describe('margins, alignment and hyphenation', () => {
    it('writes the margin', () => {
        mount()
        expect(radios('margin').map(labelOf)).toEqual(['Narrow', 'Normal', 'Wide'])
        expect(checkedValue('margin')).toBe('normal')

        radio('margin', 'narrow').click()
        expect(store.get().margin).toBe('narrow')
        radio('margin', 'wide').click()
        expect(store.get().margin).toBe('wide')
        expect(checkedValue('margin')).toBe('wide')
    })

    it('writes the alignment', () => {
        mount({ saved: { textAlign: 'justify' } })
        expect(radios('textAlign').map(labelOf)).toEqual(['Publisher', 'Left', 'Justified'])
        expect(checkedValue('textAlign')).toBe('justify')

        radio('textAlign', 'start').click()
        expect(store.get().textAlign).toBe('start')
        radio('textAlign', 'publisher').click()
        expect(store.get().textAlign).toBe('publisher')
    })

    it('writes the hyphenation', () => {
        mount({ saved: { hyphenate: false } })
        expect(labelOf(toggle('hyphenate'))).toBe('Hyphenation')
        expect(toggle('hyphenate').checked).toBe(false)

        toggle('hyphenate').click()
        expect(store.get().hyphenate).toBe(true)
        toggle('hyphenate').click()
        expect(store.get().hyphenate).toBe(false)
    })
})

describe('layout', () => {
    it('writes the layout', () => {
        mount()
        expect(radios('layout').map(labelOf)).toEqual(['Pages', 'Scroll'])
        expect(checkedValue('layout')).toBe('paged')

        radio('layout', 'scroll').click()
        expect(store.get().layout).toBe('scroll')
        radio('layout', 'paged').click()
        expect(store.get().layout).toBe('paged')
    })

    it('shows the columns and the page turn only for pages', () => {
        mount({ saved: { layout: 'paged' } })
        expect(rowOf('columns').hidden).toBe(false)
        expect(rowOf('pageTurn').hidden).toBe(false)

        radio('layout', 'scroll').click()
        expect(rowOf('columns').hidden).toBe(true)
        expect(rowOf('pageTurn').hidden).toBe(true)

        radio('layout', 'paged').click()
        expect(rowOf('columns').hidden).toBe(false)
        expect(rowOf('pageTurn').hidden).toBe(false)
    })

    it('writes the columns as a number or as auto', () => {
        mount({ saved: { columns: 2 } })
        expect(radios('columns').map(labelOf)).toEqual(['Auto', '1', '2'])
        expect(checkedValue('columns')).toBe('2')

        radio('columns', '1').click()
        expect(store.get().columns).toBe(1)
        radio('columns', 'auto').click()
        expect(store.get().columns).toBe('auto')
        radio('columns', '2').click()
        expect(store.get().columns).toBe(2)
    })

    it('writes the page turn', () => {
        mount()
        expect(radios('pageTurn').map(labelOf)).toEqual(['Slide', 'Fade', 'None'])
        expect(checkedValue('pageTurn')).toBe('slide')

        radio('pageTurn', 'fade').click()
        expect(store.get().pageTurn).toBe('fade')
        radio('pageTurn', 'none').click()
        expect(store.get().pageTurn).toBe('none')
    })
})

describe('publisher styles and keep screen awake', () => {
    it('writes the publisher styles and has the help text', () => {
        mount()
        const label = toggle('publisherStyles').closest('label')!
        expect(label.querySelector('.field-label')!.textContent).toBe('Publisher styles')
        expect(label.querySelector('.field-help')!.textContent!.trim()).toBe(
            'Turn off to ignore the fonts, colours and spacing of the book.',
        )
        expect(toggle('publisherStyles').checked).toBe(true)

        toggle('publisherStyles').click()
        expect(store.get().publisherStyles).toBe(false)
        toggle('publisherStyles').click()
        expect(store.get().publisherStyles).toBe(true)
    })

    it('writes keep screen awake and has the help text', () => {
        mount({ saved: { keepAwake: false } })
        const label = toggle('keepAwake').closest('label')!
        expect(label.querySelector('.field-label')!.textContent).toBe('Keep screen awake')
        expect(label.querySelector('.field-help')!.textContent!.trim()).toBe(
            'In the speed reader and while listening.',
        )
        expect(toggle('keepAwake').checked).toBe(false)

        toggle('keepAwake').click()
        expect(store.get().keepAwake).toBe(true)
    })

    it('writes the chapter title above the page and has the help text', () => {
        mount()
        const label = toggle('runningHead').closest('label')!
        expect(label.querySelector('.field-label')!.textContent).toBe('Chapter title')
        expect(label.querySelector('.field-help')!.textContent!.trim()).toBe('Above the page.')
        expect(toggle('runningHead').checked).toBe(true)

        toggle('runningHead').click()
        expect(store.get().runningHead).toBe(false)
        expect(store.get().runningFoot).toBe(true)
        toggle('runningHead').click()
        expect(store.get().runningHead).toBe(true)
    })

    it('writes the progress below the page and has the help text', () => {
        mount({ saved: { runningFoot: false } })
        const label = toggle('runningFoot').closest('label')!
        expect(label.querySelector('.field-label')!.textContent).toBe('Progress')
        expect(label.querySelector('.field-help')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
            'Below the page. Tap the bottom right corner of the screen to show or hide it.',
        )
        expect(toggle('runningFoot').checked).toBe(false)

        toggle('runningFoot').click()
        expect(store.get().runningFoot).toBe(true)
        expect(store.get().runningHead).toBe(true)
    })

    it('shows a change of the progress setting that comes from the page', () => {
        mount()
        store.update({ runningFoot: false })
        expect(toggle('runningFoot').checked).toBe(false)
    })
})

describe('reset', () => {
    const changed: Partial<Settings> = {
        theme: 'black',
        darkTheme: 'black',
        layout: 'scroll',
        fontId: 'lora',
        fontSize: 30,
        lineHeight: null,
        margin: 'wide',
        textAlign: 'justify',
        hyphenate: true,
        publisherStyles: false,
        columns: 2,
        pageTurn: 'none',
        keepAwake: false,
        runningHead: false,
        runningFoot: false,
        librarySort: 'title',
        readingWpm: 400,
    }

    it('sets the fields of this panel to the defaults, and no other field', () => {
        mount({ saved: changed })
        store.update({ rsvp: { wpm: 600 }, speech: { rate: 1.5 } })
        expect(resetButton().textContent!.trim()).toBe('Reset reading settings')

        resetButton().click()

        const now = store.get()
        for (const key of APPEARANCE_KEYS) expect(now[key], key).toEqual(DEFAULT_SETTINGS[key])
        expect(now.librarySort).toBe('title')
        expect(now.readingWpm).toBe(400)
        expect(now.rsvp.wpm).toBe(600)
        expect(now.speech.rate).toBe(1.5)
    })

    it('covers each setting of the panel that is not for the speed reader, speech or library', () => {
        const others = ['rsvp', 'speech', 'librarySort', 'readingWpm']

        expect([...APPEARANCE_KEYS, ...others].sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
    })

    it('shows the defaults in the controls', () => {
        mount({ saved: changed })

        resetButton().click()

        expect(checkedValue('theme')).toBe(DEFAULT_SETTINGS.theme)
        expect(checkedValue('layout')).toBe('paged')
        expect(rowOf('columns').hidden).toBe(false)
        expect(fontSelect().value).toBe('publisher')
        expect(sizeOutput().textContent).toBe(`${DEFAULT_SETTINGS.fontSize} px`)
        expect(toggle('lineHeight').checked).toBe(false)
        expect(lineSlider().disabled).toBe(false)
        expect(toggle('hyphenate').checked).toBe(false)
        expect(toggle('publisherStyles').checked).toBe(true)
        expect(toggle('keepAwake').checked).toBe(true)
        expect(toggle('runningHead').checked).toBe(true)
        expect(toggle('runningFoot').checked).toBe(true)
    })

    it('offers Undo, which puts the settings back', () => {
        mount({ saved: changed })
        const before = store.get()

        resetButton().click()
        expect(notice()!.querySelector('span')!.textContent).toBe('Reading settings reset')
        notice()!.querySelector('button')!.click()

        const now = store.get()
        for (const key of APPEARANCE_KEYS) expect(now[key], key).toEqual(before[key])
        expect(checkedValue('theme')).toBe('black')
        expect(notice()).toBeNull()
    })

    it('shows no message when the settings are the defaults already', () => {
        mount()

        resetButton().click()

        expect(notice()).toBeNull()
    })

    it('drops a slider value that waits for a frame', () => {
        mount({ saved: { fontSize: 30 } })

        slide(sizeSlider(), 35)
        resetButton().click()
        runFrames()

        expect(store.get().fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    })
})

describe('changes from outside the panel', () => {
    it('shows a change of the store while the panel is open', () => {
        mount()

        store.update({
            theme: 'dark',
            fontSize: 28,
            lineHeight: null,
            layout: 'scroll',
            hyphenate: true,
            fontId: 'inter',
        })

        expect(checkedValue('theme')).toBe('dark')
        expect(rowOf('darkTheme').hidden).toBe(true)
        expect(sizeOutput().textContent).toBe('28 px')
        expect(sizeSlider().value).toBe('28')
        expect(toggle('lineHeight').checked).toBe(true)
        expect(lineSlider().disabled).toBe(true)
        expect(checkedValue('layout')).toBe('scroll')
        expect(rowOf('pageTurn').hidden).toBe(true)
        expect(toggle('hyphenate').checked).toBe(true)
        expect(fontSelect().value).toBe('inter')
    })

    it('shows a change that came while the panel was closed at the next open', () => {
        const appearance = mount()
        appearance.close()

        store.update({ margin: 'narrow', fontSize: 14 })
        expect(checkedValue('margin')).toBe('normal')

        appearance.open()
        expect(checkedValue('margin')).toBe('narrow')
        expect(sizeOutput().textContent).toBe('14 px')
    })

    it('does not touch the controls for a setting of a different part', () => {
        mount()
        // A value that the store does not have. A sync would replace it.
        sizeOutput().textContent = 'marker'

        store.update({ readingWpm: 300, rsvp: { wpm: 500 } })

        expect(sizeOutput().textContent).toBe('marker')
    })
})

describe('destroy', () => {
    it('removes the sheet and stops following the store', () => {
        const appearance = mount()
        const dialog = sheet()
        slide(sizeSlider(), 33)

        appearance.destroy()
        panel = null
        runFrames()

        expect(host.children).toHaveLength(0)
        expect(dialog.open).toBe(false)
        // The slider value that waited for a frame is not sent.
        expect(store.get().fontSize).toBe(DEFAULT_SETTINGS.fontSize)
        expect(() => store.update({ theme: 'black' })).not.toThrow()
        expect(
            dialog.querySelector<HTMLInputElement>('input[name="appearance-theme"]:checked')!.value,
        ).toBe(DEFAULT_SETTINGS.theme)
    })
})
