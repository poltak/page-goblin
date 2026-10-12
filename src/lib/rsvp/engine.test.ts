import { describe, expect, test, vi } from 'vitest'
import { createRsvpEngine, DEFAULT_RSVP_SETTINGS, normalizeRsvpSettings } from './engine'
import { makeChapter } from './testing/chapter'
import { createFakeTimer } from './testing/fake-timer'
import type { RsvpCallbacks, RsvpSettings, RsvpState, RsvpTimer } from './types'

/** A base time of 100 ms with no ramp and no long word time. */
const PLAIN: Partial<RsvpSettings> = { wpm: 600, rampUp: false, longWordDelay: false }

const TEN_WORDS = 'zero one two three four five six seven eight nine'

function setup(settings: Partial<RsvpSettings> = PLAIN) {
    const timer = createFakeTimer()
    const shown: string[] = []
    const states: RsvpState[] = []
    const events: string[] = []
    const callbacks = {
        onWord: vi.fn<NonNullable<RsvpCallbacks['onWord']>>(({ word }) => {
            shown.push(word.text)
            events.push(`word:${word.text}`)
        }),
        onStateChange: vi.fn<NonNullable<RsvpCallbacks['onStateChange']>>((state) => {
            states.push(state)
            events.push(`state:${state.status}:${state.index}`)
        }),
        onChapterEnd: vi.fn<NonNullable<RsvpCallbacks['onChapterEnd']>>(() => {
            events.push('end')
        }),
    }
    const engine = createRsvpEngine({ settings, callbacks, timer })
    return { engine, timer, callbacks, shown, states, events }
}

/** Load one block of plain words and return the setup. */
function setupWith(blocks: string[], settings: Partial<RsvpSettings> = PLAIN) {
    const context = setup(settings)
    const chapter = makeChapter(blocks)
    context.engine.load({ words: chapter.words, blocks: chapter.blocks })
    return { ...context, chapter }
}

/** Play to the end of the chapter and collect the delay of each word. */
function collectDelays(context: ReturnType<typeof setup>): number[] {
    const delays: number[] = []
    context.engine.play()
    while (context.timer.pending().length > 0) {
        delays.push(...context.timer.pending())
        context.timer.fire()
    }
    return delays
}

describe('createRsvpEngine', () => {
    test('exports the settings helpers', () => {
        expect(normalizeRsvpSettings({})).toEqual(DEFAULT_RSVP_SETTINGS)
    })

    test('starts idle with the default settings', () => {
        const engine = createRsvpEngine()
        expect(engine.getState()).toEqual({ status: 'idle', index: 0, wordCount: 0 })
        expect(engine.getCurrentWord()).toBeNull()
        expect(engine.getSettings()).toEqual(DEFAULT_RSVP_SETTINGS)
    })

    test('normalises the settings that it gets', () => {
        const engine = createRsvpEngine({ settings: { wpm: 5000, commaMultiplier: Number.NaN } })
        expect(engine.getSettings()).toEqual({ ...DEFAULT_RSVP_SETTINGS, wpm: 1000 })
    })

    test('does nothing before a chapter is loaded', () => {
        const { engine, timer, callbacks } = setup()
        engine.play()
        engine.toggle()
        engine.pause()
        engine.startRewind()
        engine.stopRewind()
        expect(engine.seek(3)).toBe(false)
        expect(engine.seekToOffset(10)).toBe(false)
        expect(engine.stepWords(1)).toBe(false)
        expect(engine.stepSentence('next')).toBe(false)
        expect(engine.stepSentence('previous')).toBe(false)

        expect(engine.getState()).toEqual({ status: 'idle', index: 0, wordCount: 0 })
        expect(timer.startedCount()).toBe(0)
        expect(callbacks.onWord).not.toHaveBeenCalled()
        expect(callbacks.onStateChange).not.toHaveBeenCalled()
        expect(callbacks.onChapterEnd).not.toHaveBeenCalled()
    })

    test('runs with the default timer', async () => {
        const chapter = makeChapter(['one two'])
        const shown: string[] = []
        const engine = createRsvpEngine({
            settings: { ...PLAIN, wpm: 1000 },
            callbacks: { onWord: ({ word }) => shown.push(word.text) },
        })
        engine.load({ words: chapter.words, blocks: chapter.blocks })
        engine.play()
        await vi.waitFor(() => expect(shown).toEqual(['one', 'two']))
        engine.destroy()
    })
})

