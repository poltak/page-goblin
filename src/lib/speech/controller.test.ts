import { describe, expect, it, vi } from 'vitest'
import {
    PAUSE_KEEP_MS,
    SILENT_CHUNK_LIMIT,
    createSpeechController,
    speechUtteranceLength,
    speechWatchdogDelay,
    type SpeechController,
    type SpeechState,
} from './controller'
import { SpeechError } from './provider'
import {
    createFakeSpeechProvider,
    createFakeTimers,
    sentencesOf,
    type FakeSpeechProviderOptions,
} from './testing/fake-provider'

const TEXT = 'One two. Three four. Five six.'
const NEXT_TEXT = 'Next chapter. More text.'
const LONG_SENTENCE = `${'word '.repeat(60).trim()}.`
const LONG_TEXT = `Short one. ${LONG_SENTENCE} Last one.`

function setup(options: FakeSpeechProviderOptions = {}) {
    const provider = createFakeSpeechProvider(options)
    const timers = createFakeTimers()
    const callbacks = {
        onStateChange: vi.fn<(state: SpeechState) => void>(),
        onRange: vi.fn(),
        onChapterEnd: vi.fn(),
        onError: vi.fn(),
    }
    const controller = createSpeechController({ provider, callbacks, timers })
    return { provider, timers, callbacks, controller }
}

function load(
    controller: SpeechController,
    { text = TEXT, offset = 0 }: { text?: string; offset?: number } = {},
): void {
    controller.load({ text, sentences: sentencesOf(text), lang: 'en', offset })
}

function spokenTexts(provider: { utterances: { text: string }[] }): string[] {
    return provider.utterances.map((utterance) => utterance.text)
}

describe('load and play', () => {
    it('selects the first chunk that ends after the offset', () => {
        const { controller, callbacks } = setup()

        load(controller, { offset: TEXT.indexOf('four') })
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 1, chunkCount: 3 })
        expect(controller.getPosition()).toBe(TEXT.indexOf('Three'))
        expect(callbacks.onStateChange).toHaveBeenLastCalledWith({
            status: 'idle',
            chunk: 1,
            chunkCount: 3,
        })

        // The first chunk ends at offset 8, so offset 8 is after it.
        load(controller, { offset: 8 })
        expect(controller.getState().chunk).toBe(1)
        load(controller, { offset: 7 })
        expect(controller.getState().chunk).toBe(0)
        load(controller, { offset: Number.NaN })
        expect(controller.getState().chunk).toBe(0)
        load(controller, { offset: 5000 })
        expect(controller.getState().chunk).toBe(3)
        expect(controller.getPosition()).toBe(TEXT.length)
    })

    it('speaks the selected chunk inside the play call', () => {
        const { controller, provider, callbacks } = setup()
        load(controller, { offset: TEXT.indexOf('four') })
        controller.setVoice('voice-1')

        controller.play()

        expect(provider.calls).toEqual(['cancel', 'speak'])
        expect(provider.last()).toMatchObject({
            text: 'Three four.',
            voice: 'voice-1',
            rate: 1,
            pitch: 1,
            lang: 'en',
        })
        expect(controller.getState()).toEqual({ status: 'playing', chunk: 1, chunkCount: 3 })
        expect(callbacks.onRange).toHaveBeenLastCalledWith({ start: 9, end: 20 }, 'sentence')
    })

    it('does nothing before the first load', () => {
        const { controller, provider, callbacks } = setup()

        controller.play()

        expect(provider.calls).toEqual([])
        expect(callbacks.onChapterEnd).not.toHaveBeenCalled()
        expect(controller.getPosition()).toBe(0)
    })

    it('does not start again when play is called while playing', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()

        controller.play()

        expect(provider.calls).toEqual(['cancel', 'speak'])
    })

    it('continues to the next chunk when an utterance ends', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()

        provider.end()

        expect(spokenTexts(provider)).toEqual(['One two.', 'Three four.'])
        // The chain from one chunk to the next has no cancel call.
        expect(provider.calls).toEqual(['cancel', 'speak', 'speak'])
        expect(callbacks.onStateChange).toHaveBeenLastCalledWith({
            status: 'playing',
            chunk: 1,
            chunkCount: 3,
        })
        expect(callbacks.onRange).toHaveBeenLastCalledWith({ start: 9, end: 20 }, 'sentence')
    })

    it('reports each state one time', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        load(controller)
        controller.play()
        provider.end()
        controller.pause()
        controller.pause()

        const states = callbacks.onStateChange.mock.calls.map(([state]) => state)
        expect(states).toEqual([
            { status: 'idle', chunk: 0, chunkCount: 3 },
            { status: 'playing', chunk: 0, chunkCount: 3 },
            { status: 'playing', chunk: 1, chunkCount: 3 },
            { status: 'paused', chunk: 1, chunkCount: 3 },
        ])
    })

    it('speaks the new chunk at once when load is called while playing', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()
        const stale = provider.last()

        load(controller, { text: NEXT_TEXT, offset: NEXT_TEXT.indexOf('More') })
        stale.onEnd()

        expect(spokenTexts(provider)).toEqual(['One two.', 'More text.'])
        expect(provider.calls).toEqual(['cancel', 'speak', 'cancel', 'speak'])
        expect(controller.getState()).toEqual({ status: 'playing', chunk: 1, chunkCount: 2 })
    })

    it('keeps the position after stop', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()
        provider.end()

        controller.stop()
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 1, chunkCount: 3 })
        expect(callbacks.onRange).toHaveBeenLastCalledWith(null, 'sentence')
        expect(provider.calls.at(-1)).toBe('cancel')

        controller.play()
        expect(provider.last().text).toBe('Three four.')
    })

    it('does not call the provider when stop is called while idle', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)

        controller.stop()

        expect(provider.calls).toEqual([])
        expect(callbacks.onRange).not.toHaveBeenCalled()
    })
})

