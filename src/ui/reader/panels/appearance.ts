/**
 * The reading settings panel of the reader screen. The reader screen loads this file when the
 * user opens the panel for the first time.
 *
 * The panel reads and writes the settings store. The session follows the store, so each
 * change shows in the book at once.
 */

import {
    ensureFontLoaded,
    groupedFontEntries,
    PUBLISHER_FONT_ID,
    resolveFontStack,
} from '$lib/fonts'
import {
    settings as appSettings,
    COLUMN_CHOICES,
    DARK_THEMES,
    DEFAULT_SETTINGS,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    FONT_SIZE_STEP,
    LAYOUT_MODES,
    LINE_HEIGHT_MAX,
    LINE_HEIGHT_MIN,
    LINE_HEIGHT_STEP,
    MARGIN_SIZES,
    PAGE_TURN_ANIMATIONS,
    TEXT_ALIGN_CHOICES,
    THEME_CHOICES,
} from '$lib/settings'
import type { Settings, SettingsPatch, SettingsStore } from '$lib/settings'
import { connectDialog, openDialog } from '../../app/dialog'
import { on, qs, qsa, setRangeValue } from '../../dom'
import type { AppearancePanel, PartOptions } from '../parts'
import markup from './appearance.html?raw'
import { createNotice, parseMarkup } from './shared'
import './appearance.css'

/** The radio groups. The name of each radio input is this prefix and the key of its setting. */
const RADIO_PREFIX = 'appearance-'

const CHOICES = {
    theme: THEME_CHOICES,
    darkTheme: DARK_THEMES,
    margin: MARGIN_SIZES,
    textAlign: TEXT_ALIGN_CHOICES,
    layout: LAYOUT_MODES,
    columns: COLUMN_CHOICES,
    pageTurn: PAGE_TURN_ANIMATIONS,
} as const satisfies Partial<Record<keyof Settings, readonly unknown[]>>

type ChoiceKey = keyof typeof CHOICES

const CHOICE_KEYS = Object.keys(CHOICES) as ChoiceKey[]

/** The switches that write a boolean setting of the same name. */
const SWITCH_KEYS = ['hyphenate', 'publisherStyles', 'keepAwake'] as const

type SwitchKey = (typeof SWITCH_KEYS)[number]

/** The settings of this panel. The reset changes these and no others. */
export const APPEARANCE_KEYS = [
    'theme',
    'darkTheme',
    'layout',
    'fontId',
    'fontSize',
    'lineHeight',
    'margin',
    'textAlign',
    'hyphenate',
    'publisherStyles',
    'columns',
    'pageTurn',
    'keepAwake',
] as const satisfies readonly (keyof Settings)[]

/** The line height of the slider when the settings and the defaults have none. */
const LINE_HEIGHT_FALLBACK = 1.5

const template = parseMarkup(markup)