describe('load', () => {
    test('shows the first word and pauses', () => {
        const { engine, timer, events, chapter } = setupWith(['one two three'])
        expect(engine.getState()).toEqual({ status: 'paused', index: 0, wordCount: 3 })
        expect(engine.getCurrentWord()).toBe(chapter.words[0])
        expect(events).toEqual(['word:one', 'state:paused:0'])
        expect(timer.pending()).toEqual([])
    })

    test('shows the word at the given index', () => {
        const { engine, callbacks } = setup()
        const chapter = makeChapter(['one two three'])
        engine.load({ words: chapter.words, blocks: chapter.blocks, index: 2 })
        expect(engine.getState().index).toBe(2)
        expect(callbacks.onWord).toHaveBeenLastCalledWith({ index: 2, word: chapter.words[2] })
    })

    test('limits the index to the words of the chapter', () => {
        const { engine } = setup()
        const chapter = makeChapter(['one two three'])
        engine.load({ words: chapter.words, blocks: chapter.blocks, index: 99 })
        expect(engine.getState().index).toBe(2)
        engine.load({ words: chapter.words, blocks: chapter.blocks, index: -4 })
        expect(engine.getState().index).toBe(0)
        engine.load({ words: chapter.words, blocks: chapter.blocks, index: Number.NaN })
        expect(engine.getState().index).toBe(0)
    })

    test('sends the callbacks again when the same chapter is loaded again', () => {
        const { engine, events, chapter } = setupWith(['one two'])
        events.length = 0
        engine.load({ words: chapter.words, blocks: chapter.blocks })
        expect(events).toEqual(['word:one', 'state:paused:0'])
    })

    test('is idle for a chapter with no words', () => {
        const { engine, events } = setupWith(['one two'])
        events.length = 0
        engine.load({ words: [], blocks: [] })
        expect(engine.getState()).toEqual({ status: 'idle', index: 0, wordCount: 0 })
        expect(engine.getCurrentWord()).toBeNull()
        expect(events).toEqual(['state:idle:0'])
    })

    test('keeps an empty chapter at index 0 for each move', () => {
        const { engine, timer, events } = setup()
        engine.load({ words: [], blocks: [] })
        events.length = 0

        expect(engine.seek(10)).toBe(false)
        expect(engine.seekToOffset(10)).toBe(false)
        expect(engine.stepWords(3)).toBe(false)
        expect(engine.stepSentence('next')).toBe(false)
        expect(engine.stepSentence('previous')).toBe(false)
        engine.startRewind()
        engine.pause()

        expect(engine.getState()).toEqual({ status: 'idle', index: 0, wordCount: 0 })
        expect(events).toEqual([])
        expect(timer.startedCount()).toBe(0)
    })

    test('stops playback and replaces the chapter', () => {
        const { engine, timer, shown } = setupWith(['one two three'])
        engine.play()
        timer.fire()
        expect(engine.getState()).toEqual({ status: 'playing', index: 1, wordCount: 3 })

        const next = makeChapter(['alpha beta gamma delta'])
        engine.load({ words: next.words, blocks: next.blocks, index: 1 })
        expect(engine.getState()).toEqual({ status: 'paused', index: 1, wordCount: 4 })
        expect(engine.getCurrentWord()).toBe(next.words[1])
        expect(timer.pending()).toEqual([])

        timer.advance(10000)
        expect(engine.getState().index).toBe(1)
        expect(shown).toEqual(['one', 'two', 'beta'])

        engine.play()
        timer.fire()
        expect(shown).toEqual(['one', 'two', 'beta', 'gamma'])
    })

    test('stops a rewind', () => {
        const { engine, timer } = setupWith(['one two three'])
        engine.seek(2)
        engine.startRewind()
        const next = makeChapter(['alpha beta'])
        engine.load({ words: next.words, blocks: next.blocks, index: 1 })
        expect(engine.getState().status).toBe('paused')
        expect(timer.pending()).toEqual([])
    })
})

describe('play and pause', () => {
    test('shows one word for each timer', () => {
        const { engine, timer, shown, events } = setupWith(['one two three four'])
        events.length = 0
        engine.play()
        expect(events).toEqual(['state:playing:0'])
        expect(timer.pending()).toEqual([100])

        timer.fire()
        expect(events).toEqual(['state:playing:0', 'word:two', 'state:playing:1'])
        expect(timer.pending()).toEqual([100])

        timer.fire()
        expect(shown).toEqual(['one', 'two', 'three'])
        expect(engine.getState()).toEqual({ status: 'playing', index: 2, wordCount: 4 })
    })

    test('play does nothing when playback is on', () => {
        const { engine, timer, events } = setupWith(['one two three'])
        engine.play()
        events.length = 0
        engine.play()
        expect(events).toEqual([])
        expect(timer.startedCount()).toBe(1)
    })

    test('pause stops the timer and keeps the word', () => {
        const { engine, timer, events } = setupWith(['one two three'])
        engine.play()
        timer.fire()
        events.length = 0

        engine.pause()
        expect(events).toEqual(['state:paused:1'])
        expect(timer.pending()).toEqual([])
        timer.advance(10000)
        expect(engine.getState()).toEqual({ status: 'paused', index: 1, wordCount: 3 })
    })

    test('pause does nothing when playback is off', () => {
        const { engine, events } = setupWith(['one two three'])
        events.length = 0
        engine.pause()
        expect(events).toEqual([])
    })

    test('play after pause gives the word on screen its full time again', () => {
        const { engine, timer } = setupWith(['one, two three'])
        engine.play()
        timer.advance(150)
        engine.pause()
        engine.play()
        expect(timer.pending()).toEqual([200])
    })

    test('toggle changes between play and pause', () => {
        const { engine, timer } = setupWith(['one two three'])
        engine.toggle()
        expect(engine.getState().status).toBe('playing')
        engine.toggle()
        expect(engine.getState().status).toBe('paused')
        expect(timer.pending()).toEqual([])
    })

    test('a callback can pause the engine', () => {
        const timer = createFakeTimer()
        const chapter = makeChapter(['one two three'])
        const engine = createRsvpEngine({
            settings: PLAIN,
            timer,
            callbacks: {
                onWord: ({ index }) => {
                    if (index === 1) engine.pause()
                },
            },
        })
        engine.load({ words: chapter.words, blocks: chapter.blocks })
        engine.play()
        timer.fire()
        expect(engine.getState()).toEqual({ status: 'paused', index: 1, wordCount: 3 })
        expect(timer.pending()).toEqual([])
    })

    test('keeps the timer when a callback throws', () => {
        const timer = createFakeTimer()
        const chapter = makeChapter(['one two three'])
        const engine = createRsvpEngine({
            settings: PLAIN,
            timer,
            callbacks: {
                onWord: ({ index }) => {
                    if (index === 1) throw new Error('draw failed')
                },
            },
        })
        engine.load({ words: chapter.words, blocks: chapter.blocks })
        engine.play()
        expect(() => timer.fire()).toThrow('draw failed')
        expect(timer.pending()).toEqual([100])
        timer.fire()
        expect(engine.getState().index).toBe(2)
    })
})