describe('chapter end', () => {
    function playToEnd(provider: ReturnType<typeof setup>['provider']): void {
        provider.end()
        provider.end()
        provider.end()
    }

    it('calls onChapterEnd after the last chunk and then goes to idle', () => {
        const { controller, provider, callbacks } = setup()
        let statusInCallback = ''
        callbacks.onChapterEnd.mockImplementation(() => {
            statusInCallback = controller.getState().status
        })
        load(controller)
        controller.play()

        provider.end()
        provider.end()
        expect(callbacks.onChapterEnd).not.toHaveBeenCalled()
        provider.end()

        expect(callbacks.onChapterEnd).toHaveBeenCalledOnce()
        expect(statusInCallback).toBe('playing')
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 3, chunkCount: 3 })
        expect(controller.getPosition()).toBe(TEXT.length)
        expect(callbacks.onRange).toHaveBeenLastCalledWith(null, 'sentence')
        expect(provider.utterances).toHaveLength(3)
    })

    it('continues with no idle state when the callback loads the next chapter', () => {
        const { controller, provider, callbacks } = setup()
        callbacks.onChapterEnd.mockImplementationOnce(() => {
            load(controller, { text: NEXT_TEXT })
            // A play call after the load must not start the chunk a second time.
            controller.play()
        })
        load(controller)
        controller.play()
        callbacks.onStateChange.mockClear()

        playToEnd(provider)

        expect(provider.last().text).toBe('Next chapter.')
        expect(provider.utterances).toHaveLength(4)
        expect(provider.calls.filter((call) => call === 'cancel')).toHaveLength(1)
        expect(controller.getState()).toEqual({ status: 'playing', chunk: 0, chunkCount: 2 })
        const statuses = callbacks.onStateChange.mock.calls.map(([state]) => state.status)
        expect(statuses).not.toContain('idle')
        expect(callbacks.onRange).not.toHaveBeenCalledWith(null, 'sentence')

        provider.end()
        expect(provider.last().text).toBe('More text.')
    })

    it('continues when the caller loads the next chapter later and calls play', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()
        playToEnd(provider)
        expect(controller.getState().status).toBe('idle')

        load(controller, { text: NEXT_TEXT })
        controller.play()

        expect(provider.last().text).toBe('Next chapter.')
        expect(controller.getState()).toEqual({ status: 'playing', chunk: 0, chunkCount: 2 })
    })

    it('reports the end of a loaded chapter that has no text', () => {
        const { controller, provider, callbacks } = setup()
        callbacks.onChapterEnd
            .mockImplementationOnce(() => controller.load({ text: '', sentences: [] }))
            .mockImplementationOnce(() => controller.load({ text: ' * ', sentences: [] }))
            .mockImplementationOnce(() => load(controller, { text: NEXT_TEXT }))
        load(controller)
        controller.play()

        playToEnd(provider)

        expect(callbacks.onChapterEnd).toHaveBeenCalledTimes(3)
        expect(provider.last().text).toBe('Next chapter.')
        expect(controller.getState().status).toBe('playing')
    })

    it('reports the chapter end when play starts in a chapter with no text', () => {
        const { controller, provider, callbacks } = setup()
        controller.load({ text: '', sentences: [] })

        controller.play()

        expect(callbacks.onChapterEnd).toHaveBeenCalledOnce()
        expect(provider.utterances).toHaveLength(0)
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 0, chunkCount: 0 })
    })

    it('does not report the end again when the callback changes a setting before the load', () => {
        const { controller, provider, callbacks } = setup()
        callbacks.onChapterEnd.mockImplementation(() => {
            controller.setVoice('voice-fr')
            controller.setRate(1.3)
            load(controller, { text: NEXT_TEXT })
        })
        load(controller)
        controller.play()

        playToEnd(provider)

        expect(callbacks.onChapterEnd).toHaveBeenCalledOnce()
        expect(provider.utterances).toHaveLength(4)
        expect(provider.last()).toMatchObject({
            text: 'Next chapter.',
            voice: 'voice-fr',
            rate: 1.3,
        })
    })

    it('stays idle when the callback stops speech', () => {
        const { controller, provider, callbacks } = setup()
        callbacks.onChapterEnd.mockImplementation(() => controller.stop())
        load(controller)
        controller.play()

        playToEnd(provider)

        expect(controller.getState().status).toBe('idle')
        expect(callbacks.onChapterEnd).toHaveBeenCalledOnce()
    })

    it('goes to idle when the callback throws an error', () => {
        const { controller, provider, callbacks, timers } = setup()
        callbacks.onChapterEnd.mockImplementationOnce(() => {
            throw new Error('The next chapter did not load.')
        })
        load(controller, { offset: TEXT.indexOf('Five') })
        controller.play()

        expect(() => provider.end()).toThrow('The next chapter did not load.')

        expect(controller.getState()).toEqual({ status: 'idle', chunk: 3, chunkCount: 3 })
        expect(callbacks.onStateChange).toHaveBeenLastCalledWith({
            status: 'idle',
            chunk: 3,
            chunkCount: 3,
        })
        expect(callbacks.onRange).toHaveBeenLastCalledWith(null, 'sentence')
        expect(timers.pending).toBe(0)

        // The controller can play again.
        load(controller)
        controller.play()
        expect(provider.last().text).toBe('One two.')
        expect(controller.getState().status).toBe('playing')
    })
})

