import { describe, expect, it, vi } from 'vitest'
import { createStore } from './store'

interface State {
    count: number
    name: string
    ratio: number
}

const initial: State = { count: 0, name: 'a', ratio: NaN }

describe('createStore', () => {
    it('returns the initial state', () => {
        const store = createStore(initial)
        expect(store.get()).toBe(initial)
    })

    it('merges a patch into a new object', () => {
        const store = createStore(initial)
        store.set({ count: 1 })
        expect(store.get()).toEqual({ count: 1, name: 'a', ratio: NaN })
        expect(store.get()).not.toBe(initial)
        expect(initial.count).toBe(0)
    })

    it('calls the listeners synchronously with the new and the previous state', () => {
        const store = createStore(initial)
        const listener = vi.fn()
        store.subscribe(listener)
        store.set({ count: 1, name: 'b' })
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledWith(store.get(), initial)
    })

    it('does nothing when no value changed', () => {
        const store = createStore(initial)
        const listener = vi.fn()
        store.subscribe(listener)
        store.set({})
        store.set({ count: 0, name: 'a' })
        expect(listener).not.toHaveBeenCalled()
        expect(store.get()).toBe(initial)
    })

    it('compares values with Object.is', () => {
        const store = createStore({ ...initial, count: 0 })
        const listener = vi.fn()
        store.subscribe(listener)
        store.set({ ratio: NaN })
        expect(listener).not.toHaveBeenCalled()
        store.set({ count: -0 })
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('does not compare the content of objects', () => {
        const store = createStore({ list: [1] })
        const listener = vi.fn()
        store.subscribe(listener)
        store.set({ list: [1] })
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('stops calls to a listener after it is removed', () => {
        const store = createStore(initial)
        const first = vi.fn()
        const second = vi.fn()
        const removeFirst = store.subscribe(first)
        store.subscribe(second)
        removeFirst()
        removeFirst()
        store.set({ count: 1 })
        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledTimes(1)
    })

    it('lets a listener remove itself during a change', () => {
        const store = createStore(initial)
        const calls: number[] = []
        const remove = store.subscribe((state) => {
            calls.push(state.count)
            remove()
        })
        store.subscribe((state) => calls.push(state.count * 10))
        store.set({ count: 1 })
        store.set({ count: 2 })
        expect(calls).toEqual([1, 10, 20])
    })

    it('gives each listener each change in order when a listener calls set', () => {
        const store = createStore(initial)
        const seen: [number, number][] = []
        store.subscribe((state) => {
            if (state.count === 1) store.set({ count: 2 })
        })
        store.subscribe((state, previous) => seen.push([previous.count, state.count]))
        store.set({ count: 1 })
        expect(seen).toEqual([
            [0, 1],
            [1, 2],
        ])
        expect(store.get().count).toBe(2)
    })

    it('does not call a listener that an earlier listener removed during the change', () => {
        const store = createStore(initial)
        const second = vi.fn()
        let removeSecond = () => {}
        store.subscribe(() => removeSecond())
        removeSecond = store.subscribe(second)
        store.set({ count: 1 })
        expect(second).not.toHaveBeenCalled()
    })

    it('gives a listener that is added during a change only the later changes', () => {
        const store = createStore(initial)
        const late = vi.fn()
        let added = false
        store.subscribe((state) => {
            if (added) return
            added = true
            store.subscribe(late)
            if (state.count === 1) store.set({ count: 2 })
        })
        store.set({ count: 1 })
        expect(late).toHaveBeenCalledTimes(1)
        expect(late.mock.calls[0][0].count).toBe(2)
        expect(late.mock.calls[0][1].count).toBe(1)
    })

    it('calls a listener one time when it subscribes again during a change', () => {
        const store = createStore(initial)
        let calls = 0
        let remove = () => {}
        const listener = () => {
            calls++
            // Stops the loop of a store that calls the new subscription for the same change.
            if (calls > 5) return
            remove()
            remove = store.subscribe(listener)
        }
        remove = store.subscribe(listener)
        store.set({ count: 1 })
        expect(calls).toBe(1)
    })

    it('calls the other listeners and gives the queued changes when a listener throws', () => {
        const store = createStore(initial)
        const seen: number[] = []
        store.subscribe((state) => {
            if (state.count === 1) store.set({ count: 2 })
            throw new Error(`failed at ${state.count}`)
        })
        store.subscribe((state) => seen.push(state.count))
        // The caller gets the first error.
        expect(() => store.set({ count: 1 })).toThrow('failed at 1')
        expect(seen).toEqual([1, 2])
    })

    it('still works after a listener throws', () => {
        const store = createStore(initial)
        const remove = store.subscribe(() => {
            throw new Error('listener failed')
        })
        expect(() => store.set({ count: 1 })).toThrow('listener failed')
        expect(store.get().count).toBe(1)
        remove()
        const listener = vi.fn()
        store.subscribe(listener)
        store.set({ count: 2 })
        expect(listener).toHaveBeenCalledTimes(1)
    })
})
