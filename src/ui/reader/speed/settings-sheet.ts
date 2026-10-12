/**
 * The settings sheet of the speed reader and the confirmation dialog of "Start the book again".
 * The speed reader loads this file when the user opens the sheet for the first time.
 *
 * Each control writes to the settings store. The sheet shows what the store has, so a change
 * from a key or from a different tab also shows here.
 */

import type { RsvpTimer } from '$lib/rsvp'
import {
    DEFAULT_SETTINGS,
    RSVP_CONTEXT_WORDS_MAX,
    RSVP_CONTEXT_WORDS_MIN,
    RSVP_CONTEXT_WORDS_STEP,
    RSVP_FONT_SIZE_MAX,
    RSVP_FONT_SIZE_MIN,
    RSVP_FONT_SIZE_STEP,
    RSVP_MULTIPLIER_MAX,
    RSVP_MULTIPLIER_MIN,
    RSVP_MULTIPLIER_STEP,
    RSVP_WPM_MAX,
    RSVP_WPM_MIN,
    RSVP_WPM_STEP,
} from '$lib/settings'
import type { RsvpSettings, SettingsStore } from '$lib/settings'
import { connectDialog, openDialog } from '../../app/dialog'
import { qs, qsa, setRangeValue } from '../../dom'
import { holdRepeat } from './hold-repeat'

export const WPM_PRESETS: readonly number[] = [200, 300, 400, 500, 600]

type NumberKey = {
    [K in keyof RsvpSettings]: RsvpSettings[K] extends number ? K : never
}[keyof RsvpSettings]

type BooleanKey = {
    [K in keyof RsvpSettings]: RsvpSettings[K] extends boolean ? K : never
}[keyof RsvpSettings]

interface NumberControl {
    key: NumberKey
    label: string
    min: number
    max: number
    step: number
    format(value: number): string
}

const SLIDERS: readonly NumberControl[] = [
    {
        key: 'wpm',
        label: 'Speed',
        min: RSVP_WPM_MIN,
        max: RSVP_WPM_MAX,
        step: RSVP_WPM_STEP,
        format: (value) => `${value} wpm`,
    },
    {
        key: 'fontSize',
        label: 'Word size',
        min: RSVP_FONT_SIZE_MIN,
        max: RSVP_FONT_SIZE_MAX,
        step: RSVP_FONT_SIZE_STEP,
        format: (value) => `${value} px`,
    },
]

const CONTEXT_WORDS: NumberControl = {
    key: 'contextWords',
    label: 'Context words',
    min: RSVP_CONTEXT_WORDS_MIN,
    max: RSVP_CONTEXT_WORDS_MAX,
    step: RSVP_CONTEXT_WORDS_STEP,
    format: String,
}

function pause(key: NumberKey, label: string): NumberControl {
    return {
        key,
        label,
        min: RSVP_MULTIPLIER_MIN,
        max: RSVP_MULTIPLIER_MAX,
        step: RSVP_MULTIPLIER_STEP,
        format: (value) => `${value}×`,
    }
}

const PAUSES: readonly NumberControl[] = [
    pause('periodMultiplier', 'Full stop'),
    pause('commaMultiplier', 'Comma'),
    pause('semicolonMultiplier', 'Semicolon and colon'),
    pause('exclamationMultiplier', 'Exclamation and question mark'),
    pause('paragraphMultiplier', 'End of paragraph'),
    pause('headingMultiplier', 'End of heading'),
]

const STEPPERS: readonly NumberControl[] = [CONTEXT_WORDS, ...PAUSES]

const SWITCHES: readonly { key: BooleanKey; label: string }[] = [
    { key: 'showPivot', label: 'Highlight the pivot letter' },
    { key: 'rampUp', label: 'Start slowly after a pause' },
    { key: 'longWordDelay', label: 'More time for long words' },
    { key: 'pauseAtChapterStart', label: 'Pause at the start of each chapter' },
]

function icon(name: string, size = ''): string {
    return `<svg class="icon${size}" aria-hidden="true"><use href="#i-${name}" /></svg>`
}

function sliderMarkup({ key, label, min, max, step }: NumberControl): string {
    return `
        <label class="slider-row slider-row-stacked">
            <span class="slider-label">${label}</span>
            <input class="slider" type="range" data-setting="${key}"
                min="${min}" max="${max}" step="${step}" />
            <output class="slider-value"></output>
        </label>`
}

