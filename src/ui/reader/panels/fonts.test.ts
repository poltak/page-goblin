import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import type { FakeUserFonts } from '$lib/fonts/testing/fake-user-fonts'
import { buildFont, familyNames } from '$lib/fonts/testing/build-font'
import { createSettingsStore } from '$lib/settings'
import type { OwnedSettingsStore } from '$lib/settings'
import type { FontFaceRecord, FontRecord } from '$lib/storage/types'
import { clearToasts } from '../../app/toast'
import { createFontSheet } from './fonts'
import type { FontSheet } from './fonts'
import { createFakeSession, HOSTILE, mountHost } from './testing/fake-session'

function face(hash: string, changes: Partial<FontFaceRecord> = {}): FontFaceRecord {
    return {
        hash,
        format: 'truetype',
        weight: '400',
        style: 'normal',
        stretch: '100%',
        size: 10,
        ...changes,
    }
}

function makeFont(id: string, name: string, faces = [face(`${id}-r`)]): FontRecord {
    return { id, name, fallback: 'serif', faces, addedAt: 1, updatedAt: 1 }
}

function fontFile(family: string, style = 'Regular', fileName = `${family}-${style}.ttf`): File {
    const os2 = {
        weight: style.includes('Bold') ? 700 : 400,
        selection: style.includes('Italic') ? 0x01 : 0x40,
    }
    return new File([buildFont({ names: familyNames(family, style), os2 })], fileName)
}

let host: HTMLElement
let fonts: FakeUserFonts
let store: OwnedSettingsStore
let sheet: FontSheet | null = null

function mount(list: FontRecord[] = []): FontSheet {
    host = mountHost()
    fonts = createFakeUserFonts({ list })
    store = createSettingsStore({ storage: null })
    const session = createFakeSession({ fonts })
    sheet = createFontSheet({ session, host, settings: store, now: () => 500 })
    sheet.open()
    return sheet
}

const dialog = () => host.querySelector<HTMLDialogElement>('.fonts-panel')!
const q = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = dialog()) =>
    root.querySelector<T>(selector)!
const rows = () => Array.from(dialog().querySelectorAll<HTMLElement>('.fonts-row'))
const names = () => rows().map((row) => q('.fonts-row-name', row).textContent)
const notice = () => dialog().querySelector<HTMLElement>('.panel-notice .toast')
const noticeText = () => notice()?.querySelector('span')?.textContent ?? null
const fileInput = () => q<HTMLInputElement>('.fonts-input')

/** Lets the reads of the files and the hashes finish. */
async function settle(): Promise<void> {
    for (let round = 0; round < 20; round++) await new Promise((resolve) => setTimeout(resolve))
}

async function choose(files: File[], button: HTMLElement = q('[data-action="add"]')) {
    const click = vi.spyOn(fileInput(), 'click').mockImplementation(() => {})
    click.mockClear()
    button.click()
    expect(click).toHaveBeenCalledOnce()
    Object.defineProperty(fileInput(), 'files', { value: files, configurable: true })
    fileInput().dispatchEvent(new Event('change'))
    await settle()
}

afterEach(() => {
    sheet?.destroy()
    sheet = null
    store?.destroy()
    clearToasts()
    vi.restoreAllMocks()
})

