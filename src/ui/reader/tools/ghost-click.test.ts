import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GHOST_CLICK_MS, isGhostClick } from './ghost-click'

const pointerClick = () => new MouseEvent('click', { detail: 1 })
const keyClick = () => new MouseEvent('click', { detail: 0 })

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('isGhostClick', () => {
    it('is true for a pointer click with no press in the box, soon after it opened', () => {
        const openedAt = Date.now()
        vi.advanceTimersByTime(GHOST_CLICK_MS - 1)

        expect(isGhostClick(pointerClick(), { openedAt, pressedInside: false })).toBe(true)
    })

    it('is false when the press started in the box', () => {
        const openedAt = Date.now()

        expect(isGhostClick(pointerClick(), { openedAt, pressedInside: true })).toBe(false)
    })

    it('is false for a click from the keyboard', () => {
        const openedAt = Date.now()

        expect(isGhostClick(keyClick(), { openedAt, pressedInside: false })).toBe(false)
    })

    it('is false after the guard time', () => {
        const openedAt = Date.now()
        vi.advanceTimersByTime(GHOST_CLICK_MS)

        expect(isGhostClick(pointerClick(), { openedAt, pressedInside: false })).toBe(false)
    })
})
