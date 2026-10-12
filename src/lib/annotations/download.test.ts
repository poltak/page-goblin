import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { copyText, downloadTextFile } from './download'

interface ClickedLink {
    href: string
    download: string
    inDocument: boolean
    visible: boolean
}

describe('downloadTextFile', () => {
    let clicked: ClickedLink[]
    let blobs: Blob[]
    let createObjectURL: MockInstance<typeof URL.createObjectURL>
    let revokeObjectURL: MockInstance<typeof URL.revokeObjectURL>

    beforeEach(() => {
        vi.useFakeTimers()
        clicked = []
        blobs = []
        createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
            blobs.push(blob as Blob)
            return `blob:test/${blobs.length}`
        })
        revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        // A click on a link makes jsdom navigate, which it cannot do.
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement,
        ) {
            clicked.push({
                href: this.getAttribute('href') ?? '',
                download: this.download,
                inDocument: this.isConnected,
                visible: !this.hidden,
            })
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    it('clicks a hidden link to an object URL of the text', async () => {
        const text = '# Title\n\n> Zażółć gęślą jaźń\n'

        downloadTextFile({ name: 'notes.md', text, type: 'text/markdown;charset=utf-8' })

        expect(clicked).toEqual([
            { href: 'blob:test/1', download: 'notes.md', inDocument: true, visible: false },
        ])
        expect(createObjectURL).toHaveBeenCalledOnce()
        expect(blobs[0].type).toBe('text/markdown;charset=utf-8')
        expect(await blobs[0].text()).toBe(text)
    })

    it('works with the object URLs of the test environment', () => {
        createObjectURL.mockRestore()
        revokeObjectURL.mockRestore()

        downloadTextFile({ name: 'notes.md', text: 'x', type: 'text/plain' })
        vi.runAllTimers()

        expect(clicked).toHaveLength(1)
        expect(clicked[0].href).toMatch(/^blob:/)
    })

    it('removes the link from the document after the click', () => {
        downloadTextFile({ name: 'notes.md', text: 'x', type: 'text/plain' })

        expect(document.querySelector('a')).toBeNull()
        expect(document.body.childElementCount).toBe(0)
    })

    it('revokes the object URL after 40 seconds and not before', () => {
        downloadTextFile({ name: 'notes.md', text: 'x', type: 'text/plain' })

        expect(revokeObjectURL).not.toHaveBeenCalled()
        vi.advanceTimersByTime(39_999)
        expect(revokeObjectURL).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test/1')
    })

    it('makes one URL for each download', () => {
        downloadTextFile({ name: 'one.txt', text: '1', type: 'text/plain' })
        downloadTextFile({ name: 'two.txt', text: '2', type: 'text/plain' })
        vi.runAllTimers()

        expect(clicked.map((link) => link.href)).toEqual(['blob:test/1', 'blob:test/2'])
        expect(revokeObjectURL.mock.calls).toEqual([['blob:test/1'], ['blob:test/2']])
    })

    it.each([
        ['Dune: Part 1/2.md', 'Dune- Part 1-2.md'],
        ['What? "Yes" <no> | a*b\\c.txt', 'What- -Yes- -no- - a-b-c.txt'],
        ['  The\tHobbit\n or  There.json ', 'The Hobbit or There.json'],
        ['a\u0000b\u0008c\u007fd.txt', 'a-b-c-d.txt'],
        ['Zażółć gęślą 書.md', 'Zażółć gęślą 書.md'],
        ['', 'download'],
        ['   ', 'download'],
    ])('makes the file name %j safe as %j', (name, expected) => {
        downloadTextFile({ name, text: 'x', type: 'text/plain' })

        expect(clicked[0].download).toBe(expected)
    })
})

