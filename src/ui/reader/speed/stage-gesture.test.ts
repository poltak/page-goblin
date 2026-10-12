import { describe, expect, it } from 'vitest'
import { STAGE_GESTURE_IDLE, TAP_MAX_MS, stageGesture } from './stage-gesture'
import type { StageGestureAction, StageGestureEvent, StageGestureState } from './stage-gesture'

/** Runs the events in order and returns the action of each one. */
function run(events: StageGestureEvent[]): {
    actions: StageGestureAction[]
    state: StageGestureState
} {
    let state = STAGE_GESTURE_IDLE
    const actions: StageGestureAction[] = []
    for (const event of events) {
        const step = stageGesture(state, event)
        state = step.state
        actions.push(step.action)
    }
    return { actions, state }
}

describe('stageGesture', () => {
    it('starts playback after a tap while paused', () => {
        const { actions, state } = run([
            { type: 'press', time: 1000, playing: false },
            { type: 'release', time: 1100 },
        ])
        expect(actions).toEqual([null, 'play'])
        expect(state).toEqual(STAGE_GESTURE_IDLE)
    })

    it('pauses at the press and stays paused after a tap during playback', () => {
        const { actions } = run([
            { type: 'press', time: 1000, playing: true },
            { type: 'release', time: 1000 + TAP_MAX_MS - 1 },
        ])
        expect(actions).toEqual(['pause', null])
    })

    it('pauses for the time of a hold during playback', () => {
        const { actions, state } = run([
            { type: 'press', time: 1000, playing: true },
            { type: 'release', time: 1000 + TAP_MAX_MS },
        ])
        expect(actions).toEqual(['pause', 'play'])
        expect(state.pressed).toBe(false)
    })

    it('does nothing for a hold while paused', () => {
        const { actions } = run([
            { type: 'press', time: 0, playing: false },
            { type: 'release', time: 5000 },
        ])
        expect(actions).toEqual([null, null])
    })

    it('continues playback when the browser cancels a press that paused it', () => {
        const { actions, state } = run([
            { type: 'press', time: 0, playing: true },
            { type: 'cancel' },
        ])
        expect(actions).toEqual(['pause', 'play'])
        expect(state).toEqual(STAGE_GESTURE_IDLE)
    })

    it('stays paused when the browser cancels a press while paused', () => {
        const { actions } = run([{ type: 'press', time: 0, playing: false }, { type: 'cancel' }])
        expect(actions).toEqual([null, null])
    })

    it('ignores a second press before the release', () => {
        const { actions, state } = run([
            { type: 'press', time: 0, playing: true },
            { type: 'press', time: 50, playing: false },
            { type: 'release', time: 100 },
        ])
        // The second press does not change the time or the playback state of the first one.
        expect(actions).toEqual(['pause', null, null])
        expect(state.pressed).toBe(false)
    })

    it('ignores a release and a cancel with no press', () => {
        const { actions, state } = run([{ type: 'release', time: 10 }, { type: 'cancel' }])
        expect(actions).toEqual([null, null])
        expect(state).toBe(STAGE_GESTURE_IDLE)
    })

    it('does not change the state object that it gets', () => {
        const before = { ...STAGE_GESTURE_IDLE }
        stageGesture(STAGE_GESTURE_IDLE, { type: 'press', time: 5, playing: true })
        expect(STAGE_GESTURE_IDLE).toEqual(before)
    })
})