describe('word delays', () => {
    test('uses each punctuation rule, the paragraph rule and the heading rule', () => {
        const context = setupWith([
            '# Title here',
            'One two, three; four: five. Six! Seven? Eight',
            'Last "words."',
        ])
        expect(collectDelays(context)).toEqual([
            // Title, here (the end of a heading)
            100, 400,
            // One, two, three; four: five. Six! Seven? Eight (the end of a paragraph)
            100, 200, 250, 250, 300, 300, 300, 350,
            // Last, "words." (the paragraph rule is larger than the period rule)
            100, 350,
        ])
    })

    test('uses the multipliers from the settings', () => {
        const context = setupWith(['# Head', 'a, b; c. d! e'], {
            ...PLAIN,
            periodMultiplier: 5,
            commaMultiplier: 1.5,
            semicolonMultiplier: 4,
            exclamationMultiplier: 6,
            paragraphMultiplier: 7,
            headingMultiplier: 9,
        })
        expect(collectDelays(context)).toEqual([900, 150, 400, 500, 600, 700])
    })

    test('uses the base time of the old reader at 250 words for each minute', () => {
        const context = setupWith(['one two, three; four.'], {
            rampUp: false,
            longWordDelay: false,
            paragraphMultiplier: 1,
        })
        expect(collectDelays(context)).toEqual([240, 480, 600, 720])
    })

    test('gives a long word more time', () => {
        const context = setupWith(['short abcdefghij short'], { ...PLAIN, longWordDelay: true })
        const delays = collectDelays(context)
        expect(delays[0]).toBe(100)
        expect(delays[1]).toBeCloseTo(108, 6)
    })

    test('does not treat a block as a heading when the block data is missing', () => {
        const context = setup()
        const chapter = makeChapter(['# Title'])
        context.engine.load({ words: chapter.words, blocks: [] })
        expect(collectDelays(context)).toEqual([350])
    })
})

describe('ramp-up', () => {
    test('slows the first five words after play', () => {
        const context = setupWith([TEN_WORDS], { ...PLAIN, rampUp: true, paragraphMultiplier: 1 })
        const delays = collectDelays(context)
        const expected = [160, 148, 136, 124, 112, 100, 100, 100, 100, 100]
        expect(delays).toHaveLength(expected.length)
        delays.forEach((delay, i) => expect(delay).toBeCloseTo(expected[i], 6))
    })

    test('starts again after a pause', () => {
        const { engine, timer } = setupWith([TEN_WORDS], { ...PLAIN, rampUp: true })
        engine.play()
        timer.fire()
        timer.fire()
        expect(timer.pending()[0]).toBeCloseTo(136, 6)

        engine.pause()
        engine.play()
        expect(timer.pending()[0]).toBeCloseTo(160, 6)
        timer.fire()
        expect(timer.pending()[0]).toBeCloseTo(148, 6)
    })

    test('does not start again after a seek during playback', () => {
        const { engine, timer } = setupWith([TEN_WORDS], { ...PLAIN, rampUp: true })
        engine.play()
        timer.fire()
        engine.seek(5)
        expect(timer.pending()[0]).toBeCloseTo(136, 6)
    })

    test('multiplies with the punctuation rule', () => {
        const { engine, timer } = setupWith(['one. two three'], { ...PLAIN, rampUp: true })
        engine.play()
        expect(timer.pending()[0]).toBeCloseTo(480, 6)
    })

    test('is off when the setting is off', () => {
        const context = setupWith(['one two three'], { ...PLAIN, paragraphMultiplier: 1 })
        expect(collectDelays(context)).toEqual([100, 100, 100])
    })
})

describe('drift correction', () => {
    test('subtracts the lateness of a timer from the next delay', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.play()
        timer.fire(30)
        expect(timer.pending()).toEqual([70])
        timer.fire(12)
        expect(timer.pending()).toEqual([88])
        timer.fire()
        expect(timer.pending()).toEqual([100])
    })

    test('limits the correction to half of the delay', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.play()
        timer.fire(60)
        expect(timer.pending()).toEqual([50])
        timer.fire(5000)
        expect(timer.pending()).toEqual([50])
    })

    test('does not carry lateness that it could not correct', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.play()
        timer.fire(5000)
        expect(timer.pending()).toEqual([50])
        timer.fire()
        expect(timer.pending()).toEqual([100])
    })

    test('uses the delay of the next word for the limit', () => {
        const { engine, timer } = setupWith(['one two. three four'])
        engine.play()
        timer.fire(120)
        // "two." has a delay of 300, so the full 120 can be subtracted.
        expect(timer.pending()).toEqual([180])
    })

    test('gives time back when a timer runs early', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.play()
        timer.fire(-0.5)
        expect(timer.pending()).toEqual([100.5])
    })

    test('keeps the set speed when each timer is late', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.play()
        for (let i = 0; i < 9; i++) timer.fire(4)
        // Nine words of 100 ms. Only the lateness of the last timer remains.
        expect(engine.getState().index).toBe(9)
        expect(timer.now()).toBe(904)
    })

    test('has no correction after pause and play', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.play()
        timer.fire(40)
        engine.pause()
        timer.advance(3000)
        engine.play()
        expect(timer.pending()).toEqual([100])
    })
})