function stepperMarkup({ key, label }: NumberControl): string {
    return `
        <div class="field field-inline">
            <span class="field-label">${label}</span>
            <div class="stepper" role="group" aria-label="${label}" data-setting="${key}">
                <button class="stepper-btn" type="button" data-step="-1" aria-label="Decrease">
                    ${icon('minus')}
                </button>
                <output class="stepper-value"></output>
                <button class="stepper-btn" type="button" data-step="1" aria-label="Increase">
                    ${icon('plus')}
                </button>
            </div>
        </div>`
}

function switchMarkup({ key, label }: { key: BooleanKey; label: string }): string {
    return `
        <label class="field field-inline">
            <span class="field-label">${label}</span>
            <input class="switch" type="checkbox" role="switch" data-setting="${key}" />
        </label>`
}

function presetMarkup(wpm: number): string {
    return `
            <button class="btn btn-sm" type="button" data-wpm="${wpm}"
                aria-pressed="false">${wpm}</button>`
}

// All text here is from this file. No text of a book goes into this markup.
const MARKUP = `
<dialog class="sheet speed-sheet" aria-labelledby="speed-sheet-title" closedby="any" autofocus>
    <header class="sheet-header">
        <h2 class="sheet-title" id="speed-sheet-title">Speed reader</h2>
        <button class="icon-btn" type="button" data-close aria-label="Close">
            ${icon('x', ' icon-lg')}
        </button>
    </header>
    <div class="sheet-body stack">
        <div class="field">
            ${sliderMarkup(SLIDERS[0])}
            <div class="cluster speed-presets" role="group" aria-label="Speed presets">
                ${WPM_PRESETS.map(presetMarkup).join('')}
            </div>
        </div>
        <div class="field">
            ${sliderMarkup(SLIDERS[1])}
            ${stepperMarkup(CONTEXT_WORDS)}
            ${SWITCHES.map(switchMarkup).join('')}
        </div>
        <div class="field" role="group" aria-labelledby="speed-pauses-title">
            <p class="section-label" id="speed-pauses-title">Pauses</p>
            <p class="field-help">How many times longer a word stays on screen.</p>
            ${PAUSES.map(stepperMarkup).join('')}
        </div>
        <div class="speed-sheet-actions">
            <button class="btn btn-quiet" type="button" data-action="reset">
                ${icon('rotate-ccw')}
                <span>Reset speed reader settings</span>
            </button>
            <button class="btn" type="button" data-action="restart">Start the book again</button>
        </div>
    </div>
</dialog>
<dialog class="modal speed-confirm" aria-labelledby="speed-confirm-title" closedby="any">
    <h2 class="modal-title" id="speed-confirm-title">Go to the first word of the book?</h2>
    <p class="modal-body">The reading position goes back to the start of the book.</p>
    <div class="modal-actions">
        <button class="btn btn-quiet" type="button" data-close value="cancel">Cancel</button>
        <button class="btn btn-primary" type="button" data-close value="confirm">
            Start again
        </button>
    </div>
</dialog>`

let template: HTMLTemplateElement | undefined

function cloneDialogs(): DocumentFragment {
    if (!template) {
        template = document.createElement('template')
        template.innerHTML = MARKUP
    }
    return document.importNode(template.content, true)
}

/** Removes binary noise such as 2.5000000000000004 from a sum of steps. */
function round(value: number): number {
    return Math.round(value * 100) / 100
}

export interface SettingsSheetOptions {
    /** The overlay. The two dialogs go into it. */
    parent: HTMLElement
    settings: SettingsStore
    timer: Pick<RsvpTimer, 'setTimeout' | 'clearTimeout'>
    /** The user confirmed "Start the book again". The sheet is closed at this time. */
    onRestart(): void
}

export interface SettingsSheet {
    /** True while the sheet or its confirmation dialog is open. */
    readonly isOpen: boolean
    /** The focus goes back to `opener` when the sheet closes. */
    open(opener: Element | null): void
    close(): void
    destroy(): void
}

