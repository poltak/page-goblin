/**
 * The scroll view. The chapters are normal blocks in one scroll container, in spine order.
 * Only the chapters near the viewport are mounted. The view adds and removes chapters while
 * the user scrolls and corrects the scroll position itself, because not all browsers keep
 * the text in place when content above it changes.
 */

import type { ChapterContent, TextIndex } from '$lib/content/types'
import type { TextRange } from '$lib/types'
import { createActiveMarks } from './active'
import { createFrame, type Frame } from './frame'
import { scrollGeometry } from './geometry'
import { imagesSettled, lowestWhere, rectOfOffset } from './measure'
import { createTapTracker, dispatchTap, findTapTarget, focusedLink, linkTarget } from './pointer'
import { createSelectionWatcher } from './selection'
import { createSheet, getBaseSheet, overrideCss } from './sheets'
import { clampSpineIndex, linearNeighbour } from './spine'
import type {
    Appearance,
    HighlightMark,
    ReaderView,
    ReaderViewOptions,
    RelocateInfo,
} from './types'

const SETTLE_MS = 150
const STEP_FRACTION = 0.85
const FOLLOW_FRACTION = 0.3
/** Chapters that stay mounted on each side of the chapter at the viewport top. */
const KEEP_EACH_SIDE = 2
/** The loader cache has 6 chapters. The view keeps fewer of them in use. */
const CACHE_CHAPTERS = 5
const SETTLE_LIMIT_MS = 1500
/**
 * The most chapters that stay mounted while the page scrolls. At this number, the view
 * removes a chapter above the viewport also during a scroll.
 */
const MAX_MOUNTED = 12

interface Entry {
    frame: Frame
    spineIndex: number
    /** Height of the host at the last read. 0 before the first read. */
    height: number
}

/** The text position that stays in place when the layout changes. */
interface Anchor {
    spineIndex: number
    offset: number
    /**
     * The box that the position is fixed to. 'text' is the box of the character at `offset`.
     * 'chapter' is the box of the chapter: the viewport top is then above the first text.
     */
    base: 'text' | 'chapter'
    /**
     * Where the viewport top cuts the text box: the part of the box height that is above
     * the viewport top, from 0 to 1. A fraction stays correct when the font size changes.
     * A negative value is the distance in pixels down to a box that starts below the
     * viewport top. For 'chapter' it is the distance in pixels from the chapter top down to
     * the viewport top.
     */
    cut: number
}

/** The scroll distance that puts the box of an anchor back at its place. */
function anchorShift({
    box,
    anchor,
    viewTop,
}: {
    box: DOMRect
    anchor: Anchor
    viewTop: number
}): number {
    const { base, cut } = anchor
    const wanted = base === 'chapter' || cut < 0 ? viewTop - cut : viewTop - cut * box.height
    return box.top - wanted
}

/** The cut of a text box that the viewport top crosses, or that is below it. */
function textCut(box: DOMRect, viewTop: number): number {
    const above = viewTop - box.top
    return above >= 0 && box.height > 0 ? Math.min(1, above / box.height) : Math.min(above, 0)
}

interface JumpTarget {
    spineIndex: number
    offset?: number
    fragment?: string | null
}

function sameInfo(a: RelocateInfo, b: RelocateInfo): boolean {
    return (
        a.locator.spineIndex === b.locator.spineIndex &&
        a.locator.offset === b.locator.offset &&
        a.visible.start === b.visible.start &&
        a.visible.end === b.visible.end &&
        a.chapterLength === b.chapterLength &&
        a.atBookStart === b.atBookStart &&
        a.atBookEnd === b.atBookEnd
    )
}

