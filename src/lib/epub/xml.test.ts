import { describe, expect, it } from 'vitest'
import {
    attribute,
    childrenNamed,
    descendants,
    firstDescendant,
    htmlToText,
    localName,
    parseContentDocument,
    parseXml,
    textOf,
} from './xml'

describe('parseXml', () => {
    it('returns null for text that is not well-formed', () => {
        expect(parseXml('<a><b></a>')).toBeNull()
        expect(parseXml('')).toBeNull()
        expect(parseXml('not xml')).toBeNull()
    })

    it('repairs HTML entities and bare ampersands', () => {
        const document = parseXml(
            '<metadata><title>Tom &amp; Jerry &nbsp;&eacute; R&D &unknown; &#169; &lt;b&gt;</title></metadata>',
        )
        expect(document?.documentElement.textContent).toBe(
            'Tom & Jerry \u00a0é R&D &unknown; © <b>',
        )
    })

    it('repairs namespace prefixes that have no declaration', () => {
        // All browsers reject a prefix with no declaration. Real package documents have this fault.
        const document = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!-- <package> in a comment is not the root element -->
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator opf:role="aut" opf:file-as="Name, A">A Name</dc:creator>
<dc:identifier xsi:type="dcterms:ISBN">1</dc:identifier>
<dcterms:modified>2020</dcterms:modified>
</metadata>
</package>`)
        expect(document).not.toBeNull()
        expect(attribute(firstDescendant(document!, 'creator')!, 'role')).toBe('aut')
        expect(attribute(firstDescendant(document!, 'identifier')!, 'type')).toBe('dcterms:ISBN')
        expect(textOf(firstDescendant(document!, 'modified'))).toBe('2020')
        expect(document!.documentElement.getAttribute('xml:lang')).toBe('en')

        const prefixedRoot = parseXml('<opf:package><opf:metadata/></opf:package>')
        expect(prefixedRoot && localName(prefixedRoot.documentElement)).toBe('package')
    })

    it('repairs text before the XML declaration and control characters', () => {
        const document = parseXml('\n  <?xml version="1.0"?><a>one\u0001two</a>')
        expect(document?.documentElement.textContent).toBe('onetwo')
    })
})

describe('parseContentDocument', () => {
    const page = (body: string) =>
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title/></head><body>${body}</body></html>`
    const bodyText = (document: Document) =>
        textOf(document.getElementsByTagName('body')[0] ?? null)

    it('parses well-formed XHTML as XML', () => {
        const document = parseContentDocument(page('<p>One<br/>two</p>'))
        expect(bodyText(document)).toBe('Onetwo')
        expect(textOf(document.getElementsByTagName('title')[0])).toBe('')
    })

    it('repairs entities before it uses the HTML parser', () => {
        // The HTML parser would put all the text after `<title/>` into the title.
        const document = parseContentDocument(page('<p>One&nbsp;&amp; two</p>'))
        expect(bodyText(document)).toBe('One & two')
        expect(textOf(document.getElementsByTagName('title')[0])).toBe('')
    })

    it('uses the HTML parser when the text is not XML', () => {
        const document = parseContentDocument('<html><body><p>One<br>two<p>three</body></html>')
        expect(document.getElementsByTagName('p')).toHaveLength(2)
        expect(bodyText(document)).toBe('Onetwothree')
    })
})

describe('element helpers', () => {
    const document = parseXml(`<opf:package xmlns:opf="http://www.idpf.org/2007/opf"
        xmlns:dc="http://purl.org/dc/elements/1.1/">
        <opf:metadata>
            <dc:Title>  A
               title </dc:Title>
            <dc:creator opf:role="aut" id="c1">Name</dc:creator>
            <meta name="cover" content="  img  "/>
            <empty attr="   "/>
        </opf:metadata>
        <metadata>second</metadata>
    </opf:package>`)!

    it('matches the lower-case local name', () => {
        expect(localName(document.documentElement)).toBe('package')
        expect(descendants(document, 'metadata')).toHaveLength(2)
        expect(textOf(firstDescendant(document, 'title'))).toBe('A title')
        expect(firstDescendant(document, 'missing')).toBeUndefined()
        expect(childrenNamed(document.documentElement, 'metadata')).toHaveLength(2)
        expect(childrenNamed(document.documentElement, 'title')).toHaveLength(0)
    })

    it('reads attributes with and without a prefix', () => {
        const creator = firstDescendant(document, 'creator')!
        expect(attribute(creator, 'role')).toBe('aut')
        expect(attribute(creator, 'id')).toBe('c1')
        expect(attribute(creator, 'missing')).toBeNull()
        expect(attribute(firstDescendant(document, 'meta')!, 'content')).toBe('img')
        expect(attribute(firstDescendant(document, 'empty')!, 'attr')).toBeNull()
    })
})

describe('htmlToText', () => {
    it('removes markup and keeps the words of blocks apart', () => {
        // A no-break space is white space, so it becomes a normal space.
        expect(htmlToText('<p>One <b>bo</b>ld.</p><p>Two&nbsp;&amp; three.</p>')).toBe(
            'One bold. Two & three.',
        )
        expect(htmlToText('<div>A<br/>B</div><ul><li>C</li><li>D</li></ul>')).toBe('A B C D')
    })

    it('leaves out script and style content', () => {
        expect(htmlToText('<style>p{}</style><p>Text</p><script>alert(1)</script>')).toBe('Text')
    })

    it('collapses the white space of plain text', () => {
        expect(htmlToText('  A plain\n\n  description. ')).toBe('A plain description.')
        expect(htmlToText('')).toBe('')
    })
})