describe('pause and resume', () => {
    it('continues the paused utterance when the provider kept it', () => {
        const { controller, provider, timers } = setup()
        load(controller)
        controller.play()

        controller.pause()
        expect(controller.getState().status).toBe('paused')
        timers.advance(PAUSE_KEEP_MS - 1)

        controller.resume()
        expect(controller.getState().status).toBe('playing')
        expect(provider.calls).toEqual(['cancel', 'speak', 'pause', 'resume'])
        expect(provider.utterances).toHaveLength(1)
        expect(timers.pending).toBe(1)
        expect(timers.lastDelay).toBe(speechWatchdogDelay('One two.'.length, 1))

        provider.end()
        expect(provider.last().text).toBe('Three four.')
    })

    it('drops a paused utterance after 10 seconds and speaks the chunk again on resume', () => {
        const { controller, provider, timers } = setup()
        load(controller)
        controller.play()
        provider.end()
        const stale = provider.last()

        controller.pause()
        expect(timers.lastDelay).toBe(10_000)
        timers.advance(PAUSE_KEEP_MS)

        expect(provider.calls.at(-1)).toBe('cancel')
        expect(controller.getState()).toEqual({ status: 'paused', chunk: 1, chunkCount: 3 })
        expect(timers.pending).toBe(0)
        stale.onEnd()
        expect(provider.utterances).toHaveLength(2)

        controller.resume()
        expect(spokenTexts(provider)).toEqual(['One two.', 'Three four.', 'Three four.'])
        expect(controller.getState().status).toBe('playing')
    })

    it('speaks the current chunk again when the provider did not keep it', () => {
        const { controller, provider } = setup({ keepsPausedUtterance: false })
        load(controller)
        controller.play()
        provider.end()

        controller.pause()
        controller.resume()

        expect(provider.calls).toEqual([
            'cancel',
            'speak',
            'speak',
            'pause',
            'resume',
            'cancel',
            'speak',
        ])
        expect(spokenTexts(provider)).toEqual(['One two.', 'Three four.', 'Three four.'])
        expect(controller.getState()).toEqual({ status: 'playing', chunk: 1, chunkCount: 3 })
    })

    it('stays at the chunk when the end event arrives during a pause', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()

        controller.pause()
        provider.last().onEnd()

        expect(provider.utterances).toHaveLength(1)
        expect(controller.getState()).toEqual({ status: 'paused', chunk: 0, chunkCount: 3 })

        controller.resume()
        expect(spokenTexts(provider)).toEqual(['One two.', 'One two.'])
        expect(controller.getState().status).toBe('playing')
    })

    it('stays at the chunk when the provider ends the utterance inside pause', () => {
        const { controller, provider, timers } = setup()
        load(controller)
        controller.play()
        const pause = provider.pause
        provider.pause = () => {
            pause()
            provider.last().onEnd()
        }

        controller.pause()

        expect(provider.utterances).toHaveLength(1)
        expect(controller.getState()).toEqual({ status: 'paused', chunk: 0, chunkCount: 3 })
        expect(timers.pending).toBe(0)
    })

    it('speaks the chunk again when the provider ends the utterance inside resume', () => {
        const { controller, provider, timers } = setup()
        load(controller)
        controller.play()
        controller.pause()
        const resume = provider.resume
        provider.resume = () => {
            const kept = resume()
            provider.end()
            return kept
        }

        controller.resume()

        // The status is not "playing" with no utterance.
        expect(spokenTexts(provider)).toEqual(['One two.', 'One two.'])
        expect(controller.getState()).toEqual({ status: 'playing', chunk: 0, chunkCount: 3 })
        expect(timers.pending).toBe(1)
        provider.end()
        expect(provider.last().text).toBe('Three four.')
    })

    it('speaks the new chapter on resume when load is called during a pause', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()
        controller.pause()

        load(controller, { text: NEXT_TEXT, offset: NEXT_TEXT.indexOf('More') })
        expect(provider.utterances).toHaveLength(1)
        expect(controller.getState()).toEqual({ status: 'paused', chunk: 1, chunkCount: 2 })
        expect(callbacks.onRange).toHaveBeenLastCalledWith({ start: 14, end: 24 }, 'sentence')

        controller.resume()
        expect(provider.last().text).toBe('More text.')
    })

    it('ignores pause while idle and resume while playing', () => {
        const { controller, provider } = setup()
        load(controller)

        controller.pause()
        controller.resume()
        expect(provider.calls).toEqual([])

        controller.play()
        controller.resume()
        expect(provider.calls).toEqual(['cancel', 'speak'])
    })

    it('starts the selected chunk from its start when play is called during a pause', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()
        controller.pause()

        controller.play()

        expect(provider.calls).toEqual(['cancel', 'speak', 'pause', 'cancel', 'speak'])
        expect(controller.getState().status).toBe('playing')
    })
})