describe('chapter end', () => {
    test('pauses on the last word and reports the end', () => {
        const { engine, timer, events, callbacks } = setupWith(['one two'])
        events.length = 0
        engine.play()
        timer.fire()
        expect(callbacks.onChapterEnd).not.toHaveBeenCalled()
        // The last word stays on screen for its full time.
        expect(timer.pending()).toEqual([350])

        timer.fire()
        expect(events).toEqual([
            'state:playing:0',
            'word:two',
            'state:playing:1',
            'state:paused:1',
            'end',
        ])
        expect(engine.getState()).toEqual({ status: 'paused', index: 1, wordCount: 2 })
        expect(timer.pending()).toEqual([])
        expect(callbacks.onChapterEnd).toHaveBeenCalledTimes(1)
    })

    test('reports the end again when play is pushed on the last word', () => {
        const { engine, timer, callbacks } = setupWith(['one two'])
        engine.seek(1)
        engine.play()
        expect(timer.pending()).toEqual([350])
        timer.fire()
        expect(callbacks.onChapterEnd).toHaveBeenCalledTimes(1)
        engine.play()
        timer.fire()
        expect(callbacks.onChapterEnd).toHaveBeenCalledTimes(2)
    })

    test('lets the end callback load the next chapter and play', () => {
        const timer = createFakeTimer()
        const first = makeChapter(['one two'])
        const second = makeChapter(['three four'])
        const shown: string[] = []
        const engine = createRsvpEngine({
            settings: PLAIN,
            timer,
            callbacks: {
                onWord: ({ word }) => shown.push(word.text),
                onChapterEnd: () => {
                    engine.load({ words: second.words, blocks: second.blocks })
                    engine.play()
                },
            },
        })
        engine.load({ words: first.words, blocks: first.blocks })
        engine.play()
        timer.fire()
        timer.fire()
        expect(shown).toEqual(['one', 'two', 'three'])
        expect(engine.getState()).toEqual({ status: 'playing', index: 0, wordCount: 2 })
        expect(timer.pending()).toEqual([100])
        timer.fire()
        expect(shown).toEqual(['one', 'two', 'three', 'four'])
    })

    test('reports the end at once when play is called on a chapter with no words', () => {
        const { engine, timer, callbacks } = setup()
        engine.load({ words: [], blocks: [] })
        engine.play()
        expect(callbacks.onChapterEnd).toHaveBeenCalledTimes(1)
        expect(engine.getState()).toEqual({ status: 'idle', index: 0, wordCount: 0 })
        expect(timer.startedCount()).toBe(0)

        engine.toggle()
        expect(callbacks.onChapterEnd).toHaveBeenCalledTimes(2)
    })

    test('does not report the end when a state callback loads a new chapter', () => {
        const timer = createFakeTimer()
        const first = makeChapter(['one'])
        const second = makeChapter(['two three'])
        const onChapterEnd = vi.fn()
        let played = false
        const engine = createRsvpEngine({
            settings: PLAIN,
            timer,
            callbacks: {
                onChapterEnd,
                onStateChange: (state) => {
                    if (state.status === 'playing') played = true
                    // The pause at the end of the first chapter comes here before the end callback.
                    if (played && state.status === 'paused' && state.wordCount === 1) {
                        engine.load({ words: second.words, blocks: second.blocks })
                    }
                },
            },
        })
        engine.load({ words: first.words, blocks: first.blocks })
        engine.play()
        timer.fire()
        expect(engine.getState()).toEqual({ status: 'paused', index: 0, wordCount: 2 })
        expect(onChapterEnd).not.toHaveBeenCalled()
    })

    test.each([
        ['loads the same chapter again', 0],
        ['moves to a different word', 1],
    ])('does not report the end when a state callback %s', (_name, action) => {
        const timer = createFakeTimer()
        const chapter = makeChapter(['one two'])
        const onChapterEnd = vi.fn()
        let played = false
        let done = false
        const engine = createRsvpEngine({
            settings: PLAIN,
            timer,
            callbacks: {
                onChapterEnd,
                onStateChange: (state) => {
                    if (state.status === 'playing') played = true
                    if (done || !played || state.status !== 'paused' || state.index !== 1) return
                    done = true
                    // The caller keeps one word array for each chapter, so the array is the same.
                    if (action === 0) engine.load({ words: chapter.words, blocks: chapter.blocks })
                    else engine.seek(0)
                },
            },
        })
        engine.load({ words: chapter.words, blocks: chapter.blocks })
        engine.play()
        timer.fire()
        timer.fire()
        expect(engine.getState()).toEqual({ status: 'paused', index: 0, wordCount: 2 })
        expect(onChapterEnd).not.toHaveBeenCalled()

        // The next end of the chapter is reported.
        engine.play()
        timer.fire()
        timer.fire()
        expect(onChapterEnd).toHaveBeenCalledTimes(1)
    })

    test('does not report the end when a state callback starts playback again', () => {
        const timer = createFakeTimer()
        const chapter = makeChapter(['one two'])
        const onChapterEnd = vi.fn()
        let repeats = 1
        const engine = createRsvpEngine({
            settings: PLAIN,
            timer,
            callbacks: {
                onChapterEnd,
                onStateChange: (state) => {
                    if (state.status === 'paused' && state.index === 1 && repeats > 0) {
                        repeats--
                        engine.seek(0)
                        engine.play()
                    }
                },
            },
        })
        engine.load({ words: chapter.words, blocks: chapter.blocks })
        engine.play()
        timer.fire()
        timer.fire()
        expect(engine.getState()).toEqual({ status: 'playing', index: 0, wordCount: 2 })
        expect(onChapterEnd).not.toHaveBeenCalled()

        timer.fire()
        timer.fire()
        expect(onChapterEnd).toHaveBeenCalledTimes(1)
    })
})

