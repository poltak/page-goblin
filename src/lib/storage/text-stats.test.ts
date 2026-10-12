import { describe, expect, it } from 'vitest'
import { estimateTextStats } from './text-stats'

describe('estimateTextStats', () => {
    it('counts the characters and words of the body text', () => {
        const xhtml = `<?xml version="1.0" encoding="utf-8"?>
            <html xmlns="http://www.w3.org/1999/xhtml">
                <head><title>Not counted</title></head>
                <body class="chapter">
                    <h1>Chapter one</h1>
                    <p>It was a dark night.</p>
                </body>
            </html>`

        // 'Chapter one It was a dark night.'
        expect(estimateTextStats(xhtml)).toEqual({ chars: 32, words: 7 })
    })

    it('gives zero for a document with no text', () => {
        expect(estimateTextStats('')).toEqual({ chars: 0, words: 0 })
        expect(estimateTextStats('  \n\t ')).toEqual({ chars: 0, words: 0 })
        expect(estimateTextStats('<html><body><img src="a.jpg"/><br/></body></html>')).toEqual({
            chars: 0,
            words: 0,
        })
    })

    it('finds a body tag with attributes, upper case or line breaks', () => {
        expect(estimateTextStats('<head>skip</head><BODY>one two</BODY>')).toEqual({
            chars: 7,
            words: 2,
        })
        expect(estimateTextStats('<head>skip</head><body\n  id="b"\n>one two</body>')).toEqual({
            chars: 7,
            words: 2,
        })
    })

    it('uses the whole string when there is no body tag', () => {
        expect(estimateTextStats('<p>one two</p><p>three</p>')).toEqual({ chars: 13, words: 3 })
        expect(estimateTextStats('plain text only')).toEqual({ chars: 15, words: 3 })
        expect(
            estimateTextStats('<head><style>p { color: red }</style></head><p>text</p>'),
        ).toEqual({ chars: 4, words: 1 })
    })

    it('removes script elements with their content', () => {
        const xhtml = `<body>
            <p>before</p>
            <script type="text/javascript">
                if (a < b && c > d) { document.write('<p>not text</p>') }
            </script>
            <SCRIPT>var upper = 1</SCRIPT>
            <p>after</p>
        </body>`

        expect(estimateTextStats(xhtml)).toEqual({ chars: 12, words: 2 })
    })

    it('removes style elements with their content', () => {
        const xhtml = `<body>
            <style type="text/css">
                p > span { margin: 0 }
                /* a comment */
            </style>
            <p>only this</p>
        </body>`

        expect(estimateTextStats(xhtml)).toEqual({ chars: 9, words: 2 })
    })

    it('keeps the text after a script element that closes itself', () => {
        const xhtml =
            '<body><script src="a.js"/><p>one two</p><script>x()</script><p>three</p></body>'

        expect(estimateTextStats(xhtml)).toEqual({ chars: 13, words: 3 })
    })

    it('removes comments', () => {
        expect(estimateTextStats('<body>one <!-- two > three <p> --> four</body>')).toEqual({
            chars: 8,
            words: 2,
        })
    })

    it('separates the words of adjacent blocks', () => {
        expect(estimateTextStats('<body><p>one</p><p>two</p><div>three</div></body>')).toEqual({
            chars: 13,
            words: 3,
        })
        expect(estimateTextStats('<body>one<br/>two<br>three</body>')).toEqual({
            chars: 13,
            words: 3,
        })
    })

    it('does not split a word at an inline tag', () => {
        expect(
            estimateTextStats('<body><p><span class="dropcap">O</span>nce upon</p></body>'),
        ).toEqual({ chars: 9, words: 2 })
        expect(
            estimateTextStats('<body>un<em>believ</em>able <b>bold</b>, <i>it</i>.</body>'),
        ).toEqual({ chars: 22, words: 3 })
    })

    it('decodes the five basic entities', () => {
        // 'a & b < c > d "e" 'f''
        expect(
            estimateTextStats('<p>a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;</p>'),
        ).toEqual({ chars: 21, words: 9 })
    })

    it('decodes numeric entities', () => {
        // 'don' + U+2019 + 't' and 'A', then one emoji that has two UTF-16 code units.
        expect(estimateTextStats('<p>don&#8217;t &#x41; &#x1F600;</p>')).toEqual({
            chars: 10,
            words: 3,
        })
    })

    it('treats a non-breaking space as white space', () => {
        expect(estimateTextStats('<p>&nbsp;&nbsp;one&#160;two&#xA0;three&nbsp;</p>')).toEqual({
            chars: 13,
            words: 3,
        })
    })

    it('does not decode an entity two times and does not make a tag from an entity', () => {
        // '&lt;' stays as four characters. '<b>' stays as three characters of text.
        expect(estimateTextStats('<p>&amp;lt; &lt;b&gt;</p>')).toEqual({ chars: 8, words: 2 })
    })

    it('keeps an entity that it does not know as written', () => {
        // 'a &unknown; b &#99999999999; c'
        expect(estimateTextStats('<p>a &unknown; b &#99999999999; c</p>')).toEqual({
            chars: 30,
            words: 5,
        })
    })

    it('collapses all white space', () => {
        expect(estimateTextStats('<body>\n\n  one \t\r\n two\u00a0\u2003three  \n</body>')).toEqual(
            {
                chars: 13,
                words: 3,
            },
        )
    })

    it('measures a large chapter fast', () => {
        const paragraph =
            '<p class="calibre1">It was a <i>bright</i> cold day in April, and the clocks were striking thirteen&#8230;</p>\n'
        const xhtml = `<html><head><style>p{margin:0}</style></head><body>${paragraph.repeat(20_000)}</body></html>`
        expect(xhtml.length).toBeGreaterThan(2_000_000)

        const start = performance.now()
        const stats = estimateTextStats(xhtml)
        const elapsed = performance.now() - start

        expect(stats.words).toBe(20_000 * 14)
        // A wide limit. The usual time is about 15 ms. A quadratic pattern takes seconds.
        expect(elapsed).toBeLessThan(1000)
    })

    it('drops the text after a script, a style or a comment that has no end', () => {
        // A browser also reads the remainder of such a document as script, style or comment.
        expect(estimateTextStats('<body><p>one two</p><script>three four')).toEqual({
            chars: 7,
            words: 2,
        })
        expect(estimateTextStats('<body><p>one two</p><STYLE>p { margin: 0 }')).toEqual({
            chars: 7,
            words: 2,
        })
        expect(estimateTextStats('<body><p>one two</p><!-- three <p>four</p>')).toEqual({
            chars: 7,
            words: 2,
        })
    })

    it.each(['<script>', '<style>p{}', '<!-- a ', '<script></style>', '<!-- a --!>'])(
        'stays fast with many "%s" that have no end',
        (opener) => {
            // A file of this type can come from a book that wants to stop the app.
            const xhtml = `<body><p>one two</p>${opener.repeat(100_000)}`

            const start = performance.now()
            const stats = estimateTextStats(xhtml)
            const elapsed = performance.now() - start

            expect(stats).toEqual({ chars: 7, words: 2 })
            // The usual time is some milliseconds. A quadratic pattern takes many seconds.
            expect(elapsed).toBeLessThan(1000)
        },
    )

    it('keeps a "<" that is not a tag as text and stays fast with many of them', () => {
        expect(estimateTextStats('<p>a < b</p><p>c</p>')).toEqual({ chars: 7, words: 4 })

        const start = performance.now()
        const stats = estimateTextStats('a < b '.repeat(50_000))
        const elapsed = performance.now() - start

        expect(stats.words).toBe(150_000)
        expect(elapsed).toBeLessThan(1000)
    })
})