describe('rate, pitch and voice', () => {
    it('speaks the current chunk again at the new rate while playing', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()
        provider.end()
        const stale = provider.last()

        controller.setRate(1.5)
        stale.onEnd()

        expect(spokenTexts(provider)).toEqual(['One two.', 'Three four.', 'Three four.'])
        expect(provider.last().rate).toBe(1.5)
        expect(provider.calls.slice(-2)).toEqual(['cancel', 'speak'])
        expect(controller.getState()).toEqual({ status: 'playing', chunk: 1, chunkCount: 3 })
    })

    it('speaks the current chunk again on resume when the rate changed during a pause', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()
        provider.end()
        controller.pause()

        controller.setRate(1.5)
        expect(provider.utterances).toHaveLength(2)
        expect(controller.getState().status).toBe('paused')

        controller.resume()
        expect(provider.utterances).toHaveLength(3)
        expect(provider.last()).toMatchObject({ text: 'Three four.', rate: 1.5 })
    })

    it('does nothing when the rate does not change', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()

        controller.setRate(1)

        expect(provider.utterances).toHaveLength(1)
    })

    it('clamps the rate and the pitch', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()

        controller.setRate(100)
        expect(provider.last().rate).toBe(2)
        controller.setRate(0)
        expect(provider.last().rate).toBe(0.5)
        controller.setRate(Number.NaN)
        expect(provider.last().rate).toBe(1)

        controller.setPitch(9)
        expect(provider.last().pitch).toBe(2)
        controller.setPitch(-1)
        expect(provider.last().pitch).toBe(0.5)
        expect(provider.last().text).toBe('One two.')
    })

    it('makes the utterances shorter at a rate below 1', () => {
        // At rate 0.5 an utterance of 200 characters is longer than the 15 seconds of Chrome.
        expect(speechUtteranceLength(2)).toBe(200)
        expect(speechUtteranceLength(1)).toBe(200)
        expect(speechUtteranceLength(0.75)).toBe(150)
        expect(speechUtteranceLength(0.5)).toBe(100)

        const { controller, provider } = setup()
        controller.setRate(0.5)
        load(controller, { text: LONG_TEXT })
        const { chunkCount } = controller.getState()
        controller.nextSentence()
        controller.play()
        for (let count = 1; count < chunkCount; count++) provider.end()

        expect(provider.utterances.every((utterance) => utterance.text.length <= 100)).toBe(true)
        expect(spokenTexts(provider).join(' ')).toBe(LONG_TEXT.slice('Short one. '.length))
        expect(provider.last().text).toBe('Last one.')
    })

    it('keeps the position when a rate change makes new chunks while idle', () => {
        const { controller, callbacks } = setup()
        load(controller, { text: LONG_TEXT, offset: LONG_TEXT.indexOf('Last') })
        const before = controller.getState()
        expect(controller.getPosition()).toBe(LONG_TEXT.indexOf('Last'))

        controller.setRate(0.5)

        const after = controller.getState()
        expect(after.chunkCount).toBeGreaterThan(before.chunkCount)
        expect(after.chunk).toBe(after.chunkCount - 1)
        expect(controller.getPosition()).toBe(LONG_TEXT.indexOf('Last'))
        expect(callbacks.onStateChange).toHaveBeenLastCalledWith(after)

        controller.setRate(1.5)
        expect(controller.getState()).toEqual(before)
        expect(callbacks.onStateChange).toHaveBeenLastCalledWith(before)
    })

    it('speaks from the same position when a rate change makes new chunks while playing', () => {
        const { controller, provider, callbacks } = setup()
        load(controller, { text: LONG_TEXT, offset: LONG_TEXT.indexOf('word') })
        controller.play()
        const position = controller.getPosition()
        const spoken = provider.last().text
        expect(spoken.length).toBeGreaterThan(100)

        controller.setRate(0.5)

        expect(controller.getPosition()).toBe(position)
        expect(provider.last().text.length).toBeLessThanOrEqual(100)
        expect(spoken.startsWith(provider.last().text)).toBe(true)
        expect(provider.last().rate).toBe(0.5)
        expect(provider.calls.slice(-2)).toEqual(['cancel', 'speak'])
        expect(controller.getState().status).toBe('playing')
        expect(callbacks.onStateChange).toHaveBeenLastCalledWith(controller.getState())
        expect(callbacks.onRange).toHaveBeenLastCalledWith(
            { start: position, end: position + provider.last().text.length },
            'sentence',
        )
    })

    it('shows the new chunk when a rate change makes new chunks during a pause', () => {
        const { controller, provider, callbacks } = setup()
        load(controller, { text: LONG_TEXT, offset: LONG_TEXT.indexOf('Last') - 20 })
        controller.play()
        controller.pause()
        callbacks.onRange.mockClear()

        controller.setRate(0.5)

        const state = controller.getState()
        expect(state.status).toBe('paused')
        expect(callbacks.onStateChange).toHaveBeenLastCalledWith(state)
        const start = controller.getPosition()
        expect(callbacks.onRange).toHaveBeenCalledOnce()
        expect(callbacks.onRange.mock.calls[0][0].start).toBe(start)
        expect(provider.utterances).toHaveLength(1)

        controller.resume()
        expect(provider.last()).toMatchObject({ rate: 0.5 })
        expect(provider.last().text.length).toBeLessThanOrEqual(100)
        expect(controller.getPosition()).toBe(start)
    })

    it('applies a new voice at once while playing', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()

        controller.setVoice('voice-2')

        expect(provider.utterances).toHaveLength(2)
        expect(provider.last()).toMatchObject({ text: 'One two.', voice: 'voice-2' })

        controller.setVoice(null)
        expect(provider.last().voice).toBeNull()
    })

    it('keeps the settings for the next play while idle', () => {
        const { controller, provider } = setup()
        load(controller)

        controller.setVoice('voice-2')
        controller.setRate(0.8)
        controller.setPitch(1.2)
        expect(provider.calls).toEqual([])

        controller.play()
        expect(provider.last()).toMatchObject({ voice: 'voice-2', rate: 0.8, pitch: 1.2 })
    })
})

