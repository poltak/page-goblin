import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    clearToasts,
    showToast,
    TOAST_ACTION_DURATION_MS,
    TOAST_DURATION_MS,
    TOAST_LEAVE_MS,
    TOAST_MIN_MS,
} from './toast'

function toasts(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('#toasts .toast'))
}

function messages(): string[] {
    return toasts().map((toast) => toast.querySelector('span')?.textContent ?? '')
}

beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="toasts" aria-live="polite"></div>'
})

afterEach(() => {
    clearToasts()
    vi.useRealTimers()
})

describe('showToast', () => {
    it('shows the message as text in the toast container', () => {
        showToast({ message: 'Bookmark added' })

        expect(messages()).toEqual(['Bookmark added'])
        expect(toasts()[0].className).toBe('toast')
    })

    it('does not read the message as HTML', () => {
        showToast({ message: '<img src=x onerror=alert(1)>' })

        expect(toasts()[0].querySelector('img')).toBeNull()
        expect(messages()).toEqual(['<img src=x onerror=alert(1)>'])
    })

    it('marks the toast as leaving, then removes it after the leave time', () => {
        showToast({ message: 'One' })

        vi.advanceTimersByTime(TOAST_DURATION_MS - 1)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(false)

        vi.advanceTimersByTime(1)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(true)

        vi.advanceTimersByTime(TOAST_LEAVE_MS - 1)
        expect(toasts()).toHaveLength(1)

        vi.advanceTimersByTime(1)
        expect(toasts()).toHaveLength(0)
    })

    it('shows one toast at a time and the others in order', () => {
        showToast({ message: 'One' })
        showToast({ message: 'Two' })
        showToast({ message: 'Three' })
        expect(messages()).toEqual(['One'])

        // A toast that others wait for stays for the minimum time.
        vi.advanceTimersByTime(TOAST_MIN_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Two'])

        vi.advanceTimersByTime(TOAST_MIN_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Three'])

        // The last one has its full time.
        vi.advanceTimersByTime(TOAST_DURATION_MS - 1)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(false)
        vi.advanceTimersByTime(1 + TOAST_LEAVE_MS)
        expect(messages()).toEqual([])
    })

    it('makes the toast on screen leave early for a new one, but not before the minimum time', () => {
        showToast({ message: 'One' })
        vi.advanceTimersByTime(500)

        showToast({ message: 'Two' })

        vi.advanceTimersByTime(TOAST_MIN_MS - 500 - 1)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(false)
        vi.advanceTimersByTime(1)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(true)
        vi.advanceTimersByTime(TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Two'])
    })

    it('makes a toast leave at once when it was on screen for the minimum time already', () => {
        showToast({ message: 'One' })
        vi.advanceTimersByTime(TOAST_MIN_MS + 100)

        showToast({ message: 'Two' })
        vi.advanceTimersByTime(0)

        expect(toasts()[0].classList.contains('is-leaving')).toBe(true)
        vi.advanceTimersByTime(TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Two'])
    })

    it('does not make a toast stay longer than its own time', () => {
        showToast({ message: 'Short', duration: 1000 })
        showToast({ message: 'Next' })

        vi.advanceTimersByTime(1000)

        expect(toasts()[0].classList.contains('is-leaving')).toBe(true)
    })

    it('brings a toast with an action back after the toast that it left early for', () => {
        const onSelect = vi.fn()
        showToast({
            message: 'A new version is ready',
            action: { label: 'Reload', onSelect },
            duration: 30_000,
        })
        vi.advanceTimersByTime(5000)

        showToast({ message: 'The book was added.' })
        vi.advanceTimersByTime(TOAST_LEAVE_MS)
        expect(messages()).toEqual(['The book was added.'])

        vi.advanceTimersByTime(TOAST_MIN_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual(['A new version is ready'])

        // It stays for its full time now, also when a different toast waits.
        showToast({ message: 'Other' })
        vi.advanceTimersByTime(30_000 - 1)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(false)
        toasts()[0].querySelector('button')!.click()
        expect(onSelect).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Other'])
        vi.advanceTimersByTime(TOAST_DURATION_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual([])
    })

    it('does not bring a toast back when the user chose its action', () => {
        showToast({ message: 'Removed', action: { label: 'Undo', onSelect() {} } })
        showToast({ message: 'Next' })

        toasts()[0].querySelector('button')!.click()
        vi.advanceTimersByTime(TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Next'])

        vi.advanceTimersByTime(TOAST_DURATION_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual([])
    })

    it('does not add the message of a toast that waits to come back', () => {
        const options = { message: 'Removed', action: { label: 'Undo', onSelect() {} } }
        showToast(options)
        showToast({ message: 'Next' })
        vi.advanceTimersByTime(TOAST_MIN_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Next'])

        showToast(options)

        vi.advanceTimersByTime(TOAST_MIN_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Removed'])
        vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual([])
    })

    it('uses the given duration', () => {
        showToast({ message: 'Short', duration: 1000 })

        vi.advanceTimersByTime(999)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(false)
        vi.advanceTimersByTime(1)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(true)
    })

    it('keeps a toast with an action on screen for a longer time', () => {
        showToast({ message: 'A new version is ready', action: { label: 'Reload', onSelect() {} } })

        vi.advanceTimersByTime(TOAST_DURATION_MS)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(false)
        vi.advanceTimersByTime(TOAST_ACTION_DURATION_MS - TOAST_DURATION_MS)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(true)
    })

    it('runs the action one time and shows the next toast', () => {
        const onSelect = vi.fn()
        showToast({ message: 'Removed', action: { label: 'Undo', onSelect } })
        showToast({ message: 'Next' })

        const button = toasts()[0].querySelector('button')!
        expect(button.textContent).toBe('Undo')
        expect(button.type).toBe('button')
        button.click()
        button.click()

        expect(onSelect).toHaveBeenCalledTimes(1)
        expect(toasts()[0].classList.contains('is-leaving')).toBe(true)
        vi.advanceTimersByTime(TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Next'])
    })

    it('does not add a message that is on screen or in the queue', () => {
        showToast({ message: 'A new version is ready' })
        showToast({ message: 'A new version is ready' })
        showToast({ message: 'Other' })
        showToast({ message: 'Other' })

        vi.advanceTimersByTime(TOAST_DURATION_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual(['Other'])
        vi.advanceTimersByTime(TOAST_DURATION_MS + TOAST_LEAVE_MS)
        expect(messages()).toEqual([])
    })

    it('shows the same message again after the first one is gone', () => {
        showToast({ message: 'Again' })
        vi.advanceTimersByTime(TOAST_DURATION_MS + TOAST_LEAVE_MS)

        showToast({ message: 'Again' })

        expect(messages()).toEqual(['Again'])
    })

    it('gives an error toast the error class and an icon', () => {
        showToast({ message: 'The book was not removed.', tone: 'error' })

        const toast = toasts()[0]
        expect(toast.className).toBe('toast toast-error')
        expect(toast.querySelector('svg.icon use')?.getAttribute('href')).toBe('#i-info')
    })

    it('makes the container when the page has none', () => {
        document.body.innerHTML = ''

        showToast({ message: 'One' })

        expect(document.getElementById('toasts')?.getAttribute('aria-live')).toBe('polite')
        expect(messages()).toEqual(['One'])
    })

    it('waits until an open modal dialog is closed', () => {
        const dialog = document.createElement('dialog')
        document.body.append(dialog)
        const querySelector = vi
            .spyOn(document, 'querySelector')
            .mockImplementation((selector: string) => (selector === 'dialog:modal' ? dialog : null))

        showToast({ message: 'Later' })
        showToast({ message: 'Last' })
        expect(messages()).toEqual([])

        querySelector.mockRestore()
        dialog.dispatchEvent(new Event('close'))
        expect(messages()).toEqual(['Later'])
    })
})
