/**
 * The reader session: the model of one open book.
 *
 * All dependencies are inputs, so tests can use a fake view and fake storage. `open.ts` has the
 * real wiring.
 */

import { measureChapter, sanitizeDocument } from '$lib/content'
import type { ChapterContent, ContentLoader, TextModel } from '$lib/content/types'
import type { EpubBook } from '$lib/epub/types'
import { ensureFontLoaded, resolveFontStack } from '$lib/fonts'
import type {
    Appearance,
    HighlightMark,
    LinkTarget,
    ReaderView,
    ReaderViewCallbacks,
    ReaderViewOptions,
    RelocateInfo,
} from '$lib/reader/types'
import { resolveTheme, toAppearance } from '$lib/settings'
import type { SettingsStore } from '$lib/settings'
import { bookFraction, createId, locateFraction, wordsRemaining } from '$lib/storage'
import type {
    BookmarkRecord,
    BookRecord,
    HighlightRecord,
    LibraryStorage,
    ProgressRecord,
} from '$lib/storage/types'
import { compareLocators, isLocatorInRange } from '$lib/types'
import type { LayoutMode, Locator, TextRange } from '$lib/types'
import type {
    NewHighlight,
    ReaderMode,
    ReaderSession,
    ReaderSessionEvents,
    SearchOptions,
    TocEntry,
} from '../types'
import { createBackStack } from './back-stack'
import { createEmitter, reportAsync } from './emitter'
import { collapseWhitespace, leadingExcerpt } from './excerpt'
import { extractNote } from './note'
import { nextAverage, readingSample, SPEED_WRITE_INTERVAL_MS } from './reading-speed'
import type { SpeedPoint } from './reading-speed'
import { buildSearchPattern, runSearch } from './search'
import { buildToc, createTocIndex } from './toc'

/** Time with no relocate before the position goes to storage. */
export const PROGRESS_SAVE_DELAY_MS = 800

/** The message of the error that `addHighlight` rejects with after `destroy()`. */
export const HIGHLIGHT_CLOSED_MESSAGE = 'The book is closed, so the highlight was not saved.'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

type TimerHandle = ReturnType<typeof setTimeout>

export interface SessionTimers {
    setTimeout(callback: () => void, delay: number): TimerHandle
    clearTimeout(handle: TimerHandle): void
}

export type SessionStorage = Pick<
    LibraryStorage,
    | 'saveProgress'
    | 'putBookmark'
    | 'deleteBookmark'
    | 'putHighlight'
    | 'deleteHighlight'
    | 'listBookmarks'
    | 'listHighlights'
>

export interface ReaderSessionDeps {
    record: BookRecord
    book: EpubBook
    /** The session disposes the loader in `destroy()`. Call `prepare()` before. */
    content: ContentLoader
    storage: SessionStorage
    /** The element that the reader view fills. */
    container: HTMLElement
    settings: SettingsStore
    createView(mode: LayoutMode, options: ReaderViewOptions): ReaderView
    /** The saved position, when the book has one. */
    initialProgress?: ProgressRecord | null
    bookmarks: readonly BookmarkRecord[]
    highlights: readonly HighlightRecord[]
    /** True when the system prefers a dark colour scheme now. */
    systemDark(): boolean
    /** Calls the listener after each change. Returns the function that stops the watch. */
    watchSystemTheme(listener: (systemDark: boolean) => void): () => void
    /** Epoch milliseconds. */
    now(): number
    timers?: SessionTimers
}

// The functions read the globals at each call, so that fake timers of a test apply.
const DEFAULT_TIMERS: SessionTimers = {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
}

function compareBookmarks(a: BookmarkRecord, b: BookmarkRecord): number {
    return compareLocators(a.locator, b.locator) || a.createdAt - b.createdAt
}

function compareHighlights(a: HighlightRecord, b: HighlightRecord): number {
    return (
        a.spineIndex - b.spineIndex ||
        a.start - b.start ||
        a.end - b.end ||
        a.createdAt - b.createdAt
    )
}

function toMark(highlight: HighlightRecord): HighlightMark {
    return {
        id: highlight.id,
        spineIndex: highlight.spineIndex,
        start: highlight.start,
        end: highlight.end,
        color: highlight.color,
        hasNote: highlight.note !== '',
    }
}

function sameAppearance(a: Appearance, b: Appearance): boolean {
    for (const key of Object.keys(a) as (keyof Appearance)[]) {
        if (a[key] !== b[key]) return false
    }
    return true
}