describe('events of cancelled utterances', () => {
    it('ignores a late end event after stop', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()
        const stale = provider.last()

        controller.stop()
        stale.onEnd()
        stale.onStart()
        stale.onBoundary({ charIndex: 0, charLength: 3 })

        expect(provider.utterances).toHaveLength(1)
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 0, chunkCount: 3 })
    })

    it('ignores a late error event after stop', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()
        const stale = provider.last()

        controller.stop()
        stale.onError(new SpeechError('synthesis-failed'))
        stale.onError(new SpeechError('interrupted'))

        expect(callbacks.onError).not.toHaveBeenCalled()
    })

    it('ignores an end event that the provider sends inside cancel', () => {
        const { controller, provider, callbacks } = setup()
        const cancel = provider.cancel
        provider.cancel = () => {
            const active = provider.utterances.at(-1)
            cancel()
            active?.onEnd()
        }
        load(controller)
        controller.play()

        controller.setRate(1.5)
        expect(spokenTexts(provider)).toEqual(['One two.', 'One two.'])

        controller.nextSentence()
        expect(spokenTexts(provider)).toEqual(['One two.', 'One two.', 'Three four.'])

        controller.stop()
        expect(provider.utterances).toHaveLength(3)
        expect(callbacks.onChapterEnd).not.toHaveBeenCalled()
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 1, chunkCount: 3 })
    })

    it('ignores the events of an utterance after its end event', () => {
        const { controller, provider, callbacks } = setup()
        load(controller, { text: 'Only one.' })
        controller.play()
        const ended = provider.last()
        provider.end()
        expect(controller.getState().status).toBe('idle')
        callbacks.onRange.mockClear()

        ended.onBoundary({ charIndex: 0, charLength: 4 })
        ended.onError(new SpeechError('synthesis-failed'))

        expect(callbacks.onRange).not.toHaveBeenCalled()
        expect(callbacks.onError).not.toHaveBeenCalled()
    })

    it('ignores the events of an utterance after its error event', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()
        const failed = provider.last()
        provider.fail('interrupted')
        callbacks.onRange.mockClear()

        failed.onBoundary({ charIndex: 0, charLength: 3 })
        failed.onError(new SpeechError('synthesis-failed'))

        expect(callbacks.onRange).not.toHaveBeenCalled()
        expect(callbacks.onError).not.toHaveBeenCalled()
        expect(controller.getState().status).toBe('idle')
    })

    it('ignores the end event of the old utterance after a new play', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()
        const stale = provider.last()
        controller.stop()
        controller.play()

        stale.onEnd()

        expect(provider.utterances).toHaveLength(2)
        expect(controller.getState().chunk).toBe(0)
    })
})

describe('watchdog', () => {
    it('estimates the time from the chunk length and the rate', () => {
        // 14 characters at rate 1 are 1 second of speech.
        expect(speechWatchdogDelay(14, 1)).toBe(7000)
        expect(speechWatchdogDelay(28, 2)).toBe(7000)
        expect(speechWatchdogDelay(200, 0.5)).toBeCloseTo(89714.29, 1)
    })

    it('goes to the next chunk when no event arrives in time', () => {
        const { controller, provider, timers } = setup()
        load(controller)
        controller.play()
        const delay = speechWatchdogDelay('One two.'.length, 1)
        expect(timers.lastDelay).toBe(delay)
        const stale = provider.last()

        timers.advance(delay - 1)
        expect(provider.utterances).toHaveLength(1)

        timers.advance(1)
        expect(provider.calls).toEqual(['cancel', 'speak', 'cancel', 'speak'])
        expect(provider.last().text).toBe('Three four.')
        expect(controller.getState()).toEqual({ status: 'playing', chunk: 1, chunkCount: 3 })

        stale.onEnd()
        expect(provider.utterances).toHaveLength(2)
    })

    it('starts the time again at a start event and at a boundary event', () => {
        const { controller, provider, timers } = setup()
        load(controller)
        controller.play()
        const delay = speechWatchdogDelay('One two.'.length, 1)

        timers.advance(delay - 1)
        provider.last().onStart()
        timers.advance(delay - 1)
        provider.last().onBoundary({ charIndex: 4, charLength: 3 })
        timers.advance(delay - 1)
        expect(provider.utterances).toHaveLength(1)

        timers.advance(1)
        expect(provider.utterances).toHaveLength(2)
    })

    it('gives a Chinese, Japanese or Korean character the time of three characters', () => {
        const { controller, timers } = setup()
        const text = `${'\u4e2d'.repeat(40)}\u3002`
        controller.load({ text, sentences: [{ start: 0, end: text.length }] })

        controller.play()

        // 41 characters take about 9 seconds to speak, not 3 seconds.
        expect(timers.lastDelay).toBe(speechWatchdogDelay(41 * 3, 1))
    })

    it('uses the new rate after a rate change', () => {
        const { controller, timers } = setup()
        load(controller)
        controller.play()

        controller.setRate(2)

        expect(timers.pending).toBe(1)
        expect(timers.lastDelay).toBe(speechWatchdogDelay('One two.'.length, 2))
    })

    it('does not run during a pause or after stop', () => {
        const { controller, provider, timers } = setup()
        load(controller)
        controller.play()

        controller.pause()
        timers.advance(600_000)
        expect(provider.utterances).toHaveLength(1)
        expect(controller.getState()).toEqual({ status: 'paused', chunk: 0, chunkCount: 3 })
        expect(timers.pending).toBe(0)

        controller.resume()
        expect(timers.pending).toBe(1)
        controller.stop()
        expect(timers.pending).toBe(0)
    })

    it('stops with an error when no event arrives for three chunks in sequence', () => {
        const { controller, provider, timers, callbacks } = setup()
        const text = 'One. Two. Three. Four. Five.'
        load(controller, { text })
        controller.play()
        expect(SILENT_CHUNK_LIMIT).toBe(3)

        timers.advance(speechWatchdogDelay('One.'.length, 1))
        timers.advance(speechWatchdogDelay('Two.'.length, 1))
        expect(spokenTexts(provider)).toEqual(['One.', 'Two.', 'Three.'])
        expect(callbacks.onError).not.toHaveBeenCalled()

        timers.advance(speechWatchdogDelay('Three.'.length, 1))

        // The position does not move through the chapter with no sound.
        expect(provider.utterances).toHaveLength(3)
        expect(provider.calls.at(-1)).toBe('cancel')
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 2, chunkCount: 5 })
        expect(callbacks.onError).toHaveBeenCalledOnce()
        expect(callbacks.onError.mock.calls[0][0]).toBeInstanceOf(SpeechError)
        expect(callbacks.onError.mock.calls[0][0]).toMatchObject({ code: 'no-response' })
        expect(callbacks.onRange).toHaveBeenLastCalledWith(null, 'sentence')
        expect(timers.pending).toBe(0)
        timers.advance(600_000)
        expect(provider.utterances).toHaveLength(3)

        // A new play call starts the count again.
        controller.play()
        timers.advance(speechWatchdogDelay('Three.'.length, 1))
        expect(provider.last().text).toBe('Four.')
        expect(callbacks.onError).toHaveBeenCalledOnce()
    })

    it('continues after each stopped utterance while the provider sends events', () => {
        const { controller, provider, timers, callbacks } = setup()
        const text = 'One. Two. Three. Four. Five.'
        load(controller, { text })
        controller.play()

        // Chrome stops an utterance of a network voice after its start event.
        for (let count = 0; count < 4; count++) {
            provider.last().onStart()
            timers.advance(600_000)
        }

        expect(spokenTexts(provider)).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.'])
        expect(callbacks.onError).not.toHaveBeenCalled()
        expect(controller.getState().status).toBe('playing')
    })

    it('reports the chapter end when the last chunk gets no end event', () => {
        const { controller, timers, callbacks } = setup()
        load(controller, { offset: TEXT.indexOf('Five') })
        controller.play()

        timers.advance(600_000)

        expect(callbacks.onChapterEnd).toHaveBeenCalledOnce()
        expect(controller.getState().status).toBe('idle')
        expect(timers.pending).toBe(0)
    })
})