describe('settings', () => {
    test('a speed change during playback applies from the next word', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.play()
        engine.setSettings({ wpm: 300 })
        expect(timer.pending()).toEqual([100])
        expect(timer.startedCount()).toBe(1)
        timer.fire()
        expect(timer.pending()).toEqual([200])
    })

    test('a multiplier change during playback applies from the next word', () => {
        const { engine, timer } = setupWith(['one, two, three four'])
        engine.play()
        engine.setSettings({ commaMultiplier: 4 })
        expect(timer.pending()).toEqual([200])
        timer.fire()
        expect(timer.pending()).toEqual([400])
    })

    test('setSettings does not send a callback', () => {
        const { engine, events } = setupWith(['one two'])
        events.length = 0
        engine.setSettings({ wpm: 300 })
        expect(events).toEqual([])
    })

    test('setSettings limits numbers to their ranges', () => {
        const engine = createRsvpEngine()
        engine.setSettings({ wpm: 5, periodMultiplier: 0, headingMultiplier: 50 })
        expect(engine.getSettings()).toEqual({
            ...DEFAULT_RSVP_SETTINGS,
            wpm: 50,
            periodMultiplier: 1,
            headingMultiplier: 10,
        })
    })

    test('setSettings keeps the current value when the new value is not valid', () => {
        const engine = createRsvpEngine({ settings: { wpm: 400, commaMultiplier: 4 } })
        engine.setSettings({
            wpm: Number.NaN,
            periodMultiplier: Number.POSITIVE_INFINITY,
            commaMultiplier: undefined,
            longWordDelay: 'no' as unknown as boolean,
        })
        expect(engine.getSettings()).toEqual({
            ...DEFAULT_RSVP_SETTINGS,
            wpm: 400,
            commaMultiplier: 4,
        })
    })

    test('setSettings changes only the fields in the patch', () => {
        const engine = createRsvpEngine({ settings: { wpm: 400 } })
        engine.setSettings({ rampUp: false })
        expect(engine.getSettings()).toEqual({ ...DEFAULT_RSVP_SETTINGS, wpm: 400, rampUp: false })
    })

    test('getSettings gives a copy', () => {
        const engine = createRsvpEngine()
        engine.getSettings().wpm = 999
        expect(engine.getSettings().wpm).toBe(250)
    })
})

describe('seek', () => {
    test('shows the word and reports a change', () => {
        const { engine, events, chapter } = setupWith([TEN_WORDS])
        events.length = 0
        expect(engine.seek(4)).toBe(true)
        expect(engine.getCurrentWord()).toBe(chapter.words[4])
        expect(events).toEqual(['word:four', 'state:paused:4'])
    })

    test('returns false and sends no callback when the index does not change', () => {
        const { engine, events } = setupWith([TEN_WORDS])
        engine.seek(4)
        events.length = 0
        expect(engine.seek(4)).toBe(false)
        expect(events).toEqual([])
    })

    test('limits the index to the words of the chapter', () => {
        const { engine } = setupWith([TEN_WORDS])
        engine.seek(500)
        expect(engine.getState().index).toBe(9)
        engine.seek(-3)
        expect(engine.getState().index).toBe(0)
        engine.seek(6.8)
        expect(engine.getState().index).toBe(6)
        engine.seek(Number.NaN)
        expect(engine.getState().index).toBe(0)
    })

    test('during playback gives the new word its full time with one timer', () => {
        const { engine, timer } = setupWith(['one two three, four five'])
        engine.play()
        timer.advance(60)
        engine.seek(2)
        expect(engine.getState()).toEqual({ status: 'playing', index: 2, wordCount: 5 })
        expect(timer.pending()).toEqual([200])
        timer.fire()
        expect(engine.getState().index).toBe(3)
    })
})

describe('seekToOffset', () => {
    test('goes to the first word whose end is above the offset', () => {
        const { engine, chapter } = setupWith(['zero one', 'two three'])
        const { words } = chapter

        engine.seekToOffset(words[1].start)
        expect(engine.getState().index).toBe(1)
        engine.seekToOffset(words[3].end - 1)
        expect(engine.getState().index).toBe(3)
        // The offset of the space after "zero" belongs to the next word.
        engine.seekToOffset(words[0].end)
        expect(engine.getState().index).toBe(1)
        // The offset of the line break between the blocks belongs to "two".
        engine.seekToOffset(words[1].end)
        expect(engine.getState().index).toBe(2)
        engine.seekToOffset(0)
        expect(engine.getState().index).toBe(0)
    })

    test('limits the offset to the chapter', () => {
        const { engine } = setupWith(['zero one', 'two three'])
        expect(engine.seekToOffset(10000)).toBe(true)
        expect(engine.getState().index).toBe(3)
        expect(engine.seekToOffset(-50)).toBe(true)
        expect(engine.getState().index).toBe(0)
        expect(engine.seekToOffset(Number.NaN)).toBe(false)
        expect(engine.getState().index).toBe(0)
    })

    test('gives a position that maps back to the same word', () => {
        const { engine, chapter } = setupWith(['zero one', 'two three'])
        for (let i = 0; i < chapter.words.length; i++) {
            engine.seekToOffset(chapter.words[i].start)
            expect(engine.getCurrentWord()).toBe(chapter.words[i])
        }
    })
})