function pageHidden(): boolean {
    return document.visibilityState === 'hidden'
}

export function createReaderSession(deps: ReaderSessionDeps): ReaderSession {
    const { record, book, content, storage, container, settings, now } = deps
    const timers = deps.timers ?? DEFAULT_TIMERS
    const emitter = createEmitter<ReaderSessionEvents>()
    const toc: readonly TocEntry[] = Object.freeze(buildToc(book))
    const tocIndex = createTocIndex(toc)
    const backStack = createBackStack()
    const teardown = new AbortController()
    /** Text lengths of chapters, from relocate events and from text loads. */
    const chapterLengths = new Map<number, number>()
    /** Spine items whose anchor offsets are on their way. */
    const anchorLoads = new Set<number>()
    /** Error objects that the 'error' event already had. */
    const sentErrors = new WeakSet<object>()
    const initial = startLocator()

    let destroyed = false
    let destroyPromise: Promise<void> | undefined
    let mode: ReaderMode = 'read'
    let position: RelocateInfo | null = null
    let bookmarks: readonly BookmarkRecord[] = [...deps.bookmarks].sort(compareBookmarks)
    let highlights: readonly HighlightRecord[] = [...deps.highlights].sort(compareHighlights)
    let hasSelection = false
    /** The place where the last move of the progress slider ended, or null. */
    let sliderLanding: Locator | null = null
    /** More than 0 while a move of the progress slider runs. */
    let sliderMoves = 0
    /** Annotation changes run one after the other, so that two fast taps do not mix. */
    let annotationWork: Promise<unknown> = Promise.resolve()

    let systemDark = deps.systemDark()
    let layout = settings.get().layout
    let appearance = currentAppearance()
    /** Goes up with each new view. Callbacks of an older view do nothing. */
    let viewGeneration = 0

    /** The position that goes to storage. It is not always the first visible character. */
    let savedLocator: Locator = initial
    let progressDirty = false
    let progressTimer: TimerHandle | undefined
    let progressWrites = 0
    /** The last write to storage. It never rejects. */
    let progressWrite: Promise<void> = Promise.resolve()
    let progressErrorSent = false

    let searchId = 0
    let searchRanges: readonly TextRange[] = []

    let speedPoint: SpeedPoint | null = null
    /** True when the time since `speedPoint` is not only reading time. */
    let speedInterrupted = false
    let speedAverage = settings.get().readingWpm
    let speedDirty = false
    let speedWrittenAt = Number.NEGATIVE_INFINITY

    void ensureFontLoaded(settings.get().fontId)
    let view = makeView(initial)

    const stopSettings = settings.subscribe((next, previous) => {
        if (destroyed) return
        if (next.fontId !== previous.fontId) void ensureFontLoaded(next.fontId)
        if (next.layout !== layout) switchLayout(next.layout)
        else refreshAppearance()
    })
    const stopSystemTheme = deps.watchSystemTheme((dark) => {
        if (destroyed) return
        systemDark = dark
        refreshAppearance()
    })

    // A mobile browser can stop a hidden page with no more events, so these two events are
    // the last safe moments to save.
    window.addEventListener('pagehide', () => void flushProgress(), { signal: teardown.signal })
    document.addEventListener(
        'visibilitychange',
        () => {
            if (!pageHidden()) return
            speedInterrupted = true
            void flushProgress()
        },
        { signal: teardown.signal },
    )

    function startLocator(): Locator {
        const saved = deps.initialProgress?.locator
        if (saved && Number.isInteger(saved.spineIndex) && book.spine[saved.spineIndex]) {
            const offset = saved.offset > 0 && Number.isFinite(saved.offset) ? saved.offset : 0
            return { spineIndex: saved.spineIndex, offset: Math.floor(offset) }
        }
        return { spineIndex: book.spine.find((item) => item.linear)?.index ?? 0, offset: 0 }
    }

    function emitError(error: unknown): void {
        if (typeof error === 'object' && error !== null) {
            // The view can report an error and also reject the promise of the same request.
            if (sentErrors.has(error)) return
            sentErrors.add(error)
        }
        emitter.emit('error', error)
    }

    // Appearance and views

    function currentAppearance(): Appearance {
        const current = settings.get()
        return toAppearance({
            settings: current,
            resolvedTheme: resolveTheme({
                theme: current.theme,
                darkTheme: current.darkTheme,
                systemDark,
            }),
            fontFamily: resolveFontStack({
                fontId: current.fontId,
                bookFonts: content.bookFonts,
            }),
        })
    }

    function refreshAppearance(): void {
        const next = currentAppearance()
        if (sameAppearance(next, appearance)) return
        appearance = next
        view.setAppearance(next)
    }

    function makeView(locator: Locator): ReaderView {
        const generation = ++viewGeneration
        const live = (): boolean => !destroyed && generation === viewGeneration
        const callbacks: ReaderViewCallbacks = {
            onRelocate(info) {
                if (live()) handleRelocate(info)
            },
            onCenterTap() {
                if (live()) emitter.emit('center-tap', undefined)
            },
            onSelection(selection) {
                if (!live()) return
                hasSelection = selection !== null
                emitter.emit('selection', selection)
            },
            onHighlightTap(id, bounds) {
                if (!live()) return
                const highlight = highlights.find((item) => item.id === id)
                if (highlight) emitter.emit('highlight-tap', { highlight, bounds })
            },
            onLink(target) {
                if (!live()) return
                // The screen shows a note in a popover, so the reader stays on the page.
                if (target.kind === 'internal' && target.noteref && target.spineIndex >= 0) {
                    emitter.emit('note-tap', { target })
                    return
                }
                followLink(target).catch(emitError)
            },
            onImageTap(image) {
                if (live()) emitter.emit('image-tap', image)
            },
            onError(error) {
                if (live()) emitError(error)
            },
        }
        return deps.createView(layout, {
            container,
            book,
            content,
            appearance,
            initial: locator,
            highlights: highlights.map(toMark),
            callbacks,
        })
    }

    /** The selection was in a view that is gone. */
    function dropSelection(): void {
        if (!hasSelection) return
        hasSelection = false
        emitter.emit('selection', null)
    }

    function switchLayout(next: LayoutMode): void {
        const locator = position?.locator ?? initial
        view.destroy()
        layout = next
        appearance = currentAppearance()
        let created: ReaderView
        try {
            created = makeView(locator)
        } catch (error) {
            // The session has no view that works now. The next change of the layout setting
            // makes a view again. The error must not go to the code that changed the setting.
            dropSelection()
            emitError(error)
            return
        }
        view = created
        if (searchRanges.length > 0) created.setSearchRanges(searchRanges)
        created.ready.catch((error: unknown) => {
            if (!destroyed && view === created) emitError(error)
        })
        dropSelection()
        emitter.emit('view', created)
    }

    // Position

    /**
     * The position to save for a relocate.
     *
     * The paged view makes its pages again when a font of the book loads or the window gets a
     * new size. The page that has the saved position can then start at an earlier character.
     * If that character were saved, a book that the user closes in that moment would open on
     * the page before at the next open, and one more page back each time. So the saved
     * position stays while it is on the visible page. A page turn or a jump shows text that
     * does not have it.
     *
     * The scroll view keeps its first line in a new layout, and a short scroll up shows the
     * saved position lower on the same screen. Its first visible character is always saved.
     */
    function progressLocator(info: RelocateInfo): Locator {
        if (info.page !== null && isLocatorInRange(savedLocator, info.visible)) return savedLocator
        return info.locator
    }

    function handleRelocate(info: RelocateInfo): void {
        position = info
        const next = progressLocator(info)
        // The open of a book and a new layout send a relocate at the same place. A write would
        // give the record a new time, and the restore of a backup would then keep it.
        // A listener can destroy the session, and destroy() must then write a new position.
        if (compareLocators(next, savedLocator) !== 0) progressDirty = true
        savedLocator = next
        chapterLengths.set(info.locator.spineIndex, info.chapterLength)
        emitter.emit('relocate', info)
        if (destroyed) return
        if (progressDirty) scheduleProgressSave()
        measureSpeed(info)
        loadAnchors(info.locator.spineIndex)
    }

    /** The text length of a chapter, or the estimate of the import when the text was never loaded. */
    function lengthOf(spineIndex: number): number {
        return chapterLengths.get(spineIndex) ?? record.spineStats[spineIndex]?.chars ?? 0
    }

    function chapterFractionOf(locator: Locator): number {
        const length = lengthOf(locator.spineIndex)
        // The comparison is false for NaN.
        if (!(length > 0 && locator.offset > 0)) return 0
        return Math.min(1, locator.offset / length)
    }

    function fractionOf(locator: Locator): number {
        return bookFraction({
            spineStats: record.spineStats,
            spineIndex: locator.spineIndex,
            chapterFraction: chapterFractionOf(locator),
        })
    }

    function currentFraction(): number {
        if (!position) return fractionOf(initial)
        // The locator is the start of the last page, so without this rule a book that the user
        // read to the end would never show 100 percent.
        return position.atBookEnd ? 1 : fractionOf(position.locator)
    }

    function loadText(spineIndex: number): Promise<TextModel> {
        return content.loadText(spineIndex).then((model) => {
            chapterLengths.set(spineIndex, model.text.length)
            return model
        })
    }

    // Progress

    function scheduleProgressSave(): void {
        progressDirty = true
        if (pageHidden()) {
            // Speech can turn the page of a hidden tab. A browser slows the timers of such a
            // tab and can stop it with no event.
            void writeProgress()
            return
        }
        if (progressTimer !== undefined) timers.clearTimeout(progressTimer)
        progressTimer = timers.setTimeout(() => {
            progressTimer = undefined
            void writeProgress()
        }, PROGRESS_SAVE_DELAY_MS)
    }

    /** Never rejects. The storage request starts before the function returns. */
    function writeProgress(): Promise<void> {
        if (progressTimer !== undefined) {
            timers.clearTimeout(progressTimer)
            progressTimer = undefined
        }
        if (!position) return Promise.resolve()

        progressDirty = false
        const write = ++progressWrites
        const { spineIndex, offset } = savedLocator
        const progress: ProgressRecord = {
            bookId: record.id,
            locator: { spineIndex, offset },
            // The same rule as for the fraction that the screen shows.
            fraction: position.atBookEnd ? 1 : fractionOf(savedLocator),
            updatedAt: now(),
        }
        let saved: Promise<void>
        try {
            saved = storage.saveProgress(progress)
        } catch (error) {
            saved = Promise.reject(error)
        }
        progressWrite = saved.catch((error: unknown) => {
            // The next trigger tries again, but not when a newer write is on its way.
            if (write === progressWrites) progressDirty = true
            if (progressErrorSent || destroyed) return
            progressErrorSent = true
            emitError(new Error('The reading position could not be saved.', { cause: error }))
        })
        return progressWrite
    }

    /** Resolves when the last position is in storage, or when its write failed. */
    function flushProgress(): Promise<void> {
        return progressDirty ? writeProgress() : progressWrite
    }

    // Reading speed

    function measureSpeed(info: RelocateInfo): void {
        const previous = speedPoint
        if (previous && compareLocators(previous.locator, info.locator) === 0) {
            // The layout changed at the same place. The user reads on from the same start time.
            speedPoint = { ...previous, visible: info.visible }
            return
        }

        const time = now()
        const stats = record.spineStats[info.locator.spineIndex]
        const sample = readingSample({
            previous,
            next: { locator: info.locator, time },
            mode,
            visible: !speedInterrupted && !pageHidden(),
            // Offsets count the text as written. The estimate of the import counts each run
            // of white space as one character, so its number can be much smaller, and the
            // speed would be too high.
            stats:
                stats && info.chapterLength > 0
                    ? { words: stats.words, chars: info.chapterLength }
                    : stats,
        })
        speedPoint = { locator: info.locator, visible: info.visible, time }
        speedInterrupted = pageHidden()
        if (sample === null) return

        speedAverage = nextAverage(speedAverage, sample)
        speedDirty = true
        if (time - speedWrittenAt >= SPEED_WRITE_INTERVAL_MS) writeSpeed(time)
    }

    function writeSpeed(time: number): void {
        speedDirty = false
        speedWrittenAt = time
        try {
            settings.update({ readingWpm: Math.round(speedAverage) })
        } catch (error) {
            // The error is from a different listener of the settings.
            reportAsync(error)
        }
    }

    // Contents

    function currentTocEntry(): TocEntry | null {
        return position ? tocIndex.find(position.locator) : null
    }

    function chapterTitleAt(locator: Locator): string {
        return tocIndex.find(locator)?.title ?? ''
    }

    function setAnchors(spineIndex: number, anchors: ReadonlyMap<string, number>): void {
        if (!tocIndex.needsAnchors(spineIndex)) return
        const before = currentTocEntry()
        tocIndex.setAnchors(spineIndex, anchors)
        // The screen reads the chapter title on 'relocate', and the title is different now.
        if (position && currentTocEntry() !== before) emitter.emit('relocate', position)
    }

    function applyAnchors(chapter: ChapterContent): void {
        setAnchors(chapter.spineIndex, chapter.anchors)
    }

    /**
     * Reads the fragment offsets of a chapter that is not shown, for the titles of its search
     * results. `content.load()` is not used here, because it also gets the images and styles
     * and can remove a chapter of the view from the loader cache. Never rejects.
     */
    async function readAnchors(spineIndex: number): Promise<void> {
        const item = book.spine[spineIndex]
        if (!item || !tocIndex.needsAnchors(spineIndex)) return
        try {
            const xhtml = await book.readText(item.path)
            if (destroyed || !tocIndex.needsAnchors(spineIndex)) return
            // The loader measures a chapter in the same way, so the offsets are the same.
            const { body } = sanitizeDocument({ xhtml, path: item.path, book })
            setAnchors(spineIndex, measureChapter(body).anchors)
        } catch {
            // The titles then use the chapter start as the place of each entry.
        }
    }

    /** Gets the fragment offsets of the contents entries for the chapter that is shown. */
    function loadAnchors(spineIndex: number): void {
        if (!tocIndex.needsAnchors(spineIndex) || anchorLoads.has(spineIndex)) return
        anchorLoads.add(spineIndex)
        content.load(spineIndex).then(
            (chapter) => {
                anchorLoads.delete(spineIndex)
                if (!destroyed) applyAnchors(chapter)
            },
            () => {
                // The next relocate in this chapter tries again.
                anchorLoads.delete(spineIndex)
            },
        )
    }

    // Navigation

    function remember(): void {
        if (position) backStack.push(position.locator)
    }

    function openExternal(url: string): void {
        let protocol = ''
        try {
            protocol = new URL(url).protocol
        } catch {
            // Not an absolute URL.
        }
        if (!EXTERNAL_PROTOCOLS.has(protocol)) {
            emitError(new Error('This link cannot be opened.'))
            return
        }
        window.open(url, '_blank', 'noopener,noreferrer')
    }

    async function followLink(target: LinkTarget): Promise<void> {
        if (destroyed) return
        if (target.kind === 'external') {
            openExternal(target.url)
            return
        }
        if (!book.spine[target.spineIndex]) {
            emitError(new Error('This link points to a file that is not in the book.'))
            return
        }
        remember()
        await view.goToAnchor(target.spineIndex, target.fragment)
    }

    async function goToFraction(fraction: number): Promise<void> {
        if (destroyed) return
        const { spineIndex, chapterFraction } = locateFraction({
            spineStats: record.spineStats,
            fraction,
        })
        if (!book.spine[spineIndex]) return
        const offset = Math.round(chapterFraction * lengthOf(spineIndex))
        // The user often moves the slider some times to find a place. Only the position
        // before the first move is remembered, so one step back returns to the page that the
        // user left.
        const inRun =
            sliderMoves > 0 ||
            (sliderLanding !== null &&
                position !== null &&
                compareLocators(position.locator, sliderLanding) === 0)
        if (!inRun) remember()
        sliderMoves++
        try {
            await view.goTo({ spineIndex, offset })
        } finally {
            sliderMoves--
            sliderLanding = position?.locator ?? null
        }
    }

    // Bookmarks and highlights

    function queueAnnotation<T>(work: () => Promise<T>): Promise<T> {
        const result = annotationWork.then(work)
        annotationWork = result.catch(() => {})
        return result
    }

    function bookmarksAt(at: RelocateInfo): BookmarkRecord[] {
        return bookmarks.filter(
            (bookmark) =>
                isLocatorInRange(bookmark.locator, at.visible) ||
                // A page with no text has an empty range.
                compareLocators(bookmark.locator, at.locator) === 0,
        )
    }

    function setBookmarks(next: readonly BookmarkRecord[]): void {
        bookmarks = next
        emitter.emit('bookmarks', next)
    }

    function setHighlights(next: readonly HighlightRecord[]): void {
        highlights = next
        if (destroyed) return
        view.setHighlights(next.map(toMark))
        emitter.emit('highlights', next)
    }

    async function excerptAt(locator: Locator): Promise<string> {
        try {
            return leadingExcerpt({
                model: await loadText(locator.spineIndex),
                offset: locator.offset,
            })
        } catch {
            // A bookmark with no excerpt is better than no bookmark.
            return ''
        }
    }

    async function removeBookmarks(targets: readonly BookmarkRecord[]): Promise<void> {
        const removed = new Set<string>()
        try {
            for (const bookmark of targets) {
                await storage.deleteBookmark(bookmark.id)
                removed.add(bookmark.id)
            }
        } finally {
            // When one delete fails, the list still agrees with storage.
            if (removed.size > 0) {
                setBookmarks(bookmarks.filter((bookmark) => !removed.has(bookmark.id)))
            }
        }
    }

    function toggleBookmark(): Promise<void> {
        const at = position
        if (destroyed || !at) return Promise.resolve()
        return queueAnnotation(async () => {
            if (destroyed) return
            const visible = bookmarksAt(at)
            if (visible.length > 0) {
                await removeBookmarks(visible)
                return
            }

            const locator: Locator = {
                spineIndex: at.locator.spineIndex,
                offset: at.locator.offset,
            }
            const excerpt = await excerptAt(locator)
            if (destroyed) return
            const bookmark: BookmarkRecord = {
                id: createId(),
                bookId: record.id,
                locator,
                fraction: fractionOf(locator),
                chapterTitle: chapterTitleAt(locator),
                excerpt,
                createdAt: now(),
            }
            await storage.putBookmark(bookmark)
            setBookmarks([...bookmarks, bookmark].sort(compareBookmarks))
        })
    }

    function removeBookmark(id: string): Promise<void> {
        if (destroyed) return Promise.resolve()
        return queueAnnotation(async () => {
            const bookmark = bookmarks.find((item) => item.id === id)
            if (destroyed || !bookmark) return
            await removeBookmarks([bookmark])
        })
    }

    function newHighlightRecord({ range, text, color, note }: NewHighlight): HighlightRecord {
        const start: Locator = { spineIndex: range.spineIndex, offset: range.start }
        const time = now()
        return {
            id: createId(),
            bookId: record.id,
            spineIndex: range.spineIndex,
            start: range.start,
            end: range.end,
            text: collapseWhitespace(text).trim(),
            color,
            note: note ?? '',
            chapterTitle: chapterTitleAt(start),
            fraction: fractionOf(start),
            createdAt: time,
            updatedAt: time,
        }
    }

    /**
     * Rejects with an Error that has the message `HIGHLIGHT_CLOSED_MESSAGE` when the session is
     * destroyed before the write starts. A resolved promise always has a record that is in
     * storage, so the caller can tell the user about a highlight that was not saved.
     */
    function addHighlight(highlight: NewHighlight): Promise<HighlightRecord> {
        // A destroyed session stores nothing.
        if (destroyed) return Promise.reject(new Error(HIGHLIGHT_CLOSED_MESSAGE))
        const created = newHighlightRecord(highlight)
        return queueAnnotation(async () => {
            if (destroyed) throw new Error(HIGHLIGHT_CLOSED_MESSAGE)
            await storage.putHighlight(created)
            setHighlights([...highlights, created].sort(compareHighlights))
            if (!destroyed) view.clearSelection()
            return created
        })
    }

    function updateHighlight(
        id: string,
        patch: { color?: HighlightRecord['color']; note?: string },
    ): Promise<void> {
        if (destroyed) return Promise.resolve()
        return queueAnnotation(async () => {
            const current = highlights.find((item) => item.id === id)
            if (destroyed || !current) return
            const color = patch.color ?? current.color
            const note = patch.note ?? current.note
            if (color === current.color && note === current.note) return
            const updated: HighlightRecord = { ...current, color, note, updatedAt: now() }
            await storage.putHighlight(updated)
            setHighlights(highlights.map((item) => (item.id === id ? updated : item)))
        })
    }

    function removeHighlight(id: string): Promise<void> {
        if (destroyed) return Promise.resolve()
        return queueAnnotation(async () => {
            if (destroyed || !highlights.some((item) => item.id === id)) return
            await storage.deleteHighlight(id)
            setHighlights(highlights.filter((item) => item.id !== id))
        })
    }

    function reloadAnnotations(): Promise<void> {
        if (destroyed) return Promise.resolve()
        return queueAnnotation(async () => {
            const [nextBookmarks, nextHighlights] = await Promise.all([
                storage.listBookmarks(record.id),
                storage.listHighlights(record.id),
            ])
            if (destroyed) return
            setBookmarks(nextBookmarks)
            setHighlights(nextHighlights)
        })
    }

    // Search

    function setSearchRanges(ranges: readonly TextRange[]): void {
        if (ranges.length === 0 && searchRanges.length === 0) return
        searchRanges = ranges
        if (!destroyed) view.setSearchRanges(ranges)
    }

    async function search({ query, signal, onResults, onProgress }: SearchOptions): Promise<void> {
        if (destroyed) return
        // A new search replaces the one that runs.
        const id = ++searchId
        setSearchRanges([])
        const pattern = buildSearchPattern(query)
        if (!pattern || signal.aborted) return

        const ranges = await runSearch({
            pattern,
            spine: book.spine,
            loadText,
            isActive: () => !destroyed && id === searchId && !signal.aborted,
            prepareTitles: readAnchors,
            titleAt: chapterTitleAt,
            onResults,
            onProgress,
        })
        if (ranges) setSearchRanges(ranges)
    }

    function clearSearch(): void {
        if (destroyed) return
        searchId++
        setSearchRanges([])
    }

    // Notes

    async function loadNote(target: {
        spineIndex: number
        fragment: string | null
    }): Promise<{ element: HTMLElement; styles: readonly CSSStyleSheet[] } | null> {
        if (destroyed || target.fragment === null || !book.spine[target.spineIndex]) return null
        let chapter: ChapterContent
        try {
            chapter = await content.load(target.spineIndex)
        } catch {
            // The screen then follows the link, and the view reports the chapter that failed.
            return null
        }
        if (destroyed) return null
        applyAnchors(chapter)
        const element = extractNote(chapter.body, target.fragment)
        return element ? { element, styles: chapter.styles } : null
    }

    // Life cycle

    function destroy(): Promise<void> {
        if (destroyPromise) return destroyPromise
        // The write starts first, while the position is still known.
        const saved = flushProgress()
        destroyed = true
        destroyPromise = saved
        searchId++
        viewGeneration++
        if (speedDirty) writeSpeed(now())
        teardown.abort()
        stopSettings()
        stopSystemTheme()
        emitter.clear()
        backStack.clear()
        // An error of one step must not stop the other step, and destroy() must not throw.
        for (const release of [() => view.destroy(), () => content.dispose()]) {
            try {
                release()
            } catch (error) {
                reportAsync(error)
            }
        }
        return saved
    }

    return {
        record,
        book,
        content,
        toc,
        get view() {
            return view
        },
        get position() {
            return position
        },
        get mode() {
            return mode
        },
        get bookmarks() {
            return bookmarks
        },
        get highlights() {
            return highlights
        },

        on(event, listener) {
            return destroyed ? () => {} : emitter.on(event, listener)
        },

        setMode(next) {
            if (destroyed || next === mode) return
            mode = next
            // The time in a different mode is not reading time of the page.
            speedInterrupted = true
            emitter.emit('mode', next)
        },

        async next() {
            return destroyed ? false : view.next()
        },
        async prev() {
            return destroyed ? false : view.prev()
        },
        async goTo(locator, options) {
            if (destroyed) return
            if (options?.remember) remember()
            await view.goTo(locator)
        },
        async goToTocEntry(entry) {
            if (destroyed || !book.spine[entry.spineIndex]) return
            remember()
            await view.goToAnchor(entry.spineIndex, entry.fragment)
        },
        goToFraction,
        followLink,
        get canGoBack() {
            return backStack.size > 0
        },
        async back() {
            const locator = destroyed ? undefined : backStack.pop()
            if (locator) await view.goTo(locator)
        },

        fractionOf,
        get fraction() {
            return currentFraction()
        },
        get currentTocEntry() {
            return currentTocEntry()
        },
        chapterTitleAt,
        get wordsRemaining() {
            if (!position) return null
            return wordsRemaining({
                spineStats: record.spineStats,
                spineIndex: position.locator.spineIndex,
                chapterFraction: chapterFractionOf(position.locator),
            })
        },

        get isBookmarked() {
            return position !== null && bookmarksAt(position).length > 0
        },
        toggleBookmark,
        removeBookmark,

        addHighlight,
        updateHighlight,
        removeHighlight,
        reloadAnnotations,

        search,
        clearSearch,
        loadNote,

        saveProgress() {
            return destroyed ? Promise.resolve() : writeProgress()
        },
        destroy,
    }
}
