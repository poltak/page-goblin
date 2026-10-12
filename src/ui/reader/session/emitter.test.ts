import { describe, expect, it, vi } from 'vitest'
import { createEmitter } from './emitter'

interface Events {
    count: number
    done: undefined
}

describe('createEmitter', () => {
    it('calls the listeners of an event in the order in which they were added', () => {
        const emitter = createEmitter<Events>()
        const calls: string[] = []
        emitter.on('count', (value) => calls.push(`a${value}`))
        emitter.on('count', (value) => calls.push(`b${value}`))
        emitter.on('done', () => calls.push('done'))

        emitter.emit('count', 1)
        emitter.emit('done', undefined)
        emitter.emit('count', 2)

        expect(calls).toEqual(['a1', 'b1', 'done', 'a2', 'b2'])
    })

    it('does nothing for an event with no listener', () => {
        const emitter = createEmitter<Events>()
        expect(() => emitter.emit('count', 1)).not.toThrow()
    })

    it('removes a listener with the function that on() returns', () => {
        const emitter = createEmitter<Events>()
        const listener = vi.fn()
        const off = emitter.on('count', listener)
        emitter.emit('count', 1)
        off()
        off()
        emitter.emit('count', 2)
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('keeps two registrations of the same function apart', () => {
        const emitter = createEmitter<Events>()
        const listener = vi.fn()
        const offFirst = emitter.on('count', listener)
        emitter.on('count', listener)
        emitter.emit('count', 1)
        expect(listener).toHaveBeenCalledTimes(2)

        offFirst()
        emitter.emit('count', 2)
        expect(listener).toHaveBeenCalledTimes(3)
    })

    it('does not call a listener that an earlier listener removed', () => {
        const emitter = createEmitter<Events>()
        const second = vi.fn()
        emitter.on('count', () => offSecond())
        const offSecond = emitter.on('count', second)
        emitter.emit('count', 1)
        expect(second).not.toHaveBeenCalled()
    })

    it('does not call a listener that was added during the same emit', () => {
        const emitter = createEmitter<Events>()
        const late = vi.fn()
        emitter.on('count', () => emitter.on('count', late))
        emitter.emit('count', 1)
        expect(late).not.toHaveBeenCalled()
        emitter.emit('count', 2)
        expect(late).toHaveBeenCalledTimes(1)
    })

    it('calls the other listeners when one throws, and reports the error', () => {
        const errors: unknown[] = []
        const emitter = createEmitter<Events>((error) => errors.push(error))
        const failure = new Error('listener failed')
        const second = vi.fn()
        emitter.on('count', () => {
            throw failure
        })
        emitter.on('count', second)

        expect(() => emitter.emit('count', 1)).not.toThrow()
        expect(second).toHaveBeenCalledWith(1)
        expect(errors).toEqual([failure])
    })

    it('calls no more listeners of the same emit after clear()', () => {
        const emitter = createEmitter<Events>()
        const second = vi.fn()
        emitter.on('count', () => emitter.clear())
        emitter.on('count', second)
        emitter.emit('count', 1)
        expect(second).not.toHaveBeenCalled()
    })

    it('removes all listeners on clear()', () => {
        const emitter = createEmitter<Events>()
        const listener = vi.fn()
        emitter.on('count', listener)
        emitter.on('done', listener)
        emitter.clear()
        emitter.emit('count', 1)
        emitter.emit('done', undefined)
        expect(listener).not.toHaveBeenCalled()
    })
})