describe('stepWords', () => {
    test('moves forward and back', () => {
        const { engine } = setupWith([TEN_WORDS])
        expect(engine.stepWords(3)).toBe(true)
        expect(engine.getState().index).toBe(3)
        expect(engine.stepWords(-2)).toBe(true)
        expect(engine.getState().index).toBe(1)
        expect(engine.stepWords(2.9)).toBe(true)
        expect(engine.getState().index).toBe(3)
    })

    test('stops at the two ends of the chapter', () => {
        const { engine } = setupWith([TEN_WORDS])
        expect(engine.stepWords(-1)).toBe(false)
        expect(engine.stepWords(100)).toBe(true)
        expect(engine.getState().index).toBe(9)
        expect(engine.stepWords(1)).toBe(false)
        expect(engine.stepWords(-100)).toBe(true)
        expect(engine.getState().index).toBe(0)
    })

    test('ignores a count that is zero or not finite', () => {
        const { engine } = setupWith([TEN_WORDS])
        engine.seek(4)
        expect(engine.stepWords(0)).toBe(false)
        expect(engine.stepWords(Number.NaN)).toBe(false)
        expect(engine.stepWords(Number.POSITIVE_INFINITY)).toBe(false)
        expect(engine.getState().index).toBe(4)
    })

    test('during playback gives the new word its full time', () => {
        const { engine, timer } = setupWith(['one two, three four'])
        engine.play()
        timer.advance(50)
        engine.stepWords(1)
        expect(timer.pending()).toEqual([200])
    })
})

describe('stepSentence', () => {
    /*
     * Word indexes:
     *   block 0 (heading): Chapter 0, one 1
     *   block 1: "Stop!" 2, she 3, said. 4, He 5, ran 6, away 7, fast\u2026 8, Then 9, nothing 10,
     *            (at 11, all).[3] 12, The 13, end 14
     *   block 2: New 15, block 16, starts 17, here. 18, Done. 19
     */
    const blocks = [
        '# Chapter one',
        '"Stop!" she said. He ran away fast\u2026 Then nothing (at all).[3] The end',
        'New block starts here. Done.',
    ]

    test('next goes through each sentence start', () => {
        const { engine } = setupWith(blocks)
        const visited: number[] = []
        while (engine.stepSentence('next')) visited.push(engine.getState().index)
        // 2 and 15 are block starts. 3 is after a quote. 9 is after an ellipsis. 13 is after a citation.
        expect(visited).toEqual([2, 3, 5, 9, 13, 15, 19])
    })

    test('next goes to the next sentence from the middle of a sentence', () => {
        const { engine } = setupWith(blocks)
        engine.seek(7)
        expect(engine.stepSentence('next')).toBe(true)
        expect(engine.getState().index).toBe(9)
    })

    test('next returns false in the last sentence and keeps the word', () => {
        const { engine, events } = setupWith(blocks)
        engine.seek(19)
        events.length = 0
        expect(engine.stepSentence('next')).toBe(false)
        expect(engine.getState().index).toBe(19)
        expect(events).toEqual([])
    })

    test('previous goes through each sentence start', () => {
        const { engine } = setupWith(blocks)
        engine.seek(19)
        const visited: number[] = []
        while (engine.stepSentence('previous')) visited.push(engine.getState().index)
        expect(visited).toEqual([15, 13, 9, 5, 3, 2, 0])
    })

    test('previous goes to the start of the current sentence from the fourth word', () => {
        const { engine } = setupWith(blocks)
        engine.seek(8)
        expect(engine.stepSentence('previous')).toBe(true)
        expect(engine.getState().index).toBe(5)

        engine.seek(18)
        engine.stepSentence('previous')
        expect(engine.getState().index).toBe(15)
    })

    test('previous goes to the sentence before from the first three words', () => {
        const { engine } = setupWith(blocks)
        for (const index of [5, 6, 7]) {
            engine.seek(index)
            engine.stepSentence('previous')
            expect(engine.getState().index).toBe(3)
        }
    })

    test('previous goes across a block start', () => {
        const { engine } = setupWith(blocks)
        engine.seek(16)
        engine.stepSentence('previous')
        expect(engine.getState().index).toBe(13)
        engine.seek(2)
        engine.stepSentence('previous')
        expect(engine.getState().index).toBe(0)
    })

    test('previous returns false at the first word', () => {
        const { engine } = setupWith(blocks)
        expect(engine.stepSentence('previous')).toBe(false)
        engine.seek(1)
        expect(engine.stepSentence('previous')).toBe(true)
        expect(engine.getState().index).toBe(0)
    })

    test('two fast pushes of previous during playback go back two sentences', () => {
        const { engine, timer } = setupWith(blocks)
        engine.seek(12)
        engine.play()
        engine.stepSentence('previous')
        expect(engine.getState().index).toBe(9)
        timer.fire()
        expect(engine.getState().index).toBe(10)
        engine.stepSentence('previous')
        expect(engine.getState().index).toBe(5)
        expect(engine.getState().status).toBe('playing')
        expect(timer.pending()).toEqual([100])
    })
})

