import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    buildTextModel,
    createTextIndex,
    measureChapter,
    segmentSentences,
    tokenizeWords,
} from './text-model'
import type { TextModel } from './types'

function makeBody(html: string): HTMLElement {
    const body = document.createElement('rd-body')
    body.innerHTML = html
    return body
}

function blockTexts(model: TextModel): string[] {
    return model.blocks.map((block) => model.text.slice(block.start, block.end))
}

/** Wrap [start, end) of a Text node in a mark element, as the highlight code of the reader does. */
function wrapInMark({ node, start, end }: { node: Text; start: number; end: number }): HTMLElement {
    const middle = node.splitText(start)
    middle.splitText(end - start)
    const mark = document.createElement('mark')
    middle.replaceWith(mark)
    mark.appendChild(middle)
    return mark
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('buildTextModel: counted text rule', () => {
    it('joins the data of the Text nodes in document order', () => {
        const model = buildTextModel(makeBody('<p>One <em>two</em> three.</p><p>Four</p>'))

        expect(model.text).toBe('One two three.Four')
    })

    it('counts white space as written', () => {
        const model = buildTextModel(makeBody('<p>  a \n\t b  </p>\n<p>c</p>'))

        expect(model.text).toBe('  a \n\t b  \nc')
    })

    it('does not count text below svg, math, rt, rp, script, style and template', () => {
        const body = makeBody(
            '<p>a<svg><text>SVG</text><title>T</title></svg>b' +
                '<math><mi>x</mi></math>c' +
                '<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>d</p>',
        )
        for (const name of ['script', 'style', 'template']) {
            const element = document.createElement(name)
            element.appendChild(document.createTextNode(`in ${name}`))
            body.appendChild(element)
        }

        expect(buildTextModel(body).text).toBe('abc漢d')
    })

    it('does not count text below an element with data-rd-skip', () => {
        const model = buildTextModel(
            makeBody(
                '<p>a<span data-rd-skip="">skip <b>this</b></span>b</p><div data-rd-skip>x</div>',
            ),
        )

        expect(model.text).toBe('ab')
    })

    it('gives the same text after a mark element is added', () => {
        const body = makeBody('<p>Hello brave world</p><p>Next</p>')
        const before = buildTextModel(body)

        wrapInMark({ node: body.querySelector('p')!.firstChild as Text, start: 6, end: 11 })

        expect(body.querySelector('mark')!.textContent).toBe('brave')
        expect(buildTextModel(body)).toEqual(before)
    })

    it('gives an empty model for an empty body', () => {
        expect(buildTextModel(makeBody(''))).toEqual({ text: '', blocks: [] })
        expect(buildTextModel(makeBody('<svg><text>x</text></svg>'))).toEqual({
            text: '',
            blocks: [],
        })
    })
})

describe('buildTextModel: blocks', () => {
    it('makes one block for each paragraph', () => {
        const model = buildTextModel(makeBody('<p>First one.</p><p>Second <b>one</b>.</p>'))

        expect(model.blocks).toEqual([
            { start: 0, end: 10, heading: false },
            { start: 10, end: 21, heading: false },
        ])
        expect(blockTexts(model)).toEqual(['First one.', 'Second one.'])
    })

    it('trims the blocks and leaves out blocks that have only white space', () => {
        const model = buildTextModel(
            makeBody(
                '\n  <p>  padded \u00a0</p>\n<p> \n </p><p>&nbsp;</p>\n<div>\n  <p>inner</p>\n</div>\n',
            ),
        )

        expect(blockTexts(model)).toEqual(['padded', 'inner'])
        for (const block of model.blocks) {
            expect(model.text.slice(block.start, block.end)).toMatch(/^\S.*\S$/s)
        }
    })

    it('ends a block at a br element', () => {
        const model = buildTextModel(makeBody('<p>line one<br>line two<br><br>line three</p>'))

        expect(blockTexts(model)).toEqual(['line one', 'line two', 'line three'])
    })

    it('ends a block at the start and at the end of a block element', () => {
        const model = buildTextModel(
            makeBody(
                'loose text<div>in div<p>in p</p>after p</div>tail' +
                    '<ul><li>item 1</li><li>item 2<ul><li>nested</li></ul></li></ul>' +
                    '<table><caption>cap</caption><tbody><tr><td>c1</td><th>c2</th></tr></tbody></table>' +
                    '<dl><dt>term</dt><dd>def</dd></dl>' +
                    '<blockquote>quote</blockquote><pre>pre</pre>' +
                    '<figure>fig<figcaption>caption</figcaption></figure>' +
                    '<details><summary>sum</summary>more</details>' +
                    '<section><header>head</header><article>art</article><aside>side</aside>' +
                    '<footer>foot</footer><nav>nav</nav><main>main</main><address>addr</address></section>' +
                    'x<hr>y',
            ),
        )

        expect(blockTexts(model)).toEqual([
            'loose text',
            'in div',
            'in p',
            'after p',
            'tail',
            'item 1',
            'item 2',
            'nested',
            'cap',
            'c1',
            'c2',
            'term',
            'def',
            'quote',
            'pre',
            'fig',
            'caption',
            'sum',
            'more',
            'head',
            'art',
            'side',
            'foot',
            'nav',
            'main',
            'addr',
            'x',
            'y',
        ])
    })

    it('does not end a block at an inline element', () => {
        const model = buildTextModel(
            makeBody('<p>a <span>b <em>c</em></span> <a>d</a> <sup>1</sup> <mark>e</mark> f</p>'),
        )

        expect(blockTexts(model)).toEqual(['a b c d 1 e f'])
    })

    it('marks heading blocks', () => {
        const model = buildTextModel(
            makeBody(
                '<h1>Title</h1><p>Text</p><h2>Part <em>one</em><br>Subtitle</h2>' +
                    '<h3><span>Deep</span></h3><h4>4</h4><h5>5</h5><h6>6</h6><p>End</p>',
            ),
        )

        expect(
            model.blocks.map((block) => [
                blockTexts(model)[model.blocks.indexOf(block)],
                block.heading,
            ]),
        ).toEqual([
            ['Title', true],
            ['Text', false],
            ['Part one', true],
            ['Subtitle', true],
            ['Deep', true],
            ['4', true],
            ['5', true],
            ['6', true],
            ['End', false],
        ])
    })

    it('gives sorted blocks that do not overlap', () => {
        const model = buildTextModel(
            makeBody(
                '<div>a<p>b</p>c<br>d<ul><li>e</li></ul></div><p>f<ruby>g<rt>x</rt></ruby>h</p>',
            ),
        )

        let previousEnd = 0
        for (const block of model.blocks) {
            expect(block.start).toBeGreaterThanOrEqual(previousEnd)
            expect(block.end).toBeGreaterThan(block.start)
            previousEnd = block.end
        }
        expect(blockTexts(model)).toEqual(['a', 'b', 'c', 'd', 'e', 'fgh'])
    })
})

describe('measureChapter', () => {
    it('gives the text length of the model', () => {
        const body = makeBody('<h1>T</h1><p>a <b>b</b><svg><text>no</text></svg> c</p>')

        expect(measureChapter(body).length).toBe(buildTextModel(body).text.length)
    })

    it('gives the offset of each id and each a name', () => {
        const body = makeBody(
            '<h1 id="top">Title</h1><p id="p1">One <a id="n1"></a>two<a name="old"></a></p>' +
                '<svg id="art"><g id="inner"></g></svg><p id="p2">Three</p><p id="end"></p>',
        )
        body.id = 'body-id'

        const { length, anchors } = measureChapter(body)

        expect(length).toBe(17)
        expect([...anchors]).toEqual([
            ['body-id', 0],
            ['top', 0],
            ['p1', 5],
            ['n1', 9],
            ['old', 12],
            ['art', 12],
            ['inner', 12],
            ['p2', 12],
            ['end', 17],
        ])
    })

    it('uses the first element when a name is there two times', () => {
        const body = makeBody('<p id="x">ab</p><p id="x">cd</p><a name="x"></a>')

        expect(measureChapter(body).anchors.get('x')).toBe(0)
    })
})

describe('createTextIndex', () => {
    const HTML =
        '<h1 id="h">Title</h1>' +
        '<p id="p1">One <em id="em">two</em> three<svg id="svg"><text>SVG</text></svg></p>' +
        '<p id="p2"><ruby>漢<rt id="rt">kan</rt></ruby>!</p>' +
        '<p id="empty"></p>'
    // Counted text: 'Title' 'One ' 'two' ' three' '漢' '!'  = "TitleOne two three漢!"

    it('has the length of the text model', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)

        expect(index.length).toBe(20)
        expect(index.length).toBe(buildTextModel(body).text.length)
    })

    it('locates an offset in the Text node that has the character', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)
        const text = buildTextModel(body).text

        for (let offset = 0; offset < index.length; offset++) {
            const point = index.locate(offset)!
            expect(point.node.data[point.offset], `offset ${offset}`).toBe(text[offset])
        }
    })

    it('locates a boundary offset at the start of the second node', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)

        const point = index.locate(5)!
        expect(point.node.data).toBe('One ')
        expect(point.offset).toBe(0)

        const inEm = index.locate(9)!
        expect(inEm.node.parentElement!.id).toBe('em')
        expect(inEm.offset).toBe(0)
    })

    it('locates the chapter length at the end of the last Text node', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)

        const point = index.locate(index.length)!
        expect(point.node.data).toBe('!')
        expect(point.offset).toBe(1)
    })

    it('clamps an offset that is out of range', () => {
        const index = createTextIndex(makeBody(HTML))

        expect(index.locate(-5)).toEqual(index.locate(0))
        expect(index.locate(999)).toEqual(index.locate(index.length))
        expect(index.locate(Number.NaN)).toEqual(index.locate(0))
        expect(index.locate(2.7)).toEqual(index.locate(2))
    })

    it('returns null when the chapter has no text', () => {
        const index = createTextIndex(makeBody('<p></p><svg><text>x</text></svg>'))

        expect(index.length).toBe(0)
        expect(index.locate(0)).toBeNull()
        expect(index.range(0, 0)).toBeNull()
    })

    it('gives the same offset back for each located point', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)

        for (let offset = 0; offset <= index.length; offset++) {
            const point = index.locate(offset)!
            expect(index.offsetOf(point.node, point.offset), `offset ${offset}`).toBe(offset)
        }
    })

    it('gives the offset of a position in an element', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)
        const p1 = body.querySelector('#p1')!

        expect(index.offsetOf(body, 0)).toBe(0)
        expect(index.offsetOf(body, 1)).toBe(5)
        expect(index.offsetOf(body, body.childNodes.length)).toBe(index.length)
        expect(index.offsetOf(p1, 0)).toBe(5)
        expect(index.offsetOf(p1, 1)).toBe(9)
        expect(index.offsetOf(p1, 2)).toBe(12)
        expect(index.offsetOf(p1, 3)).toBe(18)
        expect(index.offsetOf(p1, p1.childNodes.length)).toBe(18)
        expect(index.offsetOf(body.querySelector('#em')!, 1)).toBe(12)
        expect(index.offsetOf(body.querySelector('#empty')!, 0)).toBe(20)
    })

    it('gives the offset of the next counted character for text that is not counted', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)
        const svgText = body.querySelector('text')!.firstChild!
        const rtText = body.querySelector('#rt')!.firstChild!

        expect(index.offsetOf(svgText, 2)).toBe(18)
        expect(index.offsetOf(body.querySelector('text')!, 0)).toBe(18)
        expect(index.offsetOf(rtText, 1)).toBe(19)
        expect(index.offsetOf(body.querySelector('#rt')!, 1)).toBe(19)
    })

    it('returns -1 for a node that is not below the body', () => {
        const index = createTextIndex(makeBody(HTML))
        const other = makeBody('<p>other</p>')

        expect(index.offsetOf(other.firstChild!.firstChild!, 0)).toBe(-1)
        expect(index.offsetOf(document.body, 0)).toBe(-1)
        expect(index.offsetOfElement(other.querySelector('p')!)).toBe(-1)
    })

    it('gives the offset of the first counted character of an element', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)
        const offsetOf = (selector: string) => index.offsetOfElement(body.querySelector(selector)!)

        expect(index.offsetOfElement(body)).toBe(0)
        expect(offsetOf('#h')).toBe(0)
        expect(offsetOf('#p1')).toBe(5)
        expect(offsetOf('#em')).toBe(9)
        expect(offsetOf('#svg')).toBe(18)
        expect(offsetOf('#p2')).toBe(18)
        expect(offsetOf('#rt')).toBe(19)
        expect(offsetOf('#empty')).toBe(20)
    })

    it('agrees with measureChapter for each anchor', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)

        for (const [id, offset] of measureChapter(body).anchors) {
            expect(index.offsetOfElement(body.querySelector(`#${id}`)!), id).toBe(offset)
        }
    })

    it('makes a range for a run of text', () => {
        const body = makeBody(HTML)
        document.body.appendChild(body)
        const index = createTextIndex(body)

        expect(index.range(5, 12)!.toString()).toBe('One two')
        expect(index.range(9, 12)!.toString()).toBe('two')
        expect(index.range(12, 5)!.toString()).toBe('One two')
        // A range also has the text between its ends that is not counted.
        expect(index.range(5, 19)!.toString()).toBe('One two threeSVG漢')
        const all = index.range(-3, 999)!
        expect((all.startContainer as Text).data).toBe('Title')
        expect(all.startOffset).toBe(0)
        expect((all.endContainer as Text).data).toBe('!')
        expect(all.endOffset).toBe(1)
        expect(index.range(7, 7)!.collapsed).toBe(true)
        body.remove()
    })

    it('ends a range in the node that has the last character', () => {
        const body = makeBody(HTML)
        const index = createTextIndex(body)

        const range = index.range(0, 5)!
        expect((range.endContainer as Text).data).toBe('Title')
        expect(range.endOffset).toBe(5)
    })

    it('gives the same offsets from a new index after a mark was put in a Text node', () => {
        const body = makeBody('<p>Hello brave world</p><p>Next <b>bold</b> end</p>')
        const text = buildTextModel(body).text
        const first = body.querySelector('p')!.firstChild as Text

        const mark = wrapInMark({ node: first, start: 6, end: 11 })
        const index = createTextIndex(body)

        expect(index.length).toBe(text.length)
        expect(index.offsetOf(mark.firstChild!, 0)).toBe(6)
        expect(index.offsetOf(mark.firstChild!, 3)).toBe(9)
        expect(index.offsetOf(mark, 0)).toBe(6)
        expect(index.offsetOf(mark, 1)).toBe(11)
        expect(index.offsetOfElement(mark)).toBe(6)
        expect(index.offsetOf(mark.nextSibling!, 2)).toBe(13)
        expect(index.locate(6)).toEqual({ node: mark.firstChild, offset: 0 })
        expect(index.range(6, 11)!.toString()).toBe('brave')
        for (let offset = 0; offset <= index.length; offset++) {
            const point = index.locate(offset)!
            expect(index.offsetOf(point.node, point.offset)).toBe(offset)
            if (offset < index.length) expect(point.node.data[point.offset]).toBe(text[offset])
        }
    })

    it('gives the offset of a Text node in a mark that was added after the index was made', () => {
        const body = makeBody('<p>Hello brave world</p><p>Next</p>')
        const first = body.querySelector('p')!.firstChild as Text
        const index = createTextIndex(body)

        const mark = wrapInMark({ node: first, start: 6, end: 11 })

        expect(index.offsetOf(first, 3)).toBe(3)
        expect(index.offsetOf(mark.firstChild!, 0)).toBe(6)
        expect(index.offsetOf(mark.firstChild!, 4)).toBe(10)
        expect(index.offsetOf(mark.nextSibling!, 1)).toBe(12)
        expect(index.offsetOf(body.querySelectorAll('p')[1].firstChild!, 2)).toBe(19)
    })

    it('gives the same offsets from a new index after the mark was removed', () => {
        const body = makeBody('<p>Hello brave world</p>')
        const paragraph = body.querySelector('p')!
        const mark = wrapInMark({ node: paragraph.firstChild as Text, start: 6, end: 11 })

        mark.replaceWith(...mark.childNodes)
        paragraph.normalize()
        const index = createTextIndex(body)

        expect(paragraph.childNodes).toHaveLength(1)
        expect(index.locate(8)).toEqual({ node: paragraph.firstChild, offset: 8 })
        expect(index.offsetOf(paragraph.firstChild!, 8)).toBe(8)
    })
})

