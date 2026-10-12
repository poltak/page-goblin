/**
 * The listen mode. Speech reads the book, a marker in the page follows the voice, and the
 * pages turn by themselves. The bar with the controls is in the dock below the page.
 *
 * The speech controller of `$lib/speech` does the speech. This file gives it the text of the
 * chapters, shows its ranges in the reader view, and connects the controls and the settings.
 *
 * iOS Safari starts speech only in the task of a user action. Each handler of a click or a
 * key in this file calls the controller with no `await` before the call.
 */

import './listen.css'

import { normalizeLanguage } from '$lib/content'
import type { ScreenWakeLock } from '$lib/pwa/wake-lock'
import type { Sentence } from '$lib/content'
import type { ReaderView, RelocateInfo } from '$lib/reader/types'
import type { Settings, SettingsStore } from '$lib/settings'
import {
    createSpeechController,
    listVoices,
    pickVoice,
    SpeechError,
    type SpeechProvider,
    type SpeechRange,
    type SpeechRangeKind,
    type SpeechState,
    type VoiceInfo,
} from '$lib/speech'
import type { Locator, TextRange } from '$lib/types'
import { showToast } from '../../app/toast'
import { on } from '../../dom'
import type { ModeController, ModeOptions } from '../parts'
import { isPageTurn } from '../screen/bars'
import type { ReaderMode } from '../types'
import {
    findSpeechChapter,
    hasSentenceAfter,
    nextLinearIndex,
    sentenceAt,
    sentencesFrom,
    type SpeechChapter,
} from './chapters'
import { observeProvider } from './observe-provider'
import { createSleepTimer } from './sleep-timer'
import { createBarView, type BarState, type BarView } from './view'
import { createVoiceSheet, type VoiceSheet } from './voice-sheet'

export interface ListenBarOptions extends ModeOptions {
    provider: SpeechProvider
    settings: SettingsStore
    wakeLock: ScreenWakeLock
}

/**
 * The time for the first sound after a start that is not in the task of a user action. With
 * no sound in this time, the bar shows the play button.
 */
export const START_WAIT_MS = 700
/**
 * With no sound in this time after such a start, speech stops. A voice from the network can
 * need more than `START_WAIT_MS`, so the controller continues to this limit. The limit is
 * below the shortest watchdog time of the controller (4 seconds), so the position does not
 * move while the browser makes no sound.
 */
export const START_LIMIT_MS = 3000
/** With no voice in the list after this time, the bar shows that there are no voices. */
export const NO_VOICES_MS = 2000
/** The first start waits this long for the voice list, so that it does not start two times. */
export const VOICE_WAIT_MS = 250
/** Each new rate starts the sentence again. Some steps in a row give one new start. */
export const RATE_APPLY_MS = 200

/** The next chapter loads when this number of utterances is left, or fewer. */
const PREPARE_AHEAD = 2

/**
 * A view can send more than one position for a new layout, and the first one can be a page
 * that it leaves again. In this time after the cause of a new layout, no position counts as a
 * move of the reader.
 */
export const LAYOUT_SETTLE_MS = 1000

/**
 * After the reader moves the page by hand, the page does not go to the marker for this time.
 * The scroll view sends its new position only when the scroll ends, and a word of the voice
 * before that would pull the page back below the finger.
 */
export const HAND_MOVE_MS = 2000

/** The keys that move the page and are not keys of the listen bar. */
const MOVE_KEYS: ReadonlySet<string> = new Set([
    'PageDown',
    'PageUp',
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
])

/**
 * The scroll view can show the start of the next chapter below the end of a chapter. A marker
 * in these first characters of the next chapter then counts as in sight.
 */
const NEXT_CHAPTER_IN_SIGHT = 1000

/** The settings that give the text of the book a new layout. */
const LAYOUT_SETTINGS = [
    'fontId',
    'fontSize',
    'lineHeight',
    'margin',
    'textAlign',
    'hyphenate',
    'publisherStyles',
    'columns',
] as const satisfies readonly (keyof Settings)[]

/** True when a part of the range is in the text that the view shows. */
export function isInSight(range: TextRange, info: RelocateInfo): boolean {
    const { visible } = info
    if (range.spineIndex === visible.spineIndex) {
        return range.start < visible.end && range.end > visible.start
    }
    // The visible range of the scroll view stops at the end of its chapter.
    return (
        info.page === null &&
        range.spineIndex > visible.spineIndex &&
        visible.end >= info.chapterLength &&
        range.start < NEXT_CHAPTER_IN_SIGHT
    )
}

