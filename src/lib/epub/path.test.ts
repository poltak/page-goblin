import { describe, expect, it } from 'vitest'
import { dirname, resolveHref, resolvePath, splitHref } from './path'

describe('dirname', () => {
    it('keeps the last slash', () => {
        expect(dirname('OEBPS/text/ch1.xhtml')).toBe('OEBPS/text/')
        expect(dirname('content.opf')).toBe('')
    })
})

describe('splitHref', () => {
    it('splits at the first hash', () => {
        expect(splitHref('ch1.xhtml#a#b')).toEqual({ path: 'ch1.xhtml', fragment: 'a#b' })
        expect(splitHref('ch1.xhtml')).toEqual({ path: 'ch1.xhtml', fragment: null })
        expect(splitHref('ch1.xhtml#')).toEqual({ path: 'ch1.xhtml', fragment: null })
        expect(splitHref('#note')).toEqual({ path: '', fragment: 'note' })
    })
})

describe('resolvePath', () => {
    it('resolves a relative path', () => {
        expect(resolvePath('OEBPS/', 'text/ch1.xhtml')).toBe('OEBPS/text/ch1.xhtml')
        expect(resolvePath('', './OEBPS/content.opf')).toBe('OEBPS/content.opf')
        expect(resolvePath('OEBPS', 'ch1.xhtml')).toBe('OEBPS/ch1.xhtml')
        expect(resolvePath('OEBPS/', 'a//b/./c.xhtml')).toBe('OEBPS/a/b/c.xhtml')
    })

    it('resolves parent segments', () => {
        expect(resolvePath('OEBPS/text/', '../images/a.jpg')).toBe('OEBPS/images/a.jpg')
        expect(resolvePath('OEBPS/text/', '../../mimetype')).toBe('mimetype')
    })

    it('treats a leading slash as the container root', () => {
        expect(resolvePath('OEBPS/text/', '/OEBPS/images/a.jpg')).toBe('OEBPS/images/a.jpg')
    })

    it('decodes percent escapes', () => {
        expect(resolvePath('OEBPS/', 'my%20chapter%231.xhtml')).toBe('OEBPS/my chapter#1.xhtml')
        expect(resolvePath('OEBPS/', 'caf%C3%A9.xhtml')).toBe('OEBPS/café.xhtml')
    })

    it('keeps a bad escape and decodes the others', () => {
        expect(resolvePath('', 'chapter%ZZ.xhtml')).toBe('chapter%ZZ.xhtml')
        expect(resolvePath('', 'my%20book/100%.xhtml')).toBe('my book/100%.xhtml')
        expect(resolvePath('', 'a%20b/caf%E9.xhtml')).toBe('a b/caf%E9.xhtml')
    })

    it('reads a backslash as a slash', () => {
        // Browsers do the same for the URLs of a page. Books from Windows tools have such hrefs.
        expect(resolvePath('OEBPS/', 'Text\\ch1.xhtml')).toBe('OEBPS/Text/ch1.xhtml')
        expect(resolvePath('OEBPS/text/', '..\\images\\a.jpg')).toBe('OEBPS/images/a.jpg')
        expect(resolvePath('OEBPS/', '..\\..\\a.xhtml')).toBeNull()
        // The ZIP reader gives names with no backslash, so an escaped one is a separator too.
        expect(resolvePath('OEBPS/', 'Text%5Cch1.xhtml')).toBe('OEBPS/Text/ch1.xhtml')
        expect(resolvePath('OEBPS/', '..%5C..%5Ca.xhtml')).toBeNull()
    })

    it('removes the query and the fragment', () => {
        expect(resolvePath('OEBPS/', 'ch1.xhtml?view=reader#start')).toBe('OEBPS/ch1.xhtml')
    })

    it('rejects a URL with a scheme', () => {
        expect(resolvePath('OEBPS/', 'https://example.com/a.jpg')).toBeNull()
        expect(resolvePath('OEBPS/', 'mailto:someone@example.com')).toBeNull()
        expect(resolvePath('OEBPS/', 'data:image/png;base64,AAAA')).toBeNull()
        expect(resolvePath('OEBPS/', '//example.com/a.jpg')).toBeNull()
    })

    it('rejects a path that leaves the container', () => {
        expect(resolvePath('OEBPS/', '../../etc/passwd')).toBeNull()
        expect(resolvePath('', '../a.xhtml')).toBeNull()
        expect(resolvePath('OEBPS/', '%2E%2E/%2E%2E/a.xhtml')).toBeNull()
    })

    it('rejects a NUL character and an empty path', () => {
        expect(resolvePath('OEBPS/', 'a%00.xhtml')).toBeNull()
        expect(resolvePath('OEBPS/', '')).toBeNull()
        expect(resolvePath('OEBPS/', '   ')).toBeNull()
        expect(resolvePath('', './')).toBeNull()
    })
})

describe('resolveHref', () => {
    const from = 'OEBPS/text/ch1.xhtml'

    it('resolves against the directory of the source file', () => {
        expect(resolveHref(from, 'ch2.xhtml')).toEqual({
            path: 'OEBPS/text/ch2.xhtml',
            fragment: null,
        })
        expect(resolveHref(from, '../images/a.jpg')).toEqual({
            path: 'OEBPS/images/a.jpg',
            fragment: null,
        })
        expect(resolveHref('ch1.xhtml', 'ch2.xhtml#top')).toEqual({
            path: 'ch2.xhtml',
            fragment: 'top',
        })
    })

    it('reads a backslash in the path as a slash and keeps it in the fragment', () => {
        expect(resolveHref(from, '..\\notes\\n1.xhtml#a\\b')).toEqual({
            path: 'OEBPS/notes/n1.xhtml',
            fragment: 'a\\b',
        })
    })

    it('keeps the fragment and decodes it', () => {
        expect(resolveHref(from, 'notes.xhtml?x=1#note%201')).toEqual({
            path: 'OEBPS/text/notes.xhtml',
            fragment: 'note 1',
        })
        expect(resolveHref(from, 'notes.xhtml#')).toEqual({
            path: 'OEBPS/text/notes.xhtml',
            fragment: null,
        })
    })

    it('resolves a fragment only to the source file', () => {
        expect(resolveHref(from, '#note1')).toEqual({ path: from, fragment: 'note1' })
        expect(resolveHref(from, '  #note1 ')).toEqual({ path: from, fragment: 'note1' })
    })

    it('removes line breaks and tabs from the href', () => {
        expect(resolveHref(from, ' ch2\n.xhtml\t#a ')).toEqual({
            path: 'OEBPS/text/ch2.xhtml',
            fragment: 'a',
        })
    })

    it('returns null for external URLs, empty hrefs and paths that leave the container', () => {
        expect(resolveHref(from, 'https://example.com/#a')).toBeNull()
        expect(resolveHref(from, 'HTTP://example.com')).toBeNull()
        expect(resolveHref(from, 'mailto:a@example.com')).toBeNull()
        expect(resolveHref(from, 'javascript:alert(1)')).toBeNull()
        expect(resolveHref(from, '//example.com/a')).toBeNull()
        expect(resolveHref(from, '\\\\example.com\\a')).toBeNull()
        expect(resolveHref(from, '')).toBeNull()
        expect(resolveHref(from, '   ')).toBeNull()
        expect(resolveHref(from, '../../../a.xhtml')).toBeNull()
    })
})