export function createScrollView(options: ReaderViewOptions): ReaderView {
    const { container, book, content, callbacks } = options
    const spine = book.spine
    let appearance: Appearance = options.appearance
    let highlights: readonly HighlightMark[] = options.highlights
    let destroyed = false

    const scroller = document.createElement('div')
    // The view corrects the scroll position itself, in the same way in each browser.
    scroller.style.cssText =
        'position:absolute;inset:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;' +
        '-webkit-overflow-scrolling:touch;scrollbar-gutter:stable;overflow-anchor:none;'

    let restorePosition: string | null = null
    if (getComputedStyle(container).position === 'static') {
        restorePosition = container.style.position
        container.style.position = 'relative'
    }
    container.appendChild(scroller)

    const listeners = new AbortController()
    const signal = listeners.signal
    const reducedMotion =
        typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

    let cssText = overrideCss({
        appearance,
        layout: { mode: 'scroll', geometry: scrollGeometry(appearance.margin) },
    })
    const baseSheet = getBaseSheet()
    const overrideSheet = createSheet(cssText)

    /** The mounted chapters in the order of the DOM. */
    const entries: Entry[] = []
    /** Chapters that did not load. The view does not try them again until the next jump. */
    const failed = new Set<number>()
    let anchor: Anchor | null = null
    let lastInfo: RelocateInfo | null = null
    let viewWidth = 0
    /** Changes when a jump replaces all frames. A fill that runs then stops. */
    let generation = 0
    let navToken = 0
    /** True when the page scrolled after the last position event. */
    let scrollDirty = false
    let lastScrollTime = -Infinity
    /** The target of a smooth scroll that the view started. */
    let smooth: { target: number } | null = null

    let scrollFrame = 0
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let filling = false
    let fillAgain = false
    let chain: Promise<unknown> = Promise.resolve()
    const fillWaiters: (() => void)[] = []
    const settleWaiters: (() => void)[] = []

    const frames = () => entries.map((entry) => entry.frame)
    const active = createActiveMarks(frames)
    const selection = createSelectionWatcher({
        frames,
        viewport: () => scroller.getBoundingClientRect(),
        onSelection: (info) => callbacks.onSelection(info),
    })

    // ---- Stylesheet ----

    /** Returns true when the layout of the chapters can be different now. */
    function applySheet(): boolean {
        const css = overrideCss({
            appearance,
            layout: { mode: 'scroll', geometry: scrollGeometry(appearance.margin) },
        })
        if (css === cssText) return false
        cssText = css
        overrideSheet.replaceSync(css)
        return true
    }

    // ---- Frames ----

    function createEntry(chapter: ChapterContent): Entry {
        const frame = createFrame({
            content: chapter,
            baseSheet,
            overrideSheet,
            publisherStyles: appearance.publisherStyles,
        })
        frame.setHighlights(highlights)
        return { frame, spineIndex: chapter.spineIndex, height: 0 }
    }

    function disposeEntry(entry: Entry): void {
        hostObserver?.unobserve(entry.frame.host)
        entry.frame.dispose()
    }

    function hostHeight(entry: Entry): number {
        return entry.frame.host.getBoundingClientRect().height
    }

    function syncHeights(): void {
        for (const entry of entries) entry.height = hostHeight(entry)
    }

    function neighbour(entry: Entry, direction: 1 | -1): number {
        const index = linearNeighbour({ spine, index: entry.spineIndex, direction })
        return failed.has(index) ? -1 : index
    }

    /** The loader removes the chapters that were not used for the longest time. */
    function touchCache(top: number): void {
        const nearest = entries
            .map((entry, position) => ({ entry, distance: Math.abs(position - top) }))
            .sort((a, b) => b.distance - a.distance)
            .slice(-CACHE_CHAPTERS)
        // The nearest chapter last, so that it is the newest entry of the cache.
        for (const { entry } of nearest) content.load(entry.spineIndex).catch(() => {})
    }

    // ---- Scroll position ----

    /**
     * Move the scroll position for a layout correction, from `from` by `delta`. `from` is
     * the position before the layout change: the browser can have limited the position
     * after content was removed. A smooth scroll keeps its goal.
     */
    function shiftScroll(from: number, delta: number): void {
        scroller.scrollTop = from + delta
        if (smooth && delta) {
            smooth.target += delta
            scroller.scrollTo({ top: smooth.target, behavior: 'smooth' })
        }
    }

    function adjustScroll(delta: number): void {
        if (delta) shiftScroll(scroller.scrollTop, delta)
    }

    /** Position in `entries` of the chapter at the viewport top, from the known heights. */
    function topPosition(scrollTop: number): number {
        let bottom = 0
        for (let i = 0; i < entries.length; i++) {
            bottom += entries[i].height
            if (bottom > scrollTop + 1) return i
        }
        return entries.length - 1
    }

    /**
     * Scroll so that a chapter offset is at the viewport top. Returns false when the content
     * is too short to scroll that far.
     */
    function scrollToOffset(entry: Entry, offset: number): boolean {
        const view = scroller.getBoundingClientRect()
        // The start of a chapter shows with the space above its first line.
        const rect = offset > 0 ? rectOfOffset(entry.frame.index, offset) : null
        const top = rect ? rect.top : entry.frame.host.getBoundingClientRect().top
        const wanted = scroller.scrollTop + (top - view.top)
        scroller.scrollTop = wanted
        return Math.abs(scroller.scrollTop - wanted) < 1.5
    }

    function restoreAnchor(): void {
        const kept = anchor
        if (!kept) return
        const entry = entries.find((other) => other.spineIndex === kept.spineIndex)
        if (!entry) return
        const hostBox = entry.frame.host.getBoundingClientRect()
        const textBox = kept.base === 'text' ? rectOfOffset(entry.frame.index, kept.offset) : null
        const viewTop = scroller.getBoundingClientRect().top
        adjustScroll(anchorShift({ box: textBox ?? hostBox, anchor: kept, viewTop }))
    }

    /** The anchor for a chapter offset that is the first text below the viewport top. */
    function anchorAt({
        entry,
        offset,
        viewTop,
    }: {
        entry: Entry
        offset: number
        viewTop: number
    }): Anchor {
        const spineIndex = entry.spineIndex
        const textBox = rectOfOffset(entry.frame.index, offset)
        // Above the first text of a chapter there is only space. That space keeps its size
        // when the text size changes, so the chapter top is the better fixed point.
        if (!textBox || (offset === 0 && textBox.top > viewTop)) {
            const hostTop = entry.frame.host.getBoundingClientRect().top
            return { spineIndex, offset, base: 'chapter', cut: viewTop - hostTop }
        }
        return { spineIndex, offset, base: 'text', cut: textCut(textBox, viewTop) }
    }

    function computePosition(): { info: RelocateInfo; anchor: Anchor } | null {
        if (!entries.length) return null
        const view = scroller.getBoundingClientRect()
        const top = view.top
        const bottom = top + scroller.clientHeight

        // The chapter that crosses the viewport top, or the first one below it.
        let entry = entries[entries.length - 1]
        for (const candidate of entries) {
            if (candidate.frame.host.getBoundingClientRect().bottom > top + 1) {
                entry = candidate
                break
            }
        }

        const firstBelowTop = (index: TextIndex) =>
            lowestWhere({
                low: 0,
                high: index.length,
                test: (offset) => {
                    const rect = rectOfOffset(index, offset)
                    return !!rect && rect.bottom > top + 1
                },
            })

        let index = entry.frame.index
        let start = firstBelowTop(index)
        if (start >= index.length && index.length > 0) {
            // Below the last text of a chapter there is only space. When the next chapter
            // is in sight, the reader is in that chapter.
            const next = entries[entries.indexOf(entry) + 1]
            if (next && next.frame.host.getBoundingClientRect().top < bottom) {
                entry = next
                index = next.frame.index
                start = firstBelowTop(index)
            }
        }
        const length = index.length
        const shownIndex = index
        const end = lowestWhere({
            low: start,
            high: length,
            test: (offset) => {
                const rect = rectOfOffset(shownIndex, offset)
                return !!rect && rect.top >= bottom
            },
        })

        // The line of the anchor is still the first line: keep the character of the anchor.
        // A new anchor at the start of the line after each layout change moves the place
        // back, one line at a time.
        let anchorOffset = start
        const kept = anchor
        if (
            kept &&
            kept.base === 'text' &&
            kept.spineIndex === entry.spineIndex &&
            kept.offset > start &&
            kept.offset < end
        ) {
            const startBox = rectOfOffset(index, start)
            const keptBox = rectOfOffset(index, kept.offset)
            if (startBox && keptBox && Math.abs(keptBox.top - startBox.top) < 1) {
                anchorOffset = kept.offset
            }
        }

        const first = entries[0]
        const last = entries[entries.length - 1]
        const scrollTop = scroller.scrollTop

        return {
            info: {
                locator: { spineIndex: entry.spineIndex, offset: start },
                visible: { spineIndex: entry.spineIndex, start, end },
                chapterLength: length,
                page: null,
                pageCount: null,
                atBookStart:
                    scrollTop <= 1 &&
                    linearNeighbour({ spine, index: first.spineIndex, direction: -1 }) < 0,
                atBookEnd:
                    scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 &&
                    linearNeighbour({ spine, index: last.spineIndex, direction: 1 }) < 0,
            },
            anchor: anchorAt({ entry, offset: anchorOffset, viewTop: top }),
        }
    }

    /**
     * A width change moves the text. The observer reports it with the next frame, and a read
     * of the position before that would take the moved text as the new anchor.
     */
    function catchUpWidth(): void {
        if (!entries.length) return
        const width = scroller.clientWidth
        if (Math.abs(width - viewWidth) > 0.5) onViewSize(width)
    }

    /** Read the position and send it when it changed. */
    function settleNow(): void {
        if (settleTimer !== null) clearTimeout(settleTimer)
        settleTimer = null
        if (destroyed) return
        catchUpWidth()
        const position = computePosition()
        if (position) {
            scrollDirty = false
            smooth = null
            anchor = position.anchor
            if (!lastInfo || !sameInfo(lastInfo, position.info)) {
                lastInfo = position.info
                callbacks.onRelocate(position.info)
            }
        }
        for (const resolve of settleWaiters.splice(0)) resolve()
    }

    function scheduleSettle(): void {
        if (destroyed || settleTimer !== null) return
        const check = () => {
            settleTimer = null
            const quiet = performance.now() - lastScrollTime
            if (quiet >= SETTLE_MS) {
                settleNow()
                // The scroll is at rest. The chapters that waited above the viewport can go.
                kickFill()
            } else {
                settleTimer = setTimeout(check, SETTLE_MS - quiet)
            }
        }
        settleTimer = setTimeout(check, SETTLE_MS)
    }

    function nextSettle(): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(done, SETTLE_LIMIT_MS)
            function done() {
                clearTimeout(timer)
                resolve()
            }
            settleWaiters.push(done)
        })
    }

    // ---- The window of mounted chapters ----

    function exclusive<T>(task: () => Promise<T>): Promise<T> {
        const run = chain.then(task, task)
        chain = run.catch(() => {})
        return run
    }

    /** Mount one more chapter above or below. Returns false when nothing was added. */
    async function addChapter(direction: 1 | -1, token: number): Promise<boolean> {
        const edge = direction === 1 ? entries[entries.length - 1] : entries[0]
        const index = edge ? neighbour(edge, direction) : -1
        if (index < 0) return false

        let chapter: ChapterContent
        try {
            chapter = await content.load(index)
            await imagesSettled(chapter)
        } catch (error) {
            if (destroyed || token !== generation) return false
            failed.add(index)
            callbacks.onError(error)
            return false
        }
        if (destroyed || token !== generation) return false
        // The window can be different after the wait.
        const edgeNow = direction === 1 ? entries[entries.length - 1] : entries[0]
        if (edgeNow !== edge || entries.some((entry) => entry.spineIndex === index)) return true

        const entry = createEntry(chapter)
        if (direction === 1) {
            scroller.appendChild(entry.frame.host)
            entries.push(entry)
        } else {
            scroller.insertBefore(entry.frame.host, edge.frame.host)
            entries.unshift(entry)
            // In the same frame as the insert, so the text does not move.
            entry.height = hostHeight(entry)
            adjustScroll(entry.height)
        }
        hostObserver?.observe(entry.frame.host)
        active.refresh()
        return true
    }

    /** Remove the chapters that are far from the viewport. */
    function prune(scrollTop: number, viewHeight: number): void {
        let top = topPosition(scrollTop)
        // The removal of a chapter above the viewport needs a write of the scroll position,
        // and WebKit on iOS stops a momentum scroll at such a write. The chapters above thus
        // stay until the scroll is at rest. The limit keeps a long scroll from mounting the
        // complete book.
        const moving = performance.now() - lastScrollTime < SETTLE_MS
        const keepAbove = moving && entries.length < MAX_MOUNTED

        while (!keepAbove && top > KEEP_EACH_SIDE && entries.length > 1) {
            const first = entries[0]
            // A very short chapter can be far in the list and still near the viewport.
            if (!first.height || first.height > scrollTop - viewHeight) break
            const height = hostHeight(first)
            entries.shift()
            disposeEntry(first)
            // In the same frame as the removal, so the text does not move.
            shiftScroll(scrollTop, -height)
            scrollTop -= height
            top--
        }

        while (entries.length - 1 - top > KEEP_EACH_SIDE) {
            const last = entries[entries.length - 1]
            let lastTop = 0
            for (let i = 0; i < entries.length - 1; i++) lastTop += entries[i].height
            if (!last.height || lastTop < scrollTop + viewHeight * 2.5) break
            entries.pop()
            disposeEntry(last)
        }
    }

    async function fill(token: number): Promise<void> {
        // The limit stops a loop when a book has many chapters with no height.
        for (let step = 0; step < 40; step++) {
            if (destroyed || token !== generation || !entries.length) return
            const scrollTop = scroller.scrollTop
            const viewHeight = scroller.clientHeight
            if (viewHeight < 1) return
            // The observer gives the height of a new chapter with the next frame. That can
            // be late when the page draws few frames.
            for (const entry of entries) {
                if (!entry.height) entry.height = hostHeight(entry)
            }
            const before = entries.length
            prune(scrollTop, viewHeight)
            if (entries.length !== before) {
                active.refresh()
                touchCache(topPosition(scroller.scrollTop))
            }

            const below = scroller.scrollHeight - scroller.scrollTop - viewHeight
            let added = false
            if (below < viewHeight * 1.5) added = await addChapter(1, token)
            if (!added && !destroyed && token === generation && scroller.scrollTop < viewHeight) {
                added = await addChapter(-1, token)
            }
            if (!added) return
            if (!destroyed && token === generation) touchCache(topPosition(scroller.scrollTop))
        }
    }

    function kickFill(): void {
        if (destroyed) return
        if (filling) {
            fillAgain = true
            return
        }
        filling = true
        const token = generation
        void exclusive(() => fill(token))
            .catch(() => {})
            .then(() => {
                filling = false
                if (fillAgain && !destroyed) {
                    fillAgain = false
                    kickFill()
                    return
                }
                for (const resolve of fillWaiters.splice(0)) resolve()
            })
    }

    function fillIdle(): Promise<void> {
        if (!filling) return Promise.resolve()
        return new Promise((resolve) => fillWaiters.push(resolve))
    }

    // ---- Navigation ----

    async function show(target: JumpTarget): Promise<void> {
        const index = clampSpineIndex(spine, target.spineIndex)
        if (index < 0) throw new RangeError('The book has no chapters.')
        const token = ++navToken

        let entry = entries.find((other) => other.spineIndex === index) ?? null
        let chapter: ChapterContent
        if (entry) {
            chapter = entry.frame.content
        } else {
            chapter = await content.load(index)
            await imagesSettled(chapter)
            if (destroyed || token !== navToken) return
            entry = entries.find((other) => other.spineIndex === index) ?? null
            if (!entry) {
                // Start again with only this chapter.
                generation++
                for (const old of entries.splice(0)) disposeEntry(old)
                failed.clear()
                entry = createEntry(chapter)
                scroller.appendChild(entry.frame.host)
                entries.push(entry)
                hostObserver?.observe(entry.frame.host)
                active.refresh()
            }
        }

        const offset =
            target.offset ?? (target.fragment ? (chapter.anchors.get(target.fragment) ?? 0) : 0)
        const shown = entry
        const run = generation
        smooth = null

        // The jump runs now. It must not wait for a chapter that the fill loads.
        if (!scrollToOffset(shown, offset)) {
            // A position near the end of a chapter needs the next chapter below it, or the
            // page cannot scroll far enough.
            await exclusive(async () => {
                for (let step = 0; step < 8; step++) {
                    if (destroyed || token !== navToken || !entries.includes(shown)) return
                    if (!(await addChapter(1, run))) return
                    if (scrollToOffset(shown, offset)) return
                }
            })
            if (destroyed || token !== navToken) return
        }

        syncHeights()
        settleNow()
        // The place that the caller asked for stays in sight, also when it is in the middle
        // of a line.
        if (anchor && anchor.spineIndex === index && offset > anchor.offset && lastInfo) {
            const visible = lastInfo.visible
            if (offset < visible.end) {
                const viewTop = scroller.getBoundingClientRect().top
                anchor = anchorAt({ entry: shown, offset, viewTop })
            }
        }
        touchCache(entries.indexOf(shown))
        kickFill()
    }

    async function goToTarget(target: JumpTarget): Promise<void> {
        if (destroyed) return
        await ready.catch(() => {})
        if (destroyed) return
        try {
            await show(target)
        } catch (error) {
            if (!destroyed) callbacks.onError(error)
        }
    }

    function scrollTo(top: number): void {
        // A page that is not visible draws no frames, so a smooth scroll would not end.
        const instant = !!reducedMotion?.matches || document.visibilityState === 'hidden'
        const limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        const target = Math.max(0, Math.min(top, limit))
        if (instant || typeof scroller.scrollTo !== 'function') {
            smooth = null
            scroller.scrollTop = target
            // The scroll event comes with the next frame. A page that is not visible has
            // no frames, so the position event must not wait for it.
            lastScrollTime = performance.now()
            scrollDirty = true
            scheduleSettle()
            return
        }
        smooth = { target }
        scroller.scrollTo({ top: target, behavior: 'smooth' })
    }

    async function step(direction: 1 | -1): Promise<boolean> {
        if (destroyed) return false
        await ready.catch(() => {})
        if (destroyed || !entries.length) return false

        const room = () =>
            direction === 1
                ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
                : scroller.scrollTop
        const distance = scroller.clientHeight * STEP_FRACTION
        if (room() < distance) {
            // More chapters can be on the way.
            const edge = direction === 1 ? entries[entries.length - 1] : entries[0]
            if (neighbour(edge, direction) >= 0) {
                kickFill()
                await fillIdle()
                if (destroyed || !entries.length) return false
            }
        }
        if (room() < 1) return false

        const from = smooth ? smooth.target : scroller.scrollTop
        const before = scroller.scrollTop
        scrollTo(from + direction * distance)
        if (!smooth) {
            if (Math.abs(scroller.scrollTop - before) < 1) return false
            lastScrollTime = performance.now()
            settleNow()
            kickFill()
            return true
        }
        await nextSettle()
        return true
    }

    function followRange(range: TextRange): void {
        const visible = lastInfo?.visible
        const inSight =
            !scrollDirty &&
            !!visible &&
            range.spineIndex === visible.spineIndex &&
            range.start >= visible.start &&
            range.end <= visible.end
        if (inSight) return

        const entry = entries.find((other) => other.spineIndex === range.spineIndex)
        if (!entry) {
            void goToTarget({ spineIndex: range.spineIndex, offset: range.start })
            return
        }
        const live = entry.frame.index.range(range.start, range.end)
        // jsdom has no layout, and its ranges do not have this function.
        if (!live || typeof live.getBoundingClientRect !== 'function') return
        const rect = live.getBoundingClientRect()
        if (!rect.width && !rect.height) return
        const view = scroller.getBoundingClientRect()
        const height = scroller.clientHeight
        if (rect.top >= view.top && rect.bottom <= view.top + height) return
        scrollTo(scroller.scrollTop + (rect.top - view.top) - height * FOLLOW_FRACTION)
    }

    // ---- Input ----

    function onScroll(): void {
        lastScrollTime = performance.now()
        scrollDirty = true
        if (!scrollFrame) {
            scrollFrame = requestAnimationFrame(() => {
                scrollFrame = 0
                kickFill()
            })
        }
        scheduleSettle()
    }

    function handleTap(event: PointerEvent): void {
        const target = findTapTarget(event.composedPath(), scroller)
        if (!dispatchTap({ target, book, callbacks })) callbacks.onCenterTap()
    }

    const taps = createTapTracker({
        element: scroller,
        accept(event) {
            // A touch that stops a moving page is not a tap.
            if (event.timeStamp - lastScrollTime < 120) return false
            // A press on the scroll bar.
            return !(event.target === scroller && event.offsetX >= scroller.clientWidth)
        },
        onTap: handleTap,
    })

    function onKeyDown(event: KeyboardEvent): void {
        const link = focusedLink(event, scroller)
        if (!link) return
        event.preventDefault()
        callbacks.onLink(linkTarget(link, book))
    }

    scroller.addEventListener('scroll', onScroll, { passive: true, signal })
    // The user takes over a smooth scroll of the view. A later correction must not start
    // that scroll again.
    const stopSmooth = () => {
        smooth = null
    }
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
        scroller.addEventListener(type, stopSmooth, { passive: true, signal })
    }
    scroller.addEventListener('keydown', onKeyDown, { signal })
    scroller.addEventListener('dragstart', (event) => event.preventDefault(), { signal })

    // ---- Layout changes from outside ----

    /** A chapter above the viewport changed its height, for example by a late image. */
    const hostObserver =
        typeof ResizeObserver === 'function'
            ? new ResizeObserver((records) => {
                  if (destroyed) return
                  const viewTop = scroller.getBoundingClientRect().top
                  let correction = 0
                  for (const record of records) {
                      const entry = entries.find((other) => other.frame.host === record.target)
                      if (!entry) continue
                      const box = record.target.getBoundingClientRect()
                      const change = box.height - entry.height
                      // Only a chapter that is completely above the viewport top. The layout
                      // is clean in this callback, so the read costs no layout.
                      if (
                          entry.height > 0 &&
                          Math.abs(change) >= 0.5 &&
                          box.bottom <= viewTop + 1
                      ) {
                          correction += change
                      }
                      entry.height = box.height
                  }
                  adjustScroll(correction)
                  kickFill()
              })
            : null

    function onViewSize(width: number): void {
        if (destroyed) return
        const widthChanged = Math.abs(width - viewWidth) > 0.5
        viewWidth = width
        if (!entries.length) return
        if (widthChanged) {
            restoreAnchor()
            syncHeights()
        }
        kickFill()
        scheduleSettle()
    }

    // The observer runs before the browser paints, so the text does not jump.
    const viewObserver =
        typeof ResizeObserver === 'function'
            ? new ResizeObserver((records) => {
                  onViewSize(records[records.length - 1].contentRect.width)
              })
            : null
    viewObserver?.observe(scroller)

    // The observer is silent while the page draws no frames. The window event is not.
    let windowResizeTimer: ReturnType<typeof setTimeout> | null = null
    window.addEventListener(
        'resize',
        () => {
            if (windowResizeTimer !== null) return
            windowResizeTimer = setTimeout(() => {
                windowResizeTimer = null
                onViewSize(scroller.clientWidth)
            }, 80)
        },
        { signal },
    )

    function onFontsLoaded(): void {
        if (destroyed || !entries.length) return
        // While the user scrolls, the anchor is old. The height corrections are enough then.
        if (!scrollDirty) {
            restoreAnchor()
            syncHeights()
        }
        scheduleSettle()
    }
    document.fonts?.addEventListener?.('loadingdone', onFontsLoaded, { signal })

    // ---- Start ----

    let resolveReady: () => void = () => {}
    let rejectReady: (error: unknown) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
    })
    // The caller can ignore `ready`. A failed first load also goes to `onError`.
    ready.catch(() => {})

    viewWidth = scroller.clientWidth
    show({ spineIndex: options.initial.spineIndex, offset: options.initial.offset }).then(
        resolveReady,
        (error) => {
            if (destroyed) {
                resolveReady()
                return
            }
            callbacks.onError(error)
            rejectReady(error)
        },
    )

    // ---- Public interface ----

    return {
        ready,
        goTo(locator) {
            return goToTarget({ spineIndex: locator.spineIndex, offset: locator.offset })
        },
        goToAnchor(spineIndex, fragment) {
            return goToTarget({ spineIndex, fragment })
        },
        next: () => step(1),
        prev: () => step(-1),
        getPosition: () => lastInfo,
        setAppearance(next) {
            if (destroyed) return
            const stylesChanged = next.publisherStyles !== appearance.publisherStyles
            catchUpWidth()
            // The place that the user sees now must stay, not the place of the last event.
            if (entries.length && scrollDirty) {
                const position = computePosition()
                if (position) anchor = position.anchor
            }
            appearance = next
            const changed = applySheet()
            for (const entry of entries) entry.frame.setPublisherStyles(next.publisherStyles)
            if (!entries.length || (!changed && !stylesChanged)) return
            restoreAnchor()
            syncHeights()
            kickFill()
            scheduleSettle()
        },
        setHighlights(next) {
            if (destroyed) return
            highlights = next
            let changed = false
            for (const entry of entries) changed = entry.frame.setHighlights(next) || changed
            if (changed) active.refresh()
        },
        setActiveRange(range, followOptions) {
            if (destroyed) return
            active.setActive(range)
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
            generation++
            navToken++
            if (scrollFrame) cancelAnimationFrame(scrollFrame)
            if (settleTimer !== null) clearTimeout(settleTimer)
            if (windowResizeTimer !== null) clearTimeout(windowResizeTimer)
            listeners.abort()
            taps.destroy()
            hostObserver?.disconnect()
            viewObserver?.disconnect()
            selection.destroy()
            active.destroy()
            for (const entry of entries.splice(0)) entry.frame.dispose()
            scroller.remove()
            if (restorePosition !== null) container.style.position = restorePosition
            for (const resolve of settleWaiters.splice(0)) resolve()
            for (const resolve of fillWaiters.splice(0)) resolve()
            resolveReady()
        },
    }
}
