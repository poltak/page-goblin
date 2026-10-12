import type { TextBlock, WordToken } from '$lib/content/types'
import {
    clampWordIndex,
    nextSentenceIndex,
    previousSentenceIndex,
    wordIndexAtOffset,
} from './navigation'
import { normalizeRsvpSettings } from './settings'
import { rampFactorAt, rewindIntervalMs, wordDelayMs } from './timing'
import type {
    RsvpDirection,
    RsvpEngine,
    RsvpEngineOptions,
    RsvpLoadOptions,
    RsvpSettings,
    RsvpState,
    RsvpStatus,
    RsvpTimer,
} from './types'

export { DEFAULT_RSVP_SETTINGS, normalizeRsvpSettings } from './settings'

// The browser throws when a timer function runs as a method of an object that is not the window.
const defaultTimer: RsvpTimer = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => performance.now(),
}

const NO_WORDS: readonly WordToken[] = []
const NO_BLOCKS: readonly TextBlock[] = []

/** The time at which a timer callback ran, and how late that callback was. */
interface Tick {
    now: number
    lateness: number
}

export function createRsvpEngine(options: RsvpEngineOptions = {}): RsvpEngine {
    const callbacks = options.callbacks ?? {}
    const timer = options.timer ?? defaultTimer

    let settings = normalizeRsvpSettings(options.settings)
    let words = NO_WORDS
    let blocks = NO_BLOCKS
    let index = 0
    let status: RsvpStatus = 'idle'
    /** Number of `load` calls. 0 means that there is no chapter. */
    let loadCount = 0
    let destroyed = false
    let resumeAfterRewind = false
    let wordsSincePlay = 0

    let timerHandle: unknown
    let timerActive = false
    let timerToken = 0
    let dueAt = 0

    let shownWord: WordToken | null = null
    let sentStatus: RsvpStatus | null = null
    let sentIndex = -1
    let sentCount = -1

    function getState(): RsvpState {
        return { status, index, wordCount: words.length }
    }

    /**
     * Send the callbacks for what changed. Each method changes all its state before this call,
     * because a callback can call the engine again.
     */
    function notify(force = false) {
        if (destroyed) return

        const word = words.length > 0 ? words[index] : null
        if (word && (force || word !== shownWord)) {
            shownWord = word
            callbacks.onWord?.({ index, word })
            if (destroyed) return
        }

        const count = words.length
        if (force || status !== sentStatus || index !== sentIndex || count !== sentCount) {
            sentStatus = status
            sentIndex = index
            sentCount = count
            callbacks.onStateChange?.({ status, index, wordCount: count })
        }
    }

    function clearTimer() {
        // A new token makes a callback that is already in the task queue do nothing.
        timerToken++
        if (!timerActive) return
        timerActive = false
        timer.clearTimeout(timerHandle)
        timerHandle = undefined
    }

    function startTimer(delay: number, tick: Tick) {
        // The limit stops one long stall from making the next word too short to read.
        const limit = delay / 2
        const wait = delay - Math.min(Math.max(tick.lateness, -limit), limit)
        const token = ++timerToken
        dueAt = tick.now + wait
        timerActive = true
        timerHandle = timer.setTimeout(() => {
            if (token !== timerToken) return
            timerActive = false
            timerHandle = undefined
            onTimer()
        }, wait)
    }

    function onTimer() {
        const now = timer.now()
        const tick: Tick = { now, lateness: now - dueAt }
        if (status === 'playing') advance(tick)
        else if (status === 'rewinding') rewindStep(tick)
    }

    function scheduleWord(tick: Tick) {
        const word = words[index]
        const delay = wordDelayMs({
            word,
            settings,
            isHeadingEnd: word.endsBlock && blocks[word.block]?.heading === true,
            rampFactor: settings.rampUp ? rampFactorAt(wordsSincePlay) : 1,
        })
        wordsSincePlay++
        startTimer(delay, tick)
    }

    function scheduleRewind(tick: Tick) {
        // At the first word the engine waits for stopRewind. If it stopped the rewind itself,
        // playback could start again while the user still holds the rewind button.
        if (index <= 0) return
        startTimer(rewindIntervalMs(settings.wpm), tick)
    }

    function advance(tick: Tick) {
        if (index >= words.length - 1) {
            const loads = loadCount
            status = 'paused'
            notify()
            // A state callback can load a chapter, move to a different word or start playback
            // again. Then this end is old.
            const isOld = loads !== loadCount || status !== 'paused' || index < words.length - 1
            if (!destroyed && !isOld) callbacks.onChapterEnd?.()
            return
        }
        index += 1
        // The timer starts before the callbacks run, so the delay does not include their run time.
        scheduleWord(tick)
        notify()
    }

    function rewindStep(tick: Tick) {
        index = Math.max(index - 1, 0)
        scheduleRewind(tick)
        notify()
    }

    function startPlaying() {
        status = 'playing'
        wordsSincePlay = 0
        scheduleWord({ now: timer.now(), lateness: 0 })
    }

    function moveTo(target: number): boolean {
        if (destroyed || words.length === 0) return false
        const next = clampWordIndex(target, words.length)
        if (next === index) return false
        index = next

        // The new word gets its full time.
        if (status === 'playing' || status === 'rewinding') {
            clearTimer()
            const tick: Tick = { now: timer.now(), lateness: 0 }
            if (status === 'playing') scheduleWord(tick)
            else scheduleRewind(tick)
        }
        notify()
        return true
    }

    function load({ words: nextWords, blocks: nextBlocks, index: nextIndex = 0 }: RsvpLoadOptions) {
        if (destroyed) return
        clearTimer()
        words = nextWords
        blocks = nextBlocks
        index = clampWordIndex(nextIndex, words.length)
        loadCount++
        status = words.length === 0 ? 'idle' : 'paused'
        notify(true)
    }

    function play() {
        if (destroyed || status === 'playing') return
        if (words.length === 0) {
            // A chapter with no words (a cover or an image page) ends at once, so that the
            // caller goes to the next chapter with the same code path.
            if (loadCount > 0) callbacks.onChapterEnd?.()
            return
        }
        clearTimer()
        startPlaying()
        notify()
    }

    function pause() {
        if (destroyed || (status !== 'playing' && status !== 'rewinding')) return
        clearTimer()
        status = 'paused'
        notify()
    }

    function toggle() {
        if (status === 'playing') pause()
        else play()
    }

    function stepWords(count: number): boolean {
        if (!Number.isFinite(count)) return false
        return moveTo(index + Math.trunc(count))
    }

    function stepSentence(direction: RsvpDirection): boolean {
        const target =
            direction === 'next'
                ? nextSentenceIndex(words, index)
                : previousSentenceIndex(words, index)
        return target >= 0 && moveTo(target)
    }

    function startRewind() {
        if (destroyed || status === 'rewinding' || words.length === 0 || index <= 0) return
        resumeAfterRewind = status === 'playing'
        clearTimer()
        status = 'rewinding'
        scheduleRewind({ now: timer.now(), lateness: 0 })
        notify()
    }

    function stopRewind() {
        if (destroyed || status !== 'rewinding') return
        clearTimer()
        if (resumeAfterRewind) startPlaying()
        else status = 'paused'
        notify()
    }

    function setSettings(patch: Partial<RsvpSettings>) {
        if (destroyed) return
        // The timer of the word on screen does not start again. The old reader did that, and a
        // series of fast changes held one word on screen.
        settings = normalizeRsvpSettings({ ...settings, ...patch }, settings)
    }

    function destroy() {
        if (destroyed) return
        clearTimer()
        destroyed = true
        words = NO_WORDS
        blocks = NO_BLOCKS
        index = 0
        status = 'idle'
        shownWord = null
    }

    return {
        load,
        play,
        pause,
        toggle,
        seek: moveTo,
        seekToOffset: (offset) => moveTo(wordIndexAtOffset(words, offset)),
        stepWords,
        stepSentence,
        startRewind,
        stopRewind,
        setSettings,
        getSettings: () => ({ ...settings }),
        getState,
        getCurrentWord: () => (words.length > 0 ? words[index] : null),
        destroy,
    }
}
