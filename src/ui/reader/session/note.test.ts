import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractNote, findFragmentTarget, NOTE_MAX_CHARS, noteBlockOf } from './note'

function bodyOf(html: string): HTMLElement {
    const body = document.createElement('rd-body')
    body.innerHTML = html
    return body
}

/** A small CSS.escape for the test, because jsdom has none. */
function stubCssEscape(): void {
    vi.stubGlobal('CSS', {
        escape: (value: string) =>
            value.replace(/[^a-zA-Z0-9_ -￿-]/g, (char) => `\\${char}`).replace(/^\d/, '\\3$& '),
    })
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe.each([
    ['with CSS.escape', true],
    ['with no CSS.escape', false],
])('findFragmentTarget %s', (_name, withEscape) => {
    function find(body: Element, fragment: string): Element | null {
        if (withEscape) stubCssEscape()
        else vi.stubGlobal('CSS', undefined)
        return findFragmentTarget(body, fragment)
    }

    it('finds an element by its id', () => {
        const body = bodyOf('<p id="a">A</p><p id="b">B</p>')
        expect(find(body, 'b')?.textContent).toBe('B')
    })

    it('finds an anchor by its name', () => {
        const body = bodyOf('<p><a name="fn1">1</a> Note</p>')
        expect(find(body, 'fn1')?.localName).toBe('a')
    })

    it('prefers an id over a name', () => {
        const body = bodyOf('<a name="x">name</a><span id="x">id</span>')
        expect(find(body, 'x')?.textContent).toBe('id')
    })

    it('finds an id that is not a CSS identifier', () => {
        const body = bodyOf('<p id="12.note:a b">odd</p><p id="a&quot;]b">quote</p>')
        expect(find(body, '12.note:a b')?.textContent).toBe('odd')
        expect(find(body, 'a"]b')?.textContent).toBe('quote')
    })

    it('gives null for an unknown or empty fragment', () => {
        const body = bodyOf('<p id="a">A</p><span name="b">not an anchor</span>')
        expect(find(body, 'missing')).toBeNull()
        expect(find(body, '')).toBeNull()
        expect(find(body, 'b')).toBeNull()
    })
})

describe('noteBlockOf', () => {
    it.each(['aside', 'li', 'p', 'div', 'section', 'dd', 'blockquote'])(
        'gives the nearest %s around the target',
        (name) => {
            const body = bodyOf(
                `<article><${name} class="note"><span><a id="t">1</a></span> text</${name}></article>`,
            )
            const target = body.querySelector('#t') as Element
            expect(noteBlockOf(body, target)?.className).toBe('note')
        },
    )

    it('gives the table cell around the target', () => {
        const body = bodyOf(
            '<table><tbody><tr><td class="note"><a id="t">1</a></td></tr></tbody></table>',
        )
        expect(noteBlockOf(body, body.querySelector('#t') as Element)?.className).toBe('note')
    })

    it('gives the target when it is a block itself', () => {
        const body = bodyOf('<div><aside id="t"><p>Note</p></aside></div>')
        expect(noteBlockOf(body, body.querySelector('#t') as Element)?.localName).toBe('aside')
    })

    it('gives the innermost block when blocks are nested', () => {
        const body = bodyOf(
            '<section><div><p class="inner"><a id="t">1</a> Note</p></div></section>',
        )
        expect(noteBlockOf(body, body.querySelector('#t') as Element)?.className).toBe('inner')
    })

    it('gives the child of the body when no block is around the target', () => {
        const body = bodyOf('<h2 class="top"><span><a id="t">1</a></span> Title</h2>')
        expect(noteBlockOf(body, body.querySelector('#t') as Element)?.className).toBe('top')
    })

    it('gives null for the body itself', () => {
        const body = bodyOf('<p>Text</p>')
        expect(noteBlockOf(body, body)).toBeNull()
    })
})

describe('extractNote', () => {
    it('gives a detached deep copy of the note block', () => {
        const body = bodyOf(
            '<p>Text<a id="ref">1</a></p><aside id="fn1"><p>The <em>note</em> text.</p></aside>',
        )
        const original = body.querySelector('aside') as HTMLElement
        const copy = extractNote(body, 'fn1')

        expect(copy).not.toBeNull()
        expect(copy).not.toBe(original)
        expect(copy?.parentNode).toBeNull()
        expect(copy?.localName).toBe('aside')
        expect(copy?.innerHTML).toBe('<p>The <em>note</em> text.</p>')
        // The chapter is not changed.
        expect(original.id).toBe('fn1')
        expect(original.parentNode).toBe(body)
    })

    it('removes all id attributes from the copy', () => {
        const body = bodyOf(
            '<div id="note" class="n"><p id="p1"><a id="back" name="keep">1</a> Text <span id="s">x</span></p></div>',
        )
        const copy = extractNote(body, 'back') as HTMLElement
        expect(copy.localName).toBe('p')
        expect(copy.hasAttribute('id')).toBe(false)
        expect(copy.querySelectorAll('[id]')).toHaveLength(0)
        expect(copy.querySelector('a')?.getAttribute('name')).toBe('keep')
        expect(body.querySelectorAll('[id]')).toHaveLength(4)
    })

    it('gives the block around an anchor that has no content', () => {
        const body = bodyOf('<p class="fn"><a id="fn2"></a>2. A note with an empty anchor.</p>')
        expect(extractNote(body, 'fn2')?.textContent).toBe('2. A note with an empty anchor.')
    })

    it('finds the note by the name of an anchor', () => {
        const body = bodyOf('<ol><li><a name="n3">3</a> Third note</li></ol>')
        expect(extractNote(body, 'n3')?.localName).toBe('li')
    })

    it('gives null when the target is not there', () => {
        expect(extractNote(bodyOf('<p id="a">A</p>'), 'b')).toBeNull()
        expect(extractNote(bodyOf(''), 'b')).toBeNull()
    })

    it('gives null for a note with no content', () => {
        // The text of the note is in the next element, so the copy would be empty.
        const body = bodyOf('<a id="fn4"></a><p>4. The note text.</p><p id="e">  </p>')
        expect(extractNote(body, 'fn4')).toBeNull()
        expect(extractNote(body, 'e')).toBeNull()
    })

    it('leaves the marks of the reader view out of the copy', () => {
        // The view wraps highlights and the speech marker in mark elements while it shows
        // the chapter.
        const body = bodyOf(
            '<p id="n1">1. A <mark class="rd-hl" data-id="h1" data-color="blue">note ' +
                '<mark class="rd-active">with</mark></mark> marks and a <mark>book mark</mark>.</p>',
        )
        const copy = extractNote(body, 'n1') as HTMLElement
        expect(copy.innerHTML).toBe('1. A note with marks and a <mark>book mark</mark>.')
        // The text is in one node again.
        expect(copy.firstChild?.textContent).toBe('1. A note with marks and a ')
        // The chapter keeps its marks.
        expect(body.querySelectorAll('mark')).toHaveLength(3)
    })

    it('gives null for a block that is too long to be a note', () => {
        // The target is a page marker in a heading, so the block is the section of the chapter.
        const paragraph = `<p>${'word '.repeat(400)}</p>`
        const body = bodyOf(
            `<section><h2><span id="page-9"></span>Chapter</h2>${paragraph.repeat(6)}</section>` +
                `<p id="long">${'a'.repeat(NOTE_MAX_CHARS)}</p>` +
                `<p id="longer">${'a'.repeat(NOTE_MAX_CHARS)}<em>b</em></p>`,
        )
        expect(extractNote(body, 'page-9')).toBeNull()
        expect(extractNote(body, 'long')?.textContent).toHaveLength(NOTE_MAX_CHARS)
        expect(extractNote(body, 'longer')).toBeNull()
    })

    it('keeps a note that has only an image', () => {
        const body = bodyOf('<div id="fig"><img alt="A map"></div><img id="lone" alt="x">')
        expect(extractNote(body, 'fig')?.querySelector('img')).not.toBeNull()
        expect(extractNote(body, 'lone')?.localName).toBe('img')
    })
})
