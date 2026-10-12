/**
 * The elements of the speed reader overlay. This file has no playback logic. Each setter
 * writes to the page only when the value changed.
 *
 * Book text goes into Text nodes, never into markup.
 */

import type { PivotParts, RsvpStatus } from '$lib/rsvp'
import { qs, setIcon } from '../../dom'

function icon(name: string, size = ''): string {
    return `<svg class="icon${size}" aria-hidden="true"><use href="#i-${name}" /></svg>`
}

const MARKUP = `
<section class="speed" aria-label="Speed reader" data-status="idle" data-pivot="on">
    <header class="toolbar speed-top">
        <button class="btn btn-quiet speed-done" type="button" aria-label="Back to the book">
            ${icon('arrow-left')}
            <span>Back to the book</span>
        </button>
        <p class="speed-title"></p>
        <button class="icon-btn speed-settings" type="button" aria-label="Speed reader settings"
            aria-haspopup="dialog">
            ${icon('sliders', ' icon-lg')}
        </button>
        <button class="icon-btn speed-fullscreen" type="button" aria-label="Full screen"
            aria-pressed="false" hidden>
            ${icon('maximize', ' icon-lg')}
        </button>
    </header>
    <p class="speed-notice" role="status"></p>
    <div class="speed-stage" role="button" tabindex="0" aria-label="Play or pause">
        <p class="speed-context speed-context-before" aria-hidden="true"></p>
        <div class="speed-focus">
            <p class="speed-word" aria-live="off"><span class="speed-word-before"></span
                ><span class="speed-word-pivot"></span><span class="speed-word-after"></span></p>
        </div>
        <p class="speed-context speed-context-after" aria-hidden="true"></p>
    </div>
    <footer class="speed-bottom">
        <div class="progress progress-thin speed-progress" role="progressbar"
            aria-label="Chapter progress" aria-valuemin="0" aria-valuemax="100"
            aria-valuenow="0"></div>
        <p class="speed-status num"></p>
        <div class="speed-controls">
            <button class="icon-btn speed-rewind" type="button" aria-label="Rewind"
                aria-pressed="false">
                ${icon('rewind', ' icon-lg')}
            </button>
            <button class="icon-btn speed-previous" type="button" aria-label="Previous sentence">
                ${icon('skip-back', ' icon-lg')}
            </button>
            <button class="btn btn-primary speed-play" type="button" aria-label="Play">
                ${icon('play', ' icon-lg')}
            </button>
            <button class="icon-btn speed-next" type="button" aria-label="Next sentence">
                ${icon('skip-forward', ' icon-lg')}
            </button>
            <div class="stepper speed-rate" role="group" aria-label="Speed">
                <button class="stepper-btn speed-slower" type="button" aria-label="Slower">
                    ${icon('minus')}
                </button>
                <output class="stepper-value"></output>
                <button class="stepper-btn speed-faster" type="button" aria-label="Faster">
                    ${icon('plus')}
                </button>
            </div>
        </div>
    </footer>
</section>`

let template: HTMLTemplateElement | undefined

function cloneOverlay(): HTMLElement {
    if (!template) {
        template = document.createElement('template')
        template.innerHTML = MARKUP
    }
    return document.importNode(template.content.firstElementChild as HTMLElement, true)
}

function setAriaDisabled(element: HTMLElement, disabled: boolean): void {
    // aria-disabled keeps the focus on the button. The disabled attribute moves it away.
    if (disabled) element.setAttribute('aria-disabled', 'true')
    else element.removeAttribute('aria-disabled')
}

export interface WpmView {
    wpm: number
    min: number
    max: number
}

export interface FullscreenView {
    supported: boolean
    active: boolean
}

export interface SpeedView {
    readonly root: HTMLElement
    readonly stage: HTMLElement
    readonly doneButton: HTMLButtonElement
    readonly settingsButton: HTMLButtonElement
    readonly fullscreenButton: HTMLButtonElement
    readonly rewindButton: HTMLButtonElement
    readonly previousButton: HTMLButtonElement
    readonly playButton: HTMLButtonElement
    readonly nextButton: HTMLButtonElement
    readonly slowerButton: HTMLButtonElement
    readonly fasterButton: HTMLButtonElement
    /** Null removes the word and the context lines. */
    setWord(parts: PivotParts | null): void
    /** A scale below 1 makes a long word fit. */
    setScale(scale: number): void
    setContext(before: string, after: string): void
    setContextShown(shown: boolean): void
    setPivotShown(shown: boolean): void
    /** Size of the word in CSS pixels. */
    setFontSize(px: number): void
    setStatus(status: RsvpStatus): void
    setRewindDisabled(disabled: boolean): void
    setWpm(view: WpmView): void
    setTitle(title: string): void
    /** Position in the chapter from 0 to 1. */
    setProgress(fraction: number): void
    setStatusText(text: string): void
    /** A short message above the stage. Null removes it. */
    setNotice(text: string | null): void
    setFullscreen(view: FullscreenView): void
}

