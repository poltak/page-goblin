/**
 * A content loader for the tests of the reader views. It makes chapters from HTML text and
 * keeps them, as the real loader keeps the chapters that are in its cache.
 */

import { buildTextModel, measureChapter } from '$lib/content'
import type { ChapterContent, ContentLoader } from '$lib/content/types'

export interface FakeContentOptions {
    /** The body markup of each spine item. */
    chapters: readonly string[]
    /** Spine indexes whose load rejects. */
    broken?: readonly number[]
}

export interface FakeContent extends ContentLoader {
    /** The number of `load` calls for each spine index. */
    readonly loads: Map<number, number>
}

function makeChapter(spineIndex: number, html: string): ChapterContent {
    const root = document.createElement('rd-html')
    const body = document.createElement('rd-body')
    body.innerHTML = html
    root.appendChild(body)
    const { length, anchors } = measureChapter(body)
    return {
        spineIndex,
        path: `text/chapter-${spineIndex}.xhtml`,
        root,
        body,
        styles: [],
        length,
        anchors,
        lang: null,
        dir: null,
        imagesReady: Promise.resolve(),
    }
}

export function createFakeContent({ chapters, broken = [] }: FakeContentOptions): FakeContent {
    const cache = new Map<number, ChapterContent>()
    const loads = new Map<number, number>()

    function get(spineIndex: number): ChapterContent {
        let chapter = cache.get(spineIndex)
        if (!chapter) {
            chapter = makeChapter(spineIndex, chapters[spineIndex])
            cache.set(spineIndex, chapter)
        }
        return chapter
    }

    return {
        loads,
        bookFonts: [],
        prepare: () => Promise.resolve(),
        load(spineIndex) {
            loads.set(spineIndex, (loads.get(spineIndex) ?? 0) + 1)
            if (chapters[spineIndex] === undefined) {
                return Promise.reject(new RangeError(`The book has no spine item ${spineIndex}.`))
            }
            if (broken.includes(spineIndex)) {
                return Promise.reject(new Error(`Chapter ${spineIndex} is broken.`))
            }
            return Promise.resolve(get(spineIndex))
        },
        loadText: (spineIndex) => Promise.resolve(buildTextModel(get(spineIndex).body)),
        dispose() {
            cache.clear()
        },
    }
}
