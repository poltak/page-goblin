import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installOverlayMethods } from '../../app/testing/page'
import { qs } from '../../dom'
import { formatRate, RATE_MENU_ID, SLEEP_MENU_ID } from './markup'
import type { SleepChoice } from './sleep-timer'
import { createBarView, stepRate, type BarViewOptions } from './view'

function make(changes: Partial<BarViewOptions> = {}) {
    const options: BarViewOptions = {
        onToggle: vi.fn<() => void>(),
        onPrevious: vi.fn<() => void>(),
        onNext: vi.fn<() => void>(),
        onRate: vi.fn<(rate: number) => void>(),
        onSleep: vi.fn<(choice: SleepChoice) => void>(),
        onVoices: vi.fn<(opener: HTMLElement) => void>(),
        onClose: vi.fn<() => void>(),
        getRate: () => 1,
        getSleep: () => 'off',
        ...changes,
    }
    const view = createBarView(options)
    view.mount({ dock: qs('#dock'), host: qs('#host') })
    return { view, options }
}

function button(action: string): HTMLButtonElement {
    return qs<HTMLButtonElement>(`[data-action="${action}"]`)
}

beforeEach(() => {
    installOverlayMethods()
    document.body.innerHTML = '<div id="dock"></div><div id="host"></div>'
})

afterEach(() => {
    document.body.innerHTML = ''
})

describe('formatRate', () => {
    it('shows one decimal place', () => {
        expect(formatRate(1)).toBe('1.0×')
        expect(formatRate(0.8)).toBe('0.8×')
        expect(formatRate(2)).toBe('2.0×')
    })
})

describe('stepRate', () => {
    it('steps by 0.1 with no binary noise', () => {
        expect(stepRate(1, 1)).toBe(1.1)
        expect(stepRate(1.1, 1)).toBe(1.2)
        expect(stepRate(0.7, -1)).toBe(0.6)
        expect(stepRate(1.2, -1)).toBe(1.1)
    })

    it('stays in the limits', () => {
        expect(stepRate(2, 1)).toBe(2)
        expect(stepRate(0.5, -1)).toBe(0.5)
    })
})

