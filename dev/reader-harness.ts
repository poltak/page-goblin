/**
 * A test page for the reader views. It is not part of the production build.
 *
 * URL parameters: book (a file name in /local-books/), mode (paged or scroll), theme, spine,
 * offset, font (size in pixels), margin, columns, turn (slide, fade or none), publisher (0
 * turns the book styles off), bar (0 hides the bar), motion (0 makes the page act as if
 * the user asked for reduced motion), visible (1 makes the page act as if it is visible).
 */

import { createContentLoader, createTextIndex } from '$lib/content'
import type { ContentLoader, TextIndex } from '$lib/content/types'
import { openEpub } from '$lib/epub'
import type { EpubBook } from '$lib/epub/types'
import {
    createPagedView,
    createScrollView,
    type Appearance,
    type ColumnChoice,
    type HighlightMark,
    type LinkTarget,
    type MarginSize,
    type ReaderView,
    type RelocateInfo,
    type SelectionInfo,
} from '$lib/reader'
import { pagedGeometry, pagesOfScrollWidth } from '$lib/reader/geometry'
import {
    compareLocators,
    type LayoutMode,
    type Locator,
    type PageTurnAnimation,
    type ReadingTheme,
} from '$lib/types'

interface Timings {
    /** Download of the file from the dev server. */
    fetch: number
    open: number
    prepare: number
    /** From the view constructor to `ready`. */
    ready: number
}

interface Harness {
    view: ReaderView
    book: EpubBook
    content: ContentLoader
    mode: LayoutMode
    appearance: Appearance
    /** All relocate events of the view that is mounted now. */
    events: RelocateInfo[]
    /** The other callbacks, as short text lines. */
    log: string[]
    errors: unknown[]
    timings: Timings
    stage: HTMLElement
    setAppearance(patch: Partial<Appearance>): void
    setMode(mode: LayoutMode): Promise<void>
    /** Problems of the page that the paged view shows now. */
    inspectPage(): Promise<string[]>
    /** Turn pages forward from the position now and look at each page. Paged view only. */
    sweep(maxPages?: number): Promise<SweepResult>
    selfTest(): Promise<string[]>
}

interface SweepResult {
    pages: number
    chapters: number
    atBookEnd: boolean
    /** Time of one `next()` with its relocate event, in milliseconds. */
    next: { median: number; p90: number; max: number }
    problemCount: number
    /** The first problems. */
    problems: string[]
}

declare global {
    interface Window {
        harness?: Harness
    }
}

const THEMES: readonly ReadingTheme[] = ['light', 'sepia', 'dark', 'black']
const MARGINS: readonly MarginSize[] = ['narrow', 'normal', 'wide']
const TURNS: readonly PageTurnAnimation[] = ['slide', 'fade', 'none']

function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id)
    if (!element) throw new Error(`No element with the id ${id}`)
    return element as T
}