describe('tokenizeWords', () => {
    it('splits each block at white space', () => {
        const model = buildTextModel(
            makeBody('<p>Hello,  brave\n“new” world!</p><p> One-two\u00a0three </p>'),
        )
        const words = tokenizeWords(model)

        expect(words.map((word) => word.text)).toEqual([
            'Hello,',
            'brave',
            '“new”',
            'world!',
            'One-two',
            'three',
        ])
        for (const word of words) {
            expect(model.text.slice(word.start, word.end)).toBe(word.text)
            expect(word.text).not.toMatch(/\s/)
        }
    })

    it('never joins words of two blocks', () => {
        const model = buildTextModel(makeBody('<p>end</p><p>start</p><h2>Head</h2>line<br>break'))
        const words = tokenizeWords(model)

        expect(model.text).toBe('endstartHeadlinebreak')
        expect(words.map((word) => [word.text, word.block])).toEqual([
            ['end', 0],
            ['start', 1],
            ['Head', 2],
            ['line', 3],
            ['break', 4],
        ])
    })

    it('marks the last word of each block', () => {
        const model = buildTextModel(makeBody('<p>a b c</p><p>d</p><p>e f</p>'))

        expect(tokenizeWords(model).map((word) => word.endsBlock)).toEqual([
            false,
            false,
            true,
            true,
            false,
            true,
        ])
    })

    it('joins the text of inline elements into one word', () => {
        const model = buildTextModel(makeBody('<p>un<em>believ</em>able<sup>1</sup> x</p>'))

        expect(tokenizeWords(model).map((word) => word.text)).toEqual(['unbelievable1', 'x'])
    })

    it('gives no words for an empty model', () => {
        expect(tokenizeWords({ text: '', blocks: [] })).toEqual([])
    })
})

