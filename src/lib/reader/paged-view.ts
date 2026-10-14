/**
 * The paged view. Each chapter is one strip of CSS columns in its own frame. The frames of
 * the current chapter and of its two neighbours are side by side on one track, and a page
 * turn moves the track by the width of one screen.
 */

import type { ChapterContent } from '$lib/content/types'
import type { Locator, TextRange } from '$lib/types'
import { createActiveMarks } from './active'
import { createFrame, type Frame } from './frame'
import {
    pagedGeometry,
    pageOfLeft,
    pagesOfScrollWidth,
    sameGeometry,
    type PagedGeometry,
} from './geometry'
import {
    TAP_ZONE_FRACTION,
    createVelocityTracker,
    createWheelAccumulator,
    dragAxis,
    dragOffset,
    isTap,
    settleDuration,
    swipeDecision,
    tapZone,
    type DragAxis,
    type TurnDirection,
    type VelocityTracker,
} from './gestures'
import { imagesSettled, lowestWhere, rectOfOffset } from './measure'
import { claimClick, dispatchTap, findTapTarget, focusedLink, linkTarget } from './pointer'
import { createSelectionWatcher, hasTextSelection } from './selection'
import { createSheet, getBaseSheet, overrideCss } from './sheets'
import { clampSpineIndex, linearNeighbour } from './spine'
import type {
    Appearance,
    HighlightMark,
    ReaderView,
    ReaderViewOptions,
    RelocateInfo,
} from './types'

const SLIDE_MS = 300
const SLIDE_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)'
const FADE_OUT_MS = 90
const FADE_IN_MS = 130
const EDGE_PX = 24
const EDGE_MS = 260
const RESIZE_DELAY_MS = 80
const MEASURE_DELAY_MS = 60
/** The wait after the last layout change, before the neighbour chapters load again. */
const NEIGHBOUR_DELAY_MS = 250
/** The elements of the book text that the Tab key stops at. */
const FOCUSABLE = 'a[href], [tabindex="0"], summary'
/** The settings that change only colours or the page turn. All others move the text. */
const NO_LAYOUT_KEYS: readonly (keyof Appearance)[] = ['theme', 'pageTurn']

type Side = 'prev' | 'next'
type MotionKind = 'slide' | 'fade' | 'none'

interface Entry {
    frame: Frame
    spineIndex: number
    pages: number
    /** Position of the first page on the track. */
    x: number
    measured: boolean
    /** The first chapter offset of a page, for the layout as it is now. */
    starts: Map<number, number>
    release(): void
}

interface Slot {
    spineIndex: number
    entry: Entry | null
    cancelled: boolean
    promise: Promise<Entry | null>
}

/** The text position that the view keeps in sight when the layout changes. */
interface Anchor {
    spineIndex: number
    offset: number
    /** Pages from the shown page to the page of `offset`. Not 0 for a page with no text. */
    lag: number
}

interface Motion {
    /** Go to the end state now. The relocate event waits for the next motion. */
    finish(): void
    /** Stop with no more work. For `destroy`. */
    abort(): void
}

interface MotionOptions {
    kind: MotionKind
    from: number
    /** Track position at the end. Null when `apply` sets the track. */
    to: number | null
    duration?: number
    /** Runs one time when the page changes: the change of the current chapter. */
    apply?(): void
    /** True when the shown page is the new anchor. */
    reanchor: boolean
}

interface Press {
    id: number
    startX: number
    startY: number
    time: number
    mouse: boolean
    hadSelection: boolean
    axis: DragAxis
    dragging: boolean
    captured: boolean
    /** True when the track follows the finger. */
    follows: boolean
    baseX: number
    dx: number
    canNext: boolean
    canPrev: boolean
    velocity: VelocityTracker
}

interface JumpTarget {
    spineIndex: number
    offset?: number
    fragment?: string | null
    fade?: boolean
}

function translate(x: number): string {
    return `translate3d(${-x}px, 0, 0)`
}

function requestIdle(callback: () => void): () => void {
    if (typeof requestIdleCallback === 'function') {
        const handle = requestIdleCallback(callback, { timeout: 300 })
        return () => cancelIdleCallback(handle)
    }
    const handle = setTimeout(callback, 60)
    return () => clearTimeout(handle)
}

/** True when the line breaks of the text can be different with the new settings. */
function changesLayout(before: Appearance, after: Appearance): boolean {
    const keys = Object.keys({ ...before, ...after }) as (keyof Appearance)[]
    return keys.some((key) => before[key] !== after[key] && !NO_LAYOUT_KEYS.includes(key))
}

function sameInfo(a: RelocateInfo, b: RelocateInfo): boolean {
    return (
        a.locator.spineIndex === b.locator.spineIndex &&
        a.locator.offset === b.locator.offset &&
        a.visible.start === b.visible.start &&
        a.visible.end === b.visible.end &&
        a.chapterLength === b.chapterLength &&
        a.page === b.page &&
        a.pageCount === b.pageCount &&
        a.atBookStart === b.atBookStart &&
        a.atBookEnd === b.atBookEnd
    )
}

