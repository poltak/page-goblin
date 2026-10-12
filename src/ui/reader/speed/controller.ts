/**
 * The speed reader mode. This file is the link between the RSVP engine, the overlay and the
 * open book.
 *
 * The engine shows one chapter. This file gives it the chapters of the book in spine order,
 * draws each word, and moves the book below the overlay to the word on screen, so the saved
 * progress is right. That move does a page layout, so it occurs only at a pause, each 10
 * seconds of playback, when the word leaves the page that the book shows, at a chapter change
 * and at the exit.
 */

import type { WordToken } from '$lib/content'
import type { ScreenWakeLock } from '$lib/pwa/wake-lock'
import { createRsvpEngine, sentenceStartIndex, splitAtPivot, wordIndexAtOffset } from '$lib/rsvp'
import type { RelocateInfo } from '$lib/reader/types'
import type { RsvpDirection, RsvpState, RsvpStatus, RsvpTimer } from '$lib/rsvp'
import { RSVP_WPM_MAX, RSVP_WPM_MIN, RSVP_WPM_STEP } from '$lib/settings'
import type { RsvpSettings, Settings, SettingsStore } from '$lib/settings'
import { isLocatorInRange } from '$lib/types'
import type { Locator } from '$lib/types'
import { on } from '../../dom'
import type { ModeController, ModeOptions } from '../parts'
import { findChapter } from './chapters'
import type { FindChapterOptions, LoadedChapter } from './chapters'
import { contextAfter, contextBefore, contextCharBudget } from './context'
import { statusText } from './format'
import { createFullscreen } from './fullscreen'
import type { FullscreenControl } from './fullscreen'
import { holdRepeat } from './hold-repeat'
import type { SettingsSheet } from './settings-sheet'
import { STAGE_GESTURE_IDLE, stageGesture } from './stage-gesture'
import type { StageGestureEvent } from './stage-gesture'
import { createSpeedView } from './view'
import type { SpeedView } from './view'
import { createWordFitter } from './word-fit'
import type { MeasureText } from './word-fit'

/** Time between two updates of the status line during playback. */
export const TICK_MS = 1000
/** The book below the overlay follows after this number of ticks of playback. */
export const SYNC_TICKS = 10
/** Time that the title of a new chapter stays on screen. */
export const NOTICE_MS = 2500
/** The exit does not wait longer than this for the page of the book. */
export const EXIT_WAIT_MS = 3000

/** The value of --speed-max, and the side padding of the stage. For the first word only. */
export const STAGE_MAX_WIDTH = 720
export const STAGE_PADDING = 32

export interface SpeedReaderDeps {
    settings: SettingsStore
    createWakeLock(): ScreenWakeLock
    /** The clock of the engine and of the timers of this part. */
    timer: RsvpTimer
    /** Width of a text in em, at the font of the word line. */
    measure: MeasureText
}

type ChapterSearch = Pick<FindChapterOptions, 'from' | 'step' | 'acceptFirst'>

interface OpenOptions {
    spineIndex: number
    offset: number
    /** Take the spine item also when it is not linear. */
    acceptFirst: boolean
}

function capturePointer(element: Element, event: PointerEvent): void {
    try {
        // The pointer events then come to the element also when the finger moves off it.
        element.setPointerCapture?.(event.pointerId)
    } catch {
        // The pointer is gone already.
    }
}

/**
 * A finger has an implicit capture on the element below it, for example the word in the stage.
 * When a parent takes the capture, that element loses it, and its event bubbles to the parent.
 * So a capture loss ends a press only when the element itself lost the capture.
 */
function ownCaptureLoss(handler: (event: PointerEvent) => void): (event: PointerEvent) => void {
    return (event) => {
        if (event.target === event.currentTarget) handler(event)
    }
}

function isSecondaryButton(event: PointerEvent): boolean {
    return event.pointerType === 'mouse' && event.button !== 0
}

function isActivationKey(event: KeyboardEvent): boolean {
    return event.key === ' ' || event.key === 'Enter'
}

function sameLocator(a: Locator | null, b: Locator): boolean {
    return a !== null && a.spineIndex === b.spineIndex && a.offset === b.offset
}

/**
 * The element that the keyboard gave the focus, or null. A button that a pointer pressed can
 * also have the focus, but it has no focus ring.
 */
