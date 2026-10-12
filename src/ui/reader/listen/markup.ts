/**
 * Static markup of the listen bar, its two menus and the voice sheet. It has no book data and
 * no voice data. Each string is parsed one time.
 */

/** The quick values of the speed menu. */
export const RATE_CHOICES: readonly number[] = [0.8, 1, 1.2, 1.5, 2]

/** The times of the sleep timer menu, in minutes. */
export const SLEEP_MINUTES: readonly number[] = [5, 10, 15, 30, 45, 60]

export const RATE_MENU_ID = 'listen-rate-menu'
export const SLEEP_MENU_ID = 'listen-sleep-menu'

/** The speech rate as the bar shows it, for example "1.0×". */
export function formatRate(rate: number): string {
    return `${rate.toFixed(1)}×`
}

function icon(name: string, size = ''): string {
    const classes = size ? `icon ${size}` : 'icon'
    return `<svg class="${classes}" aria-hidden="true"><use href="#i-${name}" /></svg>`
}

const BAR = `
<div class="toolbar toolbar-bottom listen-bar" role="group" aria-label="Listen" data-state="loading">
    <div class="listen-controls">
        <button class="icon-btn" type="button" data-action="previous" aria-label="Previous sentence">
            ${icon('skip-back')}
        </button>
        <button class="btn btn-primary listen-play" type="button" data-action="toggle" aria-label="Loading" aria-busy="true">
            ${icon('play', 'icon-lg')}
            <span class="spinner"></span>
        </button>
        <button class="icon-btn" type="button" data-action="next" aria-label="Next sentence">
            ${icon('skip-forward')}
        </button>
        <span class="toolbar-spacer"></span>
        <button
            class="btn btn-quiet btn-sm num listen-rate"
            type="button"
            data-action="rate"
            popovertarget="${RATE_MENU_ID}"
            aria-haspopup="dialog"
            aria-expanded="false"
        ></button>
        <button class="icon-btn" type="button" data-action="voices" aria-label="Voice" aria-haspopup="dialog">
            ${icon('volume')}
        </button>
        <button
            class="icon-btn listen-sleep"
            type="button"
            data-action="sleep"
            popovertarget="${SLEEP_MENU_ID}"
            aria-haspopup="menu"
            aria-expanded="false"
            aria-label="Sleep timer"
        >
            ${icon('clock')}
            <span class="listen-sleep-left num" aria-hidden="true" hidden></span>
        </button>
    </div>
    <p class="listen-message" role="status" hidden>This browser has no speech voices.</p>
    <button class="icon-btn" type="button" data-action="close" aria-label="Stop listening">
        ${icon('x')}
    </button>
</div>`

const RATE_MENU = `
<div class="menu listen-rate-menu" id="${RATE_MENU_ID}" popover role="dialog" aria-label="Speed">
    <div class="stepper" role="group" aria-label="Speed">
        <button class="stepper-btn" type="button" data-step="-1" aria-label="Slower">
            ${icon('minus')}
        </button>
        <output class="stepper-value"></output>
        <button class="stepper-btn" type="button" data-step="1" aria-label="Faster">
            ${icon('plus')}
        </button>
    </div>
    <hr class="menu-separator" />
    <div role="radiogroup" aria-label="Common speeds">
        ${RATE_CHOICES.map(
            (rate) =>
                `<button class="menu-item num" type="button" role="radio" aria-checked="false" data-rate="${rate}">${formatRate(rate)}</button>`,
        ).join('')}
    </div>
</div>`

const SLEEP_MENU = `
<div class="menu" id="${SLEEP_MENU_ID}" popover role="menu" aria-label="Sleep timer">
    <button class="menu-item" type="button" role="menuitemradio" aria-checked="true" data-sleep="off">Off</button>
    ${SLEEP_MINUTES.map(
        (minutes) =>
            `<button class="menu-item" type="button" role="menuitemradio" aria-checked="false" data-sleep="${minutes}">${minutes} minutes</button>`,
    ).join('')}
    <button class="menu-item" type="button" role="menuitemradio" aria-checked="false" data-sleep="chapter">End of the chapter</button>
</div>`

const VOICE_SHEET = `
<dialog class="sheet listen-voices" aria-labelledby="listen-voices-title" closedby="any" autofocus>
    <header class="sheet-header">
        <h2 class="sheet-title" id="listen-voices-title">Voice</h2>
        <button class="icon-btn" type="button" aria-label="Close" data-close>
            ${icon('x', 'icon-lg')}
        </button>
    </header>
    <div class="sheet-body listen-voice-body">
        <div class="listen-voice-groups" role="radiogroup" aria-labelledby="listen-voices-title">
            <div class="list listen-voice-list" data-group="book"></div>
            <details class="listen-voice-more">
                <summary class="list-row">
                    <span class="list-row-body">Other languages</span>
                    ${icon('chevron-down')}
                </summary>
                <div class="list list-long listen-voice-list" data-group="other"></div>
            </details>
        </div>
        <p class="listen-voice-empty text-muted" hidden>This browser has no speech voices.</p>
    </div>
    <div class="listen-voice-options">
        <label class="slider-row">
            <span class="slider-label">Pitch</span>
            <input class="slider" type="range" data-setting="pitch" />
            <output class="slider-value"></output>
        </label>
        <label class="field field-inline">
            <span class="field-label">Highlight each word</span>
            <span class="field-help">Some voices do not report words. Then the sentence is highlighted.</span>
            <input class="switch" type="checkbox" role="switch" data-setting="highlight-words" />
        </label>
    </div>
</dialog>`

const VOICE_ROW = `
<button class="list-row listen-voice" type="button" role="radio" aria-checked="false" tabindex="-1">
    <span class="list-row-body">
        <span class="list-row-title"></span>
        <span class="list-row-meta"></span>
    </span>
    ${icon('check')}
</button>`

const templates = new Map<string, HTMLTemplateElement>()

function clone<T extends Element>(markup: string): T {
    let template = templates.get(markup)
    if (!template) {
        template = document.createElement('template')
        template.innerHTML = markup.trim()
        templates.set(markup, template)
    }
    return document.importNode(template.content.firstElementChild as T, true)
}

export const cloneBar = (): HTMLElement => clone(BAR)
export const cloneRateMenu = (): HTMLElement => clone(RATE_MENU)
export const cloneSleepMenu = (): HTMLElement => clone(SLEEP_MENU)
export const cloneVoiceSheet = (): HTMLDialogElement => clone(VOICE_SHEET)
export const cloneVoiceRow = (): HTMLButtonElement => clone(VOICE_ROW)