function pickAppearance(source: Settings): SettingsPatch {
    const patch: Record<string, unknown> = {}
    for (const key of APPEARANCE_KEYS) patch[key] = source[key]
    return patch as SettingsPatch
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

export interface AppearancePanelOptions extends PartOptions {
    /** The store that the panel reads and writes. The default is the store of the app. */
    settings?: SettingsStore
}

export function createAppearancePanel(options: AppearancePanelOptions): AppearancePanel {
    const { session, host } = options
    const store = options.settings ?? appSettings
    const bookFonts = session.content.bookFonts

    const root = document.importNode(template, true)
    const dialog = qs<HTMLDialogElement>('.appearance-panel', root)
    const body = qs('.sheet-body', dialog)
    const row = (name: string) => qs(`[data-row="${name}"]`, dialog)
    const darkThemeRow = row('darkTheme')
    const columnsRow = row('columns')
    const pageTurnRow = row('pageTurn')
    const autoDarkHalf = qs('.appearance-chip-auto > :last-child', dialog)
    const fontSelect = qs<HTMLSelectElement>('#appearance-font', dialog)
    const sizeSlider = qs<HTMLInputElement>('[data-slider="fontSize"]', dialog)
    const sizeOutput = qs('[data-output="fontSize"]', dialog)
    const smaller = qs('[data-step="-1"]', dialog)
    const larger = qs('[data-step="1"]', dialog)
    const lineSwitch = qs<HTMLInputElement>('[data-switch="lineHeight"]', dialog)
    const lineSlider = qs<HTMLInputElement>('[data-slider="lineHeight"]', dialog)
    const lineOutput = qs('[data-output="lineHeight"]', dialog)

    const radios = new Map(
        CHOICE_KEYS.map((key) => [
            key,
            qsa<HTMLInputElement>(`input[name="${RADIO_PREFIX}${key}"]`, dialog),
        ]),
    )
    const switches = new Map(
        SWITCH_KEYS.map((key) => [key, qs<HTMLInputElement>(`[data-switch="${key}"]`, dialog)]),
    )
    const notice = createNotice(dialog)

    function buildFontMenu(): void {
        const groups = document.createDocumentFragment()
        for (const { label, entries } of groupedFontEntries(bookFonts)) {
            const group = document.createElement('optgroup')
            group.label = label
            for (const entry of entries) {
                // The name of a book font is text from the book file. The options show in the
                // font of the app, so the menu downloads no font.
                const option = document.createElement('option')
                option.value = entry.id
                option.textContent = entry.label
                group.append(option)
            }
            groups.append(group)
        }
        fontSelect.replaceChildren(groups)
    }

    function showSize(size: number): void {
        sizeOutput.textContent = `${size} px`
        sizeSlider.value = String(size)
        sizeSlider.setAttribute('aria-valuetext', `${size} pixels`)
        setRangeValue(sizeSlider)
        // A disabled button loses the focus. This state keeps it.
        smaller.setAttribute('aria-disabled', String(size <= FONT_SIZE_MIN))
        larger.setAttribute('aria-disabled', String(size >= FONT_SIZE_MAX))
    }

    function showLineHeight(lineHeight: number): void {
        lineOutput.textContent = lineHeight.toFixed(2)
        lineSlider.value = String(lineHeight)
        setRangeValue(lineSlider)
    }

    /** Sets each control from the store. */
    function sync(): void {
        const current = store.get()
        for (const key of CHOICE_KEYS) {
            const value = String(current[key])
            for (const input of radios.get(key)!) input.checked = input.value === value
        }
        for (const key of SWITCH_KEYS) switches.get(key)!.checked = current[key]

        darkThemeRow.hidden = current.theme !== 'auto'
        // The Auto swatch shows the dark theme that the system setting gives.
        autoDarkHalf.dataset.theme = current.darkTheme
        columnsRow.hidden = current.layout !== 'paged'
        pageTurnRow.hidden = current.layout !== 'paged'

        // The stored font can be a font of a different book, or a font that is not there now.
        // The book then shows in the publisher font.
        const known = resolveFontStack({ fontId: current.fontId, bookFonts }) !== null
        fontSelect.value = known ? current.fontId : PUBLISHER_FONT_ID

        showSize(current.fontSize)
        lineSwitch.checked = current.lineHeight === null
        lineSlider.disabled = current.lineHeight === null
        // Without a value in the store, the slider keeps the last one.
        if (current.lineHeight !== null) showLineHeight(current.lineHeight)
    }

    // A drag of a slider sends many input events. The store gets one change for each frame,
    // so the view lays out a large chapter one time for each frame at most.
    let waiting: SettingsPatch = {}
    let frame: number | null = null

    function send(): void {
        frame = null
        const patch = waiting
        waiting = {}
        store.update(patch)
    }

    function sendSoon(patch: SettingsPatch): void {
        Object.assign(waiting, patch)
        if (typeof requestAnimationFrame !== 'function') send()
        else frame ??= requestAnimationFrame(send)
    }

    function sendNow(): void {
        if (frame === null) return
        cancelAnimationFrame(frame)
        send()
    }

    function dropWaiting(): void {
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        waiting = {}
    }

    function onSlider(slider: HTMLInputElement): void {
        const value = Number(slider.value)
        // The store replaces a value that is not a number with the default.
        if (!Number.isFinite(value)) return
        if (slider === sizeSlider) {
            showSize(value)
            sendSoon({ fontSize: value })
        } else if (slider === lineSlider) {
            showLineHeight(value)
            sendSoon({ lineHeight: value })
        }
    }

    function onRadio(input: HTMLInputElement): void {
        const key = input.name.slice(RADIO_PREFIX.length) as ChoiceKey
        const choices: readonly unknown[] | undefined = CHOICES[key]
        const choice = choices?.find((candidate) => String(candidate) === input.value)
        if (choice !== undefined) store.update({ [key]: choice } as SettingsPatch)
    }

    function onSwitch(input: HTMLInputElement): void {
        const key = input.dataset.switch
        if (key === 'lineHeight') {
            store.update({ lineHeight: input.checked ? null : Number(lineSlider.value) })
        } else if (SWITCH_KEYS.includes(key as SwitchKey)) {
            store.update({ [key as SwitchKey]: input.checked })
        }
    }

    function step(direction: number): void {
        sendNow()
        const size = store.get().fontSize + direction * FONT_SIZE_STEP
        store.update({ fontSize: clamp(size, FONT_SIZE_MIN, FONT_SIZE_MAX) })
    }

    function reset(): void {
        dropWaiting()
        const before = store.get()
        store.update(pickAppearance(DEFAULT_SETTINGS))
        const after = store.get()
        if (APPEARANCE_KEYS.every((key) => after[key] === before[key])) return
        const previous = pickAppearance(before)
        notice.show({
            message: 'Reading settings reset',
            action: { label: 'Undo', onSelect: () => store.update(previous) },
        })
    }

    on(body, 'input', (event) => {
        const input = event.target
        if (input instanceof HTMLInputElement && input.type === 'range') onSlider(input)
    })

    on(body, 'change', (event) => {
        const input = event.target
        if (input === fontSelect) {
            const fontId = fontSelect.value
            store.update({ fontId })
            void ensureFontLoaded(fontId)
        } else if (!(input instanceof HTMLInputElement)) {
            return
        } else if (input.type === 'radio') {
            if (input.checked) onRadio(input)
        } else if (input.type === 'checkbox') {
            onSwitch(input)
        } else if (input.type === 'range') {
            // The drag ended. The last value must not wait for a frame.
            sendNow()
        }
    })

    on(body, 'click', (event) => {
        const button = (event.target as Element).closest<HTMLElement>('button')
        if (!button) return
        if (button.dataset.step) step(Number(button.dataset.step))
        else if (button.dataset.action === 'reset') reset()
    })

    sizeSlider.min = String(FONT_SIZE_MIN)
    sizeSlider.max = String(FONT_SIZE_MAX)
    sizeSlider.step = String(FONT_SIZE_STEP)
    lineSlider.min = String(LINE_HEIGHT_MIN)
    lineSlider.max = String(LINE_HEIGHT_MAX)
    lineSlider.step = String(LINE_HEIGHT_STEP)
    showLineHeight(DEFAULT_SETTINGS.lineHeight ?? LINE_HEIGHT_FALLBACK)
    buildFontMenu()
    sync()

    connectDialog(dialog)
    host.append(dialog)

    const unsubscribe = store.subscribe((next, previous) => {
        // A closed panel gets the values at its next open.
        if (!dialog.open) return
        if (APPEARANCE_KEYS.some((key) => next[key] !== previous[key])) sync()
    })

    return {
        open() {
            sync()
            openDialog(dialog)
        },
        close() {
            dialog.close()
        },
        destroy() {
            unsubscribe()
            dropWaiting()
            // A message on screen must not move to the toasts of the app at this close.
            notice.destroy()
            // The toasts of the app wait for the close event of an open dialog.
            if (dialog.open) dialog.close()
            dialog.remove()
        },
    }
}
