import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToasts } from '../../app/toast'
import type { Part } from '../parts'
import { lazyPart, PART_LOAD_MESSAGE } from './lazy-part'

interface TestPart extends Part {
    name: string
}

function makePart(name = 'part') {
    return { name, destroy: vi.fn<() => void>() }
}

async function flush(): Promise<void> {
    for (let round = 0; round < 10; round++) await Promise.resolve()
}

function toastText(): string | null {
    return document.querySelector('#toasts .toast')?.textContent ?? null
}

describe('lazyPart', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        clearToasts()
        document.body.replaceChildren()
        vi.restoreAllMocks()
    })

    it('does not load the part before its first use', () => {
        const create = vi.fn(async () => makePart())
        const part = lazyPart(create)
        expect(create).not.toHaveBeenCalled()
        expect(part.current).toBeNull()
    })

    it('loads the part at the first use and keeps the instance', async () => {
        const made = makePart()
        const create = vi.fn(async () => made)
        const part = lazyPart(create)
        const run = vi.fn()

        part.use(run)
        expect(run).not.toHaveBeenCalled()
        await flush()
        expect(run).toHaveBeenCalledWith(made)
        expect(part.current).toBe(made)

        part.use(run)
        expect(create).toHaveBeenCalledTimes(1)
        expect(run).toHaveBeenCalledTimes(2)
    })

    it('runs the work before use() returns when the part is loaded', async () => {
        const part = lazyPart(async () => makePart())
        part.use(() => {})
        await flush()

        let ran = false
        part.use(() => (ran = true))
        expect(ran).toBe(true)
    })

    it('loads one time for two uses during the load', async () => {
        const create = vi.fn(async () => makePart())
        const part = lazyPart(create)
        const first = vi.fn()
        const second = vi.fn()
        part.use(first)
        part.use(second)
        await flush()
        expect(create).toHaveBeenCalledTimes(1)
        expect(first).toHaveBeenCalledTimes(1)
        expect(second).toHaveBeenCalledTimes(1)
    })

    it('shows a message when the load fails, and tries again at the next use', async () => {
        const made = makePart()
        const create = vi
            .fn<() => Promise<TestPart>>()
            .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
            .mockResolvedValue(made)
        const part = lazyPart(create)
        const run = vi.fn()

        part.use(run)
        await flush()
        expect(run).not.toHaveBeenCalled()
        expect(toastText()).toBe(PART_LOAD_MESSAGE)
        expect(part.current).toBeNull()

        part.use(run)
        await flush()
        expect(create).toHaveBeenCalledTimes(2)
        expect(run).toHaveBeenCalledWith(made)
    })

    it('handles a factory that throws as a failed load', async () => {
        const part = lazyPart<TestPart>(() => {
            throw new Error('no module')
        })
        expect(() => part.use(() => {})).not.toThrow()
        await flush()
        expect(toastText()).toBe(PART_LOAD_MESSAGE)
    })

    it('shows no message when a load before the first use fails', async () => {
        const made = makePart()
        const create = vi
            .fn<() => Promise<TestPart>>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(made)
        const part = lazyPart(create)

        part.warm()
        await flush()
        expect(toastText()).toBeNull()
        expect(console.error).toHaveBeenCalled()

        part.warm()
        await flush()
        expect(part.current).toBe(made)
    })

    it('does not load again for a warm call after the load', async () => {
        const create = vi.fn(async () => makePart())
        const part = lazyPart(create)
        part.warm()
        await flush()
        part.warm()
        await flush()
        expect(create).toHaveBeenCalledTimes(1)
    })

    it('destroys the part', async () => {
        const made = makePart()
        const part = lazyPart(async () => made)
        part.use(() => {})
        await flush()

        part.destroy()
        part.destroy()
        expect(made.destroy).toHaveBeenCalledTimes(1)
        expect(part.current).toBeNull()
    })

    it('destroys a part that loads after destroy() and does not use it', async () => {
        const made = makePart()
        let finish!: (part: TestPart) => void
        const part = lazyPart(() => new Promise<TestPart>((resolve) => (finish = resolve)))
        const run = vi.fn()
        part.use(run)
        await flush()

        part.destroy()
        finish(made)
        await flush()
        expect(made.destroy).toHaveBeenCalledTimes(1)
        expect(run).not.toHaveBeenCalled()
        expect(part.current).toBeNull()
    })

    it('shows no message for a load that fails after destroy()', async () => {
        let fail!: (error: Error) => void
        const part = lazyPart(() => new Promise<TestPart>((_, reject) => (fail = reject)))
        part.use(() => {})
        await flush()
        part.destroy()
        fail(new Error('offline'))
        await flush()
        expect(toastText()).toBeNull()
    })

    it('does nothing after destroy()', async () => {
        const create = vi.fn(async () => makePart())
        const part = lazyPart(create)
        part.destroy()
        part.use(() => {})
        part.warm()
        await flush()
        expect(create).not.toHaveBeenCalled()
    })
})
