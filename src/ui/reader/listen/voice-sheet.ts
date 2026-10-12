/**
 * The voice sheet of the listen bar: the voice list, the pitch and the word highlight switch.
 *
 * Voice names and language tags come from the browser. They go into the page through
 * textContent only.
 */

import {
    SPEECH_PITCH_MAX,
    SPEECH_PITCH_MIN,
    SPEECH_PITCH_STEP,
    type SettingsStore,
} from '$lib/settings'
import { primaryLanguage, type VoiceInfo } from '$lib/speech'
import { connectDialog, openDialog } from '../../app/dialog'
import { on, qs, qsa, setRangeValue } from '../../dom'
import { cloneVoiceRow, cloneVoiceSheet } from './markup'

export interface VoiceSheetOptions {
    host: HTMLElement
    settings: SettingsStore
    /** Language of the book. Its voices are the first group. */
    language: string | null
    /** The voices in the order of the list. */
    getVoices(): VoiceInfo[]
    /** The id of the voice that speech uses, or null. */
    getSelectedId(): string | null
    /** The user selected a voice. The call is in the task of the click. */
    onSelect(voice: VoiceInfo): void
}

export interface VoiceSheet {
    readonly element: HTMLDialogElement
    /** Opens the sheet. The focus goes back to `opener` when it closes. */
    open(opener: HTMLElement): void
    close(): void
    /** The voices of the browser changed. Draws the list again when the sheet is open. */
    refreshVoices(): void
    /** The settings changed. Shows the selected voice and the values of the controls. */
    syncSettings(): void
    destroy(): void
}

function browserLanguage(): string | null {
    return typeof navigator !== 'undefined' ? navigator.language : null
}

