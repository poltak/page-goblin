/**
 * The tap and hold rules of the stage, as a state machine with no DOM code.
 *
 * A press during playback pauses at once, so no word passes while the finger is down. The
 * release then tells a tap from a hold. After a tap playback stays paused, and after a hold it
 * continues. A tap while playback is paused starts it.
 */

/** A press that is shorter than this is a tap. */
export const TAP_MAX_MS = 250

export interface StageGestureState {
    pressed: boolean
    /** Time of the press in milliseconds. */
    pressedAt: number
    /** Playback was on at the time of the press. */
    wasPlaying: boolean
}

export type StageGestureEvent =
    | { type: 'press'; time: number; playing: boolean }
    | { type: 'release'; time: number }
    | { type: 'cancel' }

/** What the caller does with the playback. Null is no change. */
export type StageGestureAction = 'play' | 'pause' | null

export interface StageGestureStep {
    state: StageGestureState
    action: StageGestureAction
}

export const STAGE_GESTURE_IDLE: StageGestureState = Object.freeze({
    pressed: false,
    pressedAt: 0,
    wasPlaying: false,
})

export function stageGesture(state: StageGestureState, event: StageGestureEvent): StageGestureStep {
    if (event.type === 'press') {
        // A second finger does not start a second press.
        if (state.pressed) return { state, action: null }
        return {
            state: { pressed: true, pressedAt: event.time, wasPlaying: event.playing },
            action: event.playing ? 'pause' : null,
        }
    }

    if (!state.pressed) return { state, action: null }

    // A press that the browser cancels has no effect, so playback returns to its old state.
    if (event.type === 'cancel') {
        return { state: STAGE_GESTURE_IDLE, action: state.wasPlaying ? 'play' : null }
    }

    const isTap = event.time - state.pressedAt < TAP_MAX_MS
    // The press paused the playback already. A tap leaves it paused, and a hold ends the pause.
    const resume = state.wasPlaying ? !isTap : isTap
    return { state: STAGE_GESTURE_IDLE, action: resume ? 'play' : null }
}
