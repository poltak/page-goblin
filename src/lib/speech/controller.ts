import {
    MAX_UTTERANCE_LENGTH,
    buildUtterances,
    speechLength,
    wordRangeAt,
    type BuildUtterancesOptions,
    type SpeechChunk,
} from './chunks'
import { SpeechError, type SpeechProvider } from './provider'
import { clampSpeechPitch, clampSpeechRate, DEFAULT_SPEECH_SETTINGS } from './settings'

export type SpeechStatus = 'idle' | 'playing' | 'paused'

export interface SpeechState {
    status: SpeechStatus
    /** Index of the selected chunk. Equal to `chunkCount` after the last chunk of the chapter. */
    chunk: number
    /** Changes with the chapter, and with a rate below 1 because the chunks are then shorter. */
    chunkCount: number
}

/** Chapter offsets. `end` is exclusive. */
export interface SpeechRange {
    start: number
    end: number
}

export type SpeechRangeKind = 'sentence' | 'word'

export interface SpeechCallbacks {
    onStateChange(state: SpeechState): void
    /**
     * The text that speech is at. A "sentence" range comes when a chunk starts, and it replaces
     * the word range of the chunk before it. A "word" range comes for each boundary event, and
     * only from voices that send these events. Null comes when speech goes to idle.
     */
    onRange(range: SpeechRange | null, kind: SpeechRangeKind): void
    /**
     * The last chunk of the chapter ended. To continue with no change of status, call `load`
     * with the next chapter before this callback returns. If not, the status goes to idle
     * after the callback returns, and a later `load` and `play` start speech again.
     */
    onChapterEnd(): void
    /**
     * An error that the user must see. The status is idle when this is called. A `SpeechError`
     * with the code "no-response" comes when the browser sent no event for some chunks in
     * sequence.
     */
    onError(error: unknown): void
}

export interface SpeechTimers {
    setTimeout(callback: () => void, delay: number): unknown
    clearTimeout(handle: unknown): void
}

export interface SpeechControllerOptions {
    provider: SpeechProvider
    callbacks?: Partial<SpeechCallbacks>
    /** Timer functions for the watchdog and the pause limit. Tests replace them. */
    timers?: SpeechTimers
}

export interface SpeechLoadOptions {
    /** `TextModel.text` of the chapter. */
    text: string
    sentences: BuildUtterancesOptions['sentences']
    /** Language of the chapter or the book. The browser uses it when no voice is set. */
    lang?: string | null
    /** Chapter offset. The first chunk that ends after it is selected. */
    offset?: number
}

export interface SpeechController {
    /**
     * Sets the chapter and selects a chunk. While the status is playing, speech continues at
     * once with the selected chunk.
     */
    load(options: SpeechLoadOptions): void
    /**
     * Speaks the selected chunk. Call it directly in the handler of a click or a key, because
     * iOS Safari permits speech only in the same task as the user input.
     */
    play(): void
    pause(): void
    resume(): void
    /** Stops speech and keeps the selected chunk. */
    stop(): void
    /**
     * Selects the next sentence. Returns false, with no change, when the chapter has no later
     * sentence and the status is not playing. While playing, the end of the chapter is handled
     * as if the last chunk ended.
     */
    nextSentence(): boolean
    /**
     * Selects the start of the current sentence when a later part of it is selected. If not,
     * selects the sentence before it. Returns false when the chapter has no earlier sentence.
     * While playing, the first sentence then starts again.
     */
    previousSentence(): boolean
    /**
     * While playing, the current chunk starts again with the new value. A rate below 1 makes
     * the chunks shorter, so the chunk index and the chunk count of the state can change.
     */
    setRate(rate: number): void
    setPitch(pitch: number): void
    /** A `VoiceInfo.id`, or null for the default voice of the browser. */
    setVoice(id: string | null): void
    getState(): SpeechState
    /** Chapter offset of the start of the selected chunk, or the text length after the last chunk. */
    getPosition(): number
    /** Stops speech. All later calls do nothing and no callback is called. */
    destroy(): void
}

/** Estimated speed of speech at rate 1, in characters for each second. */
const CHARACTERS_PER_SECOND = 14

/**
 * Chrome ends an utterance of a network voice after about 15 seconds, and a pause does not
 * stop that time. A paused utterance is dropped before the limit, and `resume` then speaks the
 * chunk again from its start.
 */
