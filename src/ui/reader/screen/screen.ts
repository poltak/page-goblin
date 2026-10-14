/**
 * The reader screen for an open book: the running head and foot, the two bars, the progress
 * slider, the keyboard, full screen, and the load of each other part at its first use.
 *
 * Text of the book (titles, author) goes into the page through textContent only.
 */

import type { RelocateInfo } from '$lib/reader/types'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SIZE_STEP } from '$lib/settings/schema'
import type { SettingsStore } from '$lib/settings/store'
import type { Locator } from '$lib/types'
import { createMenu } from '../../app/menu'
import { showToast } from '../../app/toast'
import { on, qs, setIcon, setRangeValue } from '../../dom'
import type {
    AppearancePanel,
    ContentsPanel,
    ContentsTab,
    ModeController,
    ModeOptions,
    Part,
    PartOptions,
    SearchPanel,
    SelectionToolsOptions,
} from '../parts'
import type { ReaderSession } from '../types'
import { BARS_HIDDEN, BARS_PEEK_MS, BARS_POINTER_ZONE_PX, isPageTurn, reduceBars } from './bars'
import type { BarsEvent, BarsState } from './bars'
import {
    errorMessage,
    locatorAtFraction,
    pageText,
    percentText,
    progressText,
    sliderFraction,
    sliderLabel,
    sliderValue,
    UNKNOWN_ERROR_MESSAGE,
} from './format'
import type { ScreenFrame } from './frame'
import { createFullscreen } from './fullscreen'
import { keyCommand, repeats, targetContext } from './keyboard'
import type { KeyCommand } from './keyboard'
import { lazyPart } from './lazy-part'
import type { LazyPart } from './lazy-part'
import type { ShortcutsDialog, ShortcutsOptions } from './shortcuts'

/** Each function loads the module of a part and makes the part. */
export interface PartFactories {
    contents(options: PartOptions): Promise<ContentsPanel>
    appearance(options: PartOptions): Promise<AppearancePanel>
    search(options: PartOptions): Promise<SearchPanel>
    selection(options: SelectionToolsOptions): Promise<Part>
    notePopover(options: PartOptions): Promise<Part>
    imageViewer(options: PartOptions): Promise<Part>
    speed(options: ModeOptions): Promise<ModeController>
    listen(options: ModeOptions): Promise<ModeController>
    shortcuts(options: ShortcutsOptions): Promise<ShortcutsDialog>
}

export interface ReaderScreenOptions {
    /** The elements of the screen. The reader view of the session is in `frame.stage`. */
    frame: ScreenFrame
    session: ReaderSession
    settings: SettingsStore
    parts: PartFactories
    /** The user chose "Back to the library". */
    onExit(): void
}

export interface ReaderScreen {
    /** Removes the listeners and the parts, leaves full screen, then closes the session. */
    destroy(): Promise<void>
}

type ModeName = 'speed' | 'listen'

/** The wait for idle time in a browser that has no requestIdleCallback (Safari). */
const IDLE_FALLBACK_MS = 300

/** The step of an up or down arrow key in the scroll view. Browsers use the same distance. */
export const LINE_SCROLL_PX = 40

/**
 * The page takes no press for this time after a panel closed. A closed panel stays on screen
 * for its close transition and takes no press in that time, so a press there goes to the page
 * below. The second tap of a double tap on a contents entry would turn the page.
 */
export const PANEL_CLOSE_GUARD_MS = 350

function noop(): void {}

function logError(error: unknown): void {
    console.error(error)
}

/** Runs the work when the browser has time. Returns the function that cancels it. */
function whenIdle(work: () => void): () => void {
    if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(work, { timeout: 2000 })
        return () => window.cancelIdleCallback(id)
    }
    const id = setTimeout(work, IDLE_FALLBACK_MS)
    return () => clearTimeout(id)
}

function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text
}