export function createSettingsSheet(options: SettingsSheetOptions): SettingsSheet {
    const { parent, settings, timer } = options
    const fragment = cloneDialogs()
    const sheet = qs<HTMLDialogElement>('.speed-sheet', fragment)
    const confirm = qs<HTMLDialogElement>('.speed-confirm', fragment)
    const sliders = qsa<HTMLInputElement>('.slider', sheet)
    const switches = qsa<HTMLInputElement>('.switch', sheet)
    const steppers = qsa('.stepper', sheet)
    const presets = qsa<HTMLButtonElement>('[data-wpm]', sheet)
    const removers: (() => void)[] = []
    let unsubscribe: (() => void) | null = null

    function setNumber(key: NumberKey, value: number): void {
        const patch: Partial<RsvpSettings> = {}
        patch[key] = value
        settings.update({ rsvp: patch })
    }

    function setBoolean(key: BooleanKey, value: boolean): void {
        const patch: Partial<RsvpSettings> = {}
        patch[key] = value
        settings.update({ rsvp: patch })
    }

    function controlOf(list: readonly NumberControl[], element: HTMLElement): NumberControl {
        const control = list.find((entry) => entry.key === element.dataset.setting)
        if (!control) throw new Error(`No setting has the name "${element.dataset.setting}"`)
        return control
    }

    /** Moves a stepper by one step. Returns false at a limit. */
    function step(control: NumberControl, direction: number): boolean {
        const current = settings.get().rsvp[control.key]
        const next = Math.min(
            control.max,
            Math.max(control.min, round(current + direction * control.step)),
        )
        if (next === current) return false
        setNumber(control.key, next)
        return true
    }

    function setText(element: HTMLElement, text: string): void {
        if (element.textContent !== text) element.textContent = text
    }

    function setLimit(button: HTMLElement, atLimit: boolean): void {
        // aria-disabled keeps the focus on the button. The disabled attribute moves it away.
        if (atLimit) button.setAttribute('aria-disabled', 'true')
        else button.removeAttribute('aria-disabled')
    }

    function render(rsvp: RsvpSettings): void {
        for (const input of sliders) {
            const control = controlOf(SLIDERS, input)
            const value = String(rsvp[control.key])
            // A write of the same value can stop the drag of the thumb in some browsers.
            if (input.value !== value) input.value = value
            setRangeValue(input)
            setText(
                qs('.slider-value', input.parentElement ?? sheet),
                control.format(rsvp[control.key]),
            )
        }
        for (const button of presets) {
            button.setAttribute('aria-pressed', String(Number(button.dataset.wpm) === rsvp.wpm))
        }
        for (const input of switches) {
            input.checked = rsvp[input.dataset.setting as BooleanKey]
        }
        for (const stepper of steppers) {
            const control = controlOf(STEPPERS, stepper)
            const value = rsvp[control.key]
            setText(qs('.stepper-value', stepper), control.format(value))
            setLimit(qs('[data-step="-1"]', stepper), value <= control.min)
            setLimit(qs('[data-step="1"]', stepper), value >= control.max)
        }
    }

    function stopListening(): void {
        unsubscribe?.()
        unsubscribe = null
    }

    function close(): void {
        if (confirm.open) confirm.close('')
        if (sheet.open) sheet.close()
        stopListening()
    }

    connectDialog(sheet)
    connectDialog(confirm)

    sheet.addEventListener('input', (event) => {
        const input = event.target as HTMLInputElement
        if (!input.classList.contains('slider')) return
        const value = input.valueAsNumber
        // An invalid value in the store gives the default, so it never goes there.
        if (Number.isFinite(value)) setNumber(controlOf(SLIDERS, input).key, value)
    })

    sheet.addEventListener('change', (event) => {
        const input = event.target as HTMLInputElement
        if (!input.classList.contains('switch')) return
        setBoolean(input.dataset.setting as BooleanKey, input.checked)
    })

    sheet.addEventListener('click', (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(
            '[data-wpm], [data-action]',
        )
        if (!button) return
        if (button.dataset.wpm) setNumber('wpm', Number(button.dataset.wpm))
        else if (button.dataset.action === 'reset') {
            settings.update({ rsvp: { ...DEFAULT_SETTINGS.rsvp } })
        } else if (button.dataset.action === 'restart') openDialog(confirm, button)
    })

    for (const stepper of steppers) {
        const control = controlOf(STEPPERS, stepper)
        for (const button of qsa('[data-step]', stepper)) {
            const direction = Number(button.dataset.step)
            removers.push(holdRepeat({ button, timer, onStep: () => step(control, direction) }))
        }
    }

    sheet.addEventListener('close', () => {
        // The event comes late. The sheet can be open again at that time.
        if (!sheet.open) stopListening()
    })

    confirm.addEventListener('close', () => {
        if (confirm.returnValue !== 'confirm') return
        if (sheet.open) sheet.close()
        options.onRestart()
    })

    parent.append(fragment)

    return {
        get isOpen() {
            return sheet.open || confirm.open
        },
        open(opener) {
            if (sheet.open) return
            render(settings.get().rsvp)
            unsubscribe ??= settings.subscribe((next, previous) => {
                if (next.rsvp !== previous.rsvp) render(next.rsvp)
            })
            openDialog(sheet, opener)
        },
        close,
        destroy() {
            close()
            for (const remove of removers.splice(0)) remove()
            sheet.remove()
            confirm.remove()
        },
    }
}