export function createPagedView(options: ReaderViewOptions): ReaderView {
    const { container, book, content, callbacks } = options
    const spine = book.spine
    let appearance: Appearance = options.appearance
    let highlights: readonly HighlightMark[] = options.highlights
    let destroyed = false

    const clip = document.createElement('div')
    // `overflow: clip` also stops the scroll that the browser does for a focus move.
    clip.style.cssText =
        'position:absolute;inset:0;overflow:hidden;overflow:clip;contain:strict;touch-action:pinch-zoom;'
    const track = document.createElement('div')
    track.style.cssText = 'position:absolute;top:0;left:0;will-change:transform;'
    clip.appendChild(track)

    let restorePosition: string | null = null
    if (getComputedStyle(container).position === 'static') {
        restorePosition = container.style.position
        container.style.position = 'relative'
    }
    container.appendChild(clip)

    const listeners = new AbortController()
    const signal = listeners.signal
    const reducedMotion =
        typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

    let size = { width: 0, height: 0 }
    let geometry: PagedGeometry = pagedGeometry({
        width: 1,
        height: 1,
        margin: appearance.margin,
        columns: appearance.columns,
        fontSize: appearance.fontSize,
    })
    let cssText = overrideCss({ appearance, layout: { mode: 'paged', geometry } })
    const baseSheet = getBaseSheet()
    const overrideSheet = createSheet(cssText)

    /** All frames that are in the track, in spine order. */
    const mounted: Entry[] = []
    let current: Entry | null = null
    const slots: Record<Side, Slot | null> = { prev: null, next: null }
    /** 0-based page of the current chapter. */
    let page = 0
    let trackX = 0
    let anchor: Anchor | null = null
    let lastInfo: RelocateInfo | null = null
    /** Not null when the page changed and no relocate event went out. The value is `reanchor`. */
    let pendingSettle: boolean | null = null
    let navToken = 0

    let motion: Motion | null = null
    /** The speech range that waits for the end of a motion. */
    let followed: TextRange | null = null
    let press: Press | null = null
    let dragFrame = 0
    let lastPointerDown = -Infinity
    const restWaiters: (() => void)[] = []
    const sizeWaiters: (() => void)[] = []

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let measureTimer: ReturnType<typeof setTimeout> | null = null
    let cancelIdle: (() => void) | null = null
    /** Changes with each call of `scheduleNeighbours`. */
    let neighbourRun = 0

    const wheel = createWheelAccumulator()
    const active = createActiveMarks(() => mounted.map((entry) => entry.frame))
    const selection = createSelectionWatcher({
        frames: () => mounted.map((entry) => entry.frame),
        viewport: () => clip.getBoundingClientRect(),
        onSelection: (info) => callbacks.onSelection(info),
    })

    // ---- Geometry and stylesheet ----

    function hasSize(): boolean {
        return size.width >= 1 && size.height >= 1
    }

    /** Returns true when the layout of the chapters can be different now. */
    function applyGeometry(): boolean {
        geometry = pagedGeometry({
            width: size.width,
            height: size.height,
            margin: appearance.margin,
            columns: appearance.columns,
            fontSize: appearance.fontSize,
        })
        const css = overrideCss({ appearance, layout: { mode: 'paged', geometry } })
        if (css === cssText) return false
        cssText = css
        overrideSheet.replaceSync(css)
        return true
    }

    function motionKind(): MotionKind {
        if (reducedMotion?.matches || typeof track.animate !== 'function') return 'none'
        // A page that is not visible draws no frames, so an animation would not end. Speech
        // can turn pages there.
        if (document.visibilityState === 'hidden') return 'none'
        return appearance.pageTurn
    }

    // ---- Frames ----

    function mountEntry(chapter: ChapterContent): Entry {
        const frame = createFrame({
            content: chapter,
            baseSheet,
            overrideSheet,
            publisherStyles: appearance.publisherStyles,
        })
        const style = frame.host.style
        style.position = 'absolute'
        style.top = '0'
        style.left = '0'
        style.width = `${geometry.width}px`
        style.height = `${geometry.height}px`
        style.visibility = 'hidden'
        frame.setHighlights(highlights)

        // `load` and `error` do not bubble, so the listeners use the capture phase.
        const onMedia = () => {
            if (entry.measured) scheduleMeasure()
        }
        frame.shadow.addEventListener('load', onMedia, true)
        frame.shadow.addEventListener('error', onMedia, true)
        // A focus move between two links of one chapter does not leave the shadow root.
        frame.shadow.addEventListener('focusin', onFocusIn)

        const entry: Entry = {
            frame,
            spineIndex: chapter.spineIndex,
            pages: 1,
            x: 0,
            measured: false,
            starts: new Map(),
            release() {
                frame.shadow.removeEventListener('load', onMedia, true)
                frame.shadow.removeEventListener('error', onMedia, true)
                frame.shadow.removeEventListener('focusin', onFocusIn)
            },
        }

        // The DOM order is the reading order, so the Tab key moves through the book in order.
        const position = mounted.findIndex((other) => other.spineIndex > entry.spineIndex)
        if (position < 0) {
            mounted.push(entry)
            track.appendChild(frame.host)
        } else {
            track.insertBefore(frame.host, mounted[position].frame.host)
            mounted.splice(position, 0, entry)
        }
        return entry
    }

    function disposeEntry(entry: Entry): void {
        const position = mounted.indexOf(entry)
        if (position >= 0) mounted.splice(position, 1)
        entry.release()
        entry.frame.dispose()
    }

    function measurePages(entry: Entry): number {
        const { frame } = entry
        const rects = frame.body.getClientRects()
        if (!rects.length) return 1
        const last = rects[rects.length - 1]
        // The body has one box for each column that it is in. An engine that gives one box
        // around all columns needs the scroll width.
        const boxForEachColumn = rects.length > 1 || last.width <= geometry.columnWidth + 1
        if (!boxForEachColumn) return pagesOfScrollWidth(frame.root.scrollWidth, geometry)
        const origin = frame.root.getBoundingClientRect().left
        return Math.max(1, pageOfLeft(last.left - origin, geometry) + 1)
    }

    function measureEntry(entry: Entry): void {
        entry.starts.clear()
        entry.pages = measurePages(entry)
        entry.measured = true
    }

    /** The page of a box. `left` is the distance from the left edge of `rd-html`. */
    function pageAt(entry: Entry, left: number): number {
        return Math.max(0, Math.min(pageOfLeft(left, geometry), entry.pages - 1))
    }

    function pageOfOffset(entry: Entry, offset: number): number {
        const rect = rectOfOffset(entry.frame.index, offset)
        if (!rect) return 0
        return pageAt(entry, rect.left - entry.frame.root.getBoundingClientRect().left)
    }

    /** The lowest chapter offset that is on `target` or on a later page. */
    function firstOffsetOfPage(entry: Entry, target: number): number {
        const length = entry.frame.index.length
        if (target <= 0) return 0
        if (target >= entry.pages) return length
        const known = entry.starts.get(target)
        if (known !== undefined) return known

        const index = entry.frame.index
        const origin = entry.frame.root.getBoundingClientRect().left
        const found = lowestWhere({
            low: entry.starts.get(target - 1) ?? 0,
            high: length,
            test: (offset) => {
                const rect = rectOfOffset(index, offset)
                return (rect ? pageAt(entry, rect.left - origin) : 0) >= target
            },
        })
        entry.starts.set(target, found)
        return found
    }

    function setTrack(x: number): void {
        trackX = x
        track.style.transform = translate(x)
    }

    /** Put the neighbour chapters next to the current chapter. Writes only. */
    function placeEntries(): void {
        if (!current) return
        const prev = slots.prev?.entry ?? null
        const next = slots.next?.entry ?? null
        current.x = 0
        if (prev) prev.x = -prev.pages * geometry.width
        if (next) next.x = current.pages * geometry.width

        for (const entry of mounted) {
            const style = entry.frame.host.style
            const placed = entry === current || entry === prev || entry === next
            style.width = `${entry.pages * geometry.width}px`
            style.height = `${geometry.height}px`
            style.transform = `translateX(${entry.x}px)`
            style.visibility = placed && entry.measured ? 'visible' : 'hidden'
        }
    }

    /** The loader removes the chapters that were not used for the longest time. */
    function touchCache(): void {
        for (const entry of [slots.prev?.entry, slots.next?.entry, current]) {
            if (entry) content.load(entry.spineIndex).catch(() => {})
        }
    }

    // ---- Neighbour chapters ----

    function neighbourIndex(side: Side): number {
        if (!current) return -1
        return linearNeighbour({
            spine,
            index: current.spineIndex,
            direction: side === 'next' ? 1 : -1,
        })
    }

    function dropSlot(side: Side): void {
        const slot = slots[side]
        if (!slot) return
        slots[side] = null
        slot.cancelled = true
        if (slot.entry) disposeEntry(slot.entry)
    }

    async function loadSlot(slot: Slot, side: Side): Promise<Entry | null> {
        try {
            const chapter = await content.load(slot.spineIndex)
            await imagesSettled(chapter)
            // The layout of a chapter takes time. It must not stop a drag.
            while (!atRest() && !slot.cancelled && !destroyed) await whenAtRest()
            if (slot.cancelled || destroyed) return null
            // One chapter DOM cannot be in two frames. A later call tries again.
            if (mounted.some((other) => other.spineIndex === slot.spineIndex)) {
                if (slots[side] === slot) slots[side] = null
                return null
            }

            const entry = mountEntry(chapter)
            slot.entry = entry
            measureEntry(entry)
            placeEntries()
            active.refresh()
            touchCache()
            return entry
        } catch (error) {
            if (slot.cancelled || destroyed) return null
            if (slots[side] === slot) slots[side] = null
            callbacks.onError(error)
            return null
        }
    }

    /** The frame of a neighbour chapter. Null at the ends of the book and after a failed load. */
    function ensureSlot(side: Side): Promise<Entry | null> {
        const index = neighbourIndex(side)
        const existing = slots[side]
        if (existing && existing.spineIndex === index) return existing.promise
        dropSlot(side)
        if (index < 0 || destroyed) return Promise.resolve(null)

        const slot: Slot = {
            spineIndex: index,
            entry: null,
            cancelled: false,
            promise: Promise.resolve(null),
        }
        slots[side] = slot
        slot.promise = loadSlot(slot, side)
        return slot.promise
    }

    /** Load the neighbour chapters when the page is idle. A delay comes before the idle wait. */
    function scheduleNeighbours(delayMs = 0): void {
        cancelIdle?.()
        const run = ++neighbourRun
        if (delayMs > 0) {
            const timer = setTimeout(() => {
                cancelIdle = null
                scheduleNeighbours()
            }, delayMs)
            cancelIdle = () => clearTimeout(timer)
            return
        }
        cancelIdle = requestIdle(() => {
            cancelIdle = null
            if (destroyed || !current) return
            void ensureSlot('next').then(() => {
                // A newer call has its own wait. This one must not replace it.
                if (destroyed || !current || run !== neighbourRun) return
                cancelIdle = requestIdle(() => {
                    cancelIdle = null
                    if (!destroyed && current) void ensureSlot('prev')
                })
            })
        })
    }

    /** Make a mounted frame the current chapter and keep the frames that are still neighbours. */
    function makeCurrent(entry: Entry): void {
        const old: Entry[] = []
        if (current && current !== entry) old.push(current)
        for (const side of ['prev', 'next'] as const) {
            const slot = slots[side]
            if (!slot) continue
            slots[side] = null
            if (!slot.entry) slot.cancelled = true
            else if (slot.entry !== entry) old.push(slot.entry)
        }

        current = entry
        for (const side of ['prev', 'next'] as const) {
            const wanted = neighbourIndex(side)
            const position = old.findIndex((other) => other.spineIndex === wanted)
            if (position < 0) continue
            const kept = old.splice(position, 1)[0]
            slots[side] = {
                spineIndex: wanted,
                entry: kept,
                cancelled: false,
                promise: Promise.resolve(kept),
            }
        }
        for (const other of old) disposeEntry(other)
        active.refresh()
    }

    // ---- Position ----

    function computeInfo(entry: Entry): RelocateInfo {
        const length = entry.frame.index.length
        const start = firstOffsetOfPage(entry, page)
        const end = Math.max(start, firstOffsetOfPage(entry, page + 1))
        return {
            locator: { spineIndex: entry.spineIndex, offset: start },
            visible: { spineIndex: entry.spineIndex, start, end },
            chapterLength: length,
            page: page + 1,
            pageCount: entry.pages,
            atBookStart: page === 0 && neighbourIndex('prev') < 0,
            atBookEnd: page === entry.pages - 1 && neighbourIndex('next') < 0,
        }
    }

    function emit(info: RelocateInfo): void {
        if (lastInfo && sameInfo(lastInfo, info)) return
        lastInfo = info
        callbacks.onRelocate(info)
    }

    /** Send the position of the page that is shown. The view must be at rest. */
    function settle(reanchor: boolean): void {
        const useNewAnchor = reanchor || pendingSettle === true
        pendingSettle = null
        if (destroyed || !current) return
        const info = computeInfo(current)
        if (useNewAnchor) {
            const offset = info.locator.offset
            anchor = {
                spineIndex: current.spineIndex,
                offset,
                lag: pageOfOffset(current, offset) - page,
            }
        }
        dropHiddenFocus()
        emit(info)
    }

    function settleIfPending(): void {
        if (pendingSettle !== null) settle(false)
    }

    /**
     * A link that is not on the page must not keep the focus. The Enter key would follow it,
     * and the Tab key would go back to its page.
     */
    function dropHiddenFocus(): void {
        for (const entry of mounted) {
            const focused = entry.frame.shadow.activeElement
            if (!(focused instanceof HTMLElement)) continue
            const offset = entry.frame.index.offsetOfElement(focused)
            if (entry === current && offset >= 0 && pageOfOffset(entry, offset) === page) continue
            focused.blur()
        }
    }

    function anchoredPage(entry: Entry): number {
        const last = entry.pages - 1
        if (!anchor || anchor.spineIndex !== entry.spineIndex) return Math.min(page, last)
        const found = pageOfOffset(entry, anchor.offset) - anchor.lag
        return Math.max(0, Math.min(found, last))
    }

    /** Measure all frames again and show the page that has the anchor. */
    function remeasure(): void {
        if (destroyed || !current) return
        // All reads first, then all writes. A write between two reads costs one more layout.
        for (const entry of mounted) measureEntry(entry)
        page = anchoredPage(current)
        const info = computeInfo(current)
        placeEntries()
        setTrack(page * geometry.width)
        dropHiddenFocus()
        emit(info)
    }

    /**
     * Apply the appearance and the size. `textMoves` is true when the line breaks can change.
     * The neighbour chapters are not on screen, so they leave the page then and get their
     * new layout later, one time. A slider sends many steps, and each step would lay out
     * three chapters.
     */
    function relayout(textMoves: boolean): void {
        if (destroyed) return
        if (!current) {
            if (hasSize()) applyGeometry()
            return
        }
        if (!hasSize()) return
        cancelPress()
        finishMotion()
        // The position that the user sees now is the anchor for the new layout.
        settleIfPending()
        if (textMoves) {
            dropSlot('prev')
            dropSlot('next')
        }
        applyGeometry()
        for (const entry of mounted) entry.frame.setPublisherStyles(appearance.publisherStyles)
        remeasure()
        // A page turn before that time loads its neighbour itself.
        if (textMoves) scheduleNeighbours(NEIGHBOUR_DELAY_MS)
    }

    function scheduleMeasure(): void {
        if (destroyed) return
        if (measureTimer !== null) clearTimeout(measureTimer)
        measureTimer = setTimeout(async () => {
            measureTimer = null
            while (!atRest() && !destroyed) await whenAtRest()
            remeasure()
        }, MEASURE_DELAY_MS)
    }

    // ---- Motion ----

    function atRest(): boolean {
        return !motion && !press?.dragging
    }

    function whenAtRest(): Promise<void> {
        if (atRest()) return Promise.resolve()
        return new Promise((resolve) => restWaiters.push(resolve))
    }

    function flushRest(): void {
        if (!atRest() && !destroyed) return
        for (const resolve of restWaiters.splice(0)) resolve()
    }

    function finishMotion(): void {
        motion?.finish()
    }

    function runMotion(options: MotionOptions): Promise<boolean> {
        const { kind, from, to, apply, reanchor } = options
        let applied = false
        const switchPage = () => {
            if (applied) return
            applied = true
            if (to !== null) setTrack(to)
            apply?.()
        }

        if (kind === 'none' || destroyed) {
            switchPage()
            settle(reanchor)
            flushRest()
            return Promise.resolve(true)
        }

        return new Promise((resolve) => {
            let done = false
            let animations: Animation[] = []

            const end = (settleNow: boolean) => {
                if (done) return
                done = true
                motion = null
                for (const animation of animations) animation.cancel()
                animations = []
                if (!destroyed) {
                    switchPage()
                    if (settleNow) settle(reanchor)
                    else pendingSettle = reanchor || pendingSettle === true
                }
                resolve(true)
                flushRest()
            }

            motion = {
                finish: () => end(false),
                abort: () => {
                    done = true
                    motion = null
                    for (const animation of animations) animation.cancel()
                    resolve(true)
                },
            }

            if (kind === 'slide' && to !== null) {
                // The end state is the style, so a cancelled animation leaves the right page.
                setTrack(to)
                const slide = track.animate(
                    [{ transform: translate(from) }, { transform: translate(to) }],
                    { duration: options.duration ?? SLIDE_MS, easing: SLIDE_EASING },
                )
                animations.push(slide)
                slide.onfinish = () => end(true)
                return
            }

            const fadeOut = clip.animate([{ opacity: 1 }, { opacity: 0 }], {
                duration: FADE_OUT_MS,
                easing: 'ease-out',
                fill: 'forwards',
            })
            animations.push(fadeOut)
            fadeOut.onfinish = () => {
                if (done) return
                switchPage()
                const fadeIn = clip.animate([{ opacity: 0 }, { opacity: 1 }], {
                    duration: FADE_IN_MS,
                    easing: 'ease-in',
                })
                animations.push(fadeIn)
                fadeIn.onfinish = () => end(true)
                fadeOut.cancel()
            }
        })
    }

    /** The short motion at the first and the last page of the book. */
    function bounce(direction: TurnDirection): void {
        if (motionKind() !== 'slide') return
        const x = trackX
        const animation = track.animate(
            [
                { transform: translate(x) },
                { transform: translate(x + EDGE_PX * direction) },
                { transform: translate(x) },
            ],
            { duration: EDGE_MS, easing: 'ease-out' },
        )
        const stop = () => {
            if (motion !== own) return
            motion = null
            animation.cancel()
            flushRest()
        }
        const own: Motion = { finish: stop, abort: stop }
        motion = own
        animation.onfinish = stop
    }

    /** The change of the current chapter at the end of a turn over a chapter boundary. */
    function rebase(side: Side): void {
        const entry = slots[side]?.entry
        if (!entry) return
        makeCurrent(entry)
        page = side === 'next' ? 0 : entry.pages - 1
        placeEntries()
        setTrack(page * geometry.width)
        touchCache()
        scheduleNeighbours()
    }

    interface TurnOptions {
        direction: TurnDirection
        /** Track position now, when a drag moved the track. */
        from?: number
        duration?: number
        kind?: MotionKind
    }

    /** Start the motion to the next or the previous page. Null when the page is not ready. */
    function startTurn({ direction, from, duration, kind }: TurnOptions): Promise<boolean> | null {
        if (!current) return null
        const start = from ?? trackX
        const motionType = kind ?? motionKind()
        const target = page + direction

        if (target >= 0 && target < current.pages) {
            page = target
            return runMotion({
                kind: motionType,
                from: start,
                to: page * geometry.width,
                duration,
                reanchor: true,
            })
        }

        const side: Side = direction === 1 ? 'next' : 'prev'
        const entry = slots[side]?.entry
        if (!entry || slots[side]?.spineIndex !== neighbourIndex(side)) return null
        return runMotion({
            kind: motionType,
            from: start,
            to: direction === 1 ? current.pages * geometry.width : -geometry.width,
            duration,
            apply: () => rebase(side),
            reanchor: true,
        })
    }

    function turn(direction: TurnDirection): Promise<boolean> {
        if (destroyed) return Promise.resolve(false)
        // After the start, the turn begins in the same task as the tap.
        if (current) return turnNow(direction)
        return ready.then(
            () => turnNow(direction),
            () => false,
        )
    }

    async function turnNow(direction: TurnDirection): Promise<boolean> {
        if (destroyed || !current) return false

        cancelPress()
        // Fast taps turn fast: the running turn ends now.
        finishMotion()
        const token = ++navToken
        const started = startTurn({ direction })
        if (started) return started

        settleIfPending()
        const side: Side = direction === 1 ? 'next' : 'prev'
        if (neighbourIndex(side) < 0) {
            bounce(direction)
            return false
        }

        const entry = await ensureSlot(side)
        if (destroyed || token !== navToken || !entry) return false
        finishMotion()
        return startTurn({ direction }) ?? false
    }

    async function show(target: JumpTarget): Promise<void> {
        const index = clampSpineIndex(spine, target.spineIndex)
        if (index < 0) throw new RangeError('The book has no chapters.')
        cancelPress()
        finishMotion()
        const token = ++navToken

        let entry = mounted.find((other) => other.spineIndex === index && other.measured) ?? null
        let chapter: ChapterContent
        if (entry) {
            chapter = entry.frame.content
        } else {
            chapter = await content.load(index)
            await imagesSettled(chapter)
            if (destroyed || token !== navToken) return
            cancelPress()
            finishMotion()
            // A neighbour slot can have mounted the chapter in the meantime.
            entry = mounted.find((other) => other.spineIndex === index) ?? mountEntry(chapter)
            if (!entry.measured) measureEntry(entry)
        }

        const offset =
            target.offset ?? (target.fragment ? (chapter.anchors.get(target.fragment) ?? 0) : 0)
        const shown = entry
        // The target of the jump is the anchor, not the start of a page from an older turn.
        pendingSettle = null
        anchor = { spineIndex: index, offset, lag: 0 }

        // A jump inside the page that is shown needs no motion.
        const samePage = shown === current && pageOfOffset(shown, offset) === page
        const fade = !!target.fade && !!current && !samePage && motionKind() !== 'none'
        await runMotion({
            kind: fade ? 'fade' : 'none',
            from: trackX,
            to: null,
            reanchor: false,
            apply: () => {
                if (shown !== current) makeCurrent(shown)
                page = pageOfOffset(shown, offset)
                placeEntries()
                setTrack(page * geometry.width)
                touchCache()
                scheduleNeighbours()
            },
        })
    }

    // ---- Pointer, wheel and keys ----

    function releaseCapture(state: Press): void {
        if (!state.captured) return
        state.captured = false
        try {
            clip.releasePointerCapture(state.id)
        } catch {
            // The browser released the pointer already.
        }
    }

    /** Forget the press. A drag goes back to the page where it started. */
    function cancelPress(): void {
        const state = press
        press = null
        if (dragFrame) cancelAnimationFrame(dragFrame)
        dragFrame = 0
        if (!state) return
        releaseCapture(state)
        if (!state.dragging) return
        if (state.follows && trackX !== state.baseX) {
            void runMotion({
                kind: motionKind() === 'none' ? 'none' : 'slide',
                from: trackX,
                to: state.baseX,
                duration: settleDuration({
                    distance: trackX - state.baseX,
                    width: geometry.width,
                }),
                reanchor: false,
            })
        } else {
            settleIfPending()
            flushRest()
        }
    }

    function writeDrag(): void {
        dragFrame = 0
        const state = press
        if (!state?.dragging || !state.follows) return
        const blocked = state.dx < 0 ? !state.canNext : !state.canPrev
        setTrack(state.baseX - dragOffset({ dx: state.dx, blocked, width: geometry.width }))
    }

    function onPointerDown(event: PointerEvent): void {
        if (!event.isPrimary || event.button !== 0) return
        lastPointerDown = event.timeStamp
        press = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            time: event.timeStamp,
            // Some WebKit versions give an empty pointer type for a finger.
            mouse: event.pointerType === 'mouse',
            hadSelection: hasTextSelection(),
            axis: 'undecided',
            dragging: false,
            captured: false,
            follows: false,
            baseX: trackX,
            dx: 0,
            canNext: false,
            canPrev: false,
            velocity: createVelocityTracker(),
        }
    }

    function startDrag(state: Press): void {
        if (!current) return
        finishMotion()
        state.dragging = true
        state.follows = appearance.pageTurn === 'slide'
        state.baseX = trackX
        state.canNext = page + 1 < current.pages || !!slots.next?.entry
        state.canPrev = page > 0 || !!slots.prev?.entry
        try {
            clip.setPointerCapture(state.id)
            state.captured = true
        } catch {
            // The drag works without capture while the finger stays on the page.
        }
    }

    function onPointerMove(event: PointerEvent): void {
        const state = press
        if (!state || event.pointerId !== state.id) return
        const dx = event.clientX - state.startX

        if (!state.dragging) {
            if (state.axis !== 'undecided') return
            state.axis = dragAxis({ dx, dy: event.clientY - state.startY })
            // A mouse drag selects text. It never turns the page.
            if (state.axis !== 'horizontal' || state.mouse) return
            if (state.hadSelection || hasTextSelection()) return
            startDrag(state)
            if (!state.dragging) return
        }

        state.dx = dx
        state.velocity.add(event.clientX, event.timeStamp)
        if (state.follows && !dragFrame) dragFrame = requestAnimationFrame(writeDrag)
    }

    function endDrag(state: Press, event: PointerEvent): void {
        if (dragFrame) cancelAnimationFrame(dragFrame)
        dragFrame = 0
        releaseCapture(state)

        const direction = swipeDecision({
            dx: event.clientX - state.startX,
            velocity: state.velocity.read(event.timeStamp),
            width: geometry.width,
        })
        const moved = state.follows && trackX !== state.baseX
        const slideKind: MotionKind = motionKind() === 'none' ? 'none' : 'slide'

        if (direction) {
            const target =
                direction === 1 ? state.baseX + geometry.width : state.baseX - geometry.width
            const started = startTurn({
                direction,
                from: trackX,
                duration: settleDuration({ distance: target - trackX, width: geometry.width }),
                kind: state.follows ? slideKind : undefined,
            })
            if (started) return
        }

        const back = moved
            ? runMotion({
                  kind: slideKind,
                  from: trackX,
                  to: state.baseX,
                  duration: settleDuration({
                      distance: trackX - state.baseX,
                      width: geometry.width,
                  }),
                  reanchor: false,
              })
            : Promise.resolve(true)
        if (!moved) {
            settleIfPending()
            flushRest()
        }
        // The neighbour chapter was not ready for the drag. Turn when it is.
        if (direction && neighbourIndex(direction === 1 ? 'next' : 'prev') >= 0) {
            void back.then(() => turn(direction))
        }
    }

    function handleTap(event: PointerEvent): void {
        let target = findTapTarget(event.composedPath(), clip)
        const view = clip.getBoundingClientRect()
        const zone = tapZone({ x: event.clientX, left: view.left, width: view.width })

        if (target.kind === 'image' && zone !== 'center') {
            // An image that covers both turn zones, such as a cover, must not stop the turns.
            const box = target.element.getBoundingClientRect()
            const edge = view.width * TAP_ZONE_FRACTION
            if (box.left <= view.left + edge && box.right >= view.right - edge) {
                target = { kind: 'none' }
            }
        }
        if (dispatchTap({ target, book, callbacks })) return

        if (zone === 'prev') void turn(-1)
        else if (zone === 'next') void turn(1)
        else callbacks.onCenterTap()
    }

    function onPointerUp(event: PointerEvent): void {
        const state = press
        if (!state || event.pointerId !== state.id) return
        press = null
        if (state.dragging) {
            endDrag(state, event)
            return
        }
        const tap = isTap({
            dx: event.clientX - state.startX,
            dy: event.clientY - state.startY,
            elapsed: event.timeStamp - state.time,
        })
        // A press that made or cleared a selection must do nothing more.
        if (tap && !state.hadSelection && !hasTextSelection()) handleTap(event)
    }

    function onPointerCancel(event: PointerEvent): void {
        if (press && event.pointerId === press.id) cancelPress()
    }

    function onLostCapture(event: PointerEvent): void {
        // A finger has an implicit capture on the element below it. When the clip takes the
        // capture for a drag, that element loses it, and its event bubbles to the clip. Only a
        // loss of the capture of the clip itself ends the drag.
        if (event.target !== clip) return
        if (press?.captured && event.pointerId === press.id) cancelPress()
    }

    function onWheel(event: WheelEvent): void {
        // The Control key with the wheel is a zoom.
        if (event.ctrlKey) return
        // A horizontal wheel movement must not start the history gesture of the browser.
        event.preventDefault()
        const direction = wheel.push({
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            time: event.timeStamp,
        })
        if (direction) void turn(direction)
    }

    function onKeyDown(event: KeyboardEvent): void {
        const link = focusedLink(event, clip)
        if (!link) return
        event.preventDefault()
        callbacks.onLink(linkTarget(link, book))
    }

    /** The first element on the visible page that can get the focus. */
    function firstFocusableOnPage(): HTMLElement | null {
        if (!current || !lastInfo || !atRest()) return null
        if (lastInfo.visible.spineIndex !== current.spineIndex) return null
        const { start, end } = lastInfo.visible
        const { body, index } = current.frame
        // The content pipeline keeps only these elements that can get the focus.
        for (const item of body.querySelectorAll<HTMLElement>(FOCUSABLE)) {
            const at = index.offsetOfElement(item)
            if (at >= end) break
            if (at >= start) return pageOfOffset(current, at) === page ? item : null
        }
        return null
    }

    /**
     * A link of the book text got the focus. Each frame has this listener on its shadow root,
     * because the event of a move in one chapter does not go out of the shadow root.
     */
    function onFocusIn(event: Event): void {
        if (press || event.timeStamp - lastPointerDown < 700) return
        const element = event.composedPath()[0]
        if (!(element instanceof Element)) return
        const root = element.getRootNode()
        const entry = mounted.find((other) => other.frame.shadow === root)
        if (!entry?.measured) return
        const offset = entry.frame.index.offsetOfElement(element)
        if (offset < 0) return
        if (entry === current && atRest() && pageOfOffset(entry, offset) === page) return

        // The element that had the focus: a link of the same chapter, the host of a different
        // chapter, an element outside the book text, or null.
        const from = (event as FocusEvent).relatedTarget
        // Only the Tab key from one element of the book text to the next shows a different page.
        if (from instanceof Node && (from.getRootNode() === root || track.contains(from))) {
            void show({ spineIndex: entry.spineIndex, offset }).catch(() => {})
            return
        }
        // The focus came from a bar or a dialog, or the window is active again. The page stays.
        firstFocusableOnPage()?.focus({ preventScroll: true })
        // The page can have no element for the focus, and a hidden element does not take it.
        // The element that is not on the page must not keep the focus then.
        if (entry.frame.shadow.activeElement === element && element instanceof HTMLElement) {
            element.blur()
        }
    }

    clip.addEventListener('pointerdown', onPointerDown, { signal })
    clip.addEventListener('pointermove', onPointerMove, { signal })
    clip.addEventListener('pointerup', onPointerUp, { signal })
    clip.addEventListener('pointercancel', onPointerCancel, { signal })
    clip.addEventListener('lostpointercapture', onLostCapture, { signal })
    clip.addEventListener('click', (event) => claimClick(event, clip), { signal })
    clip.addEventListener('wheel', onWheel, { passive: false, signal })
    clip.addEventListener('keydown', onKeyDown, { signal })
    clip.addEventListener('dragstart', (event) => event.preventDefault(), { signal })
    // A browser without `overflow: clip` can scroll the clip element. Undo that.
    clip.addEventListener(
        'scroll',
        () => {
            if (clip.scrollLeft) clip.scrollLeft = 0
            if (clip.scrollTop) clip.scrollTop = 0
        },
        { signal },
    )

    // ---- Layout changes from outside ----

    function onSize(width: number, height: number): void {
        size = { width, height }
        if (!hasSize()) return
        for (const resolve of sizeWaiters.splice(0)) resolve()
        if (!current) {
            // The first chapter is not mounted yet. It must get the size as it is now.
            applyGeometry()
            return
        }
        const next = pagedGeometry({
            ...size,
            margin: appearance.margin,
            columns: appearance.columns,
            fontSize: appearance.fontSize,
        })
        if (sameGeometry(next, geometry)) return
        if (resizeTimer !== null) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
            resizeTimer = null
            relayout(true)
        }, RESIZE_DELAY_MS)
    }

    const observer =
        typeof ResizeObserver === 'function'
            ? new ResizeObserver((entries) => {
                  const box = entries[entries.length - 1].contentRect
                  onSize(box.width, box.height)
              })
            : null
    observer?.observe(clip)

    // The observer is silent while the page draws no frames. The window event is not.
    let windowResizeTimer: ReturnType<typeof setTimeout> | null = null
    window.addEventListener(
        'resize',
        () => {
            if (windowResizeTimer !== null) return
            windowResizeTimer = setTimeout(() => {
                windowResizeTimer = null
                if (destroyed) return
                const box = clip.getBoundingClientRect()
                onSize(box.width, box.height)
            }, RESIZE_DELAY_MS)
        },
        { signal },
    )

    // A font that loads late changes the line breaks.
    document.fonts?.addEventListener?.('loadingdone', scheduleMeasure, { signal })

    // A page that is not visible draws no frames, so a page turn in motion would not end
    // and its position event would not come.
    document.addEventListener(
        'visibilitychange',
        () => {
            if (document.visibilityState !== 'hidden' || !motion) return
            finishMotion()
            settleIfPending()
        },
        { signal },
    )

    // ---- Start ----

    let resolveReady: () => void = () => {}
    let rejectReady: (error: unknown) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
    })
    // The caller can ignore `ready`. A failed first load also goes to `onError`.
    ready.catch(() => {})

    async function start(): Promise<void> {
        const box = clip.getBoundingClientRect()
        size = { width: box.width, height: box.height }
        if (!hasSize()) await new Promise<void>((resolve) => sizeWaiters.push(resolve))
        if (destroyed) return
        applyGeometry()
        await show({ spineIndex: options.initial.spineIndex, offset: options.initial.offset })
    }

    start().then(resolveReady, (error) => {
        if (destroyed) {
            resolveReady()
            return
        }
        callbacks.onError(error)
        rejectReady(error)
    })

    // ---- Public interface ----

    async function goToTarget(target: JumpTarget): Promise<void> {
        if (destroyed) return
        await ready.catch(() => {})
        if (destroyed) return
        try {
            await show(target)
        } catch (error) {
            if (destroyed) return
            settleIfPending()
            callbacks.onError(error)
        }
    }

    /** Show the page of the speech marker when the marker is not in sight. */
    function followRange(range: TextRange): void {
        if (destroyed || !current || !lastInfo) return
        if (!atRest()) {
            // A layout read must wait for the end of the page turn. A newer range can come
            // in that time.
            followed = range
            void whenAtRest().then(() => {
                if (followed === range) followRange(range)
            })
            return
        }
        followed = null
        const visible = lastInfo.visible
        const inSight =
            pendingSettle === null &&
            range.spineIndex === visible.spineIndex &&
            range.start >= visible.start &&
            range.start < visible.end
        if (inSight) return

        if (range.spineIndex === current.spineIndex) {
            const target = pageOfOffset(current, range.start)
            if (target === page) return
            if (target === page + 1) {
                void turn(1)
                return
            }
        } else if (page === current.pages - 1) {
            const next = slots.next?.entry
            if (
                next &&
                next.spineIndex === range.spineIndex &&
                pageOfOffset(next, range.start) === 0
            ) {
                void turn(1)
                return
            }
        }
        void goToTarget({ spineIndex: range.spineIndex, offset: range.start, fade: true })
    }

    return {
        ready,
        goTo(locator: Locator) {
            return goToTarget({ spineIndex: locator.spineIndex, offset: locator.offset })
        },
        goToAnchor(spineIndex, fragment) {
            return goToTarget({ spineIndex, fragment })
        },
        next: () => turn(1),
        prev: () => turn(-1),
        getPosition: () => lastInfo,
        setAppearance(next) {
            if (destroyed) return
            const textMoves = changesLayout(appearance, next)
            appearance = next
            relayout(textMoves)
        },
        setHighlights(next) {
            if (destroyed) return
            highlights = next
            let changed = false
            for (const entry of mounted) changed = entry.frame.setHighlights(next) || changed
            if (!changed) return
            active.refresh()
            // A mark must not change the line breaks. Measure again to be sure.
            scheduleMeasure()
        },
        setActiveRange(range, followOptions) {
            if (destroyed) return
            active.setActive(range)
            followed = null
            if (range && followOptions?.follow !== false) followRange(range)
        },
        setSearchRanges(ranges) {
            if (destroyed) return
            active.setSearch(ranges)
        },
        clearSelection() {
            if (destroyed) return
            document.getSelection()?.removeAllRanges()
        },
        destroy() {
            if (destroyed) return
            destroyed = true
            navToken++
            motion?.abort()
            motion = null
            if (press) releaseCapture(press)
            press = null
            if (dragFrame) cancelAnimationFrame(dragFrame)
            if (resizeTimer !== null) clearTimeout(resizeTimer)
            if (windowResizeTimer !== null) clearTimeout(windowResizeTimer)
            if (measureTimer !== null) clearTimeout(measureTimer)
            cancelIdle?.()
            listeners.abort()
            observer?.disconnect()
            selection.destroy()
            active.destroy()
            for (const side of ['prev', 'next'] as const) {
                const slot = slots[side]
                if (slot) slot.cancelled = true
                slots[side] = null
            }
            for (const entry of [...mounted]) disposeEntry(entry)
            current = null
            clip.remove()
            if (restorePosition !== null) container.style.position = restorePosition
            for (const resolve of sizeWaiters.splice(0)) resolve()
            flushRest()
            resolveReady()
        },
    }
}