describe('copyText', () => {
    let execCommand: ReturnType<typeof vi.fn>

    function setClipboard(clipboard: unknown): void {
        Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
    }

    beforeEach(() => {
        // jsdom has no execCommand and no Clipboard API.
        execCommand = vi.fn(() => true)
        Object.assign(document, { execCommand })
    })

    afterEach(() => {
        Reflect.deleteProperty(document, 'execCommand')
        Reflect.deleteProperty(navigator, 'clipboard')
        document.body.replaceChildren()
    })

    it('writes the text with the Clipboard API', async () => {
        const writeText = vi.fn(() => Promise.resolve())
        setClipboard({ writeText })

        expect(await copyText('Some words')).toBe(true)
        expect(writeText).toHaveBeenCalledExactlyOnceWith('Some words')
        expect(execCommand).not.toHaveBeenCalled()
    })

    it('uses a selected text field when there is no Clipboard API', async () => {
        const text = 'Line one\nline two'
        let field: { tag: string; value: string; selected: string; readOnly: boolean } | null = null
        execCommand.mockImplementation(() => {
            const active = document.activeElement as HTMLTextAreaElement
            field = {
                tag: active.tagName,
                value: active.value,
                selected: active.value.slice(active.selectionStart, active.selectionEnd),
                readOnly: active.readOnly,
            }
            return true
        })

        expect(await copyText(text)).toBe(true)
        expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy')
        expect(field).toEqual({ tag: 'TEXTAREA', value: text, selected: text, readOnly: true })
        expect(document.querySelector('textarea')).toBeNull()
    })

    it('uses the text field when the Clipboard API rejects', async () => {
        const writeText = vi.fn(() => Promise.reject(new DOMException('No', 'NotAllowedError')))
        setClipboard({ writeText })

        expect(await copyText('Some words')).toBe(true)
        expect(writeText).toHaveBeenCalledOnce()
        expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy')
    })

    it('uses the text field when the clipboard object has no writeText', async () => {
        setClipboard({})

        expect(await copyText('Some words')).toBe(true)
        expect(execCommand).toHaveBeenCalledOnce()
    })

    it('gives false when the browser refuses the copy command', async () => {
        execCommand.mockReturnValue(false)

        expect(await copyText('Some words')).toBe(false)
        expect(document.querySelector('textarea')).toBeNull()
    })

    it('gives false when the copy command throws', async () => {
        execCommand.mockImplementation(() => {
            throw new Error('Not allowed')
        })

        expect(await copyText('Some words')).toBe(false)
        expect(document.querySelector('textarea')).toBeNull()
    })

    it('gives false when the environment has no copy method', async () => {
        Reflect.deleteProperty(document, 'execCommand')

        expect(await copyText('Some words')).toBe(false)
        expect(document.body.childElementCount).toBe(0)
    })

    describe('when a modal dialog is open', () => {
        let dialog: HTMLDialogElement
        let button: HTMLButtonElement

        beforeEach(() => {
            dialog = document.createElement('dialog')
            dialog.setAttribute('open', '')
            button = document.createElement('button')
            dialog.append(button)
            document.body.append(dialog)
            button.focus()
        })

        afterEach(() => {
            vi.restoreAllMocks()
        })

        /** A browser makes the page behind a modal dialog inert. jsdom does not, so this does. */
        function makeInertOutside(host: Element | null): void {
            const focus = HTMLTextAreaElement.prototype.focus
            vi.spyOn(HTMLTextAreaElement.prototype, 'focus').mockImplementation(function (
                this: HTMLTextAreaElement,
                options?: FocusOptions,
            ) {
                if (host?.contains(this)) focus.call(this, options)
            })
        }

        it('puts the text field into the dialog, because the page behind it is inert', async () => {
            makeInertOutside(dialog)
            let fieldHost: Element | null = null
            execCommand.mockImplementation(() => {
                fieldHost = document.activeElement?.parentElement ?? null
                return document.activeElement instanceof HTMLTextAreaElement
            })

            expect(await copyText('Some words')).toBe(true)
            expect(fieldHost).toBe(dialog)
            expect(document.querySelector('textarea')).toBeNull()
            expect(document.activeElement).toBe(button)
        })

        it('gives false and copies nothing when the text field cannot get the focus', async () => {
            makeInertOutside(null)

            expect(await copyText('Some words')).toBe(false)
            // The copy command copies the selection of the page, which is not the text.
            expect(execCommand).not.toHaveBeenCalled()
            expect(document.querySelector('textarea')).toBeNull()
            expect(document.activeElement).toBe(button)
        })
    })

    it('gives the focus and the selection back after the copy', async () => {
        const button = document.createElement('button')
        const paragraph = document.createElement('p')
        paragraph.textContent = 'The selected words of the book'
        document.body.append(button, paragraph)
        button.focus()
        const range = document.createRange()
        range.setStart(paragraph.firstChild!, 4)
        range.setEnd(paragraph.firstChild!, 12)
        const selection = document.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)

        expect(await copyText('Other text')).toBe(true)
        expect(document.activeElement).toBe(button)
        expect(selection.rangeCount).toBe(1)
        expect(selection.toString()).toBe('selected')
    })
})
