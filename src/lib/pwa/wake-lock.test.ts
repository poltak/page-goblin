import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWakeLock } from './wake-lock'

class FakeSentinel extends EventTarget {
    released = false
    release = vi.fn(async () => {
        this.released = true
        this.dispatchEvent(new Event('release'))
    })
}

describe('createWakeLock', () => {
    let sentinels: FakeSentinel[]
    let request: ReturnType<typeof vi.fn<() => Promise<FakeSentinel>>>

    function setVisibility(state: DocumentVisibilityState): void {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
        document.dispatchEvent(new Event('visibilitychange'))
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve))

    beforeEach(() => {
        sentinels = []
        request = vi.fn(async () => {
            const sentinel = new FakeSentinel()
            sentinels.push(sentinel)
            return sentinel
        })
        Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true })
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    })

    afterEach(() => {
        Reflect.deleteProperty(navigator, 'wakeLock')
        vi.restoreAllMocks()
    })

    it('takes one screen lock for many requests', async () => {
        const lock = createWakeLock()

        await Promise.all([lock.request(), lock.request()])
        await lock.request()

        expect(request).toHaveBeenCalledExactlyOnceWith('screen')
    })

    it('releases the lock', async () => {
        const lock = createWakeLock()
        await lock.request()

        await lock.release()

        expect(sentinels[0].released).toBe(true)
    })

    it('takes the lock again when the page is visible again', async () => {
        const lock = createWakeLock()
        await lock.request()

        setVisibility('hidden')
        await sentinels[0].release()
        await settle()
        expect(request).toHaveBeenCalledOnce()

        setVisibility('visible')
        await settle()
        expect(request).toHaveBeenCalledTimes(2)
        expect(sentinels[1].released).toBe(false)
    })

    it('waits for a visible page before it takes the lock', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        const lock = createWakeLock()

        await lock.request()
        expect(request).not.toHaveBeenCalled()

        setVisibility('visible')
        await settle()
        expect(request).toHaveBeenCalledOnce()
    })

    it('does not take the lock again after a release', async () => {
        const lock = createWakeLock()
        await lock.request()
        await lock.release()

        setVisibility('hidden')
        setVisibility('visible')
        await settle()

        expect(request).toHaveBeenCalledOnce()
    })

    it('releases a lock that arrives after the release call', async () => {
        const lock = createWakeLock()

        const pending = lock.request()
        await lock.release()
        await pending

        expect(sentinels[0].released).toBe(true)
    })

    it('resolves when the browser refuses the lock', async () => {
        request.mockRejectedValue(new DOMException('refused', 'NotAllowedError'))
        const lock = createWakeLock()

        await expect(lock.request()).resolves.toBeUndefined()
        await expect(lock.release()).resolves.toBeUndefined()
    })

    it('resolves when the release fails', async () => {
        const lock = createWakeLock()
        await lock.request()
        sentinels[0].release.mockRejectedValue(new Error('already released'))

        await expect(lock.release()).resolves.toBeUndefined()
    })

    it('resolves in a browser without the wake lock API', async () => {
        Reflect.deleteProperty(navigator, 'wakeLock')
        const lock = createWakeLock()

        await expect(lock.request()).resolves.toBeUndefined()
        await expect(lock.release()).resolves.toBeUndefined()
    })
})