describe('the font sheet', () => {
    it('opens as a sheet in the overlay layer and shows the empty state', () => {
        mount()
        expect(dialog().parentElement).toBe(host)
        expect(dialog().open).toBe(true)
        expect(q('.empty-state').hidden).toBe(false)
        expect(q('.fonts-list').hidden).toBe(true)
    })

    it('lists the fonts as text, each name in its own font', () => {
        mount([
            makeFont('a', HOSTILE, [face('r'), face('i', { style: 'italic' })]),
            makeFont('b', 'Lora'),
        ])

        expect(names()).toEqual([HOSTILE, 'Lora'])
        expect(dialog().querySelector('img, b')).toBeNull()
        expect(q('.fonts-row-styles', rows()[0]).textContent).toBe('Regular, Italic')
        expect(q('.fonts-row-name', rows()[1]).style.fontFamily).toBe('"pg-font-b", serif')
        expect(q('[data-action="remove"]', rows()[1]).getAttribute('aria-label')).toBe(
            'Remove Lora',
        )
        expect(q('.empty-state').hidden).toBe(true)
        // The names show in their own fonts, so the fonts load.
        expect(fonts.loads).toEqual(['user:a', 'user:b'])
    })

    it('follows changes of the list', () => {
        mount()
        fonts.setList([makeFont('a', 'Arrived')])
        expect(names()).toEqual(['Arrived'])
    })

    it('adds the chosen files as one font and selects it', async () => {
        mount()
        await choose([fontFile('Lora'), fontFile('Lora', 'Italic')])

        expect(fonts.saved).toHaveLength(1)
        const { record, files } = fonts.saved[0]
        expect(record).toMatchObject({ name: 'Lora', addedAt: 500, updatedAt: 500 })
        expect(record.faces.map((item) => item.style)).toEqual(['normal', 'italic'])
        expect(files.size).toBe(2)
        expect(store.get().fontId).toBe(`user:${record.id}`)
        expect(noticeText()).toBe('Added Lora')
        expect(names()).toEqual(['Lora'])
        expect(q('.fonts-problems').hidden).toBe(true)
    })

    it('adds files to the font of the same name and keeps the font setting', async () => {
        const lora = makeFont('a', 'Lora')
        mount([lora])
        await choose([fontFile('Lora', 'Bold')])

        expect(fonts.saved.map((write) => write.record.id)).toEqual(['a'])
        expect(store.get().fontId).toBe('publisher')
        expect(noticeText()).toBe('Added Lora')
    })

    it('adds styles to the font of the row, whatever the name in the files', async () => {
        mount([makeFont('a', 'My Font')])
        await choose([fontFile('Other Name', 'Italic')], q('[data-action="styles"]', rows()[0]))

        expect(fonts.saved.map((write) => write.record.id)).toEqual(['a'])
        expect(fonts.saved[0].record.faces).toHaveLength(2)
    })

    it('shows each file that it refused, with the file name as text', async () => {
        mount()
        await choose([new File(['not a font'], HOSTILE), fontFile('Lora')])

        expect(q('.fonts-problems').hidden).toBe(false)
        expect(q('.fonts-problem-file').textContent).toBe(HOSTILE)
        expect(q('.fonts-problem-text').textContent).toBe(
            'This file is not a font. Use a .ttf, .otf, .woff or .woff2 file.',
        )
        expect(dialog().querySelector('img, b')).toBeNull()
        expect(names()).toEqual(['Lora'])
    })

    it('tells the user when the files are in the fonts already', async () => {
        mount()
        await choose([fontFile('Lora')])
        await choose([fontFile('Lora')])

        expect(fonts.saved).toHaveLength(1)
        expect(noticeText()).toBe('These files are already in your fonts.')
    })

    it('shows an error when the storage has no space', async () => {
        mount()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(fonts, 'save').mockRejectedValue(
            Object.assign(new Error('full'), { name: 'QuotaExceededError' }),
        )
        await choose([fontFile('Lora')])

        expect(noticeText()).toBe('The device has no space for the fonts.')
        expect(store.get().fontId).toBe('publisher')
        expect(q('[data-action="add"]').getAttribute('aria-disabled')).toBe('false')
    })

    it('renames a font', async () => {
        mount([makeFont('a', 'Old')])
        q('[data-action="rename"]', rows()[0]).click()
        const form = q<HTMLFormElement>('.fonts-rename', rows()[0])
        const field = q<HTMLInputElement>('.input', form)
        expect(form.hidden).toBe(false)
        expect(field.value).toBe('Old')
        expect(document.activeElement).toBe(field)

        field.value = '  New   name '
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
        await settle()

        expect(fonts.saved[0].record).toMatchObject({ id: 'a', name: 'New name', updatedAt: 500 })
        expect(fonts.saved[0].files.size).toBe(0)
        expect(names()).toEqual(['New name'])
        expect(form.hidden).toBe(true)
    })

    it('stops a rename with Escape and keeps the sheet open', () => {
        mount([makeFont('a', 'Old')])
        q('[data-action="rename"]', rows()[0]).click()
        const field = q<HTMLInputElement>('.fonts-rename .input', rows()[0])
        const escape = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        })
        field.dispatchEvent(escape)

        expect(escape.defaultPrevented).toBe(true)
        expect(q<HTMLFormElement>('.fonts-rename', rows()[0]).hidden).toBe(true)
        expect(dialog().open).toBe(true)
        expect(document.activeElement).toBe(q('[data-action="rename"]', rows()[0]))
        expect(fonts.saved).toEqual([])
    })

    it('does not save a name with no text or with no change', async () => {
        mount([makeFont('a', 'Old')])
        for (const value of ['   ', 'Old']) {
            q('[data-action="rename"]', rows()[0]).click()
            const form = q<HTMLFormElement>('.fonts-rename', rows()[0])
            q<HTMLInputElement>('.input', form).value = value
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
            await settle()
        }
        expect(fonts.saved).toEqual([])
    })

    it('removes a font and puts it back with Undo', async () => {
        mount([makeFont('a', 'Lora'), makeFont('b', 'Inter')])
        q('[data-action="remove"]', rows()[1]).click()
        await settle()

        expect(names()).toEqual(['Lora'])
        expect(noticeText()).toBe('Removed Inter')

        notice()!.querySelector('button')!.click()
        await settle()
        expect(fonts.saved.map((write) => write.record.id)).toEqual(['b'])
        // A new time, so the font wins over its delete on the sync server.
        expect(fonts.saved[0].record.updatedAt).toBe(500)
        expect(names()).toEqual(['Lora', 'Inter'])
    })

    it('removes its dialog and listeners at destroy', () => {
        const fontSheet = mount([makeFont('a', 'Lora')])
        fontSheet.destroy()
        sheet = null
        expect(host.querySelector('.fonts-panel')).toBeNull()
        fonts.setList([])
    })
})
