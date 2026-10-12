import { afterEach, describe, expect, it, vi } from 'vitest'
import { settings } from '$lib/settings'
import { createSpeedReader } from './index'
import { CHAPTER_1, flush, makeFakeSession } from './testing/fixtures'

afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

describe('createSpeedReader', () => {
    it('runs with the app settings, the browser timers and a canvas measurement', async () => {
        const measureText = vi.fn((text: string) => ({ width: text.length * 60 }))
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            font: '',
            measureText,
        } as unknown as CanvasRenderingContext2D)
        const { session, goTo } = makeFakeSession({
            chapters: [['Pneumonoultramicroscopicsilicovolcanoconiosis is a long word.']],
        })
        const host = document.createElement('div')
        document.body.append(host)
        const onExit = vi.fn()

        const speed = createSpeedReader({ session, host, dock: host, onExit })
        expect(speed.active).toBe(false)
        await speed.start({ spineIndex: 0, offset: 0 })
        expect(speed.active).toBe(true)

        const word = host.querySelector<HTMLElement>('.speed-word')
        expect(word?.textContent).toBe('Pneumonoultramicroscopicsilicovolcanoconiosis')
        expect(measureText).toHaveBeenCalled()
        expect(word?.style.transform).toMatch(/^scale\(0\.\d+\)$/)
        expect(host.querySelector('.speed-rate output')?.textContent).toBe(
            `${settings.get().rsvp.wpm} wpm`,
        )

        // The play button starts the real timers. A pause stops them.
        host.querySelector<HTMLButtonElement>('.speed-play')?.click()
        expect(host.querySelector<HTMLElement>('.speed')?.dataset.status).toBe('playing')
        host.querySelector<HTMLButtonElement>('.speed-play')?.click()
        expect(goTo).toHaveBeenCalledWith({ spineIndex: 0, offset: 0 })

        await speed.stop()
        expect(onExit).toHaveBeenCalledTimes(1)
        expect(host.childElementCount).toBe(0)
        speed.destroy()
        await flush()
    })

    it('has no effect on the page before the first start', () => {
        const { session, setMode } = makeFakeSession()
        const host = document.createElement('div')
        const speed = createSpeedReader({ session, host, dock: host, onExit: vi.fn() })
        expect(host.childElementCount).toBe(0)
        expect(setMode).not.toHaveBeenCalled()
        speed.destroy()
        expect(CHAPTER_1).toBe(1)
    })
})
