/** The sleep timer of the listen bar: a number of minutes, or the end of the chapter. */

/** A number is a time in minutes. */
export type SleepChoice = 'off' | 'chapter' | number

export interface SleepTimerOptions {
    /** The choice changed, or one minute less is left. */
    onChange(): void
    /** The time of a timer in minutes ended. The choice is 'off' at this time. */
    onElapsed(): void
}

export interface SleepTimer {
    readonly choice: SleepChoice
    /** Minutes to the end of a timer in minutes, rounded up. Null for the other choices. */
    readonly minutesLeft: number | null
    set(choice: SleepChoice): void
    /**
     * Call at the end of a chapter. True when the choice was 'chapter'. The choice is then
     * 'off', so the timer stops speech one time.
     */
    takeChapterEnd(): boolean
    /** Sets the choice to 'off'. */
    clear(): void
}

const MINUTE_MS = 60_000

export function createSleepTimer({ onChange, onElapsed }: SleepTimerOptions): SleepTimer {
    let choice: SleepChoice = 'off'
    let endsAt = 0
    let minutesLeft: number | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    function stopClock(): void {
        if (timer !== null) clearTimeout(timer)
        timer = null
        minutesLeft = null
    }

    // One timer for each minute. The time comes from the clock, because a browser makes the
    // timers of a hidden page late.
    function tick(): void {
        timer = null
        const left = endsAt - Date.now()
        if (left <= 0) {
            choice = 'off'
            minutesLeft = null
            onChange()
            onElapsed()
            return
        }
        const minutes = Math.ceil(left / MINUTE_MS)
        timer = setTimeout(tick, left - (minutes - 1) * MINUTE_MS)
        if (minutes === minutesLeft) return
        minutesLeft = minutes
        onChange()
    }

    function set(next: SleepChoice): void {
        const valid =
            next === 'chapter' || (typeof next === 'number' && next > 0 && next < Infinity)
        const wanted: SleepChoice = valid ? next : 'off'
        // The same number of minutes starts the time again.
        if (wanted === choice && typeof wanted !== 'number') return
        stopClock()
        choice = wanted
        if (typeof wanted === 'number') {
            endsAt = Date.now() + wanted * MINUTE_MS
            // Sets the minutes and tells the listener.
            tick()
            return
        }
        onChange()
    }

    return {
        get choice() {
            return choice
        },
        get minutesLeft() {
            return minutesLeft
        },
        set,
        takeChapterEnd() {
            if (choice !== 'chapter') return false
            choice = 'off'
            onChange()
            return true
        },
        clear: () => set('off'),
    }
}