export function createVoiceSheet(options: VoiceSheetOptions): VoiceSheet {
    const { host, settings, getVoices, getSelectedId, onSelect } = options
    const dialog = cloneVoiceSheet()
    const groups = qs('.listen-voice-groups', dialog)
    const bookList = qs('[data-group="book"]', dialog)
    const otherList = qs('[data-group="other"]', dialog)
    const more = qs<HTMLDetailsElement>('.listen-voice-more', dialog)
    const empty = qs('.listen-voice-empty', dialog)
    const pitch = qs<HTMLInputElement>('[data-setting="pitch"]', dialog)
    const pitchValue = qs('.slider-value', dialog)
    const highlightWords = qs<HTMLInputElement>('[data-setting="highlight-words"]', dialog)
    // A book with no language shows the voices for the language of the browser first.
    const firstLanguage = primaryLanguage(options.language) || primaryLanguage(browserLanguage())

    /** The voice of each row. A row has its index in `data-index`. */
    let voices: VoiceInfo[] = []

    pitch.min = String(SPEECH_PITCH_MIN)
    pitch.max = String(SPEECH_PITCH_MAX)
    pitch.step = String(SPEECH_PITCH_STEP)
    connectDialog(dialog)
    host.append(dialog)

    /** The rows that the arrow keys can reach. The rows of a closed group are not in sight. */
    function reachableRows(): HTMLElement[] {
        return qsa('.listen-voice', more.open ? groups : bookList)
    }

    function showPitch(value: number): void {
        pitchValue.textContent = value.toFixed(1)
        setRangeValue(pitch)
    }

    function readSettings(): void {
        const { speech } = settings.get()
        pitch.value = String(speech.pitch)
        showPitch(speech.pitch)
        highlightWords.checked = speech.highlightWords
    }

    /** Marks the selected row and returns it. Only one row takes the Tab key. */
    function markSelected(): HTMLElement | null {
        const selectedId = getSelectedId()
        let selected: HTMLElement | null = null
        for (const row of qsa('.listen-voice', groups)) {
            // Two voices can have the same id. The first one is the voice that speaks.
            const isSelected = !selected && voices[Number(row.dataset.index)]?.id === selectedId
            if (isSelected) selected = row
            row.setAttribute('aria-checked', String(isSelected))
            row.tabIndex = -1
        }
        const reachable = reachableRows()
        const stop = selected && reachable.includes(selected) ? selected : reachable[0]
        if (stop) stop.tabIndex = 0
        return selected
    }

    function drawList(): void {
        const hadFocus = groups.contains(document.activeElement)
        voices = getVoices()
        const book = document.createDocumentFragment()
        const other = document.createDocumentFragment()

        voices.forEach((voice, index) => {
            const row = cloneVoiceRow()
            row.dataset.index = String(index)
            qs('.list-row-title', row).textContent = voice.name
            qs('.list-row-meta', row).textContent = voice.local
                ? `${voice.lang} · On this device`
                : voice.lang
            const isBookVoice =
                firstLanguage !== '' && primaryLanguage(voice.lang) === firstLanguage
            ;(isBookVoice ? book : other).append(row)
        })

        const hasBookVoices = book.childElementCount > 0
        const hasOtherVoices = other.childElementCount > 0
        bookList.replaceChildren(book)
        otherList.replaceChildren(other)
        bookList.hidden = !hasBookVoices
        more.hidden = !hasOtherVoices
        groups.hidden = voices.length === 0
        empty.hidden = voices.length > 0
        // With no voice for the book, the other voices are the list.
        if (!hasBookVoices && hasOtherVoices) more.open = true

        // The selected voice must be in sight.
        const selected = markSelected()
        if (selected && otherList.contains(selected) && !more.open) {
            more.open = true
            markSelected()
        }
        // The row that had the focus is gone.
        if (hadFocus) groups.querySelector<HTMLElement>('.listen-voice[tabindex="0"]')?.focus()
    }

    const removers = [
        on(groups, 'click', (event) => {
            const row = (event.target as Element).closest<HTMLElement>('.listen-voice')
            const voice = row ? voices[Number(row.dataset.index)] : undefined
            if (!row || !voice) return
            onSelect(voice)
            markSelected()
        }),

        on(groups, 'keydown', (event) => {
            const { key } = event
            if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
            const current = (event.target as Element).closest<HTMLElement>('.listen-voice')
            if (!current) return
            const list = reachableRows()
            const index = list.indexOf(current)
            let next = index
            if (key === 'Home') next = 0
            else if (key === 'End') next = list.length - 1
            else if (key === 'ArrowDown') next = Math.min(list.length - 1, index + 1)
            else next = Math.max(0, index - 1)
            event.preventDefault()
            // The arrow keys move the focus only. A new voice speaks at once, so the user
            // selects a voice with Enter or Space.
            list[next]?.focus()
        }),

        // The rows of this group change between in sight and not in sight.
        on(more, 'toggle', () => {
            markSelected()
        }),

        on(pitch, 'input', () => showPitch(Number(pitch.value))),
        // Speech starts the sentence again for each new value, so the change waits for the
        // end of the drag.
        on(pitch, 'change', () => {
            const value = Number(pitch.value)
            if (Number.isFinite(value)) settings.update({ speech: { pitch: value } })
        }),

        on(highlightWords, 'change', () => {
            settings.update({ speech: { highlightWords: highlightWords.checked } })
        }),
    ]

    return {
        element: dialog,

        open(opener) {
            if (dialog.open) return
            readSettings()
            drawList()
            openDialog(dialog, opener)
            // This also moves a selected voice that is far down the list into sight.
            groups.querySelector<HTMLElement>('.listen-voice[aria-checked="true"]')?.focus()
        },

        close() {
            if (dialog.open) dialog.close()
        },

        refreshVoices() {
            if (dialog.open) drawList()
        },

        syncSettings() {
            if (!dialog.open) return
            readSettings()
            markSelected()
        },

        destroy() {
            for (const remove of removers) remove()
            if (dialog.open) dialog.close()
            dialog.remove()
        },
    }
}
