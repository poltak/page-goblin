/** The elements of the listen bar and its two menus. The behaviour is in bar.ts. */

import { SPEECH_RATE_MAX, SPEECH_RATE_MIN, SPEECH_RATE_STEP } from '$lib/settings'
import { createMenu } from '../../app/menu'
import { on, qs, qsa, setIcon } from '../../dom'
import { cloneBar, cloneRateMenu, cloneSleepMenu, formatRate } from './markup'
import type { SleepChoice } from './sleep-timer'

/**
 * - 'loading'      a chapter loads, or speech did not start yet
 * - 'playing'      the button pauses
 * - 'paused'       the button plays
 * - 'unavailable'  the browser has no voices. Only the text and the close button show.
 */
export type BarState = 'loading' | 'playing' | 'paused' | 'unavailable'

export interface BarViewOptions {
    /** The play button. The call is in the task of the click. */
    onToggle(): void
    onPrevious(): void
    onNext(): void
    onRate(rate: number): void
    onSleep(choice: SleepChoice): void
    /** The voice button. The sheet gives the focus back to `opener`. */
    onVoices(opener: HTMLElement): void
    onClose(): void
    getRate(): number
    getSleep(): SleepChoice
}

export interface BarView {
    readonly element: HTMLElement
    /** True while the speed menu or the sleep timer menu is open. */
    readonly menuOpen: boolean
    /** Puts the bar in the dock and the menus in the overlay layer. */
    mount(place: { dock: HTMLElement; host: HTMLElement }): void
    unmount(): void
    /** Gives the focus to the play button, or to the close button when only that one shows. */
    focus(): void
    setState(state: BarState): void
    setRate(rate: number): void
    setSleep(sleep: { choice: SleepChoice; minutesLeft: number | null }): void
}

const PLAY_LABELS: Record<BarState, string> = {
    loading: 'Loading',
    playing: 'Pause',
    paused: 'Play',
    unavailable: 'Play',
}

/** One step of the speed stepper. The result has one decimal place. */
export function stepRate(rate: number, direction: number): number {
    const next = Math.round((rate + direction * SPEECH_RATE_STEP) * 10) / 10
    return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, next))
}

function sleepLabel(choice: SleepChoice, minutesLeft: number | null): string {
    if (choice === 'chapter') return 'Sleep timer, to the end of the chapter'
    if (choice === 'off' || minutesLeft === null) return 'Sleep timer'
    return minutesLeft === 1
        ? 'Sleep timer, 1 minute left'
        : `Sleep timer, ${minutesLeft} minutes left`
}