export function createReaderScreen(options: ReaderScreenOptions): ReaderScreen {
    const { frame, session, settings, parts } = options
    const { topBar, bottomBar, slider, stage } = frame
    /** Each function removes one listener or stops one timer. */
    const stops: Array<() => void> = []
    let destroyed = false
    let closing: Promise<void> | null = null

    // ---------- Parts ----------

    const partOptions: PartOptions = { session, host: frame.overlay }
    const modeOptions: ModeOptions = {
        ...partOptions,
        dock: frame.dock,
        onExit: () => showBarsAfterMode(),
    }

    const contents = lazyPart(() => parts.contents(partOptions))
    const appearance = lazyPart(() => parts.appearance(partOptions))
    const search = lazyPart(() => parts.search(partOptions))
    const shortcuts = lazyPart(() => parts.shortcuts({ host: frame.overlay }))
    const modes: Record<ModeName, LazyPart<ModeController>> = {
        speed: lazyPart(() => parts.speed(modeOptions)),
        listen: lazyPart(() => parts.listen(modeOptions)),
    }
    const selection = lazyPart(() =>
        parts.selection({
            ...partOptions,
            onSpeedRead: (locator) => startMode('speed', locator),
            onListen: (locator) => startMode('listen', locator),
            onSearch: (query) => openSearch(query),
        }),
    )
    const notePopover = lazyPart(() => parts.notePopover(partOptions))
    const imageViewer = lazyPart(() => parts.imageViewer(partOptions))
    const allParts: LazyPart<Part>[] = [
        contents,
        appearance,
        search,
        shortcuts,
        modes.speed,
        modes.listen,
        selection,
        notePopover,
        imageViewer,
    ]

    const openContents = (tab?: ContentsTab): void => contents.use((panel) => panel.open(tab))
    const openAppearance = (): void => appearance.use((panel) => panel.open())
    const openSearch = (query?: string): void => search.use((panel) => panel.open(query))
    const openShortcuts = (): void => shortcuts.use((dialog) => dialog.open())

    // These three parts wait for events of the session, so they load before their first use.
    stops.push(
        whenIdle(() => {
            selection.warm()
            notePopover.warm()
            imageViewer.warm()
        }),
    )

    // A part that did not load in idle time loads when the user does something that needs it.
    stops.push(
        session.on('selection', (selected) => {
            if (selected && !selection.current) selection.use(noop)
        }),
        session.on('highlight-tap', () => {
            if (!selection.current) selection.use(noop)
        }),
        session.on('image-tap', () => {
            if (!imageViewer.current) imageViewer.use(noop)
        }),
        session.on('note-tap', ({ target }) => {
            if (notePopover.current) return
            notePopover.use(noop)
            // No popover can show this note, so the link goes to the note in the book.
            session.followLink(target).catch(logError)
        }),
    )

    // ---------- Modes ----------

    /** More than 0 while one mode stops for the start of a mode. The bars then stay hidden. */
    let switching = 0
    /** Goes up with each request for a mode. An older request that still loads does nothing. */
    let modeRequest = 0

    async function stopMode(controller: ModeController): Promise<void> {
        switching++
        try {
            await controller.stop()
        } catch (error) {
            logError(error)
        } finally {
            switching--
            // The mode is 'read' until the next mode starts. This call changes no state of
            // the bars. It puts the button that shows them back for the keyboard.
            dispatchBars('mode')
        }
    }

    function runMode(controller: ModeController, locator?: Locator): void {
        if (destroyed) return
        // start() sets the mode of the session, and the 'mode' event hides the bars.
        controller.start(locator).catch((error: unknown) => {
            logError(error)
            if (!destroyed) showToast({ message: UNKNOWN_ERROR_MESSAGE, tone: 'error' })
        })
    }

    function startMode(name: ModeName, locator?: Locator): void {
        const request = ++modeRequest
        const begin = (): void =>
            modes[name].use((controller) => {
                // The user asked for the other mode while the module of this one loaded.
                if (request !== modeRequest) return
                // A mode that runs already starts again only for a new place in the book.
                if (!controller.active || locator) runMode(controller, locator)
            })

        // With no mode to stop, start() runs in the click handler. Speech needs that.
        const other = modes[name === 'speed' ? 'listen' : 'speed'].current
        if (other?.active) void stopMode(other).then(begin)
        else begin()
    }

    function showBarsAfterMode(): void {
        if (switching === 0) dispatchBars('mode-exit')
    }

    // ---------- Bars ----------

    let bars: BarsState = BARS_HIDDEN
    let peekTimer: ReturnType<typeof setTimeout> | undefined
    let menuOpen = false
    let pointerOnBar = false
    let dragging = false

    function focusedInBar(): HTMLElement | null {
        const focused = document.activeElement
        if (!(focused instanceof HTMLElement)) return null
        return topBar.contains(focused) || bottomBar.contains(focused) ? focused : null
    }

    function dispatchBars(event: BarsEvent): void {
        if (destroyed) return
        const held = menuOpen || pointerOnBar || dragging || focusedInBar() !== null
        const next = reduceBars(bars, event, { mode: session.mode, held })
        const wasVisible = bars.visible
        bars = next

        if (!next.timed) {
            clearTimeout(peekTimer)
            peekTimer = undefined
        } else if (peekTimer === undefined) {
            peekTimer = setTimeout(() => {
                peekTimer = undefined
                dispatchBars('timeout')
            }, BARS_PEEK_MS)
        }
        if (next.visible !== wasVisible) renderBars()
        // The button that shows the bars has no use while the bars show, or below the
        // speed reader.
        const noWayToBars = next.visible || session.mode === 'speed'
        if (frame.showBars.hidden !== noWayToBars) frame.showBars.hidden = noWayToBars
    }

    function renderBars(): void {
        const { visible } = bars
        if (!visible) {
            // The menu gives the focus back to its button, so it must close first.
            moreMenu.close()
            endDrag()
            // An element that becomes inert must not keep the focus.
            focusedInBar()?.blur()
            // A bar that leaves below a pointer at rest sends no pointerleave event.
            pointerOnBar = false
        } else {
            // The session has no event for a change of its back stack.
            renderPosition()
        }
        topBar.toggleAttribute('inert', !visible)
        // The listen bar is in the place of the bottom bar, and it has the controls of its
        // mode. A jump with the slider would also not stay, because the page follows the voice.
        bottomBar.toggleAttribute('inert', !visible || session.mode === 'listen')
    }

    stops.push(
        on(topBar, 'focusin', () => dispatchBars('focus')),
        on(bottomBar, 'focusin', () => dispatchBars('focus')),
        // A hidden bar is outside the screen. A browser without `overflow: clip` can scroll the
        // screen to it, and the page then moves up. Undo that.
        on(frame.root, 'scroll', () => {
            if (frame.root.scrollTop) frame.root.scrollTop = 0
            if (frame.root.scrollLeft) frame.root.scrollLeft = 0
        }),
    )

    // The bars must not leave below a mouse pointer that rests on them.
    for (const bar of [topBar, bottomBar]) {
        stops.push(
            on(bar, 'pointerenter', (event) => {
                if (event.pointerType === 'mouse') pointerOnBar = true
            }),
            on(bar, 'pointerleave', () => {
                pointerOnBar = false
            }),
        )
    }

    // A phone has no mouse pointer, so it gets no listener for pointer moves.
    const hasFinePointer = window.matchMedia?.('(any-pointer: fine)').matches ?? true
    if (hasFinePointer) {
        let pointerInZone = false
        stops.push(
            on(
                frame.root,
                'pointermove',
                (event) => {
                    // A move with a button down is a drag, for example a text selection.
                    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
                    const inZone = event.clientY <= BARS_POINTER_ZONE_PX
                    if (inZone === pointerInZone) return
                    pointerInZone = inZone
                    // A panel covers the bars, so a pointer in a panel does not ask for them.
                    const inDialog = (event.target as Element).closest?.('dialog') != null
                    if (inZone && !inDialog) dispatchBars('pointer-top')
                },
                { passive: true },
            ),
            // No move event comes when the pointer goes from the top zone to the tabs of
            // the browser. The next move at the top is then a new visit.
            on(frame.root, 'pointerleave', () => {
                pointerInZone = false
            }),
        )
    }

    // A tap in the page hides the bars. A tap in the centre of the page also sends
    // 'center-tap', which toggles them. Together the two must not hide the bars and then show
    // them again, so each press keeps the state of the bars at its start.
    let press: { barsVisible: boolean; menuOpen: boolean } | null = null
    let panelClosedAt = Number.NEGATIVE_INFINITY
    const panelJustClosed = (): boolean => Date.now() - panelClosedAt < PANEL_CLOSE_GUARD_MS
    stops.push(
        // The close event of a dialog does not bubble, so the listener is in the capture phase.
        on(
            frame.overlay,
            'close',
            (event) => {
                if (event.target instanceof HTMLDialogElement) panelClosedAt = Date.now()
            },
            true,
        ),
        // On the window, because a part can stop the event on its way down to the stage.
        on(
            window,
            'pointerdown',
            (event) => {
                const inPage = event.target instanceof Node && stage.contains(event.target)
                press =
                    inPage && !panelJustClosed() ? { barsVisible: bars.visible, menuOpen } : null
            },
            { capture: true, passive: true },
        ),
        // A press outside the open menu only closes the menu. The reader view acts on the
        // release of a press, so it must not get this one. The menu script stops the click.
        // A press on a panel that closes is also not for the page.
        on(
            stage,
            'pointerdown',
            (event) => {
                if (menuOpen || panelJustClosed()) event.stopPropagation()
            },
            true,
        ),
        on(stage, 'click', () => {
            if (press?.barsVisible && bars.visible) dispatchBars('page-tap')
        }),
        session.on('center-tap', () => {
            const pressed = press
            press = null
            // A press outside the open menu only closes the menu.
            if (pressed?.menuOpen) return
            // The click of this tap hid the bars already.
            if (pressed?.barsVisible && !bars.visible) return
            dispatchBars('center-tap')
        }),
        session.on('mode', (mode) => {
            // The speed reader covers the page. The Tab key must not get to a link below it.
            stage.toggleAttribute('inert', mode === 'speed')
            renderPageButtons()
            if (mode === 'read') showBarsAfterMode()
            else dispatchBars('mode')
            // The bottom bar shows only outside the listen mode.
            renderBars()
        }),
    )

    // ---------- Position: running head, running foot, slider ----------

    let lastPosition: RelocateInfo | null = session.position
    /** More than 0 while a control of the bars moves the book. Such a move keeps the bars. */
    let barMoves = 0
    let bookmarked: boolean | null = null
    const bookmarkIcon = qs<SVGElement>('svg', frame.bookmarkButton)

    /** The count must be up before the call, because the view can send 'relocate' at once. */
    function moveFromBars(move: () => Promise<unknown>): void {
        barMoves++
        void new Promise((resolve) => resolve(move())).catch(logError).finally(() => {
            barMoves--
        })
    }

    function renderBookmark(): void {
        const next = session.isBookmarked
        if (next === bookmarked) return
        bookmarked = next
        frame.bookmarkButton.setAttribute('aria-pressed', String(next))
        setIcon(bookmarkIcon, next ? 'bookmark-filled' : 'bookmark')
    }

    function renderPosition(): void {
        const entry = session.currentTocEntry
        const fraction = session.fraction
        setText(frame.headText, entry?.title.trim() || session.record.title)
        setText(frame.footPage, pageText(session.position))
        setText(
            frame.footProgress,
            progressText({
                fraction,
                chapterWords: session.wordsRemaining?.chapter ?? null,
                wpm: settings.get().readingWpm,
            }),
        )
        setText(frame.percent, percentText(fraction))
        const noWayBack = !session.canGoBack
        if (frame.backButton.hidden !== noWayBack) {
            // The focus must not stay on a button that goes away.
            if (noWayBack && document.activeElement === frame.backButton) {
                slider.focus({ preventScroll: true })
            }
            frame.backButton.hidden = noWayBack
        }
        // The book does not move during a drag, and the thumb stays below the finger.
        if (!dragging) {
            const value = String(sliderValue(fraction))
            if (slider.value !== value) {
                slider.value = value
                setRangeValue(slider)
            }
            setValueText(sliderLabel({ title: entry?.title ?? '', fraction }))
        }
        renderBookmark()
    }

    /**
     * The running head and foot keep their height when their text is hidden, so the page text
     * does not move.
     */
    function renderRunningLines(): void {
        const { runningHead, runningFoot } = settings.get()
        frame.headText.hidden = !runningHead
        frame.footPage.hidden = !runningFoot
        frame.footProgress.hidden = !runningFoot
        frame.footToggle.setAttribute('aria-pressed', String(runningFoot))
    }

    /** What a screen reader says for the slider position. */
    function setValueText(text: string): void {
        if (slider.getAttribute('aria-valuetext') !== text) {
            slider.setAttribute('aria-valuetext', text)
        }
    }

    function endDrag(): void {
        dragging = false
        frame.sliderLabel.hidden = true
    }

    function endDragOfPointer(): void {
        if (dragging) endDrag()
    }

    stops.push(
        session.on('relocate', (info) => {
            // The event comes again with the same position when the contents entry of the
            // position changes, and with the same text on the page after a layout change.
            const turned = isPageTurn(lastPosition, info)
            lastPosition = info
            renderPosition()
            if (turned && barMoves === 0) dispatchBars('page-turn')
        }),
        session.on('bookmarks', renderBookmark),
        session.on('view', () => {
            press = null
        }),
        session.on('error', (error) => {
            logError(error)
            showToast({ message: errorMessage(error), tone: 'error' })
        }),
        // The session measures the reading speed, and the time that is left depends on it.
        settings.subscribe((next, previous) => {
            if (next.readingWpm !== previous.readingWpm) renderPosition()
            if (
                next.runningHead !== previous.runningHead ||
                next.runningFoot !== previous.runningFoot
            ) {
                renderRunningLines()
            }
        }),
        on(slider, 'input', () => {
            // A touch gives the slider no focus in some browsers, so its use keeps the bars.
            if (!dragging) dispatchBars('focus')
            dragging = true
            setRangeValue(slider)
            const fraction = sliderFraction(slider.value)
            const title = session
                .chapterTitleAt(locatorAtFraction(session.record.spineStats, fraction))
                .trim()
            setText(frame.sliderLabelTitle, title)
            frame.sliderLabelTitle.hidden = title === ''
            setText(frame.sliderLabelPercent, percentText(fraction))
            frame.sliderLabel.style.setProperty('--value', String(fraction))
            frame.sliderLabel.hidden = false
            setValueText(sliderLabel({ title, fraction }))
        }),
        on(slider, 'change', () => {
            endDrag()
            moveFromBars(() => session.goToFraction(sliderFraction(slider.value)))
        }),
        // A drag that ends at its start value sends no change event. The pointer can be
        // off the slider at that time, so the listeners are on the window.
        on(window, 'pointerup', endDragOfPointer, true),
        on(window, 'pointercancel', endDragOfPointer, true),
        on(slider, 'blur', endDrag),
    )

    // ---------- Actions ----------

    function toggleBookmark(): void {
        const before = session.isBookmarked
        session.toggleBookmark().then(
            () => {
                const after = session.isBookmarked
                if (destroyed || after === before) return
                showToast({ message: after ? 'Bookmark added' : 'Bookmark removed' })
            },
            (error: unknown) => {
                logError(error)
                if (!destroyed) showToast({ message: 'The bookmark was not saved.', tone: 'error' })
            },
        )
    }

    function changeFontSize(delta: number): void {
        const { fontSize } = settings.get()
        const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, fontSize + delta))
        if (next !== fontSize) settings.update({ fontSize: next })
    }

    const fullscreen = createFullscreen({ onChange: renderFullscreen })
    const fullscreenLabel = qs('span', frame.fullscreenItem)
    const fullscreenIcon = qs<SVGElement>('svg', frame.fullscreenItem)

    function renderFullscreen(): void {
        const { active } = fullscreen
        setText(fullscreenLabel, active ? 'Exit full screen' : 'Full screen')
        setIcon(fullscreenIcon, active ? 'minimize' : 'maximize')
    }

    function toggleFullscreen(): void {
        fullscreen.toggle().catch((error: unknown) => {
            logError(error)
            if (!destroyed) showToast({ message: 'Full screen is not available.', tone: 'error' })
        })
    }

    function showBarsFromKeyboard(): void {
        dispatchBars('focus')
        if (bars.visible) qs('[data-screen-action="exit"]', topBar).focus({ preventScroll: true })
    }

    function runAction(action: string | undefined): void {
        switch (action) {
            case 'exit':
                options.onExit()
                break
            case 'search':
                openSearch()
                break
            case 'bookmark':
                toggleBookmark()
                break
            case 'contents':
                openContents()
                break
            case 'appearance':
                openAppearance()
                break
            case 'back':
                moveFromBars(() => session.back())
                break
            case 'speed':
            case 'listen':
                startMode(action)
                break
            case 'fullscreen':
                toggleFullscreen()
                break
            case 'shortcuts':
                openShortcuts()
                break
            case 'export':
                openContents('highlights')
                break
        }
    }

    const moreMenu = createMenu({
        menu: frame.moreMenu,
        onOpen: renderFullscreen,
        onSelect: (item) => runAction(item.dataset.screenAction),
    })
    frame.fullscreenItem.hidden = !fullscreen.supported

    function onBarClick(event: MouseEvent): void {
        const button = (event.target as Element).closest<HTMLElement>('[data-screen-action]')
        if (!button) return
        // Safari gives a button no focus for a click, so the click itself keeps the bars.
        dispatchBars('focus')
        if (button === frame.moreButton) {
            // The menu script opens the menu and sets its position.
            event.preventDefault()
            moreMenu.toggle(button)
            return
        }
        runAction(button.dataset.screenAction)
    }

    stops.push(
        on(topBar, 'click', onBarClick),
        on(bottomBar, 'click', onBarClick),
        on(frame.showBars, 'click', showBarsFromKeyboard),
        on(frame.prevPage, 'click', () => turnPage(false, false)),
        on(frame.nextPage, 'click', () => turnPage(true, false)),
        on(frame.footToggle, 'click', (event) => {
            settings.update({ runningFoot: !settings.get().runningFoot })
            // A button that keeps the focus after a tap takes the Space key, which turns the
            // page. A click from the keyboard has a detail of 0, and its focus stays.
            if (event.detail > 0) frame.footToggle.blur()
        }),
        on(frame.moreMenu, 'beforetoggle', (event) => {
            menuOpen = (event as ToggleEvent).newState === 'open'
        }),
        // The speech of the first tap needs the module, so its load starts with the press.
        on(bottomBar, 'pointerdown', (event) => {
            const button = (event.target as Element).closest<HTMLElement>('[data-screen-action]')
            const action = button?.dataset.screenAction
            if (action === 'speed' || action === 'listen') modes[action].warm()
        }),
        // A panel that is loaded at the click opens in the click handler. iOS shows the
        // keyboard for the search field only then.
        on(topBar, 'pointerdown', (event) => {
            const button = (event.target as Element).closest<HTMLElement>('[data-screen-action]')
            const action = button?.dataset.screenAction
            if (action === 'search') search.warm()
            else if (action === 'contents') contents.warm()
            else if (action === 'appearance') appearance.warm()
        }),
    )

    // ---------- Keyboard ----------

    /** More than 0 while a page turn or a scroll step from the keyboard runs. */
    let turns = 0

    function turnPage(forward: boolean, held: boolean): void {
        // The scroll view adds each step to the target of the scroll that runs. A held key
        // would send the text far past the place where the user lets the key go.
        if (held && turns > 0 && settings.get().layout === 'scroll') return
        turns++
        const turn = forward ? session.next() : session.prev()
        void turn.catch(logError).finally(() => {
            turns--
        })
    }

    /** The speed reader covers the page and has its own controls. */
    function renderPageButtons(): void {
        const covered = session.mode === 'speed'
        frame.prevPage.hidden = covered
        frame.nextPage.hidden = covered
        frame.footToggle.hidden = covered
    }

    function scrollLines(lines: number): boolean {
        // The scroll view is the only child of the stage, and it is the element that scrolls.
        const scroller = stage.firstElementChild
        if (!(scroller instanceof HTMLElement)) return false
        scroller.scrollTop += lines * LINE_SCROLL_PX
        return true
    }

    /** Returns false when the key did nothing, so the browser keeps its own action. */
    function runCommand(command: KeyCommand, held: boolean): boolean {
        switch (command) {
            case 'next':
                turnPage(true, held)
                return true
            case 'prev':
                turnPage(false, held)
                return true
            case 'line-down':
                return scrollLines(1)
            case 'line-up':
                return scrollLines(-1)
            case 'contents':
                openContents()
                return true
            case 'bookmark':
                toggleBookmark()
                return true
            case 'appearance':
                openAppearance()
                return true
            case 'search':
                openSearch()
                return true
            case 'speed':
            case 'listen':
                startMode(command)
                return true
            case 'fullscreen':
                if (!fullscreen.supported) return false
                toggleFullscreen()
                return true
            case 'font-larger':
                changeFontSize(FONT_SIZE_STEP)
                return true
            case 'font-smaller':
                changeFontSize(-FONT_SIZE_STEP)
                return true
            case 'back':
                if (!session.canGoBack) return false
                session.back().catch(logError)
                return true
            case 'shortcuts':
                openShortcuts()
                return true
            case 'hide-bars':
                // With hidden bars the key does nothing. It must not close the book.
                dispatchBars('escape')
                return false
        }
    }

    stops.push(
        on(window, 'keydown', (event) => {
            if (event.defaultPrevented || event.isComposing) return
            const target = targetContext(event)
            // The progress slider uses the arrow keys itself, but not Escape.
            if (event.key === 'Escape' && event.target === slider) target.typing = false
            const command = keyCommand(event, {
                ...target,
                mode: session.mode,
                layout: settings.get().layout,
                dialogOpen: document.querySelector('dialog[open]') !== null,
                focusInPage: stage.contains(document.activeElement),
            })
            if (!command) return
            if (event.repeat && !repeats(command)) {
                // The first press used the key, so the browser gets no part of it.
                if (command !== 'hide-bars') event.preventDefault()
                return
            }
            if (runCommand(command, event.repeat)) event.preventDefault()
        }),
    )

    // ---------- Start ----------

    frame.bookTitle.textContent = session.record.title
    frame.bookAuthor.textContent = session.record.author
    frame.bookAuthor.hidden = session.record.author.trim() === ''
    setRangeValue(slider)
    renderPosition()
    renderRunningLines()
    renderFullscreen()
    renderPageButtons()
    dispatchBars('open')

    async function close(): Promise<void> {
        destroyed = true
        clearTimeout(peekTimer)
        for (const stop of stops.splice(0)) stop()
        moreMenu.close()
        fullscreen.destroy()
        for (const part of allParts) {
            try {
                part.destroy()
            } catch (error) {
                // A part that fails here must not keep the book open.
                logError(error)
            }
        }
        const left = fullscreen.leave()
        await session.destroy()
        await left
    }

    return {
        destroy: () => (closing ??= close()),
    }
}
