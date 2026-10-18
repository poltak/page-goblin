/**
 * The sheet of the fonts that the user added. The reading settings panel loads this file when
 * the user opens the sheet for the first time, with the code that reads font files.
 *
 * The sheet adds, renames and removes fonts through the font registry of the session.
 */

import { resolveFontStack, USER_FONT_PREFIX } from '$lib/fonts'
import { faceLabel, planFontImport, readFontFile } from '$lib/fonts/import'
import type { FontFile, FontFileProblem } from '$lib/fonts/import'
import { settings as appSettings } from '$lib/settings'
import type { SettingsStore } from '$lib/settings'
import { createId } from '$lib/storage/crypto'
import { isQuotaError } from '$lib/storage/storage-info'
import type { FontRecord } from '$lib/storage/types'
import { connectDialog, openDialog } from '../../app/dialog'
import { on, qs } from '../../dom'
import type { PartOptions } from '../parts'
import markup from './fonts.html?raw'
import {
    createKeyedList,
    createNotice,
    parseMarkup,
    renderKeepingFocus,
    rowFactory,
} from './shared'
import './fonts.css'

const template = parseMarkup(markup)
const makeFontRow = rowFactory(template, 'font')
const makeProblemRow = rowFactory(template, 'problem')

export interface FontSheetOptions extends PartOptions {
    /** The store that the sheet writes when an import adds a font. The default is the store of the app. */
    settings?: SettingsStore
    /** Epoch milliseconds. The default is `Date.now`. */
    now?: () => number
}

export interface FontSheet {
    open(opener?: Element | null): void
    close(): void
    destroy(): void
}

function stylesText(record: FontRecord): string {
    return record.faces.map(faceLabel).join(', ')
}

function importMessage(added: readonly FontRecord[], duplicates: number): string | null {
    if (added.length === 1) return `Added ${added[0].name}`
    if (added.length > 1) return `Added ${added.length} fonts`
    if (duplicates > 0) return 'These files are already in your fonts.'
    return null
}