describe('sentence navigation', () => {
    it('selects the next and the previous sentence while idle', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)

        expect(controller.nextSentence()).toBe(true)
        expect(controller.getState().chunk).toBe(1)
        expect(controller.getPosition()).toBe(9)
        expect(controller.nextSentence()).toBe(true)
        expect(controller.nextSentence()).toBe(false)
        expect(controller.getState().chunk).toBe(2)

        expect(controller.previousSentence()).toBe(true)
        expect(controller.previousSentence()).toBe(true)
        expect(controller.previousSentence()).toBe(false)
        expect(controller.getState().chunk).toBe(0)
        expect(provider.calls).toEqual([])
        expect(callbacks.onRange).not.toHaveBeenCalled()
    })

    it('speaks the new sentence at once while playing', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()
        const stale = provider.last()

        expect(controller.nextSentence()).toBe(true)
        stale.onEnd()
        expect(controller.previousSentence()).toBe(true)

        expect(spokenTexts(provider)).toEqual(['One two.', 'Three four.', 'One two.'])
        expect(provider.calls).toEqual(['cancel', 'speak', 'cancel', 'speak', 'cancel', 'speak'])
    })

    it('moves by sentence when a long sentence has more than one chunk', () => {
        const { controller } = setup()
        load(controller, { text: LONG_TEXT })
        const { chunkCount } = controller.getState()
        // "Short one.", two or more parts of the long sentence, "Last one."
        expect(chunkCount).toBeGreaterThan(3)

        controller.nextSentence()
        expect(controller.getState().chunk).toBe(1)
        controller.nextSentence()
        expect(controller.getState().chunk).toBe(chunkCount - 1)

        controller.previousSentence()
        expect(controller.getState().chunk).toBe(1)

        load(controller, { text: LONG_TEXT, offset: LONG_TEXT.indexOf('Last') - 20 })
        expect(controller.getState().chunk).toBe(chunkCount - 2)
        // From a later part of a sentence, go to the start of that sentence.
        expect(controller.previousSentence()).toBe(true)
        expect(controller.getState().chunk).toBe(1)
        expect(controller.previousSentence()).toBe(true)
        expect(controller.getState().chunk).toBe(0)
    })

    it('handles the next sentence after the last one as the chapter end while playing', () => {
        const { controller, provider, callbacks } = setup()
        callbacks.onChapterEnd.mockImplementationOnce(() => load(controller, { text: NEXT_TEXT }))
        load(controller, { offset: TEXT.indexOf('Five') })
        controller.play()

        expect(controller.nextSentence()).toBe(true)

        expect(callbacks.onChapterEnd).toHaveBeenCalledOnce()
        expect(provider.last().text).toBe('Next chapter.')
    })

    it('starts the first sentence again when there is no previous sentence while playing', () => {
        const { controller, provider } = setup()
        load(controller)
        controller.play()

        expect(controller.previousSentence()).toBe(false)

        expect(spokenTexts(provider)).toEqual(['One two.', 'One two.'])
    })

    it('goes to the last sentence from the position after the last chunk', () => {
        const { controller } = setup()
        load(controller, { offset: 5000 })

        expect(controller.nextSentence()).toBe(false)
        expect(controller.previousSentence()).toBe(true)
        expect(controller.getState().chunk).toBe(2)
    })

    it('shows the new sentence and speaks it on resume while paused', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()
        controller.pause()

        expect(controller.nextSentence()).toBe(true)

        expect(provider.utterances).toHaveLength(1)
        expect(provider.calls.at(-1)).toBe('cancel')
        expect(controller.getState()).toEqual({ status: 'paused', chunk: 1, chunkCount: 3 })
        expect(callbacks.onRange).toHaveBeenLastCalledWith({ start: 9, end: 20 }, 'sentence')

        controller.resume()
        expect(provider.last().text).toBe('Three four.')
        expect(controller.getState().status).toBe('playing')
    })
})