function keyboardFocus(): HTMLElement | null {
    const element = document.activeElement
    if (!(element instanceof HTMLElement)) return null
    try {
        return element.matches(':focus-visible') ? element : null
    } catch {
        return element
    }
}

export function createSpeedController(options: ModeOptions, deps: SpeedReaderDeps): ModeController {
    const { session, host } = options
    const { settings, timer } = deps
    const fitter = createWordFitter(deps.measure)

    let rsvp: RsvpSettings = settings.get().rsvp
    let status: RsvpStatus = 'idle'
    let active = false
    let destroyed = false
    let stopping: Promise<void> | null = null

    let chapter: LoadedChapter | null = null
    /** A new number makes the result of an older chapter load do nothing. */
    let loadToken = 0
    let loading = false
    /** The user wants playback. A chapter end and a chapter load do not change this. */
    let wantPlay = false
    let atBookEnd = false
    /** The last position that the book below the overlay got. */
    let lastSynced: Locator | null = null
    /** The position of the book at its last move for a word that left the page. */
    let turnedAt: RelocateInfo | null = null
    /** The word at the last exit. */
    let lastWord: Locator | null = null

    let view: SpeedView | null = null
    let mounted = false
    const viewCleanups: (() => void)[] = []
    const mountCleanups: (() => void)[] = []
    let fullscreen: FullscreenControl | null = null
    let sheet: SettingsSheet | null = null
    /** The control that started the mode with the keyboard. It gets the focus back. */
    let opener: HTMLElement | null = null
    let stageWidth = 0
    let contextChars = 0
    let rewindDisabled: boolean | undefined
    let gesture = STAGE_GESTURE_IDLE
    let stagePointer: number | undefined
    /** The last press of Space was the play key, and not the key of a button. */
    let spaceUsed = false
    /** The user moved the focus with the Tab key after the last press with a pointer. */
    let keyboardNav = false

    let wakeLock: ScreenWakeLock | null = null
    let lockHeld = false
    let ticking = false
    let tickHandle: unknown
    let ticks = 0
    let noticeTimed = false
    let noticeHandle: unknown
    /** Ends the wait of the exit for the page of the book. */
    let endExitWait: (() => void) | null = null

    const engine = createRsvpEngine({
        settings: rsvp,
        timer,
        callbacks: {
            onWord: (event) => renderWord(event.word, event.index),
            onStateChange,
            onChapterEnd: () => void advance(),
        },
    })

    /** False while the mode is off and during the exit. */
    function canAct(): boolean {
        return active && !stopping && !destroyed
    }

    function isRunning(): boolean {
        return status === 'playing' || status === 'rewinding'
    }

    // ---------- Drawing ----------

    function renderWord(word: WordToken, index: number): void {
        if (!view || !chapter) return
        const parts = splitAtPivot(word.text)
        view.setWord(parts)
        view.setScale(
            fitter.scaleFor({
                text: word.text,
                parts,
                width: stageWidth,
                fontSize: rsvp.fontSize,
                pivot: rsvp.showPivot,
            }),
        )
        const count = rsvp.contextWords
        if (count > 0) {
            const range = { words: chapter.words, index, count, maxChars: contextChars }
            view.setContext(contextBefore(range), contextAfter(range))
        }
        keepPage(word)
    }

    function refreshWord(): void {
        const word = engine.getCurrentWord()
        if (word) renderWord(word, engine.getState().index)
        else view?.setWord(null)
    }

    function currentLocator(): Locator | null {
        const word = engine.getCurrentWord()
        return chapter && word ? { spineIndex: chapter.spineIndex, offset: word.start } : null
    }

    /** The progress bar, the status line and the chapter title. Not for each word. */
    function updateStatus(): void {
        if (!view) return
        const locator = currentLocator()
        if (!locator) {
            view.setProgress(0)
            view.setStatusText('')
            view.setTitle(session.record.title)
            return
        }
        const { index, wordCount } = engine.getState()
        view.setProgress(wordCount > 1 ? index / (wordCount - 1) : 1)
        view.setStatusText(
            statusText({
                wordsLeft: wordCount - 1 - index,
                wpm: rsvp.wpm,
                bookFraction: atBookEnd ? 1 : session.fractionOf(locator),
            }),
        )
        view.setTitle(session.chapterTitleAt(locator) || session.record.title)
    }

    function showNotice(text: string, timed = false): void {
        hideNotice()
        if (!text) return
        view?.setNotice(text)
        noticeTimed = timed
        if (timed) noticeHandle = timer.setTimeout(hideNotice, NOTICE_MS)
    }

    function hideNotice(): void {
        if (noticeTimed) timer.clearTimeout(noticeHandle)
        noticeTimed = false
        view?.setNotice(null)
    }

    function applyViewSettings(): void {
        if (!view) return
        view.setWpm({ wpm: rsvp.wpm, min: RSVP_WPM_MIN, max: RSVP_WPM_MAX })
        view.setFontSize(rsvp.fontSize)
        view.setPivotShown(rsvp.showPivot)
        view.setContextShown(rsvp.contextWords > 0)
        refreshWord()
        updateStatus()
    }

    function setStageWidth(width: number): void {
        if (width === stageWidth) return
        stageWidth = width
        contextChars = contextCharBudget(width)
        refreshWord()
    }

    // ---------- Engine events ----------

    function onStateChange(state: RsvpState): void {
        const previous = status
        status = state.status

        if (atBookEnd && state.index < state.wordCount - 1) {
            atBookEnd = false
            hideNotice()
        }

        if (status !== previous) {
            view?.setStatus(status)
            // The engine sends no word for a chapter that has none.
            if (state.wordCount === 0) view?.setWord(null)
            setTicking(isRunning())
            applyWakeLock()
        }

        // The button stays on during a rewind, also at the first word. If it went off there,
        // the release of the hold could get lost and the rewind would never stop.
        const disabled = state.wordCount === 0 || (state.index === 0 && status !== 'rewinding')
        if (disabled !== rewindDisabled) {
            rewindDisabled = disabled
            view?.setRewindDisabled(disabled)
        }

        // During playback the ticker does this one time each second.
        if (!isRunning()) updateStatus()
    }

    function setTicking(run: boolean): void {
        if (run === ticking) return
        ticking = run
        if (run) {
            ticks = 0
            tickHandle = timer.setTimeout(onTick, TICK_MS)
        } else {
            timer.clearTimeout(tickHandle)
        }
    }

    function onTick(): void {
        if (!ticking) return
        tickHandle = timer.setTimeout(onTick, TICK_MS)
        ticks++
        updateStatus()
        if (ticks % SYNC_TICKS === 0) void syncPosition()
    }

    function applyWakeLock(): void {
        const want = isRunning() && settings.get().keepAwake
        if (want === lockHeld) return
        lockHeld = want
        wakeLock ??= deps.createWakeLock()
        void (want ? wakeLock.request() : wakeLock.release())
    }

    function onSettings(next: Settings, previous: Settings): void {
        if (next.rsvp !== previous.rsvp) {
            rsvp = next.rsvp
            engine.setSettings(rsvp)
            applyViewSettings()
        }
        if (next.keepAwake !== previous.keepAwake) applyWakeLock()
    }

    // ---------- The book below the overlay ----------

    function goTo(locator: Locator): Promise<void> {
        lastSynced = locator
        // The view shows its own message for a chapter that does not load.
        return session.goTo(locator).catch(() => {})
    }

    /**
     * Resolves when the book shows the locator. A view that never completes the move must not
     * keep the user in the overlay, so the wait has a time limit.
     */
    function goToWithLimit(locator: Locator): Promise<void> {
        return new Promise((resolve) => {
            const handle = timer.setTimeout(end, EXIT_WAIT_MS)
            function end(): void {
                if (endExitWait !== end) return
                endExitWait = null
                timer.clearTimeout(handle)
                resolve()
            }
            endExitWait = end
            void goTo(locator).then(end)
        })
    }

    /**
     * Turns the book to the page of the word when the word left the page that the book shows.
     * The book saves the page that it shows. The user can leave with the Back action of the
     * browser at each moment, with no call to this part before the page is hidden, and the
     * saved page must then be the page of the word.
     *
     * The test compares numbers and reads no layout. The book moves one time for each of its
     * positions, so a view that cannot show the word gets one call and not one for each word.
     */
    function keepPage(word: WordToken): void {
        const position = session.position
        if (!position || position === turnedAt || !chapter || !canAct()) return
        const { visible } = position
        const onPage =
            visible.spineIndex === chapter.spineIndex &&
            word.start >= visible.start &&
            word.start < visible.end
        if (onPage) return
        turnedAt = position
        void goTo({ spineIndex: chapter.spineIndex, offset: word.start })
    }

    /** Move the book to the word on screen. Does nothing when the book is there already. */
    function syncPosition(): Promise<void> {
        const locator = currentLocator()
        if (!locator || sameLocator(lastSynced, locator)) return Promise.resolve()
        return goTo(locator)
    }

    // ---------- Chapters ----------

    function beginLoad(): number {
        loading = true
        return ++loadToken
    }

    function isCurrent(token: number): boolean {
        return token === loadToken && canAct()
    }

    function showChapter(next: LoadedChapter, index: number): void {
        chapter = next
        atBookEnd = false
        // The engine keeps the array and stops the playback.
        engine.load({ words: next.words, blocks: next.blocks, index })
    }

    function search(target: ChapterSearch): Promise<LoadedChapter | null> {
        return findChapter({ content: session.content, spine: session.book.spine, ...target })
    }

    /** Show the chapter of a position, paused. A chapter with no words gives the next one. */
    async function open({ spineIndex, offset, acceptFirst }: OpenOptions): Promise<void> {
        const token = beginLoad()
        wantPlay = false
        let found: LoadedChapter | null
        try {
            found = await search({ from: spineIndex, step: 1, acceptFirst })
        } catch {
            if (isCurrent(token)) {
                loading = false
                wantPlay = false
                showNotice('The chapter did not load.')
            }
            return
        }
        if (!isCurrent(token)) return
        loading = false
        // A push on play during the load does not count. The overlay always opens paused.
        wantPlay = false
        if (!found) {
            showNotice('No text from here to the end of the book.')
            return
        }
        hideNotice()
        const sameChapter = found.spineIndex === spineIndex
        showChapter(found, sameChapter ? wordIndexAtOffset(found.words, offset) : 0)
    }

    /** Go to the first word of the next chapter that has words. */
    async function advance(): Promise<void> {
        const from = chapter
        // The engine reports the chapter end again when the user pushes play during the load.
        if (!from || loading || !canAct()) return
        const token = beginLoad()
        let next: LoadedChapter | null
        try {
            next = await search({ from: from.spineIndex + 1, step: 1 })
        } catch {
            if (!isCurrent(token)) return
            loading = false
            showNotice('The next chapter did not load.')
            if (engine.getState().status !== 'playing') {
                wantPlay = false
                void syncPosition()
            }
            return
        }
        if (!isCurrent(token)) return
        loading = false

        if (!next) {
            // After a sentence step the last sentence can still play. Its end comes here again.
            if (engine.getState().status !== 'playing') reachBookEnd()
            return
        }

        showChapter(next, 0)
        void syncPosition()
        if (wantPlay && !rsvp.pauseAtChapterStart) {
            hideNotice()
            engine.play()
        } else {
            wantPlay = false
            showNotice(session.chapterTitleAt({ spineIndex: next.spineIndex, offset: 0 }), true)
        }
    }

    /** Go to the last sentence of the chapter before this one. */
    async function retreat(): Promise<void> {
        const from = chapter
        if (!from || loading || !canAct()) return
        const token = beginLoad()
        let previous: LoadedChapter | null
        try {
            previous = await search({ from: from.spineIndex - 1, step: -1 })
        } catch {
            if (isCurrent(token)) {
                loading = false
                showNotice('The chapter before this one did not load.')
            }
            return
        }
        if (!isCurrent(token)) return
        loading = false
        if (!previous) return

        const resume = engine.getState().status === 'playing'
        hideNotice()
        showChapter(previous, sentenceStartIndex(previous.words, previous.words.length - 1))
        void syncPosition()
        if (resume) engine.play()
    }

    function reachBookEnd(): void {
        wantPlay = false
        const { index, wordCount } = engine.getState()
        atBookEnd = wordCount > 0 && index >= wordCount - 1
        // After a sentence step in the last sentence, a different word is on screen. The
        // message is then only a short hint.
        showNotice('End of the book', !atBookEnd)
        updateStatus()
        void syncPosition()
    }

    async function restart(): Promise<void> {
        if (!canAct()) return
        pause()
        await open({ spineIndex: 0, offset: 0, acceptFirst: false })
        if (canAct()) void syncPosition()
    }

    // ---------- Actions of the user ----------

    function play(): void {
        if (!canAct()) return
        wantPlay = true
        if (loading || !chapter) return
        hideNotice()
        engine.play()
    }

    function pause(): void {
        wantPlay = false
        const wasRunning = isRunning()
        engine.pause()
        if (wasRunning) void syncPosition()
    }

    function toggle(): void {
        if (status === 'rewinding') return
        if (status === 'playing' || (loading && wantPlay)) pause()
        else play()
    }

    function stepSentence(direction: RsvpDirection): void {
        if (!canAct() || !chapter || loading) return
        if (engine.stepSentence(direction)) return
        // The target is in a different chapter.
        if (direction === 'next') void advance()
        else void retreat()
    }

    function startRewind(): void {
        if (!canAct() || !chapter || loading) return
        engine.startRewind()
    }

    function stopRewind(): void {
        if (engine.getState().status !== 'rewinding') return
        engine.stopRewind()
        if (engine.getState().status === 'paused') void syncPosition()
    }

    /** Returns false when the speed is at a limit. */
    function changeWpm(delta: number): boolean {
        // A hold on the speed control that is still on at the exit stops here.
        if (!canAct()) return false
        const next = Math.min(RSVP_WPM_MAX, Math.max(RSVP_WPM_MIN, rsvp.wpm + delta))
        if (next === rsvp.wpm) return false
        settings.update({ rsvp: { wpm: next } })
        return true
    }

    async function openSettings(): Promise<void> {
        if (!canAct() || !view) return
        // The words do not move behind the sheet.
        pause()
        if (!sheet) {
            try {
                const { createSettingsSheet } = await import('./settings-sheet')
                if (!canAct() || !view) return
                sheet ??= createSettingsSheet({
                    parent: view.root,
                    settings,
                    timer,
                    onRestart: () => void restart(),
                })
            } catch {
                if (canAct()) showNotice('The settings did not load.', true)
                return
            }
            // The user can start the playback again while the sheet loads.
            pause()
        }
        // The release of a hold on the stage must not start the playback behind the sheet.
        gesture = STAGE_GESTURE_IDLE
        sheet.open(view.settingsButton)
    }

    // ---------- Pointer and keyboard ----------

    function runGesture(event: StageGestureEvent): void {
        const step = stageGesture(gesture, event)
        gesture = step.state
        if (step.action === 'pause') pause()
        else if (step.action === 'play') play()
    }

    function onStagePress(event: PointerEvent): void {
        if (isSecondaryButton(event) || gesture.pressed || !canAct() || !view) return
        stagePointer = event.pointerId
        capturePointer(view.stage, event)
        runGesture({ type: 'press', time: timer.now(), playing: status === 'playing' })
    }

    function onStageRelease(event: PointerEvent): void {
        if (!gesture.pressed || event.pointerId !== stagePointer) return
        runGesture({ type: 'release', time: timer.now() })
    }

    function onStageCancel(event: PointerEvent): void {
        if (!gesture.pressed || event.pointerId !== stagePointer) return
        runGesture({ type: 'cancel' })
    }

    function onRewindKeyDown(event: KeyboardEvent): void {
        if (!isActivationKey(event)) return
        // Without this the key also sends a click, and Space scrolls.
        event.preventDefault()
        if (!event.repeat) startRewind()
    }

    function onRewindKeyUp(event: KeyboardEvent): void {
        if (!isActivationKey(event)) return
        event.preventDefault()
        stopRewind()
    }

    function onKeyDown(event: KeyboardEvent): void {
        // Each press of Space decides this again.
        if (event.key === ' ') spaceUsed = false
        if (event.key === 'Tab') keyboardNav = true
        if (event.ctrlKey || event.metaKey || event.altKey || !canAct() || !view) return
        // An open dialog has its own keys.
        if (sheet?.isOpen) return
        const target = event.target instanceof Element ? event.target : null
        if (target?.closest('input, textarea, select, [contenteditable]')) return

        switch (event.key) {
            case ' ':
                // A button that the Tab key gave the focus does its own action for this key.
                // A button that a pointer pressed can also keep the focus. Space is then
                // still the play key. :focus-visible cannot tell the two cases here, because
                // Chrome sets it for each key press.
                if (keyboardNav && target?.closest('button, a[href]')) return
                spaceUsed = true
                if (!event.repeat) toggle()
                break
            case 'Enter':
                if (target !== view.stage) return
                if (!event.repeat) toggle()
                break
            case 'k':
            case 'K':
                if (!event.repeat) toggle()
                break
            case 'ArrowLeft':
                stepSentence('previous')
                break
            case 'ArrowRight':
                stepSentence('next')
                break
            case 'ArrowUp':
                changeWpm(RSVP_WPM_STEP)
                break
            case 'ArrowDown':
                changeWpm(-RSVP_WPM_STEP)
                break
            case 'r':
            case 'R':
                if (!event.repeat) startRewind()
                break
            case 'f':
            case 'F':
                if (!event.repeat) fullscreen?.toggle()
                break
            case 'Escape':
                void stop()
                break
            default:
                return
        }
        event.preventDefault()
        // The reader screen below must not also turn a page or close the book for this key.
        event.stopPropagation()
    }

    function onKeyUp(event: KeyboardEvent): void {
        if (event.key === 'r' || event.key === 'R') stopRewind()
        if (event.key === ' ' && spaceUsed) {
            spaceUsed = false
            // Firefox sends the click of a button at the release of Space, also when the
            // press had no default action.
            event.preventDefault()
        }
    }

    function onVisibilityChange(): void {
        if (document.visibilityState !== 'hidden') return
        // The release of a hold on the stage can come late, or as a cancel. It must not start
        // the playback again.
        gesture = STAGE_GESTURE_IDLE
        // A hidden tab slows its timers, so the words would move on with no reader.
        pause()
        // A sentence step during a pause moved the word but not the book.
        void syncPosition()
    }

    // ---------- Overlay ----------

    function buildView(): SpeedView {
        const created = createSpeedView()
        const { stage, rewindButton } = created
        viewCleanups.push(
            // The dialogs of the overlay are in its root, so this also gets their presses.
            on(
                created.root,
                'pointerdown',
                () => {
                    keyboardNav = false
                },
                true,
            ),
            on(created.doneButton, 'click', () => void stop()),
            on(created.settingsButton, 'click', () => void openSettings()),
            on(created.fullscreenButton, 'click', () => fullscreen?.toggle()),
            on(created.playButton, 'click', toggle),
            on(created.previousButton, 'click', () => stepSentence('previous')),
            on(created.nextButton, 'click', () => stepSentence('next')),
            holdRepeat({
                button: created.slowerButton,
                timer,
                onStep: () => changeWpm(-RSVP_WPM_STEP),
            }),
            holdRepeat({
                button: created.fasterButton,
                timer,
                onStep: () => changeWpm(RSVP_WPM_STEP),
            }),

            on(stage, 'pointerdown', onStagePress),
            on(stage, 'pointerup', onStageRelease),
            on(stage, 'pointercancel', onStageCancel),
            on(stage, 'lostpointercapture', ownCaptureLoss(onStageCancel)),
            // A captured pointer does not leave. Without the capture, the release can come to
            // a different element, and the stage would then ignore each later press.
            on(stage, 'pointerleave', onStageCancel),
            // A screen reader sends a click with no pointer events. The click that follows a
            // tap has a detail of 1 or more, and the tap did the toggle already.
            on(stage, 'click', (event) => {
                if (event.detail === 0) toggle()
            }),
            // A long press on a touch screen can open a menu, which cancels the hold. A click
            // with the secondary mouse button is not a hold, so it keeps its menu.
            on(stage, 'contextmenu', (event) => {
                if (gesture.pressed) event.preventDefault()
            }),

            on(rewindButton, 'pointerdown', (event) => {
                if (isSecondaryButton(event)) return
                capturePointer(rewindButton, event)
                startRewind()
            }),
            // Each way in which a hold can end. One that is missed would leave the rewind on.
            ...(['pointerup', 'pointercancel', 'pointerleave', 'blur'] as const).map((type) =>
                on(rewindButton, type, stopRewind),
            ),
            on(rewindButton, 'lostpointercapture', ownCaptureLoss(stopRewind)),
            on(rewindButton, 'keydown', onRewindKeyDown),
            on(rewindButton, 'keyup', onRewindKeyUp),
            // A long press on a touch screen can open a menu, which cancels the hold.
            on(rewindButton, 'contextmenu', (event) => event.preventDefault()),
        )
        return created
    }

    function mount(): void {
        const current = (view ??= buildView())
        mounted = true
        rsvp = settings.get().rsvp
        engine.setSettings(rsvp)
        // The real width comes from the observer after the first layout.
        setStageWidth(Math.max(0, Math.min(window.innerWidth, STAGE_MAX_WIDTH) - STAGE_PADDING))
        current.setStatus(status)
        applyViewSettings()
        host.append(current.root)

        if (typeof ResizeObserver === 'function') {
            // The observer gives the width with no layout read from this code.
            const observer = new ResizeObserver((entries) => {
                const width = entries[entries.length - 1]?.contentRect.width
                if (width) setStageWidth(width)
            })
            observer.observe(current.stage)
            mountCleanups.push(() => observer.disconnect())
        }

        fullscreen = createFullscreen({
            onChange: (isOn) => current.setFullscreen({ supported: true, active: isOn }),
        })
        current.setFullscreen({ supported: fullscreen.supported, active: fullscreen.active })

        mountCleanups.push(
            on(document, 'keydown', onKeyDown, true),
            on(document, 'keyup', onKeyUp, true),
            on(document, 'visibilitychange', onVisibilityChange),
            // A window that loses the focus does not get the key release of a rewind.
            on(window, 'blur', stopRewind),
            settings.subscribe(onSettings),
        )
        current.playButton.focus({ preventScroll: true })
    }

    function unmount(): void {
        if (!mounted) return
        mounted = false
        for (const cleanup of mountCleanups.splice(0)) cleanup()
        sheet?.close()
        fullscreen?.leave()
        fullscreen?.destroy()
        fullscreen = null
        hideNotice()
        view?.root.remove()
        gesture = STAGE_GESTURE_IDLE
        keyboardNav = false
        chapter = null
        // The next start must not show a word of this run.
        engine.load({ words: [], blocks: [] })
    }

    // ---------- The mode ----------

    /** The word at the last exit, when the page that is open now still has it. */
    function resumeLocator(): Locator | null {
        const visible = session.position?.visible
        return lastWord && visible && isLocatorInRange(lastWord, visible) ? lastWord : null
    }

    async function start(locator?: Locator): Promise<void> {
        if (destroyed) return
        if (stopping) await stopping
        if (destroyed) return

        const target = locator ??
            resumeLocator() ??
            session.position?.locator ?? { spineIndex: 0, offset: 0 }
        if (active) {
            pause()
        } else {
            active = true
            lastSynced = null
            turnedAt = null
            // The reader screen hides its bars for the mode. A control in a bar then loses
            // the focus, so this comes first.
            opener = keyboardFocus()
            session.setMode('speed')
            mount()
        }
        await open({ spineIndex: target.spineIndex, offset: target.offset, acceptFirst: true })
    }

    async function leave(): Promise<void> {
        loadToken++
        loading = false
        wantPlay = false
        // This also releases the wake lock and stops the ticker.
        engine.pause()
        const locator = currentLocator()
        if (locator) {
            lastWord = locator
            // The page with the word must be ready before the overlay goes away.
            await goToWithLimit(locator)
        }
        if (destroyed) return
        unmount()
        session.setMode('read')
        active = false
        options.onExit()
        // The bars of the reader screen are back now, so a control in a bar can take the focus.
        if (opener?.isConnected) opener.focus({ preventScroll: true })
        opener = null
    }

    function stop(): Promise<void> {
        if (!active || destroyed) return Promise.resolve()
        stopping ??= leave().finally(() => {
            stopping = null
        })
        return stopping
    }

    function destroy(): void {
        if (destroyed) return
        destroyed = true
        loadToken++
        loading = false
        engine.destroy()
        // The engine sends no more events, so the timers and the lock stop here.
        setTicking(false)
        endExitWait?.()
        if (lockHeld) {
            lockHeld = false
            void wakeLock?.release()
        }
        unmount()
        sheet?.destroy()
        sheet = null
        for (const cleanup of viewCleanups.splice(0)) cleanup()
        view = null
        active = false
    }

    return {
        get active() {
            return active
        },
        start,
        stop,
        destroy,
    }
}
