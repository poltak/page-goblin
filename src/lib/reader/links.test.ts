import { describe, expect, it } from 'vitest'
import { isNoteRef } from './links'

function link(html: string): Element {
    const holder = document.createElement('div')
    holder.innerHTML = html
    const found = holder.querySelector('a')
    if (!found) throw new Error('The test markup has no link.')
    return found
}

describe('isNoteRef', () => {
    it('accepts a link with the EPUB type noteref', () => {
        expect(
            isNoteRef(link('<a data-rd-path="n.xhtml" data-epub-type="noteref">see the note</a>')),
        ).toBe(true)
        expect(isNoteRef(link('<a data-epub-type="link NoteRef">see</a>'))).toBe(true)
    })

    it('accepts the ARIA role for a note reference', () => {
        expect(isNoteRef(link('<a role="doc-noteref">see the note</a>'))).toBe(true)
    })

    it('does not accept a type that only has the word in it', () => {
        expect(isNoteRef(link('<a data-epub-type="noterefs">see the note</a>'))).toBe(false)
        expect(isNoteRef(link('<a data-epub-type="footnote">back to the text</a>'))).toBe(false)
    })

    it('accepts a link inside a sup element', () => {
        expect(isNoteRef(link('<sup><a data-rd-path="n.xhtml">note</a></sup>'))).toBe(true)
        expect(isNoteRef(link('<sup><span><a>a</a></span></sup>'))).toBe(true)
    })

    it('accepts a short number or note mark as the text', () => {
        for (const text of ['1', '12', '1234', '[3]', '(4)', '*', '**', '†', '‡', '7.', ' 5 ']) {
            expect(isNoteRef(link(`<a data-rd-path="n.xhtml">${text}</a>`)), text).toBe(true)
        }
    })

    it('accepts a number in an element inside the link', () => {
        expect(isNoteRef(link('<a data-rd-path="n.xhtml"><sup>3</sup></a>'))).toBe(true)
    })

    it('does not accept normal link text', () => {
        for (const text of [
            'Chapter 1',
            'see note 3',
            '12345',
            '1 2',
            'a',
            'Notes',
            '[a link]',
            '',
        ]) {
            expect(isNoteRef(link(`<a data-rd-path="c.xhtml">${text}</a>`)), text).toBe(false)
        }
    })

    it('does not accept a link with only an image', () => {
        expect(isNoteRef(link('<a data-rd-path="c.xhtml"><img alt="1"></a>'))).toBe(false)
    })
})