function pick<T extends string>(value: string | null, choices: readonly T[], fallback: T): T {
    return choices.includes(value as T) ? (value as T) : fallback
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function describe(info: RelocateInfo): string {
    const page = info.page === null ? 'scroll' : `page ${info.page} of ${info.pageCount}`
    const flags = `${info.atBookStart ? ' start' : ''}${info.atBookEnd ? ' end' : ''}`
    return (
        `spine ${info.locator.spineIndex} offset ${info.locator.offset} ` +
        `visible ${info.visible.start} to ${info.visible.end} of ${info.chapterLength} ${page}${flags}`
    )
}

async function main(): Promise<void> {
    const params = new URLSearchParams(location.search)
    if (params.get('motion') === '0') {
        // A browser pane that is not visible draws one frame each second, and a smooth scroll
        // then takes very long.
        const original = window.matchMedia.bind(window)
        window.matchMedia = (query: string) => {
            const list = original(query)
            if (!query.includes('prefers-reduced-motion')) return list
            return Object.create(list, { matches: { value: true } }) as MediaQueryList
        }
    }
    if (params.get('visible') === '1') {
        // The view does not animate in a page that is not visible. A test of the animations
        // in a browser pane that is not on the screen needs this.
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible' })
    }
    const stage = byId('stage')
    const info = byId('dev-info')
    const errorLine = byId('dev-error')
    if (params.get('bar') === '0') {
        byId('dev-bar').hidden = true
        document.body.style.setProperty('--dev-bar-height', '0px')
    }

    const bookName = params.get('book') || 'quick-start.epub'
    let mode: LayoutMode = pick(params.get('mode'), ['paged', 'scroll'], 'paged')
    const columnsParam = params.get('columns')
    const columns: ColumnChoice = columnsParam === '1' ? 1 : columnsParam === '2' ? 2 : 'auto'
    let appearance: Appearance = {
        theme: pick(params.get('theme'), THEMES, 'light'),
        fontFamily: params.get('family'),
        fontSize: Number(params.get('font')) || 18,
        lineHeight: null,
        margin: pick(params.get('margin'), MARGINS, 'normal'),
        textAlign: 'publisher',
        hyphenate: false,
        publisherStyles: params.get('publisher') !== '0',
        columns,
        pageTurn: pick(params.get('turn'), TURNS, 'slide'),
    }
    document.documentElement.dataset.theme = appearance.theme

    const timings: Timings = { fetch: 0, open: 0, prepare: 0, ready: 0 }
    let mark = performance.now()
    const lap = () => {
        const now = performance.now()
        const elapsed = now - mark
        mark = now
        return Math.round(elapsed * 10) / 10
    }

    const response = await fetch(`/local-books/${encodeURIComponent(bookName)}`)
    if (!response.ok) throw new Error(`The book ${bookName} did not load (${response.status}).`)
    const file = await response.blob()
    timings.fetch = lap()
    const book = await openEpub(file)
    timings.open = lap()
    const content = createContentLoader({ book })
    await content.prepare()
    timings.prepare = lap()

    const events: RelocateInfo[] = []
    const log: string[] = []
    const errors: unknown[] = []
    let highlights: HighlightMark[] = []

    const callbacks = {
        onRelocate(position: RelocateInfo) {
            events.push(position)
            info.textContent = describe(position)
        },
        onCenterTap() {
            log.push('center-tap')
        },
        onSelection(selection: SelectionInfo | null) {
            log.push(
                selection
                    ? `selection ${selection.range.start}-${selection.range.end} "${selection.text.slice(0, 40)}"`
                    : 'selection none',
            )
        },
        onHighlightTap(id: string) {
            log.push(`highlight-tap ${id}`)
        },
        onLink(target: LinkTarget) {
            if (target.kind !== 'internal') return
            log.push(
                `link ${target.path}#${target.fragment ?? ''} spine ${target.spineIndex} noteref ${target.noteref}`,
            )
            if (target.spineIndex >= 0 && !target.noteref) {
                void harness.view.goToAnchor(target.spineIndex, target.fragment)
            }
        },
        onImageTap(image: { src: string; alt: string }) {
            log.push(`image-tap ${image.alt}`)
        },
        onError(error: unknown) {
            errors.push(error)
            errorLine.textContent = String(error)
            console.error(error)
        },
    }

    function createView(initial: Locator): ReaderView {
        events.length = 0
        const create = mode === 'paged' ? createPagedView : createScrollView
        return create({
            container: stage,
            book,
            content,
            appearance,
            initial,
            highlights,
            callbacks,
        })
    }

    mark = performance.now()
    const first = createView({
        spineIndex: Number(params.get('spine')) || 0,
        offset: Number(params.get('offset')) || 0,
    })

    function setAppearance(patch: Partial<Appearance>): void {
        appearance = { ...appearance, ...patch }
        harness.appearance = appearance
        document.documentElement.dataset.theme = appearance.theme
        harness.view.setAppearance(appearance)
    }

    async function setMode(next: LayoutMode): Promise<void> {
        if (next === mode) return
        const position = harness.view.getPosition()
        // Only one view can own the chapter DOM, so the old view goes first.
        harness.view.destroy()
        mode = next
        harness.mode = next
        harness.view = createView(position?.locator ?? { spineIndex: 0, offset: 0 })
        await harness.view.ready
    }

    /**
     * The text index of a chapter. For a chapter that the view shows, the body is the one in
     * the frame: the loader can give a new copy when the chapter left its cache.
     */
    async function indexOf(spineIndex: number) {
        const host = stage.querySelector(`[data-rd-spine="${spineIndex}"]`)
        const mounted = host?.shadowRoot?.querySelector<HTMLElement>('rd-body')
        const body = mounted ?? (await content.load(spineIndex)).body
        const root = body.parentElement ?? body
        return { chapter: { body, root }, index: createTextIndex(body) }
    }

    function position(): RelocateInfo {
        const now = harness.view.getPosition()
        if (!now) throw new Error('The view has no position.')
        return now
    }

    function inVisible(info: RelocateInfo, locator: Locator): boolean {
        if (info.visible.spineIndex !== locator.spineIndex) return false
        const { start, end } = info.visible
        // The end of the chapter is a valid position. It is in sight with the last text.
        const atEnd = locator.offset === info.chapterLength && end === info.chapterLength
        return (
            locator.offset >= start && (locator.offset < end || locator.offset === start || atEnd)
        )
    }

    /**
     * The boxes of the text of a range, one Text node at a time. A range over more than one
     * node also gives the boxes of the images between them.
     */
    function textRects(
        index: TextIndex,
        { start, end }: { start: number; end: number },
    ): DOMRect[] {
        const rects: DOMRect[] = []
        let offset = start
        if (offset < end) {
            // A range that starts after a hyphen of the browser also has the box of that
            // hyphen, which is on the line before. The character itself is the last box.
            const sized = [...(index.range(offset, offset + 1)?.getClientRects() ?? [])].filter(
                (rect) => rect.width || rect.height,
            )
            if (sized.length) rects.push(sized[sized.length - 1])
            offset++
        }
        while (offset < end) {
            const point = index.locate(offset)
            if (!point) break
            const nodeEnd = offset + Math.max(1, point.node.data.length - point.offset)
            const range = index.range(offset, Math.min(end, nodeEnd))
            for (const rect of range?.getClientRects() ?? []) {
                if (rect.width || rect.height) rects.push(rect)
            }
            offset = nodeEnd
        }
        return rects
    }

    function hosts(): HTMLElement[] {
        return [...stage.querySelectorAll<HTMLElement>('[data-rd-frame]')]
    }

    /**
     * Look at the page that the paged view shows now: the visible text must be inside the
     * container, the text before and after the visible range must be outside it, and each
     * image that shows must show completely.
     */
    async function inspectPage(): Promise<string[]> {
        const problems: string[] = []
        const now = position()
        const clip = stage.getBoundingClientRect()
        const { chapter, index } = await indexOf(now.visible.spineIndex)
        const inClipX = (rect: DOMRect) => rect.right > clip.left + 1 && rect.left < clip.right - 1

        let sideways = 0
        let cut = 0
        for (const rect of textRects(index, now.visible)) {
            if (rect.left < clip.left - 1 || rect.right > clip.right + 1) sideways++
            if (rect.top < clip.top - 0.5 || rect.bottom > clip.bottom + 0.5) cut++
        }
        if (sideways) problems.push(`${sideways} text boxes outside the page at the sides`)
        if (cut) problems.push(`${cut} text boxes cut at the top or the bottom`)

        const before = textRects(index, {
            start: Math.max(0, now.visible.start - 40),
            end: now.visible.start,
        }).filter(inClipX).length
        if (before) problems.push(`${before} boxes of the text before the page are in sight`)
        const after = textRects(index, {
            start: now.visible.end,
            end: Math.min(now.chapterLength, now.visible.end + 40),
        }).filter(inClipX).length
        if (after) problems.push(`${after} boxes of the text after the page are in sight`)

        const geometry = pagedGeometry({
            width: clip.width,
            height: clip.height,
            margin: appearance.margin,
            columns: appearance.columns,
        })
        const step = geometry.columnWidth + geometry.columnGap
        for (const image of chapter.body.querySelectorAll('img, svg, video')) {
            const box = image.getBoundingClientRect()
            if (!box.width || !box.height || !inClipX(box)) continue
            // The place of the box in its column. An image must not be in the margins.
            const raw = (((box.left - clip.left - geometry.marginX) % step) + step) % step
            const inColumn = raw > step - 1 ? raw - step : raw
            if (inColumn + box.width > geometry.columnWidth + 1) {
                problems.push(
                    `image ${Math.round(box.width)} wide sticks out of its column by ` +
                        `${Math.round(inColumn + box.width - geometry.columnWidth)} pixels`,
                )
            }
            if (
                box.left < clip.left - 1 ||
                box.right > clip.right + 1 ||
                box.top < clip.top - 1 ||
                box.bottom > clip.bottom + 1
            ) {
                const size = `${Math.round(box.width)}x${Math.round(box.height)}`
                problems.push(
                    `image ${size} at ${Math.round(box.left)},${Math.round(box.top)} is cut`,
                )
            }
        }
        return problems
    }

    async function sweep(maxPages = 300): Promise<SweepResult> {
        const view = harness.view
        await view.ready
        const problems: string[] = []
        const times: number[] = []
        const chapters = new Set<number>()
        let previous = position()
        chapters.add(previous.locator.spineIndex)
        for (const problem of await inspectPage())
            problems.push(`${problem}. ${describe(previous)}`)

        let pages = 0
        for (; pages < maxPages; pages++) {
            const before = performance.now()
            const turned = await view.next()
            times.push(performance.now() - before)
            if (!turned) break
            const now = position()
            chapters.add(now.locator.spineIndex)
            if (now.locator.spineIndex === previous.locator.spineIndex) {
                if (now.visible.start !== previous.visible.end) {
                    problems.push(
                        `start is not the last end ${previous.visible.end}. ${describe(now)}`,
                    )
                }
                if (now.page !== (previous.page ?? 0) + 1) {
                    problems.push(`page after ${previous.page}. ${describe(now)}`)
                }
            } else {
                if (now.page !== 1) problems.push(`a new chapter not at page 1. ${describe(now)}`)
                if (previous.page !== previous.pageCount) {
                    problems.push(`left the chapter before its end. ${describe(previous)}`)
                }
            }
            for (const problem of await inspectPage()) problems.push(`${problem}. ${describe(now)}`)
            previous = now
        }
        if (pages < maxPages && !position().atBookEnd) {
            problems.push(`next() gave false before the end. ${describe(position())}`)
        }

        times.sort((a, b) => a - b)
        const at = (part: number) =>
            Math.round(
                (times[Math.min(times.length - 1, Math.floor(times.length * part))] ?? 0) * 10,
            ) / 10
        return {
            pages,
            chapters: chapters.size,
            atBookEnd: position().atBookEnd,
            next: { median: at(0.5), p90: at(0.9), max: at(1) },
            problemCount: problems.length,
            problems: problems.slice(0, 25),
        }
    }

    async function selfTest(): Promise<string[]> {
        const failures: string[] = []
        const fail = (check: string, message: string) => failures.push(`(${check}) ${message}`)
        const view = harness.view
        const paged = mode === 'paged'
        const savedAppearance = appearance
        // The checks need no motion. The page turns are then immediate.
        setAppearance({ pageTurn: 'none' })
        await view.ready

        // (a) The first position is consistent.
        const firstInfo = events[0]
        if (!firstInfo) {
            fail('a', 'No relocate event after ready.')
            return failures
        }
        {
            const { locator, visible, chapterLength, page, pageCount } = firstInfo
            if (locator.offset < 0 || locator.offset > chapterLength) fail('a', 'Offset outside.')
            if (visible.start > visible.end || visible.end > chapterLength) fail('a', 'Bad range.')
            if (paged && (page === null || pageCount === null || page < 1 || page > pageCount)) {
                fail('a', `Bad page ${page} of ${pageCount}.`)
            }
            if (!paged && (page !== null || pageCount !== null)) fail('a', 'Page in scroll mode.')
        }

        // (b) 40 steps forward, (c) each visible text box is inside the clip.
        const start = position()
        const saved: Locator[] = []
        let steps = 0
        let previous = start
        for (let i = 0; i < 40; i++) {
            if (!(await view.next())) break
            steps++
            const now = position()
            if (compareLocators(now.locator, previous.locator) < 0) {
                fail('b', `Step ${i}: the locator went back. ${describe(now)}`)
            }
            const sameChapter = now.locator.spineIndex === previous.locator.spineIndex
            if (paged && sameChapter && now.visible.start !== previous.visible.end) {
                fail(
                    'b',
                    `Step ${i}: start ${now.visible.start}, last end ${previous.visible.end}.`,
                )
            }
            if (paged && sameChapter && now.page !== (previous.page ?? 0) + 1) {
                fail('b', `Step ${i}: page ${now.page} after ${previous.page}.`)
            }
            if (paged) {
                for (const problem of await inspectPage()) {
                    fail('c', `Step ${i}: ${problem}. ${describe(now)}`)
                }
            }
            if (i % 4 === 0) saved.push(now.locator)
            previous = now
        }
        if (steps === 0 && !start.atBookEnd) fail('b', 'next() gave false at the first step.')

        // (g) The same number of steps back gives the start position.
        for (let i = 0; i < steps; i++) {
            if (await view.prev()) continue
            // The last step forward can be a short one at the end of the book. The way back
            // then needs fewer steps.
            if (!position().atBookStart) fail('g', `prev() gave false at step ${i} of ${steps}.`)
            break
        }
        {
            const back = position()
            const same = paged
                ? compareLocators(back.locator, start.locator) === 0 && back.page === start.page
                : back.locator.spineIndex === start.locator.spineIndex &&
                  Math.abs(back.locator.offset - start.locator.offset) <= 400
            if (!same) fail('g', `Start ${describe(start)}. After the return ${describe(back)}.`)
        }

        // (d) goTo shows a page that has the locator.
        for (const locator of saved.slice(0, 10)) {
            await view.goTo(locator)
            const now = position()
            if (!inVisible(now, locator)) {
                fail('d', `goTo ${locator.spineIndex}:${locator.offset} shows ${describe(now)}.`)
            }
        }

        // (e) A font size change and a container resize keep the anchor.
        {
            const target = saved[Math.min(5, saved.length - 1)] ?? start.locator
            await view.goTo(target)
            const anchor = position().locator
            const check = (label: string) => {
                const now = position()
                if (!inVisible(now, anchor)) {
                    fail(
                        'e',
                        `${label}: ${anchor.spineIndex}:${anchor.offset} is not in ${describe(now)}.`,
                    )
                }
            }
            /** The frames of the paged view have the height of the container. */
            const followed = async (label: string) => {
                if (!paged) {
                    await wait(400)
                    return
                }
                const height = `${Math.floor(stage.getBoundingClientRect().height)}px`
                const end = performance.now() + 3000
                while (hosts()[0]?.style.height !== height && performance.now() < end)
                    await wait(40)
                const now = hosts()[0]?.style.height
                if (now !== height) fail('e', `${label}: the frame is ${now} high, not ${height}.`)
            }
            setAppearance({ fontSize: appearance.fontSize + 4 })
            await wait(300)
            check('Larger text')

            stage.style.right = '143px'
            stage.style.bottom = '97px'
            // A browser pane that is not visible sends no resize observer events.
            window.dispatchEvent(new Event('resize'))
            await followed('Smaller container')
            check('Smaller container')

            stage.style.right = ''
            stage.style.bottom = ''
            window.dispatchEvent(new Event('resize'))
            await followed('First container size again')
            setAppearance({ fontSize: savedAppearance.fontSize })
            await wait(300)
            check('First size again')
        }

        // (f) The page count of each frame is the count from the scroll width.
        if (paged) {
            const box = stage.getBoundingClientRect()
            const geometry = pagedGeometry({
                width: box.width,
                height: box.height,
                margin: appearance.margin,
                columns: appearance.columns,
            })
            for (const host of hosts()) {
                const root = host.shadowRoot?.querySelector('rd-html')
                if (!root) continue
                const fromView = Math.round(host.offsetWidth / geometry.width)
                const fromScroll = pagesOfScrollWidth(root.scrollWidth, geometry)
                // Content that sticks out of its column makes the scroll width larger, and
                // the count from it can then be one page too high.
                const step = geometry.columnWidth + geometry.columnGap
                const sticksOut = (root.scrollWidth + geometry.columnGap) % step !== 0
                if (
                    sticksOut
                        ? fromScroll - fromView > 1 || fromScroll < fromView
                        : fromView !== fromScroll
                ) {
                    const text = (root.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
                    fail('f', `Frame "${text}": ${fromView} pages, scroll width ${fromScroll}.`)
                }
            }
        }

        // (h) Highlights make marks and change no text and no page count.
        {
            const before = position()
            const { chapter, index } = await indexOf(before.visible.spineIndex)
            const from = before.visible.start
            const room = before.visible.end - from
            if (room > 20) {
                const a = Math.min(from + 3, before.visible.end - 2)
                const b = Math.min(a + Math.floor(room / 3), before.visible.end)
                const c = Math.min(a + Math.floor(room / 6), b - 1)
                const d = Math.min(b + Math.floor(room / 6), before.visible.end)
                const spineIndex = before.visible.spineIndex
                highlights = [
                    { id: 'test-1', spineIndex, start: a, end: b, color: 'yellow', hasNote: false },
                    { id: 'test-2', spineIndex, start: c, end: d, color: 'blue', hasNote: true },
                ]
                view.setHighlights(highlights)
                await wait(250)
                const marks = chapter.body.querySelectorAll('mark.rd-hl')
                const ids = new Set([...marks].map((mark) => mark.getAttribute('data-id')))
                if (ids.size !== 2) fail('h', `Marks for ${ids.size} highlights, not for 2.`)
                if (createTextIndex(chapter.body).length !== index.length)
                    fail('h', 'Text changed.')
                const after = position()
                if (after.pageCount !== before.pageCount) {
                    fail('h', `Page count ${before.pageCount} became ${after.pageCount}.`)
                }
                if (compareLocators(after.locator, before.locator) !== 0) fail('h', 'Page moved.')
                highlights = []
                view.setHighlights(highlights)
                await wait(100)
                if (chapter.body.querySelector('mark.rd-hl')) fail('h', 'A mark stayed.')
                if (createTextIndex(chapter.body).length !== index.length)
                    fail('h', 'Text changed.')
            }
        }

        // (i) Scroll view: a chapter that is added above does not move the text.
        if (!paged) {
            const linear = book.spine.filter((item) => item.linear).map((item) => item.index)
            const target = linear[Math.min(3, linear.length - 1)]
            const above = linear[linear.indexOf(target) - 1]
            if (above !== undefined) {
                // A jump to a far chapter and back mounts the target chapter alone.
                await view.goTo({ spineIndex: linear[linear.length - 1], offset: 0 })
                await view.goTo({ spineIndex: target, offset: 0 })
                const { chapter } = await indexOf(target)
                const targetHost = () =>
                    hosts().find((host) => host.shadowRoot?.contains(chapter.root))
                const hasChapterAbove = () => !!targetHost()?.previousElementSibling
                const hostTop = () => chapter.root.getBoundingClientRect().top
                // In a short book the chapter above is there from the start. Then there is
                // nothing to compare.
                if (!hasChapterAbove()) {
                    const before = { locator: position().locator, top: hostTop() }
                    for (let i = 0; i < 60 && !hasChapterAbove(); i++) await wait(50)
                    if (!hasChapterAbove()) {
                        fail('i', 'The chapter above was not added.')
                    } else {
                        await wait(300)
                        const after = { locator: position().locator, top: hostTop() }
                        if (compareLocators(before.locator, after.locator) !== 0) {
                            fail(
                                'i',
                                `Locator ${before.locator.offset} became ${after.locator.offset}.`,
                            )
                        }
                        if (Math.abs(after.top - before.top) > 1.5) {
                            fail('i', `The text moved by ${after.top - before.top} pixels.`)
                        }
                    }
                }
            }
        }

        setAppearance(savedAppearance)
        for (const error of errors) fail('error', String(error))
        return failures
    }

    const harness: Harness = {
        view: first,
        book,
        content,
        mode,
        appearance,
        events,
        log,
        errors,
        timings,
        stage,
        setAppearance,
        setMode,
        inspectPage,
        sweep,
        selfTest,
    }
    window.harness = harness

    // ---- The bar ----

    const modeSelect = byId<HTMLSelectElement>('dev-mode')
    const themeSelect = byId<HTMLSelectElement>('dev-theme')
    const marginSelect = byId<HTMLSelectElement>('dev-margin')
    const columnsSelect = byId<HTMLSelectElement>('dev-columns')
    modeSelect.value = mode
    themeSelect.value = appearance.theme
    marginSelect.value = appearance.margin
    columnsSelect.value = String(appearance.columns)

    byId('dev-prev').addEventListener('click', () => void harness.view.prev())
    byId('dev-next').addEventListener('click', () => void harness.view.next())
    modeSelect.addEventListener('change', () => void setMode(modeSelect.value as LayoutMode))
    themeSelect.addEventListener('change', () =>
        setAppearance({ theme: themeSelect.value as ReadingTheme }),
    )
    byId('dev-font-minus').addEventListener('click', () =>
        setAppearance({ fontSize: Math.max(12, appearance.fontSize - 1) }),
    )
    byId('dev-font-plus').addEventListener('click', () =>
        setAppearance({ fontSize: Math.min(40, appearance.fontSize + 1) }),
    )
    marginSelect.addEventListener('change', () =>
        setAppearance({ margin: marginSelect.value as MarginSize }),
    )
    columnsSelect.addEventListener('change', () => {
        const value = columnsSelect.value
        setAppearance({ columns: value === '1' ? 1 : value === '2' ? 2 : 'auto' })
    })
    window.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight' || event.key === 'PageDown') void harness.view.next()
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') void harness.view.prev()
    })

    await first.ready
    timings.ready = lap()
}

