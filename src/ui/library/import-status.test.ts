import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountPage } from '../app/testing/page'
import { createImportStatusView } from './import-status'
import type { ImportStatusView } from './import-status'

let root: HTMLElement
let view: ImportStatusView
let frames: FrameRequestCallback[]

const q = (selector: string) => root.querySelector<HTMLElement>(selector)!
const runFrames = () => {
    for (const frame of frames.splice(0)) frame(0)
}

beforeEach(() => {
    mountPage()
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
        frames.length = 0
    })
    root = document.getElementById('import-status')!
    view = createImportStatusView(root)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('import status', () => {
    it('is a live region that is empty at the start', () => {
        expect(root.getAttribute('aria-live')).toBe('polite')
        // Not role="status": that role reads the full region again for each change.
        expect(root.hasAttribute('role')).toBe(false)
        expect(root.getAttribute('aria-atomic')).toBe('false')
        expect(q('.import-current').hidden).toBe(true)
        expect(root.querySelectorAll('.import-failure')).toHaveLength(0)
    })

    it('shows the file name and the first phase when a file starts', () => {
        view.start({ fileName: 'anna-karenina.epub', position: 1, total: 1 })

        expect(q('.import-current').hidden).toBe(false)
        expect(q('.import-file').textContent).toBe('Adding anna-karenina.epub')
        expect(q('.import-phase').textContent).toBe('Reading the file')
        expect(q('.progress').style.getPropertyValue('--value')).toBe('0')
    })

    it('shows the position when more than one file is in the queue', () => {
        view.start({ fileName: 'b.epub', position: 2, total: 5 })

        expect(q('.import-file').textContent).toBe('Adding b.epub (2 of 5)')
    })

    it('shows the phase in plain words, and done and total for the measure phase', () => {
        view.start({ fileName: 'a.epub', position: 1, total: 1 })

        view.progress({ phase: 'measure', done: 12, total: 258 })
        runFrames()

        expect(q('.import-phase').textContent).toBe('Measuring the chapters')
        expect(q('.import-count').textContent).toBe('12 of 258')
        expect(q('.progress').getAttribute('aria-valuenow')).toBe('33')

        view.progress({ phase: 'save', done: 0, total: 1 })
        runFrames()

        expect(q('.import-phase').textContent).toBe('Saving to the library')
        expect(q('.import-count').textContent).toBe('')
    })

    it('writes one time for each frame, with the last event', () => {
        view.start({ fileName: 'a.epub', position: 1, total: 1 })
        const bar = q('.progress')
        const setProperty = vi.spyOn(bar.style, 'setProperty')

        for (let done = 1; done <= 200; done++) {
            view.progress({ phase: 'measure', done, total: 200 })
        }
        expect(frames).toHaveLength(1)
        expect(setProperty).not.toHaveBeenCalled()

        runFrames()
        expect(setProperty).toHaveBeenCalledTimes(1)
        expect(q('.import-count').textContent).toBe('200 of 200')
    })

    it('keeps the numbers away from the live region text', () => {
        expect(q('.import-progress-text').getAttribute('aria-hidden')).toBe('true')
        expect(q('.import-progress-text').contains(q('.import-count'))).toBe(true)
        expect(q('.import-progress-text').contains(q('.import-file'))).toBe(false)
    })

    it('hides the current file when the queue is idle and drops a late frame', () => {
        view.start({ fileName: 'a.epub', position: 1, total: 1 })
        view.progress({ phase: 'open', done: 1, total: 1 })

        view.idle()
        runFrames()

        expect(q('.import-current').hidden).toBe(true)
    })

    it('adds a message for a file that failed', () => {
        view.fail({
            fileName: 'locked.epub',
            message: 'This book has DRM protection and cannot be opened.',
            detail: null,
        })

        const item = q('.import-failure')
        expect(item.querySelector('.import-failure-file')?.textContent).toBe('locked.epub')
        expect(item.querySelector('.import-failure-message')?.textContent).toBe(
            'This book has DRM protection and cannot be opened.',
        )
        expect(item.querySelector<HTMLElement>('.import-failure-details')?.hidden).toBe(true)
    })

    it('puts the text of an unknown error in a details element', () => {
        view.fail({
            fileName: 'odd.epub',
            message: 'The book was not added.',
            detail: 'Unexpected end of data',
        })

        const details = q('.import-failure-details')
        expect(details.tagName).toBe('DETAILS')
        expect(details.hidden).toBe(false)
        expect(details.querySelector('.import-failure-detail')?.textContent).toBe(
            'Unexpected end of data',
        )
    })

    it('keeps a file name and an error text with markup as text', () => {
        view.fail({
            fileName: '<img src=x onerror=alert(1)>.epub',
            message: 'The book was not added.',
            detail: '<script>alert(1)</script>',
        })

        const item = q('.import-failure')
        expect(item.querySelector('img')).toBeNull()
        expect(item.querySelector('script')).toBeNull()
        expect(item.querySelector('.import-failure-file')?.textContent).toBe(
            '<img src=x onerror=alert(1)>.epub',
        )
    })

    it('keeps the failures when the queue is idle, until the user closes them', () => {
        view.fail({ fileName: 'a.epub', message: 'The book was not added.', detail: null })
        view.fail({ fileName: 'b.epub', message: 'The book was not added.', detail: null })
        view.idle()
        expect(root.querySelectorAll('.import-failure')).toHaveLength(2)

        root.querySelector<HTMLElement>('[data-action="dismiss-failure"]')!.click()

        const left = root.querySelectorAll('.import-failure')
        expect(left).toHaveLength(1)
        expect(left[0].querySelector('.import-failure-file')?.textContent).toBe('b.epub')
    })

    it('moves the focus to the next message when the user closes one with the keyboard', () => {
        for (const fileName of ['a.epub', 'b.epub', 'c.epub']) {
            view.fail({ fileName, message: 'The book was not added.', detail: null })
        }
        const buttons = () => root.querySelectorAll<HTMLElement>('[data-action="dismiss-failure"]')
        const fileOfFocus = () =>
            document.activeElement
                ?.closest('.import-failure')
                ?.querySelector('.import-failure-file')?.textContent

        buttons()[1].focus()
        buttons()[1].click()
        expect(fileOfFocus()).toBe('c.epub')

        // The last message has no next one, so the one before it gets the focus.
        buttons()[1].click()
        expect(fileOfFocus()).toBe('a.epub')
    })

    it('leaves the focus alone when the closed message did not have it', () => {
        view.fail({ fileName: 'a.epub', message: 'The book was not added.', detail: null })
        view.fail({ fileName: 'b.epub', message: 'The book was not added.', detail: null })
        const outside = document.createElement('button')
        document.body.append(outside)
        outside.focus()

        root.querySelector<HTMLElement>('[data-action="dismiss-failure"]')!.click()

        expect(document.activeElement).toBe(outside)
    })
})