describe('segmentSentences', () => {
    const sentenceTexts = (model: TextModel, locale?: string | null) =>
        segmentSentences({ model, locale }).map((sentence) =>
            model.text.slice(sentence.start, sentence.end),
        )

    it('splits each block into sentences with no white space at the end', () => {
        const model = buildTextModel(
            makeBody('<p>Hello there. How are you?  I am fine!</p><p>Next block</p>'),
        )
        const sentences = segmentSentences({ model, locale: 'en' })

        expect(sentenceTexts(model, 'en')).toEqual([
            'Hello there.',
            'How are you?',
            'I am fine!',
            'Next block',
        ])
        expect(sentences.map((sentence) => sentence.block)).toEqual([0, 0, 0, 1])
    })

    it('never joins two blocks into one sentence', () => {
        const model = buildTextModel(
            makeBody('<h1>A title with no full stop</h1><p>and a paragraph.</p>'),
        )

        expect(sentenceTexts(model, 'en')).toEqual([
            'A title with no full stop',
            'and a paragraph.',
        ])
    })

    it('accepts a bad or missing locale', () => {
        const model = buildTextModel(makeBody('<p>One. Two.</p>'))

        expect(sentenceTexts(model, 'en_US')).toEqual(['One.', 'Two.'])
        expect(sentenceTexts(model, 'not a locale!')).toEqual(['One.', 'Two.'])
        expect(sentenceTexts(model, null)).toEqual(['One.', 'Two.'])
        expect(sentenceTexts(model)).toEqual(['One.', 'Two.'])
    })

    it('splits after a full stop, a question mark or an exclamation mark when Intl.Segmenter is not there', () => {
        vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined })
        const model = buildTextModel(
            makeBody('<p>First one. Second one?  “Third one!” Fourth, 3.5 in all</p><p>Other.</p>'),
        )
        const sentences = segmentSentences({ model, locale: 'en' })

        expect(sentenceTexts(model, 'en')).toEqual([
            'First one.',
            'Second one?',
            '“Third one!”',
            'Fourth, 3.5 in all',
            'Other.',
        ])
        expect(sentences.map((sentence) => sentence.block)).toEqual([0, 0, 0, 0, 1])
    })

    it('reads a long run of full stops in linear time when Intl.Segmenter is not there', () => {
        vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined })
        const text = `Wait${'.'.repeat(100_000)}and then. Next one.`
        const start = performance.now()

        const sentences = segmentSentences({
            model: { text, blocks: [{ start: 0, end: text.length, heading: false }] },
        })

        expect(performance.now() - start).toBeLessThan(2000)
        expect(sentences).toEqual([
            { start: 0, end: 100_013, block: 0 },
            { start: 100_014, end: text.length, block: 0 },
        ])
    })

    it('gives no sentences for an empty model', () => {
        expect(segmentSentences({ model: { text: '', blocks: [] } })).toEqual([])
    })
})