describe('rewind', () => {
    test('goes back one word for each interval with no punctuation delay', () => {
        const { engine, timer, events } = setupWith(['one. two, three; four five'])
        engine.seek(4)
        events.length = 0

        engine.startRewind()
        expect(events).toEqual(['state:rewinding:4'])
        // 600 words for each minute gives the limit of 800, which is 75 ms.
        expect(timer.pending()).toEqual([75])

        timer.fire()
        expect(events).toEqual(['state:rewinding:4', 'word:four', 'state:rewinding:3'])
        expect(timer.pending()).toEqual([75])
        timer.fire()
        timer.fire()
        expect(engine.getState()).toEqual({ status: 'rewinding', index: 1, wordCount: 5 })
        expect(timer.pending()).toEqual([75])
    })

    test.each([
        [50, 600],
        [250, 120],
        [399, 60000 / 798],
        [400, 75],
        [1000, 75],
    ])('at %i words for each minute the interval is %f ms', (wpm, interval) => {
        const { engine, timer } = setupWith([TEN_WORDS], { ...PLAIN, wpm })
        engine.seek(5)
        engine.startRewind()
        expect(timer.pending()).toEqual([interval])
    })

    test('uses a new speed from the next word', () => {
        const { engine, timer } = setupWith([TEN_WORDS], { ...PLAIN, wpm: 250 })
        engine.seek(5)
        engine.startRewind()
        engine.setSettings({ wpm: 100 })
        expect(timer.pending()).toEqual([120])
        timer.fire()
        expect(timer.pending()).toEqual([300])
    })

    test('corrects drift', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.seek(5)
        engine.startRewind()
        timer.fire(10)
        expect(timer.pending()).toEqual([65])
        timer.fire(1000)
        expect(timer.pending()).toEqual([37.5])
    })

    test('stopRewind returns to paused when the engine was paused', () => {
        const { engine, timer, events } = setupWith([TEN_WORDS])
        engine.seek(5)
        engine.startRewind()
        timer.fire()
        events.length = 0

        engine.stopRewind()
        expect(events).toEqual(['state:paused:4'])
        expect(timer.pending()).toEqual([])
        timer.advance(10000)
        expect(engine.getState()).toEqual({ status: 'paused', index: 4, wordCount: 10 })
    })

    test('stopRewind returns to playing when the engine was playing', () => {
        const { engine, timer } = setupWith(['zero one two, three four five'])
        engine.seek(4)
        engine.play()
        engine.startRewind()
        expect(engine.getState().status).toBe('rewinding')
        expect(timer.pending()).toEqual([75])
        timer.fire()
        timer.fire()

        engine.stopRewind()
        expect(engine.getState()).toEqual({ status: 'playing', index: 2, wordCount: 6 })
        // "two," gets its full time.
        expect(timer.pending()).toEqual([200])
        timer.fire()
        expect(engine.getState().index).toBe(3)
    })

    test('the ramp starts again when playback continues after a rewind', () => {
        const { engine, timer } = setupWith([TEN_WORDS], { ...PLAIN, rampUp: true })
        engine.play()
        for (let i = 0; i < 6; i++) timer.fire()
        expect(timer.pending()).toEqual([100])

        engine.startRewind()
        timer.fire()
        engine.stopRewind()
        expect(timer.pending()[0]).toBeCloseTo(160, 6)
    })

    test('waits at the first word until stopRewind', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.seek(2)
        engine.play()
        engine.startRewind()
        timer.fire()
        timer.fire()
        expect(engine.getState()).toEqual({ status: 'rewinding', index: 0, wordCount: 10 })
        expect(timer.pending()).toEqual([])
        timer.advance(10000)
        expect(engine.getState()).toEqual({ status: 'rewinding', index: 0, wordCount: 10 })

        engine.stopRewind()
        expect(engine.getState()).toEqual({ status: 'playing', index: 0, wordCount: 10 })
        expect(timer.pending()).toEqual([100])
    })

    test('startRewind does nothing at the first word', () => {
        const { engine, timer, events } = setupWith([TEN_WORDS])
        engine.play()
        events.length = 0
        engine.startRewind()
        expect(events).toEqual([])
        expect(engine.getState().status).toBe('playing')
        expect(timer.startedCount()).toBe(1)
    })

    test('a second startRewind does not start a second timer', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.seek(5)
        engine.play()
        engine.startRewind()
        engine.startRewind()
        expect(timer.pending()).toEqual([75])

        // The second call must not replace the status to return to.
        engine.stopRewind()
        expect(engine.getState().status).toBe('playing')
    })

    test('stopRewind does nothing when there is no rewind', () => {
        const { engine, timer, events } = setupWith([TEN_WORDS])
        engine.play()
        events.length = 0
        engine.stopRewind()
        expect(events).toEqual([])
        expect(timer.startedCount()).toBe(1)
    })

    test('pause stops a rewind, and a later stopRewind does not start playback', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.seek(5)
        engine.play()
        engine.startRewind()
        engine.pause()
        expect(engine.getState().status).toBe('paused')
        expect(timer.pending()).toEqual([])
        engine.stopRewind()
        expect(engine.getState().status).toBe('paused')
        expect(timer.pending()).toEqual([])
    })

    test('play stops a rewind and plays with one timer', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.seek(5)
        engine.startRewind()
        engine.play()
        expect(engine.getState().status).toBe('playing')
        expect(timer.pending()).toEqual([100])
        timer.fire()
        expect(engine.getState().index).toBe(6)
    })

    test('a seek during a rewind continues the rewind from the new word', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.seek(1)
        engine.startRewind()
        timer.fire()
        expect(timer.pending()).toEqual([])

        engine.seek(8)
        expect(engine.getState().status).toBe('rewinding')
        expect(timer.pending()).toEqual([75])
        timer.fire()
        expect(engine.getState().index).toBe(7)
    })
})