const SLEEP_MESSAGE = 'Sleep timer: listening is paused.'
const ERROR_MESSAGE = 'The voice stopped. Try a different voice.'
const END_MESSAGE = 'End of the book'

const NOT_FOR_KEYS =
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, .menu'
const PRESSABLE = 'button, a[href], summary, [role="button"], [role="link"]'

/** The next chapter with sentences, loaded before the current chapter ends. */
interface Upcoming {
    /** Spine index of the chapter that this one comes after. */
    after: number
    promise: Promise<SpeechChapter | null>
    settled: boolean
    /** Null after `settled` means the end of the book. */
    chapter: SpeechChapter | null
}

type Timer = ReturnType<typeof setTimeout> | null

export function createListenBarWith(options: ListenBarOptions): ModeController {
    const { session, host, dock, settings, wakeLock, onExit } = options
    const bookLanguage = normalizeLanguage(session.book.metadata.language)
    const provider = observeProvider(options.provider, onSound)
    const controller = createSpeechController({
        provider,
        callbacks: { onStateChange, onRange, onChapterEnd, onError },
    })
    const sleep = createSleepTimer({ onChange: showSleep, onElapsed: onSleepElapsed })

    let view: BarView | null = null
    let sheet: VoiceSheet | null = null
    let active = false
    let destroyed = false
    let cleanups: (() => void)[] = []

    /** The chapter that the controller has. */
    let chapter: SpeechChapter | null = null
    /** The sentences that the controller has. The first one can start at the start offset. */
    let spoken: Sentence[] = []
    let upcoming: Upcoming | null = null
    /** Each start and each chapter change takes a new value. An older load is ignored. */
    let loadToken = 0
    /** `start` loads a chapter. */
    let loading = false
    /** The next chapter loads after the end of a chapter. The controller is idle in this time. */
    let advancing = false
    /** Speech starts when the chapter that loads now is ready. */
    let playAfterLoad = false
    let unavailable = false

    /** The browser sent a speech event at some time, so it accepts speech from this page. */
    let heard = false
    /**
     * The wait for the first sound after a start that is not in the task of a user action:
     * 'waiting' to `START_WAIT_MS`, then 'blocked' to `START_LIMIT_MS`.
     */
    let probe: 'none' | 'waiting' | 'blocked' = 'none'
    let probeTimer: Timer = null
    /** The controller went to idle during that wait. Its error callback comes after that. */
    let startFailed = false
    let noVoicesTimer: Timer = null
    let rateTimer: Timer = null
    /** Ends the wait of a start for the voice list. */
    let voicesArrived: (() => void) | null = null
    let voiceList: VoiceInfo[] | null = null

    /** The sentence that speech is at. */
    let sentence: TextRange | null = null
    /** The range that the view shows: the sentence or one of its words. */
    let marker: TextRange | null = null
    let keepMarker = false
    let wakeLocked = false
    /**
     * The reader went to a different place in the book while the voice continued. The page
     * then stays there and does not go back to the marker.
     */
    let away = false
    /**
     * The view got a marker that was not in sight, and it moves to that marker now. The
     * positions that it sends in this time are not moves of the reader.
     */
    let following = false
    /** The last position of the book, for the test of a page turn. */
    let lastPosition: RelocateInfo | null = null
    /** The time (`Date.now()`) to which a new position comes from a new layout. */
    let layoutUntil = 0
    /** The time of the last move of the page by hand. */
    let handMoveAt = Number.NEGATIVE_INFINITY
    let pointerDown = false

    // ---------- State of the bar ----------

    function barState(): BarState {
        if (unavailable) return 'unavailable'
        if (loading) return 'loading'
        if (advancing) {
            if (!playAfterLoad) return 'paused'
            return heard ? 'playing' : 'loading'
        }
        if (controller.getState().status !== 'playing') return 'paused'
        if (probe === 'waiting') return 'loading'
        return probe === 'blocked' ? 'paused' : 'playing'
    }

    function render(): void {
        if (!view || !active) return
        const state = barState()
        view.setState(state)
        setWakeLock(state === 'playing' && settings.get().keepAwake)
    }

    function setWakeLock(wanted: boolean): void {
        if (wanted === wakeLocked) return
        wakeLocked = wanted
        void (wanted ? wakeLock.request() : wakeLock.release())
    }

    function showSleep(): void {
        view?.setSleep({ choice: sleep.choice, minutesLeft: sleep.minutesLeft })
    }

    // ---------- Marker ----------

    function showMarker(range: TextRange | null): void {
        marker = range
        // The view object changes with the layout mode, so read it each time.
        if (!range) {
            session.view.setActiveRange(null)
            return
        }
        const follow = canFollow()
        const position = session.position
        if (follow && position && !isInSight(range, position)) following = true
        session.view.setActiveRange(range, { follow })
    }

    function canFollow(): boolean {
        return !away && Date.now() - handMoveAt >= HAND_MOVE_MS
    }

    /** The reader moves the page with the wheel, a finger, the scroll bar or a key. */
    function onHandMove(event: Event): void {
        const target = event.target
        // A scroll in a panel, a menu or the bar is not a move of the page.
        if (target instanceof Node && (host.contains(target) || dock.contains(target))) return
        handMoveAt = Date.now()
    }

    /** The page shows the marker again and follows it. */
    function comeBack(): void {
        away = false
        handMoveAt = Number.NEGATIVE_INFINITY
    }

    function onRelocate(info: RelocateInfo): void {
        // A new layout shows the same place, so it is not a move of the reader.
        const moved = Date.now() >= layoutUntil && isPageTurn(lastPosition, info)
        lastPosition = info
        if (!marker) return
        if (isInSight(marker, info)) {
            following = false
            away = false
        } else if (moved && !following) {
            away = true
        }
    }

    /** The text gets a new layout now. The positions that follow say nothing about the reader. */
    function expectLayout(): void {
        layoutUntil = Date.now() + LAYOUT_SETTLE_MS
    }

    function onRange(range: SpeechRange | null, kind: SpeechRangeKind): void {
        if (!active || !chapter) return
        if (!range) {
            if (keepMarker) return
            sentence = null
            if (marker) showMarker(null)
            return
        }
        const textRange = { spineIndex: chapter.spineIndex, start: range.start, end: range.end }
        if (kind === 'sentence') {
            sentence = textRange
            showMarker(textRange)
        } else if (settings.get().speech.highlightWords) {
            showMarker(textRange)
        }
    }

    /** The controller shows no range while it is idle. This shows where speech will start. */
    function markSelection(): void {
        if (!chapter || controller.getState().status !== 'idle') return
        const found = sentenceAt(spoken, controller.getPosition())
        sentence = found && {
            spineIndex: chapter.spineIndex,
            start: found.start,
            end: found.end,
        }
        if (sentence || marker) showMarker(sentence)
    }

    function onViewChange(next: ReaderView): void {
        expectLayout()
        if (marker) next.setActiveRange(marker, { follow: canFollow() })
    }

    // ---------- Voices ----------

    function voices(): VoiceInfo[] {
        return (voiceList ??= listVoices({ provider, bookLanguage }))
    }

    function selectedVoice(): VoiceInfo | null {
        return pickVoice({
            voices: voices(),
            preferredId: settings.get().speech.voiceId,
            bookLanguage,
        })
    }

    function applyVoice(): void {
        controller.setVoice(selectedVoice()?.id ?? null)
    }

    function onVoicesChanged(): void {
        voiceList = null
        if (voices().length > 0) {
            clearTimeout(noVoicesTimer ?? undefined)
            noVoicesTimer = null
            voicesArrived?.()
            // The voices came after the limit. The loaded chapter is ready for the play button.
            if (unavailable && provider.isSupported()) unavailable = false
        }
        applyVoice()
        sheet?.refreshVoices()
        render()
    }

    function onNoVoices(): void {
        noVoicesTimer = null
        // A browser can fill its list and send no event, so read the list again.
        voiceList = null
        if (voices().length > 0) onVoicesChanged()
        // Some browsers speak with their default voice and give no list.
        else if (!heard) setUnavailable()
    }

    function setUnavailable(): void {
        unavailable = true
        clearProbe()
        if (controller.getState().status !== 'idle') controller.stop()
        sheet?.close()
        render()
    }

    /** Resolves when the voice list has a voice, and after `VOICE_WAIT_MS` at the latest. */
    function waitForVoices(): Promise<void> {
        if (voices().length > 0) return Promise.resolve()
        return new Promise((resolve) => {
            const timer = setTimeout(finish, VOICE_WAIT_MS)
            function finish(): void {
                clearTimeout(timer)
                if (voicesArrived === finish) voicesArrived = null
                resolve()
            }
            // The wait of an older start has no use now.
            voicesArrived?.()
            voicesArrived = finish
        })
    }

    // ---------- The first sound ----------

    function clearProbe(): void {
        if (probeTimer !== null) clearTimeout(probeTimer)
        probeTimer = null
        probe = 'none'
        startFailed = false
    }

    function startProbe(): void {
        clearProbe()
        probe = 'waiting'
        probeTimer = setTimeout(() => {
            probe = 'blocked'
            probeTimer = setTimeout(onStartLimit, START_LIMIT_MS - START_WAIT_MS)
            render()
        }, START_WAIT_MS)
    }

    function onStartLimit(): void {
        clearProbe()
        playAfterLoad = false
        if (controller.getState().status === 'playing') stopKeepingMarker()
        render()
    }

    function onSound(): void {
        heard = true
        if (probe === 'none') return
        clearProbe()
        render()
    }

    /** Stops speech. The marker stays on the sentence where the play button starts again. */
    function stopKeepingMarker(): void {
        keepMarker = true
        try {
            controller.stop()
        } finally {
            keepMarker = false
        }
    }

    // ---------- Chapters ----------

    function loadChapter(next: SpeechChapter): void {
        chapter = next
        spoken = sentencesFrom(next)
        if (upcoming && upcoming.after !== next.spineIndex) upcoming = null
        controller.load({
            text: next.text,
            sentences: spoken,
            lang: next.lang,
            offset: next.offset,
        })
    }

    /** The chapter in memory as a start at `from`, or null when it is a different chapter. */
    function chapterInMemory(from: Locator): SpeechChapter | null {
        if (!chapter || chapter.spineIndex !== from.spineIndex) return null
        if (!hasSentenceAfter(chapter.sentences, from.offset)) return null
        return { ...chapter, offset: from.offset }
    }

    /**
     * Loads the text at the reading position. The reader screen makes the bar at the press on
     * its Listen button. When the text is in memory at the click, `start` speaks in the task
     * of the click, which iOS Safari requires.
     */
    async function loadAhead(): Promise<void> {
        const from = session.position?.locator
        if (!from || !provider.isSupported()) return
        // The first read of the voice list starts its load in Chrome.
        provider.getVoices()
        const found = await findSpeechChapter({
            book: session.book,
            content: session.content,
            from,
            isCurrent: () => !destroyed,
        })
        // A start that did not wait for this load has its own chapter.
        if (found && !chapter && !destroyed) chapter = found
    }

    /** The next linear chapter that has sentences, after the chapter of the controller. */
    function loadUpcoming(): Promise<SpeechChapter | null> {
        if (!chapter) return Promise.resolve(null)
        const after = chapter.spineIndex
        if (upcoming?.after === after) return upcoming.promise

        const entry: Upcoming = {
            after,
            promise: Promise.resolve(null),
            settled: false,
            chapter: null,
        }
        const next = nextLinearIndex(session.book, after)
        if (next < 0) {
            entry.settled = true
        } else {
            entry.promise = findSpeechChapter({
                book: session.book,
                content: session.content,
                from: { spineIndex: next, offset: 0 },
                isCurrent: () => upcoming === entry,
            }).then((found) => {
                entry.settled = true
                entry.chapter = found
                return found
            })
        }
        upcoming = entry
        return entry.promise
    }

    /** Goes to the next chapter when its text is not in memory at the end of a chapter. */
    async function advance({ play: playNext }: { play: boolean }): Promise<void> {
        const token = ++loadToken
        advancing = true
        playAfterLoad = playNext
        render()
        const next = await loadUpcoming()
        if (token !== loadToken || !active) return
        if (!next) {
            advancing = false
            // A step to the next sentence while speech is paused does not end the mode.
            if (playAfterLoad) finishBook()
            else render()
            return
        }
        // The controller reports its idle state in this call. The bar must not show a pause
        // and release the wake lock between two chapters.
        loadChapter(next)
        advancing = false
        if (playAfterLoad && !unavailable) startSpeech()
        else markSelection()
        render()
    }

    function finishBook(): void {
        showToast({ message: END_MESSAGE })
        void stop()
    }

    // ---------- Controller callbacks ----------

    function onStateChange(state: SpeechState): void {
        if (!active) return
        if (state.status !== 'playing') {
            const wasWaiting = probe !== 'none'
            clearProbe()
            startFailed = wasWaiting
        } else if (state.chunkCount - state.chunk <= PREPARE_AHEAD) {
            // With the text in memory, the next chapter starts with no gap and in the same
            // call chain as the end of this one.
            void loadUpcoming()
        }
        render()
    }

    function onChapterEnd(): void {
        if (!active || !chapter) return
        if (sleep.takeChapterEnd()) {
            // No load here, so the controller goes to idle. The play button then gives this
            // callback again, and the text of the next chapter is ready for it.
            playAfterLoad = false
            void loadUpcoming()
            showToast({ message: SLEEP_MESSAGE })
            return
        }

        const ready = upcoming?.after === chapter.spineIndex && upcoming.settled ? upcoming : null
        if (!ready) {
            void advance({ play: true })
            return
        }
        loadToken += 1
        if (ready.chapter) loadChapter(ready.chapter)
        else finishBook()
    }

    function onError(error: unknown): void {
        if (!active) return
        const code = error instanceof SpeechError ? error.code : null
        if (code === 'unsupported') {
            setUnavailable()
            return
        }
        // The browser refused a start that was not in the task of a user action. The play
        // button is the answer, not a message.
        const refusedStart = code === 'not-allowed' && (startFailed || probe !== 'none')
        clearProbe()
        playAfterLoad = false
        // The marker shows where the play button starts speech.
        if (refusedStart) markSelection()
        else showToast({ message: ERROR_MESSAGE, tone: 'error' })
        render()
    }

    // ---------- Speech actions ----------

    /**
     * Makes the controller speak. Call it in the task of a user action. With `again`, a paused
     * sentence starts from its first word, so that the reader hears a new voice.
     */
    function speak({ again = false } = {}): void {
        if (!chapter) return
        const { status } = controller.getState()
        if (status === 'idle') {
            controller.play()
            return
        }
        // The status "playing" here means no sound: the browser dropped the first call. A load
        // of the same text at the same place speaks the sentence again, and it drops the part
        // of a paused sentence that the browser kept.
        if (status === 'playing' || again) {
            controller.load({
                text: chapter.text,
                sentences: spoken,
                lang: chapter.lang,
                offset: controller.getPosition(),
            })
        }
        if (status === 'paused') controller.resume()
    }

    /** Starts speech after a load, which is not in the task of a user action. */
    function startSpeech(): void {
        if (!heard) startProbe()
        const { status } = controller.getState()
        if (status === 'paused') controller.resume()
        else if (status === 'idle') controller.play()
        // The state callback does not come when the chapter had nothing to speak.
        if (controller.getState().status !== 'playing') clearProbe()
    }

    function play(): void {
        // The reader went to a different place during the pause. Speech continues there.
        const from = away ? session.position?.locator : undefined
        if (from) {
            void startAt(from)
            return
        }
        playAfterLoad = true
        clearProbe()
        if (!advancing) speak()
        render()
    }

    function pause(): void {
        playAfterLoad = false
        clearProbe()
        controller.pause()
        render()
    }

    function canControl(): boolean {
        return active && !unavailable && !loading && chapter !== null
    }

    function toggle(): void {
        if (!canControl()) return
        if (barState() === 'playing') pause()
        else play()
    }

    function previousSentence(): void {
        if (!canControl() || advancing) return
        comeBack()
        // While speech plays, the controller speaks again in the task of this user action.
        clearProbe()
        controller.previousSentence()
        markSelection()
        render()
    }

    function nextSentence(): void {
        if (!canControl() || advancing) return
        comeBack()
        clearProbe()
        if (controller.nextSentence()) {
            markSelection()
            render()
            return
        }
        // The chapter has no later sentence and speech does not play. While speech plays, the
        // controller ends the chapter itself.
        if (controller.getState().status !== 'playing') void advance({ play: false })
    }

    function selectVoice(voice: VoiceInfo): void {
        const speakCount = provider.speakCount
        // The settings listener gives the voice to the controller.
        settings.update({ speech: { voiceId: voice.id } })
        if (!canControl()) return
        playAfterLoad = true
        clearProbe()
        // The reader must hear the voice. A new voice starts the sentence again only while
        // speech plays.
        if (!advancing && provider.speakCount === speakCount) speak({ again: true })
        render()
    }

    function onSleepElapsed(): void {
        if (!active) return
        const state = barState()
        if (state === 'paused' || state === 'unavailable') return
        pause()
        showToast({ message: SLEEP_MESSAGE })
    }

    // ---------- Settings ----------

    function applyRate(): void {
        rateTimer = null
        controller.setRate(settings.get().speech.rate)
    }

    function onSettings(next: Settings, previous: Settings): void {
        if (next.keepAwake !== previous.keepAwake) render()
        if (LAYOUT_SETTINGS.some((key) => next[key] !== previous[key])) expectLayout()
        const { speech } = next
        if (speech === previous.speech) return

        if (speech.rate !== previous.speech.rate) {
            view?.setRate(speech.rate)
            if (rateTimer !== null) clearTimeout(rateTimer)
            rateTimer = setTimeout(applyRate, RATE_APPLY_MS)
        }
        if (speech.pitch !== previous.speech.pitch) controller.setPitch(speech.pitch)
        if (speech.voiceId !== previous.speech.voiceId) applyVoice()
        // The marker of a word goes back to its sentence.
        const wordsOff = previous.speech.highlightWords && !speech.highlightWords
        if (wordsOff && sentence && marker !== sentence) showMarker(sentence)
        sheet?.syncSettings()
    }

    // ---------- Keyboard and page events ----------

    function onKeyDown(event: KeyboardEvent): void {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
        const { key } = event
        if (MOVE_KEYS.has(key)) onHandMove(event)
        const isToggle = key === ' ' || key === 'k' || key === 'K'
        const isPageKey = key === 'PageDown' || key === 'PageUp'
        const isOther = key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Escape'
        if (!isToggle && !isPageKey && !isOther) return

        const target = event.target instanceof Element ? event.target : null
        if (target?.closest(NOT_FOR_KEYS)) return
        if (view?.menuOpen || document.querySelector('dialog[open]')) return
        // Space on a button is the click of that button.
        if (key === ' ' && target?.closest(PRESSABLE)) return

        event.preventDefault()
        // A key that the user holds down turns pages, and does nothing more.
        if (event.repeat && !isPageKey) return

        if (isToggle) toggle()
        else if (key === 'ArrowLeft') previousSentence()
        else if (key === 'ArrowRight') nextSentence()
        else if (key === 'Escape') void stop()
        else turnPage(key === 'PageDown' ? session.next() : session.prev())
    }

    function turnPage(turn: Promise<unknown>): void {
        // The session tells the screen about an error that the user must see.
        turn.catch(() => {})
    }

    // Chrome continues to speak after the page is gone.
    function onPageHide(): void {
        playAfterLoad = false
        clearProbe()
        if (controller.getState().status !== 'idle') stopKeepingMarker()
        render()
    }

    // A different mode started and this one did not get a stop call.
    function onModeChange(mode: ReaderMode): void {
        if (active && mode !== 'listen') teardown()
    }

    // ---------- Mount and teardown ----------

    function openVoices(opener: HTMLElement): void {
        sheet ??= createVoiceSheet({
            host,
            settings,
            language: bookLanguage,
            getVoices: voices,
            getSelectedId: () => selectedVoice()?.id ?? null,
            onSelect: selectVoice,
        })
        sheet.open(opener)
    }

    function mount(): void {
        view ??= createBarView({
            onToggle: toggle,
            onPrevious: previousSentence,
            onNext: nextSentence,
            onRate: (rate) => settings.update({ speech: { rate } }),
            onSleep: (choice) => sleep.set(choice),
            onVoices: openVoices,
            onClose: () => void stop(),
            getRate: () => settings.get().speech.rate,
            getSleep: () => sleep.choice,
        })
        view.mount({ dock, host })
        // The screen hid the button that started the mode. The keyboard continues at the bar.
        view.focus()

        // The provider keeps its voice list only while it has a listener.
        voiceList = null
        cleanups = [
            provider.onVoicesChanged(onVoicesChanged),
            settings.subscribe(onSettings),
            session.on('view', onViewChange),
            session.on('mode', onModeChange),
            session.on('relocate', onRelocate),
            on(document, 'keydown', onKeyDown),
            on(window, 'pagehide', onPageHide),
            // The views make their layout again for a new window size.
            on(window, 'resize', expectLayout, { passive: true }),
            on(document, 'wheel', onHandMove, { capture: true, passive: true }),
            on(document, 'touchmove', onHandMove, { capture: true, passive: true }),
            // A drag of the scroll bar sends scroll events while the pointer is down. The
            // scroll of the view to the marker comes with no pointer.
            on(document, 'pointerdown', () => void (pointerDown = true), true),
            on(document, 'pointerup', () => void (pointerDown = false), true),
            on(document, 'pointercancel', () => void (pointerDown = false), true),
            on(
                document,
                'scroll',
                (event) => {
                    if (pointerDown) onHandMove(event)
                },
                { capture: true, passive: true },
            ),
        ]

        // The settings can change while the bar is closed.
        const { speech } = settings.get()
        controller.setRate(speech.rate)
        controller.setPitch(speech.pitch)
        applyVoice()
        view.setRate(speech.rate)
        showSleep()

        if (provider.isSupported() && voices().length === 0) {
            noVoicesTimer = setTimeout(onNoVoices, NO_VOICES_MS)
        }
    }

    /** Ends speech and removes the bar. The mode of the session stays as it is. */
    function teardown(): void {
        // The callbacks of the controller do nothing from here.
        active = false
        loadToken += 1
        loading = false
        advancing = false
        playAfterLoad = false
        clearProbe()
        for (const timer of [noVoicesTimer, rateTimer]) {
            if (timer !== null) clearTimeout(timer)
        }
        noVoicesTimer = null
        rateTimer = null
        voicesArrived?.()

        controller.stop()
        session.view.setActiveRange(null)
        wakeLocked = false
        void wakeLock.release()
        sleep.clear()

        for (const remove of cleanups) remove()
        cleanups = []
        sheet?.close()
        view?.unmount()

        // The chapter stays in memory. A start in the same chapter then speaks in the task
        // of the caller, with no load.
        sentence = null
        marker = null
        away = false
        following = false
        lastPosition = null
        layoutUntil = 0
        handMoveAt = Number.NEGATIVE_INFINITY
        pointerDown = false
        unavailable = false
        voiceList = null
    }

    function start(locator?: Locator): Promise<void> {
        const from = locator ?? session.position?.locator ?? { spineIndex: 0, offset: 0 }
        // A locator from the caller is the start of a text selection, which can be inside a
        // word. The position of the session is the first character of the page.
        return startAt(from, locator !== undefined)
    }

    async function startAt(from: Locator, wholeWord = false): Promise<void> {
        if (destroyed) return
        const token = ++loadToken
        advancing = false
        playAfterLoad = true
        comeBack()
        following = false
        lastPosition = session.position
        sleep.clear()

        if (!active) {
            active = true
            session.setMode('listen')
            mount()
            // The bar takes height from the page.
            expectLayout()
        }
        if (!provider.isSupported()) {
            setUnavailable()
            return
        }

        // With the chapter in memory, speech starts in the task of the caller.
        let ready = chapterInMemory(from)
        if (ready) {
            loading = false
        } else {
            loading = true
            clearProbe()
            if (controller.getState().status !== 'idle') controller.stop()
            render()

            // The load that started with the bar can have this chapter.
            await warmUp
            if (token !== loadToken || !active) return
            ready =
                chapterInMemory(from) ??
                (await findSpeechChapter({
                    book: session.book,
                    content: session.content,
                    from,
                    isCurrent: () => token === loadToken && active,
                }))
            if (token !== loadToken || !active) return
            await waitForVoices()
            if (token !== loadToken || !active) return

            loading = false
            if (!ready) {
                finishBook()
                return
            }
        }
        // A chapter after the one of `from` starts at its first sentence.
        loadChapter(ready.spineIndex === from.spineIndex ? { ...ready, wholeWord } : ready)
        if (playAfterLoad && !unavailable) startSpeech()
        render()
    }

    async function stop(): Promise<void> {
        if (!active) return
        teardown()
        session.setMode('read')
        onExit()
    }

    const warmUp = loadAhead()

    return {
        get active() {
            return active
        },
        start,
        stop,
        destroy() {
            if (destroyed) return
            destroyed = true
            if (active) {
                teardown()
                if (session.mode === 'listen') session.setMode('read')
            }
            controller.destroy()
            sheet?.destroy()
            sheet = null
            view = null
            chapter = null
            upcoming = null
        },
    }
}