export function createFontSheet(options: FontSheetOptions): FontSheet {
    const { session, host } = options
    const store = options.settings ?? appSettings
    const now = options.now ?? Date.now
    const fonts = session.fonts

    const root = document.importNode(template, true)
    const dialog = qs<HTMLDialogElement>('.fonts-panel', root)
    const body = qs('.sheet-body', dialog)
    const addButton = qs<HTMLButtonElement>('[data-action="add"]', dialog)
    const addLabel = qs('[data-label]', addButton)
    const input = qs<HTMLInputElement>('.fonts-input', dialog)
    const problemBox = qs('.fonts-problems', dialog)
    const problemList = qs('.fonts-problem-list', dialog)
    const list = qs('.fonts-list', dialog)
    const empty = qs('.empty-state', dialog)
    const notice = createNotice(dialog)

    /** The family that gets the next chosen files, or null for new families. */
    let target: string | null = null
    let busy = false
    let destroyed = false
    let editing: string | null = null

    const keyed = createKeyedList<FontRecord>({
        list,
        key: (record) => record.id,
        create: makeFontRow,
        fill(row, record) {
            const name = qs('.fonts-row-name', row)
            // The name is text from a font file.
            name.textContent = record.name
            name.style.fontFamily =
                resolveFontStack({
                    fontId: USER_FONT_PREFIX + record.id,
                    bookFonts: [],
                    userFonts: [record],
                }) ?? ''
            qs('.fonts-row-styles', row).textContent = stylesText(record)
            for (const [action, label] of [
                ['rename', 'Rename'],
                ['styles', 'Add styles to'],
                ['remove', 'Remove'],
            ]) {
                qs(`[data-action="${action}"]`, row).setAttribute(
                    'aria-label',
                    `${label} ${record.name}`,
                )
            }
        },
    })

    function render(): void {
        const records = fonts.list
        renderKeepingFocus({ list, render: () => keyed.render(records), fallback: addButton })
        list.hidden = records.length === 0
        empty.hidden = records.length > 0
        if (editing && !records.some((record) => record.id === editing)) editing = null
    }

    /** Loads each font, so its name shows in its own font. Only while the sheet is open. */
    function loadSamples(): void {
        for (const record of fonts.list) void fonts.ensureLoaded(USER_FONT_PREFIX + record.id)
    }

    function showProblems(problems: readonly FontFileProblem[]): void {
        problemList.replaceChildren(
            ...problems.map(({ fileName, message }) => {
                const row = makeProblemRow()
                // The file name is text from the device of the user.
                qs('.fonts-problem-file', row).textContent = fileName
                qs('.fonts-problem-text', row).textContent = message
                return row
            }),
        )
        problemBox.hidden = problems.length === 0
    }

    function setBusy(next: boolean): void {
        busy = next
        addButton.setAttribute('aria-disabled', String(next))
        addLabel.textContent = next ? 'Adding fonts…' : 'Add fonts'
    }

    function chooseFiles(familyId: string | null): void {
        if (busy) return
        target = familyId
        input.value = ''
        input.click()
    }

    async function importFiles(files: readonly File[], targetId: string | null): Promise<void> {
        setBusy(true)
        showProblems([])
        try {
            const read: FontFile[] = []
            const problems: FontFileProblem[] = []
            for (const file of files) {
                try {
                    read.push(await readFontFile(file))
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    problems.push({ fileName: file.name, message })
                }
            }
            if (destroyed) return
            const plan = planFontImport({
                files: read,
                existing: fonts.list,
                targetId: targetId ?? undefined,
                now: now(),
                createId,
            })
            problems.push(...plan.problems)
            const known = new Set(fonts.list.map((record) => record.id))
            await fonts.save(plan.writes)
            if (destroyed) return
            showProblems(problems)
            const added = plan.writes.map((write) => write.record)
            // A new font is the font that the user wants to read in.
            const created = added.filter((record) => !known.has(record.id))
            if (targetId === null && created.length === 1) {
                store.update({ fontId: USER_FONT_PREFIX + created[0].id })
            }
            const message = importMessage(added, plan.duplicates)
            if (message) notice.show({ message })
            loadSamples()
        } catch (error) {
            console.error(error)
            if (destroyed) return
            notice.show({
                message: isQuotaError(error)
                    ? 'The device has no space for the fonts.'
                    : 'The fonts were not added. Try again.',
                tone: 'error',
            })
        } finally {
            setBusy(false)
        }
    }

    function startRename(row: HTMLElement, record: FontRecord): void {
        stopRename()
        editing = record.id
        row.dataset.editing = ''
        const form = qs<HTMLFormElement>('.fonts-rename', row)
        const field = qs<HTMLInputElement>('.input', form)
        form.hidden = false
        field.value = record.name
        field.setAttribute('aria-label', `New name for ${record.name}`)
        field.focus()
        field.select()
    }

    function stopRename(): void {
        if (editing === null) return
        const id = editing
        const row = Array.from(list.children).find(
            (child): child is HTMLElement =>
                child instanceof HTMLElement && child.dataset.key === id,
        )
        editing = null
        if (!row) return
        delete row.dataset.editing
        qs<HTMLFormElement>('.fonts-rename', row).hidden = true
        qs<HTMLElement>('[data-action="rename"]', row).focus()
    }

    async function rename(record: FontRecord, name: string): Promise<void> {
        const trimmed = name.replace(/\s+/g, ' ').trim()
        stopRename()
        if (!trimmed || trimmed === record.name) return
        try {
            await fonts.save([
                { record: { ...record, name: trimmed, updatedAt: now() }, files: new Map() },
            ])
        } catch (error) {
            console.error(error)
            notice.show({ message: 'The font was not renamed.', tone: 'error' })
        }
    }

    async function remove(record: FontRecord): Promise<void> {
        try {
            const removed = await fonts.remove(record.id)
            if (!removed || destroyed) return
            notice.show({
                message: `Removed ${record.name}`,
                action: {
                    label: 'Undo',
                    onSelect: () => {
                        fonts.save([removed]).catch((error: unknown) => {
                            console.error(error)
                            notice.show({ message: 'The font did not come back.', tone: 'error' })
                        })
                    },
                },
            })
        } catch (error) {
            console.error(error)
            notice.show({ message: 'The font was not removed.', tone: 'error' })
        }
    }

    on(body, 'click', (event) => {
        const button = (event.target as Element).closest<HTMLElement>('button[data-action]')
        if (!button) return
        const action = button.dataset.action
        if (action === 'add') {
            chooseFiles(null)
            return
        }
        const record = keyed.itemOf(button)
        if (!record) return
        if (action === 'rename') startRename(button.closest('li')!, record)
        else if (action === 'styles') chooseFiles(record.id)
        else if (action === 'remove') void remove(record)
    })

    on(input, 'change', () => {
        const files = Array.from(input.files ?? [])
        input.value = ''
        if (files.length > 0 && !busy) void importFiles(files, target)
    })

    on(body, 'submit', (event) => {
        event.preventDefault()
        const form = event.target as HTMLFormElement
        const record = keyed.itemOf(form)
        if (record) void rename(record, qs<HTMLInputElement>('.input', form).value)
    })

    on(body, 'keydown', (event) => {
        // Escape in the name field stops the rename and does not close the sheet.
        if (event.key !== 'Escape' || editing === null) return
        if (!(event.target as Element).closest('.fonts-rename')) return
        event.preventDefault()
        event.stopPropagation()
        stopRename()
    })

    connectDialog(dialog)
    host.append(dialog)
    render()

    const stopFonts = fonts.subscribe(() => {
        render()
        if (dialog.open) loadSamples()
    })

    return {
        open(opener) {
            render()
            loadSamples()
            openDialog(dialog, opener ?? document.activeElement)
        },
        close() {
            dialog.close()
        },
        destroy() {
            destroyed = true
            stopFonts()
            notice.destroy()
            if (dialog.open) dialog.close()
            dialog.remove()
        },
    }
}