describe('timer use', () => {
    test('never has more than one timer', () => {
        const { engine, timer } = setupWith([
            '# A heading',
            'First sentence here. Second one, with a comma. Third!',
            'Another block of words that goes on.',
        ])
        const actions: Array<() => void> = [
            () => engine.play(),
            () => engine.pause(),
            () => engine.toggle(),
            () => engine.seek(7),
            () => engine.seekToOffset(30),
            () => engine.stepWords(2),
            () => engine.stepWords(-3),
            () => engine.stepSentence('next'),
            () => engine.stepSentence('previous'),
            () => engine.startRewind(),
            () => engine.stopRewind(),
            () => engine.setSettings({ wpm: 500 }),
            () => timer.advance(90),
            () => timer.advance(400),
        ]

        // A fixed pseudo-random order, so that a failure can be repeated.
        let seed = 12345
        for (let step = 0; step < 3000; step++) {
            seed = (seed * 1103515245 + 12345) % 2147483648
            actions[seed % actions.length]()
            expect(timer.pending().length).toBeLessThanOrEqual(1)

            const { status, index, wordCount } = engine.getState()
            expect(index).toBeGreaterThanOrEqual(0)
            expect(index).toBeLessThan(wordCount)
            if (status === 'playing') expect(timer.pending()).toHaveLength(1)
            if (status === 'paused') expect(timer.pending()).toHaveLength(0)
        }
    })

    test('ignores a timer callback that runs after it was cleared', () => {
        // This timer cannot clear a timeout. It models a callback that is already in the task queue.
        const callbacks: Array<() => void> = []
        const timer: RsvpTimer = {
            setTimeout: (callback) => callbacks.push(callback),
            clearTimeout: () => {},
            now: () => 0,
        }
        const chapter = makeChapter([TEN_WORDS])
        const engine = createRsvpEngine({ settings: PLAIN, timer })
        engine.load({ words: chapter.words, blocks: chapter.blocks })

        engine.play()
        engine.pause()
        engine.play()
        expect(callbacks).toHaveLength(2)

        callbacks[0]()
        expect(engine.getState().index).toBe(0)
        callbacks[1]()
        expect(engine.getState().index).toBe(1)
        callbacks[1]()
        expect(engine.getState().index).toBe(1)
    })
})

describe('destroy', () => {
    test('stops the timer and releases the chapter', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.play()
        engine.destroy()
        expect(timer.pending()).toEqual([])
        expect(engine.getState()).toEqual({ status: 'idle', index: 0, wordCount: 0 })
        expect(engine.getCurrentWord()).toBeNull()
    })

    test('stops a rewind', () => {
        const { engine, timer } = setupWith([TEN_WORDS])
        engine.seek(5)
        engine.startRewind()
        engine.destroy()
        expect(timer.pending()).toEqual([])
    })

    test('makes each method do nothing', () => {
        const { engine, timer, events, chapter } = setupWith([TEN_WORDS])
        engine.seek(3)
        engine.destroy()
        events.length = 0
        const started = timer.startedCount()

        engine.load({ words: chapter.words, blocks: chapter.blocks, index: 2 })
        engine.play()
        engine.pause()
        engine.toggle()
        expect(engine.seek(4)).toBe(false)
        expect(engine.seekToOffset(20)).toBe(false)
        expect(engine.stepWords(1)).toBe(false)
        expect(engine.stepWords(-1)).toBe(false)
        expect(engine.stepSentence('next')).toBe(false)
        expect(engine.stepSentence('previous')).toBe(false)
        engine.startRewind()
        engine.stopRewind()
        engine.setSettings({ wpm: 900 })
        engine.destroy()
        timer.advance(10000)

        expect(events).toEqual([])
        expect(timer.startedCount()).toBe(started)
        expect(engine.getState()).toEqual({ status: 'idle', index: 0, wordCount: 0 })
        expect(engine.getCurrentWord()).toBeNull()
        expect(engine.getSettings().wpm).toBe(600)
    })

    test('sends no callback after a callback destroys the engine', () => {
        const timer = createFakeTimer()
        const chapter = makeChapter(['one two three'])
        const onStateChange = vi.fn()
        const onChapterEnd = vi.fn()
        const engine = createRsvpEngine({
            settings: PLAIN,
            timer,
            callbacks: {
                onWord: ({ index }) => {
                    if (index === 1) engine.destroy()
                },
                onStateChange,
                onChapterEnd,
            },
        })
        engine.load({ words: chapter.words, blocks: chapter.blocks })
        engine.play()
        onStateChange.mockClear()

        timer.fire()
        expect(onStateChange).not.toHaveBeenCalled()
        expect(timer.pending()).toEqual([])
        timer.advance(10000)
        expect(onChapterEnd).not.toHaveBeenCalled()
    })
})
