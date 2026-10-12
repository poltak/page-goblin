import { describe, expect, it } from 'vitest'
import { BACK_STACK_LIMIT, createBackStack } from './back-stack'

describe('createBackStack', () => {
    it('gives the positions back, newest first', () => {
        const stack = createBackStack()
        stack.push({ spineIndex: 0, offset: 10 })
        stack.push({ spineIndex: 2, offset: 0 })
        expect(stack.size).toBe(2)
        expect(stack.pop()).toEqual({ spineIndex: 2, offset: 0 })
        expect(stack.pop()).toEqual({ spineIndex: 0, offset: 10 })
        expect(stack.pop()).toBeUndefined()
        expect(stack.size).toBe(0)
    })

    it('keeps 20 positions at most and drops the oldest', () => {
        const stack = createBackStack()
        for (let offset = 0; offset < 25; offset++) stack.push({ spineIndex: 0, offset })
        expect(BACK_STACK_LIMIT).toBe(20)
        expect(stack.size).toBe(20)

        const popped: number[] = []
        for (let entry = stack.pop(); entry; entry = stack.pop()) popped.push(entry.offset)
        expect(popped).toHaveLength(20)
        expect(popped[0]).toBe(24)
        expect(popped[19]).toBe(5)
    })

    it('accepts a different limit', () => {
        const stack = createBackStack(2)
        for (let offset = 0; offset < 5; offset++) stack.push({ spineIndex: 1, offset })
        expect(stack.size).toBe(2)
        expect(stack.pop()?.offset).toBe(4)
        expect(stack.pop()?.offset).toBe(3)
    })

    it('does not add the position that is on top already', () => {
        const stack = createBackStack()
        stack.push({ spineIndex: 1, offset: 5 })
        stack.push({ spineIndex: 1, offset: 5 })
        stack.push({ spineIndex: 1, offset: 6 })
        stack.push({ spineIndex: 1, offset: 5 })
        expect(stack.size).toBe(3)
    })

    it('keeps a copy, so a later change of the input has no effect', () => {
        const stack = createBackStack()
        const locator = { spineIndex: 3, offset: 7 }
        stack.push(locator)
        locator.offset = 99
        expect(stack.pop()).toEqual({ spineIndex: 3, offset: 7 })
    })

    it('is empty after clear()', () => {
        const stack = createBackStack()
        stack.push({ spineIndex: 0, offset: 1 })
        stack.clear()
        expect(stack.size).toBe(0)
        expect(stack.pop()).toBeUndefined()
    })
})