export const PAUSE_KEEP_MS = 10_000

/**
 * The watchdog stops speech after this number of chunks in sequence with no event from the
 * provider. Without the limit, a browser that makes no sound (for example when a different tab
 * holds the speech queue) lets the position move through the book.
 */
export const SILENT_CHUNK_LIMIT = 3

const defaultTimers: SpeechTimers = {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The time in milliseconds with no speech event after which the controller goes to the next
 * chunk. Some browsers stop an utterance and send no end event. `length` is the `speechLength`
 * of the chunk text.
 */
export function speechWatchdogDelay(length: number, rate: number): number {
    const estimatedSeconds = length / (CHARACTERS_PER_SECOND * rate)
    return (estimatedSeconds * 3 + 4) * 1000
}

/**
 * The longest utterance for a rate. At a rate below 1 an utterance of 200 characters is longer
 * than the 15 seconds of Chrome, so the limit decreases with the rate.
 */
export function speechUtteranceLength(rate: number): number {
    return Math.round(MAX_UTTERANCE_LENGTH * Math.min(1, rate))
}

export function createSpeechController({
    provider,
    callbacks = {},
    timers = defaultTimers,
}: SpeechControllerOptions): SpeechController {
    let chunks: SpeechChunk[] = []
    /** The `maxLength` that `chunks` was made with. */
    let chunkLimit = 0
    let sourceText: string | null = null
    let sourceSentences: SpeechLoadOptions['sentences'] | null = null
    let lang: string | null = null
    let index = 0
    let status: SpeechStatus = 'idle'
    let voiceId = DEFAULT_SPEECH_SETTINGS.voiceId
    let rate = DEFAULT_SPEECH_SETTINGS.rate
    let pitch = DEFAULT_SPEECH_SETTINGS.pitch
    // Each utterance keeps the value from its start. A cancelled utterance can send its end or
    // error event later, or inside `provider.cancel()`. An event with an old value is ignored.
    let generation = 0
    /** The provider has an utterance of the current generation, speaking or paused. */
    let speaking = false
    /** The watchdog while playing, or the limit of a pause. Only one of them runs at a time. */
    let timer: unknown = null
    /** Chunks in sequence that the watchdog stopped with no event from the provider. */
    let silentChunks = 0
    let loadCount = 0
    let finishing = false
    let destroyed = false
    let reported: SpeechState = { status, chunk: 0, chunkCount: 0 }
    let rangeShown = false

    function notifyState(): void {
        if (
            reported.status === status &&
            reported.chunk === index &&
            reported.chunkCount === chunks.length
        ) {
            return
        }
        reported = { status, chunk: index, chunkCount: chunks.length }
        callbacks.onStateChange?.({ ...reported })
    }

    function showSelectedRange(): void {
        const chunk = chunks[index]
        if (!chunk) return
        rangeShown = true
        callbacks.onRange?.({ start: chunk.start, end: chunk.end }, 'sentence')
    }

    function clearTimer(): void {
        if (timer !== null) timers.clearTimeout(timer)
        timer = null
    }

    function armWatchdog(chunk: SpeechChunk): void {
        clearTimer()
        timer = timers.setTimeout(onWatchdog, speechWatchdogDelay(speechLength(chunk.text), rate))
    }

    function onWatchdog(): void {
        timer = null
        if (status !== 'playing' || !speaking) return
        generation += 1
        speaking = false
        provider.cancel()
        silentChunks += 1
        if (silentChunks >= SILENT_CHUNK_LIMIT) {
            silentChunks = 0
            toIdle()
            if (!destroyed) callbacks.onError?.(new SpeechError('no-response'))
            return
        }
        index += 1
        speakSelected()
    }

    function toIdle(): void {
        clearTimer()
        speaking = false
        status = 'idle'
        notifyState()
        // The state callback can destroy the controller.
        if (destroyed || !rangeShown) return
        rangeShown = false
        callbacks.onRange?.(null, 'sentence')
    }

    function speakSelected(): void {
        const chunk = chunks[index]
        if (!chunk) {
            finishChapter()
            return
        }

        const token = ++generation
        speaking = true
        status = 'playing'
        armWatchdog(chunk)
        // Speak before the callbacks run, so that an error in a callback cannot stop speech.
        provider.speak({
            text: chunk.text,
            voice: voiceId,
            rate,
            pitch,
            lang,
            onStart: () => {
                if (token !== generation) return
                silentChunks = 0
                if (status === 'playing') armWatchdog(chunk)
            },
            onBoundary: ({ charIndex, charLength }) => {
                if (token !== generation) return
                silentChunks = 0
                if (status === 'playing') armWatchdog(chunk)
                const range = wordRangeAt({ chunk, charIndex, charLength })
                if (!range) return
                rangeShown = true
                callbacks.onRange?.(range, 'word')
            },
            onEnd: () => {
                if (token === generation) onUtteranceEnd()
            },
            onError: (error) => {
                if (token === generation) onUtteranceError(error)
            },
        })
        // A provider can end the utterance or fail inside `speak()`.
        if (token !== generation || !speaking) return

        notifyState()
        if (token === generation) showSelectedRange()
    }

    function onUtteranceEnd(): void {
        // The utterance is complete. Ignore all later events from it.
        generation += 1
        silentChunks = 0
        speaking = false
        clearTimer()
        // An end event during a pause means that the provider did not keep the utterance (some
        // Android browsers). Stay at this chunk. `resume` speaks it again.
        if (status !== 'playing') return
        index += 1
        speakSelected()
    }

    function onUtteranceError(error: unknown): void {
        generation += 1
        speaking = false
        clearTimer()
        const code = error instanceof SpeechError ? error.code : null
        if (code === 'interrupted' || code === 'canceled') {
            // Something outside the controller stopped the utterance. This is not an error for
            // the user. During a pause, `resume` speaks the chunk again.
            if (status === 'playing') toIdle()
            return
        }
        toIdle()
        if (!destroyed) callbacks.onError?.(error)
    }

    function finishChapter(): void {
        speaking = false
        clearTimer()
        index = chunks.length
        // The status stays "playing" during the callback, so that `load` continues speech.
        status = 'playing'
        // `load` with a chapter that has no text comes back here from inside the callback.
        // The loop below then reports that chapter. This prevents a deep call chain for a
        // sequence of such chapters.
        if (finishing) return

        finishing = true
        try {
            for (;;) {
                const loadsBefore = loadCount
                callbacks.onChapterEnd?.()
                if (destroyed || status !== 'playing' || speaking) return
                if (loadCount === loadsBefore) return
            }
        } finally {
            finishing = false
            // No chapter was loaded, or the callback threw an error. Without this, the status
            // stays "playing" with no utterance, and `play` does nothing.
            if (!destroyed && status === 'playing' && !speaking) toIdle()
        }
    }

    /** Speaks the selected chunk from its start in place of the current utterance. */
    function restart(): void {
        // Increment before `cancel()`, because some providers send the end event inside it.
        generation += 1
        clearTimer()
        if (speaking) {
            speaking = false
            provider.cancel()
        }
        speakSelected()
    }

    /** Drops a paused utterance, which cannot change. `resume` speaks the chunk again. */
    function dropPaused(): void {
        generation += 1
        clearTimer()
        speaking = false
        provider.cancel()
    }

    function onPauseLimit(): void {
        timer = null
        if (status === 'paused' && speaking) dropPaused()
    }

    /**
     * Applies a new voice, rate or pitch to the current utterance. Returns true when speech
     * started again.
     */
    function applySettings(): boolean {
        if (!speaking) return false
        if (status === 'playing') {
            restart()
            return true
        }
        dropPaused()
        return false
    }

    function select(target: number): void {
        index = target
        if (status === 'playing') {
            restart()
            return
        }
        if (speaking) dropPaused()
        notifyState()
        // Show where speech will continue.
        if (status === 'paused') showSelectedRange()
    }

    function firstChunkOfSentence(chunkIndex: number): number {
        let first = chunkIndex
        while (first > 0 && chunks[first - 1].sentence === chunks[chunkIndex].sentence) first--
        return first
    }

    /** The first chunk that ends after `offset`, or the chunk count if there is none. */
    function chunkIndexAfter(offset: number): number {
        let low = 0
        let high = chunks.length
        while (low < high) {
            const middle = (low + high) >> 1
            if (chunks[middle].end > offset) high = middle
            else low = middle + 1
        }
        return low
    }

    function getPosition(): number {
        return chunks[index]?.start ?? sourceText?.length ?? 0
    }

    /**
     * Makes the chunks again when the rate needs a different utterance length, and keeps the
     * position. Returns true when the chunks changed.
     */
    function fitChunksToRate(): boolean {
        const limit = speechUtteranceLength(rate)
        if (sourceText === null || sourceSentences === null || limit === chunkLimit) return false
        const position = getPosition()
        chunks = buildUtterances({ text: sourceText, sentences: sourceSentences, maxLength: limit })
        chunkLimit = limit
        index = chunkIndexAfter(position)
        return true
    }

    return {
        load({ text, sentences, lang: nextLang = null, offset = 0 }) {
            if (destroyed) return
            loadCount += 1
            const limit = speechUtteranceLength(rate)
            if (text !== sourceText || sentences !== sourceSentences || limit !== chunkLimit) {
                chunks = buildUtterances({ text, sentences, maxLength: limit })
                chunkLimit = limit
                sourceText = text
                sourceSentences = sentences
            }
            lang = nextLang || null
            select(chunkIndexAfter(Number.isFinite(offset) ? offset : 0))
        },

        play() {
            if (destroyed || sourceText === null || status === 'playing') return
            if (!provider.isSupported()) {
                callbacks.onError?.(new SpeechError('unsupported'))
                return
            }
            generation += 1
            speaking = false
            silentChunks = 0
            // This also ends a paused state that an earlier utterance left in the engine.
            provider.cancel()
            speakSelected()
        },

        pause() {
            if (destroyed || status !== 'playing') return
            clearTimer()
            // Set the status first, because some providers end the utterance inside `pause()`.
            status = 'paused'
            if (speaking) {
                provider.pause()
                // No limit is necessary when the utterance ended inside `pause()`.
                if (speaking) timer = timers.setTimeout(onPauseLimit, PAUSE_KEEP_MS)
            }
            notifyState()
        },

        resume() {
            if (destroyed || status !== 'paused') return
            // Read `speaking` again, because a provider can end the utterance inside `resume()`.
            if (speaking && provider.resume() && speaking) {
                status = 'playing'
                armWatchdog(chunks[index])
                notifyState()
                return
            }
            generation += 1
            speaking = false
            provider.cancel()
            speakSelected()
        },

        stop() {
            if (destroyed || status === 'idle') return
            generation += 1
            provider.cancel()
            toIdle()
        },

        nextSentence() {
            if (destroyed) return false
            const current = chunks[index]
            if (!current) return false

            let next = index + 1
            while (next < chunks.length && chunks[next].sentence === current.sentence) next++
            if (next === chunks.length && status !== 'playing') return false
            select(next)
            return true
        },

        previousSentence() {
            if (destroyed || chunks.length === 0) return false
            if (index >= chunks.length) {
                select(firstChunkOfSentence(chunks.length - 1))
                return true
            }

            const first = firstChunkOfSentence(index)
            if (first < index) {
                select(first)
                return true
            }
            if (first > 0) {
                select(firstChunkOfSentence(first - 1))
                return true
            }
            if (status === 'playing') restart()
            return false
        },

        setRate(value) {
            const next = clampSpeechRate(value)
            if (destroyed || next === rate) return
            rate = next
            const changed = fitChunksToRate()
            // A new start of speech reports the new chunks. The status "playing" with no
            // utterance occurs only in `onChapterEnd`, and the chapter end then reports them.
            if (applySettings() || !changed || status === 'playing') return
            notifyState()
            if (status === 'paused') showSelectedRange()
        },

        setPitch(value) {
            const next = clampSpeechPitch(value)
            if (destroyed || next === pitch) return
            pitch = next
            applySettings()
        },

        setVoice(id) {
            const next = id || null
            if (destroyed || next === voiceId) return
            voiceId = next
            applySettings()
        },

        getState: () => ({ status, chunk: index, chunkCount: chunks.length }),

        getPosition,

        destroy() {
            if (destroyed) return
            destroyed = true
            generation += 1
            clearTimer()
            if (status !== 'idle') provider.cancel()
            status = 'idle'
            speaking = false
            index = 0
            chunks = []
            sourceText = null
            sourceSentences = null
        },
    }
}