export function createBarView(options: BarViewOptions): BarView {
    const bar = cloneBar()
    const controls = qs('.listen-controls', bar)
    const message = qs('.listen-message', bar)
    const play = qs<HTMLButtonElement>('[data-action="toggle"]', bar)
    const playIcon = qs<SVGElement>('.icon', play)
    const spinner = qs('.spinner', play)
    const rateButton = qs<HTMLButtonElement>('[data-action="rate"]', bar)
    const sleepButton = qs<HTMLButtonElement>('[data-action="sleep"]', bar)
    const sleepLeft = qs('.listen-sleep-left', bar)
    const closeButton = qs<HTMLButtonElement>('[data-action="close"]', bar)

    const rateMenuElement = cloneRateMenu()
    const stepValue = qs('.stepper-value', rateMenuElement)
    const slower = qs<HTMLButtonElement>('[data-step="-1"]', rateMenuElement)
    const faster = qs<HTMLButtonElement>('[data-step="1"]', rateMenuElement)
    const sleepMenuElement = cloneSleepMenu()

    let state: BarState | null = null
    let shownRate = Number.NaN

    const rateMenu = createMenu({
        menu: rateMenuElement,
        onSelect(item) {
            const rate = Number(item.dataset.rate)
            if (Number.isFinite(rate)) options.onRate(rate)
        },
    })

    const sleepMenu = createMenu({
        menu: sleepMenuElement,
        onOpen() {
            const choice = String(options.getSleep())
            for (const item of qsa('[data-sleep]', sleepMenuElement)) {
                item.setAttribute('aria-checked', String(item.dataset.sleep === choice))
            }
        },
        onSelect(item) {
            const value = item.dataset.sleep
            options.onSleep(value === 'off' || value === 'chapter' ? value : Number(value))
        },
    })

    on(bar, 'click', (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]')
        if (!button) return
        switch (button.dataset.action) {
            case 'toggle':
                options.onToggle()
                break
            case 'previous':
                options.onPrevious()
                break
            case 'next':
                options.onNext()
                break
            case 'rate':
                // This script opens the menu, not the popovertarget attribute.
                event.preventDefault()
                rateMenu.toggle(button)
                break
            case 'sleep':
                event.preventDefault()
                sleepMenu.toggle(button)
                break
            case 'voices':
                options.onVoices(button)
                break
            case 'close':
                options.onClose()
                break
        }
    })

    // A step keeps the menu open, so that the user can go more than one step.
    on(rateMenuElement, 'click', (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-step]')
        if (button) options.onRate(stepRate(options.getRate(), Number(button.dataset.step)))
    })

    function setRate(rate: number): void {
        if (rate === shownRate) return
        shownRate = rate
        const text = formatRate(rate)
        rateButton.textContent = text
        rateButton.setAttribute('aria-label', `Speed, ${text}`)
        stepValue.textContent = text
        // Not the disabled attribute: a button that has the focus would lose it at the limit.
        slower.setAttribute('aria-disabled', String(rate <= SPEECH_RATE_MIN))
        faster.setAttribute('aria-disabled', String(rate >= SPEECH_RATE_MAX))
        for (const item of qsa('[data-rate]', rateMenuElement)) {
            item.setAttribute('aria-checked', String(Number(item.dataset.rate) === rate))
        }
    }

    return {
        element: bar,

        get menuOpen() {
            return (
                rateButton.getAttribute('aria-expanded') === 'true' ||
                sleepButton.getAttribute('aria-expanded') === 'true'
            )
        },

        mount({ dock, host }) {
            dock.append(bar)
            host.append(rateMenuElement, sleepMenuElement)
        },

        unmount() {
            rateMenu.close()
            sleepMenu.close()
            bar.remove()
            rateMenuElement.remove()
            sleepMenuElement.remove()
        },

        focus() {
            const target = controls.hidden ? closeButton : play
            target.focus({ preventScroll: true })
        },

        setState(next) {
            if (next === state) return
            state = next
            bar.dataset.state = next
            const loading = next === 'loading'
            const unavailable = next === 'unavailable'
            setIcon(playIcon, next === 'playing' ? 'pause' : 'play')
            playIcon.toggleAttribute('hidden', loading)
            spinner.hidden = !loading
            play.setAttribute('aria-label', PLAY_LABELS[next])
            play.setAttribute('aria-busy', String(loading))
            if (unavailable) {
                // A menu that closes gives the focus back to its button.
                rateMenu.close()
                sleepMenu.close()
            }
            // A control that becomes hidden must not keep the focus.
            const focusLeaves = unavailable && controls.contains(document.activeElement)
            controls.hidden = unavailable
            message.hidden = !unavailable
            if (focusLeaves) closeButton.focus({ preventScroll: true })
        },

        setRate,

        setSleep({ choice, minutesLeft }) {
            const timed = typeof choice === 'number' && minutesLeft !== null
            sleepButton.classList.toggle('is-on', choice !== 'off')
            sleepButton.setAttribute('aria-label', sleepLabel(choice, minutesLeft))
            sleepLeft.hidden = !timed
            sleepLeft.textContent = timed ? String(minutesLeft) : ''
        },
    }
}