describe('ranges', () => {
    it('reports the chapter range of each word from boundary events', () => {
        const { controller, provider, callbacks } = setup()
        load(controller, { offset: TEXT.indexOf('Three') })
        controller.play()

        provider.last().onBoundary({ charIndex: 0, charLength: 5 })
        expect(callbacks.onRange).toHaveBeenLastCalledWith({ start: 9, end: 14 }, 'word')

        // Safari gives no length.
        provider.last().onBoundary({ charIndex: 6, charLength: 0 })
        expect(callbacks.onRange).toHaveBeenLastCalledWith({ start: 15, end: 20 }, 'word')
    })

    it('ignores a boundary event that is not on a word', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()
        callbacks.onRange.mockClear()

        provider.last().onBoundary({ charIndex: 99, charLength: 3 })

        expect(callbacks.onRange).not.toHaveBeenCalled()
    })

    it('maps a word after collapsed white space', () => {
        const { controller, provider, callbacks } = setup()
        const text = 'One\n   two\tthree.'
        controller.load({ text, sentences: [{ start: 0, end: text.length }] })
        controller.play()

        provider.last().onBoundary({ charIndex: 4, charLength: 3 })

        expect(provider.last().text).toBe('One two three.')
        expect(callbacks.onRange).toHaveBeenLastCalledWith({ start: 7, end: 10 }, 'word')
    })
})

describe('errors', () => {
    it('reports a provider error and goes to idle', () => {
        const { controller, provider, callbacks, timers } = setup()
        load(controller)
        controller.play()
        provider.end()

        provider.fail('synthesis-failed')

        expect(callbacks.onError).toHaveBeenCalledOnce()
        expect(callbacks.onError.mock.calls[0][0]).toMatchObject({ code: 'synthesis-failed' })
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 1, chunkCount: 3 })
        expect(callbacks.onRange).toHaveBeenLastCalledWith(null, 'sentence')
        expect(timers.pending).toBe(0)

        controller.play()
        expect(provider.last().text).toBe('Three four.')
    })

    it.each(['interrupted', 'canceled'])('does not report "%s" as an error', (code) => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()

        provider.fail(code)

        expect(callbacks.onError).not.toHaveBeenCalled()
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 0, chunkCount: 3 })
        expect(provider.utterances).toHaveLength(1)
    })

    it('speaks the chunk again on resume after "interrupted" during a pause', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()
        controller.pause()

        provider.fail('interrupted')
        expect(controller.getState().status).toBe('paused')
        expect(callbacks.onError).not.toHaveBeenCalled()

        controller.resume()
        expect(spokenTexts(provider)).toEqual(['One two.', 'One two.'])
    })

    it('reports an error when the browser has no speech', () => {
        const { controller, provider, callbacks } = setup({ supported: false })
        load(controller)

        controller.play()

        expect(provider.calls).toEqual([])
        expect(callbacks.onError).toHaveBeenCalledOnce()
        expect(callbacks.onError.mock.calls[0][0]).toBeInstanceOf(SpeechError)
        expect(callbacks.onError.mock.calls[0][0]).toMatchObject({
            code: 'unsupported',
            message: 'Text to speech is not available in this browser.',
        })
        expect(controller.getState().status).toBe('idle')
    })

    it('goes to idle when the provider fails inside speak', () => {
        const { controller, provider, callbacks } = setup()
        const speak = provider.speak
        provider.speak = (options) => {
            speak(options)
            options.onError(new SpeechError('not-allowed'))
        }
        load(controller)
        callbacks.onStateChange.mockClear()

        controller.play()

        expect(callbacks.onError).toHaveBeenCalledOnce()
        expect(controller.getState().status).toBe('idle')
        expect(callbacks.onStateChange).not.toHaveBeenCalled()
        expect(callbacks.onRange).not.toHaveBeenCalled()
    })

    it('works with no callbacks', () => {
        const provider = createFakeSpeechProvider()
        const controller = createSpeechController({ provider, timers: createFakeTimers() })
        load(controller, { text: 'Only one.' })

        controller.play()
        provider.last().onBoundary({ charIndex: 0, charLength: 4 })
        provider.end()

        expect(controller.getState().status).toBe('idle')
    })
})

describe('destroy', () => {
    it('cancels speech and ignores all later calls and events', () => {
        const { controller, provider, callbacks, timers } = setup()
        load(controller)
        controller.play()
        const stale = provider.last()
        callbacks.onStateChange.mockClear()
        callbacks.onRange.mockClear()

        controller.destroy()
        expect(provider.calls).toEqual(['cancel', 'speak', 'cancel'])
        expect(timers.pending).toBe(0)

        stale.onEnd()
        stale.onError(new SpeechError('synthesis-failed'))
        load(controller, { text: NEXT_TEXT })
        controller.play()
        controller.pause()
        controller.resume()
        controller.stop()
        controller.setRate(2)
        controller.setPitch(2)
        controller.setVoice('voice-2')
        expect(controller.nextSentence()).toBe(false)
        expect(controller.previousSentence()).toBe(false)
        controller.destroy()

        expect(provider.calls).toEqual(['cancel', 'speak', 'cancel'])
        expect(controller.getState()).toEqual({ status: 'idle', chunk: 0, chunkCount: 0 })
        expect(controller.getPosition()).toBe(0)
        expect(callbacks.onStateChange).not.toHaveBeenCalled()
        expect(callbacks.onRange).not.toHaveBeenCalled()
        expect(callbacks.onError).not.toHaveBeenCalled()
        expect(callbacks.onChapterEnd).not.toHaveBeenCalled()
    })

    it('does not call the provider when it is destroyed while idle', () => {
        const { controller, provider } = setup()
        load(controller)

        controller.destroy()

        expect(provider.calls).toEqual([])
    })

    it('calls no callback after the state callback destroys the controller', () => {
        const { controller, provider, callbacks } = setup()
        load(controller)
        controller.play()
        callbacks.onStateChange.mockImplementation((state) => {
            if (state.status === 'idle') controller.destroy()
        })
        callbacks.onRange.mockClear()

        provider.fail('synthesis-failed')

        expect(callbacks.onStateChange).toHaveBeenLastCalledWith({
            status: 'idle',
            chunk: 0,
            chunkCount: 3,
        })
        expect(callbacks.onRange).not.toHaveBeenCalled()
        expect(callbacks.onError).not.toHaveBeenCalled()
    })

    it('stops when the chapter end callback destroys the controller', () => {
        const { controller, provider, callbacks } = setup()
        callbacks.onChapterEnd.mockImplementation(() => controller.destroy())
        load(controller, { text: 'Only one.' })
        controller.play()
        callbacks.onStateChange.mockClear()

        provider.end()

        expect(callbacks.onStateChange).not.toHaveBeenCalled()
        expect(controller.getState().status).toBe('idle')
    })
})