describe('createBarView', () => {
    it('puts the bar in the dock and the menus in the overlay layer', () => {
        const { view } = make()
        expect(view.element.parentElement).toBe(qs('#dock'))
        expect(view.element.classList.contains('toolbar')).toBe(true)
        expect(qs(`#${RATE_MENU_ID}`).parentElement).toBe(qs('#host'))
        expect(qs(`#${SLEEP_MENU_ID}`).parentElement).toBe(qs('#host'))

        view.unmount()
        expect(qs('#dock').childElementCount).toBe(0)
        expect(qs('#host').childElementCount).toBe(0)
    })

    it('has the controls in the specified order', () => {
        make()
        const actions = Array.from(document.querySelectorAll('#dock [data-action]')).map(
            (element) => (element as HTMLElement).dataset.action,
        )
        expect(actions).toEqual(['previous', 'toggle', 'next', 'rate', 'voices', 'sleep', 'close'])
    })

    it('gives each click to its handler', () => {
        const { options } = make()
        button('toggle').click()
        button('previous').click()
        button('next').click()
        button('voices').click()
        button('close').click()
        expect(options.onToggle).toHaveBeenCalledTimes(1)
        expect(options.onPrevious).toHaveBeenCalledTimes(1)
        expect(options.onNext).toHaveBeenCalledTimes(1)
        expect(options.onVoices).toHaveBeenCalledWith(button('voices'))
        expect(options.onClose).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['loading', 'Loading', '#i-play', false],
        ['playing', 'Pause', '#i-pause', true],
        ['paused', 'Play', '#i-play', true],
    ] as const)('shows the state %s on the play button', (state, label, icon, spinnerHidden) => {
        const { view } = make()
        // A different state first, so that each state is a change.
        view.setState(state === 'paused' ? 'playing' : 'paused')
        view.setState(state)
        const play = button('toggle')
        expect(view.element.dataset.state).toBe(state)
        expect(play.getAttribute('aria-label')).toBe(label)
        expect(play.getAttribute('aria-busy')).toBe(String(state === 'loading'))
        expect(qs('use', play).getAttribute('href')).toBe(icon)
        expect(qs('.spinner', play).hidden).toBe(spinnerHidden)
        expect(qs('.icon', play).hasAttribute('hidden')).toBe(!spinnerHidden)
    })

    it('shows only the text and the close button when no voice is available', () => {
        const { view } = make()
        button('sleep').click()
        expect(view.menuOpen).toBe(true)

        view.setState('unavailable')
        expect(qs('.listen-controls').hidden).toBe(true)
        expect(qs('.listen-message').hidden).toBe(false)
        expect(button('close').closest('[hidden]')).toBeNull()
        expect(view.menuOpen).toBe(false)

        view.setState('paused')
        expect(qs('.listen-controls').hidden).toBe(false)
        expect(qs('.listen-message').hidden).toBe(true)
    })

    it('gives the focus to the play button', () => {
        const { view } = make()
        view.focus()
        expect(document.activeElement).toBe(button('toggle'))
    })

    it('gives the focus to the close button when only that one shows', () => {
        const { view } = make()
        view.setState('unavailable')
        view.unmount()
        view.mount({ dock: qs('#dock'), host: qs('#host') })
        view.focus()
        expect(document.activeElement).toBe(button('close'))
    })

    it('moves the focus to the close button when the controls go away', () => {
        const { view } = make()
        button('sleep').focus()
        view.setState('unavailable')
        expect(document.activeElement).toBe(button('close'))
    })

    it('leaves the focus alone when it is not in the controls that go away', () => {
        const { view } = make()
        const other = document.body.appendChild(document.createElement('button'))
        other.focus()
        view.setState('unavailable')
        expect(document.activeElement).toBe(other)

        button('close').focus()
        view.setState('paused')
        expect(document.activeElement).toBe(button('close'))
    })

    it('opens and closes the speed menu with its button', () => {
        const { view } = make()
        const rate = button('rate')
        const event = new MouseEvent('click', { bubbles: true, cancelable: true })
        rate.dispatchEvent(event)
        // The script opens the menu, not the popovertarget attribute.
        expect(event.defaultPrevented).toBe(true)
        expect(view.menuOpen).toBe(true)
        expect(rate.getAttribute('aria-expanded')).toBe('true')

        rate.click()
        expect(view.menuOpen).toBe(false)
        expect(rate.getAttribute('aria-expanded')).toBe('false')
    })

    it('gives a quick value and a step to the rate handler', () => {
        const { view, options } = make({ getRate: () => 1.3 })
        view.setRate(1.3)
        button('rate').click()
        const menu = qs(`#${RATE_MENU_ID}`)
        const quick = Array.from(menu.querySelectorAll('[data-rate]')).map(
            (item) => item.textContent,
        )
        expect(quick).toEqual(['0.8×', '1.0×', '1.2×', '1.5×', '2.0×'])
        // No quick value is the rate.
        expect(menu.querySelector('[aria-checked="true"]')).toBeNull()

        qs('[data-step="1"]', menu).click()
        expect(options.onRate).toHaveBeenLastCalledWith(1.4)
        qs('[data-step="-1"]', menu).click()
        expect(options.onRate).toHaveBeenLastCalledWith(1.2)
        expect(view.menuOpen).toBe(true)

        qs('[data-rate="2"]', menu).click()
        expect(options.onRate).toHaveBeenLastCalledWith(2)
        expect(view.menuOpen).toBe(false)
    })

    it('gives the choice of the sleep menu to the handler', () => {
        const { options } = make({ getSleep: () => 30 })
        button('sleep').click()
        const menu = qs(`#${SLEEP_MENU_ID}`)
        expect(qs('[aria-checked="true"]', menu).dataset.sleep).toBe('30')

        qs('[data-sleep="45"]', menu).click()
        expect(options.onSleep).toHaveBeenLastCalledWith(45)
        button('sleep').click()
        qs('[data-sleep="chapter"]', menu).click()
        expect(options.onSleep).toHaveBeenLastCalledWith('chapter')
        button('sleep').click()
        qs('[data-sleep="off"]', menu).click()
        expect(options.onSleep).toHaveBeenLastCalledWith('off')
    })

    it('shows the sleep timer on its button', () => {
        const { view } = make()
        const sleep = button('sleep')
        const left = qs('.listen-sleep-left')

        view.setSleep({ choice: 15, minutesLeft: 12 })
        expect(left.hidden).toBe(false)
        expect(left.textContent).toBe('12')
        expect(sleep.getAttribute('aria-label')).toBe('Sleep timer, 12 minutes left')
        expect(sleep.classList.contains('is-on')).toBe(true)

        view.setSleep({ choice: 'chapter', minutesLeft: null })
        expect(left.hidden).toBe(true)
        expect(sleep.getAttribute('aria-label')).toBe('Sleep timer, to the end of the chapter')
        expect(sleep.classList.contains('is-on')).toBe(true)

        view.setSleep({ choice: 'off', minutesLeft: null })
        expect(left.hidden).toBe(true)
        expect(sleep.getAttribute('aria-label')).toBe('Sleep timer')
        expect(sleep.classList.contains('is-on')).toBe(false)
    })
})