export function createSpeedView(): SpeedView {
    const root = cloneOverlay()
    const stage = qs('.speed-stage', root)
    const word = qs('.speed-word', root)
    const title = qs('.speed-title', root)
    const notice = qs('.speed-notice', root)
    const contextBefore = qs('.speed-context-before', root)
    const contextAfter = qs('.speed-context-after', root)
    const progress = qs('.speed-progress', root)
    const statusLine = qs('.speed-status', root)
    const wpmOutput = qs('.speed-rate .stepper-value', root)
    const fullscreenButton = qs<HTMLButtonElement>('.speed-fullscreen', root)
    const rewindButton = qs<HTMLButtonElement>('.speed-rewind', root)
    const playButton = qs<HTMLButtonElement>('.speed-play', root)
    const slowerButton = qs<HTMLButtonElement>('.speed-slower', root)
    const fasterButton = qs<HTMLButtonElement>('.speed-faster', root)

    // One Text node for each part. A new word is then a change of data, with no new nodes.
    const text = (selector: string) => qs(selector, root).appendChild(document.createTextNode(''))
    const beforeText = text('.speed-word-before')
    const pivotText = text('.speed-word-pivot')
    const afterText = text('.speed-word-after')
    const contextBeforeText = contextBefore.appendChild(document.createTextNode(''))
    const contextAfterText = contextAfter.appendChild(document.createTextNode(''))

    let transform = ''
    let fontSize = 0
    let progressValue = ''
    let wpm = 0
    let playing: boolean | undefined
    let fullscreen: boolean | undefined

    function write(node: Text, value: string): void {
        if (node.data !== value) node.data = value
    }

    function writeText(element: HTMLElement, value: string): void {
        if (element.textContent !== value) element.textContent = value
    }

    return {
        root,
        stage,
        doneButton: qs<HTMLButtonElement>('.speed-done', root),
        settingsButton: qs<HTMLButtonElement>('.speed-settings', root),
        fullscreenButton,
        rewindButton,
        previousButton: qs<HTMLButtonElement>('.speed-previous', root),
        playButton,
        nextButton: qs<HTMLButtonElement>('.speed-next', root),
        slowerButton,
        fasterButton,

        setWord(parts) {
            write(beforeText, parts?.before ?? '')
            write(pivotText, parts?.pivot ?? '')
            write(afterText, parts?.after ?? '')
            if (parts) return
            // With no word there are no words around it.
            write(contextBeforeText, '')
            write(contextAfterText, '')
        },

        setScale(scale) {
            const next = scale < 1 ? `scale(${scale})` : ''
            if (next === transform) return
            transform = next
            word.style.transform = next
        },

        setContext(before, after) {
            write(contextBeforeText, before)
            write(contextAfterText, after)
        },

        setContextShown(shown) {
            if (contextBefore.hidden !== shown) return
            contextBefore.hidden = !shown
            contextAfter.hidden = !shown
            if (!shown) {
                contextBeforeText.data = ''
                contextAfterText.data = ''
            }
        },

        setPivotShown(shown) {
            const value = shown ? 'on' : 'off'
            if (root.dataset.pivot !== value) root.dataset.pivot = value
        },

        setFontSize(px) {
            if (px === fontSize) return
            fontSize = px
            root.style.setProperty('--speed-word-size', `${px}px`)
        },

        setStatus(status) {
            if (root.dataset.status !== status) root.dataset.status = status
            const isPlaying = status === 'playing'
            if (isPlaying !== playing) {
                playing = isPlaying
                setIcon(qs<SVGElement>('svg', playButton), isPlaying ? 'pause' : 'play')
                playButton.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play')
            }
            rewindButton.setAttribute('aria-pressed', String(status === 'rewinding'))
        },

        setRewindDisabled(disabled) {
            setAriaDisabled(rewindButton, disabled)
        },

        setWpm(view) {
            if (view.wpm === wpm) return
            wpm = view.wpm
            wpmOutput.textContent = `${view.wpm} wpm`
            setAriaDisabled(slowerButton, view.wpm <= view.min)
            setAriaDisabled(fasterButton, view.wpm >= view.max)
        },

        setTitle(value) {
            writeText(title, value)
        },

        setProgress(fraction) {
            const clamped = Math.min(1, Math.max(0, fraction))
            const value = clamped.toFixed(4)
            if (value === progressValue) return
            progressValue = value
            progress.style.setProperty('--value', value)
            progress.setAttribute('aria-valuenow', String(Math.round(clamped * 100)))
        },

        setStatusText(value) {
            writeText(statusLine, value)
        },

        setNotice(value) {
            writeText(notice, value ?? '')
            notice.classList.toggle('is-shown', value !== null && value !== '')
        },

        setFullscreen(view) {
            fullscreenButton.hidden = !view.supported
            if (view.active === fullscreen) return
            fullscreen = view.active
            setIcon(qs<SVGElement>('svg', fullscreenButton), view.active ? 'minimize' : 'maximize')
            // The label stays the same, because the pressed state tells the change.
            fullscreenButton.setAttribute('aria-pressed', String(view.active))
        },
    }
}