describe('random sequences of calls and events', () => {
    const TEXTS = [TEXT, NEXT_TEXT, LONG_TEXT, 'Only one.', '', ' * ']
    const RATES = [0.5, 0.8, 1, 2]

    /** A random number generator with a fixed sequence, so that a failure occurs again. */
    function createRandom(seed: number): () => number {
        let state = seed
        return () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0
            return state / 0x100000000
        }
    }

    it('keeps the state, the timers and the provider in agreement', () => {
        for (let seed = 1; seed <= 500; seed++) {
            const random = createRandom(seed)
            const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
            const { controller, provider, timers, callbacks } = setup({
                keepsPausedUtterance: random() < 0.5,
            })
            let range: unknown = null
            let destroyed = false
            let lateCallbacks = 0
            let loadsInCallback = 0
            const destroy = (): void => {
                destroyed = true
                controller.destroy()
            }
            const called = (): void => {
                if (destroyed) lateCallbacks += 1
            }
            callbacks.onStateChange.mockImplementation(() => {
                called()
                if (random() < 0.01) destroy()
            })
            callbacks.onError.mockImplementation(called)
            callbacks.onRange.mockImplementation((next: unknown) => {
                called()
                range = next
            })
            callbacks.onChapterEnd.mockImplementation(() => {
                called()
                const action = random()
                if (action < 0.4 && loadsInCallback++ < 5) load(controller, { text: pick(TEXTS) })
                else if (action < 0.5) controller.stop()
                else if (action < 0.6) controller.setRate(pick(RATES))
            })
            const lateEvent = (): void => {
                const old = pick(provider.utterances)
                if (!old || old === provider.active) return
                pick([
                    () => old.onStart(),
                    () => old.onEnd(),
                    () => old.onBoundary({ charIndex: 0, charLength: 3 }),
                    () => old.onError(new SpeechError('synthesis-failed')),
                ])()
            }
            const actions = [
                () => load(controller, { text: pick(TEXTS), offset: Math.floor(random() * 400) }),
                () => controller.play(),
                () => controller.play(),
                () => controller.pause(),
                () => controller.resume(),
                () => controller.stop(),
                () => controller.nextSentence(),
                () => controller.previousSentence(),
                () => controller.setRate(pick(RATES)),
                () => controller.setPitch(pick(RATES)),
                () => controller.setVoice(pick(['voice-1', null])),
                () => provider.active && provider.end(),
                () => provider.active && provider.end(),
                () => provider.active && provider.end(),
                () => provider.active && provider.fail(pick(['interrupted', 'synthesis-failed'])),
                () => provider.active?.onBoundary({ charIndex: 0, charLength: 3 }),
                lateEvent,
                () => timers.advance(pick([100, 11_000, 100_000])),
                () => random() < 0.1 && destroy(),
            ]

            for (let step = 0; step < 60; step++) {
                loadsInCallback = 0
                pick(actions)()

                const { status, chunk, chunkCount } = controller.getState()
                const check = (condition: boolean, problem: string): void => {
                    if (!condition) throw new Error(`${problem} (seed ${seed}, step ${step})`)
                }
                check(lateCallbacks === 0, 'A callback came after destroy')
                check(chunk <= chunkCount, 'The chunk index is too large')
                if (destroyed) {
                    check(timers.pending === 0, 'A timer stays after destroy')
                    continue
                }
                if (callbacks.onStateChange.mock.calls.length > 0) {
                    const reported = callbacks.onStateChange.mock.lastCall?.[0]
                    check(
                        reported?.status === status &&
                            reported.chunk === chunk &&
                            reported.chunkCount === chunkCount,
                        'The last reported state is old',
                    )
                }
                if (status === 'playing') {
                    check(chunk < chunkCount, 'The status is playing after the last chunk')
                    check(
                        provider.active === provider.last(),
                        'The status is playing with no utterance',
                    )
                    check(timers.pending === 1, 'The status is playing with no watchdog')
                    check(range !== null, 'The status is playing with no range')
                    const { text, rate } = provider.last()
                    check(text.length <= speechUtteranceLength(rate), 'The utterance is too long')
                } else if (status === 'idle') {
                    check(provider.active === null, 'The status is idle with an utterance')
                    check(timers.pending === 0, 'The status is idle with a timer')
                    check(range === null, 'The status is idle with a range')
                } else {
                    check(timers.pending <= 1, 'The status is paused with two timers')
                }
            }
        }
    })
})