main().catch((error: unknown) => {
    console.error(error)
    const line = document.getElementById('dev-error')
    if (line) line.textContent = String(error)
})

/**
 * With `debug=pointer` in the URL, a line at the top counts the pointer and touch events of the
 * page. A phone has no console, and touch faults do not show in a desktop browser.
 */
function showPointerDebug(): void {
    const line = document.createElement('div')
    line.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:99;padding:50px 8px 4px;font:11px/1.3 ui-monospace,monospace;background:#000c;color:#fff;pointer-events:none;white-space:pre-wrap'
    document.body.append(line)
    const counts: Record<string, number> = {}
    let last = ''
    const render = (): void => {
        const selection = document.getSelection()
        line.textContent =
            Object.entries(counts)
                .map(([type, count]) => `${type}:${count}`)
                .join(' ') +
            `\n${last}\nselection: ${selection?.type ?? 'none'} ranges ${selection?.rangeCount ?? 0}`
    }
    for (const type of [
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'touchstart',
        'touchmove',
        'touchend',
        'touchcancel',
        'gotpointercapture',
        'lostpointercapture',
    ]) {
        window.addEventListener(
            type,
            (event) => {
                counts[type] = (counts[type] ?? 0) + 1
                if (event instanceof PointerEvent && type !== 'pointermove') {
                    const target = event.composedPath()[0]
                    last = `${type} type=${event.pointerType || '(empty)'} primary=${event.isPrimary} button=${event.button} x=${Math.round(event.clientX)} target=${target instanceof Element ? target.localName : String(target)}`
                }
                render()
            },
            { capture: true, passive: true },
        )
    }
    render()
}

if (new URLSearchParams(location.search).get('debug') === 'pointer') showPointerDebug()
