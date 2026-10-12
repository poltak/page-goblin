import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IconName } from './dom'
import { cloneTemplate, on, qs, qsa, setIcon, setRangeValue } from './dom'

const ICON_NAMES = [
    'book',
    'book-open',
    'library',
    'plus',
    'upload',
    'search',
    'x',
    'check',
    'chevron-left',
    'chevron-right',
    'chevron-down',
    'chevron-up',
    'arrow-left',
    'list',
    'bookmark',
    'bookmark-filled',
    'highlighter',
    'note',
    'type',
    'sliders',
    'sun',
    'moon',
    'play',
    'pause',
    'rewind',
    'skip-back',
    'skip-forward',
    'zap',
    'headphones',
    'volume',
    'trash',
    'more',
    'maximize',
    'minimize',
    'info',
    'download',
    'copy',
    'columns',
    'scroll',
    'page',
    'minus',
    'external-link',
    'edit',
    'palette',
    'rotate-ccw',
    'text-size',
    'align-left',
    'align-justify',
    'eye',
    'clock',
] as const satisfies readonly IconName[]

// The type check fails here when IconName has a name that is not in the list above.
const allNamesListed: Exclude<IconName, (typeof ICON_NAMES)[number]> extends never ? true : never =
    true

function read(path: string): string {
    return readFileSync(join(import.meta.dirname, path), 'utf8')
}

afterEach(() => {
    document.body.innerHTML = ''
})

describe('qs', () => {
    it('returns the first match', () => {
        document.body.innerHTML = '<p class="a">one</p><p class="a">two</p>'
        expect(qs('.a').textContent).toBe('one')
    })

    it('searches below the root that it gets', () => {
        document.body.innerHTML = '<p>out</p><div><p>in</p></div>'
        const root = qs<HTMLDivElement>('div')
        expect(qs('p', root).textContent).toBe('in')
    })

    it('throws an error that names the selector', () => {
        expect(() => qs('#missing')).toThrow('No element matches "#missing"')
    })
})

describe('qsa', () => {
    it('returns all matches as an array', () => {
        document.body.innerHTML = '<i>1</i><i>2</i><b>3</b>'
        const found = qsa('i')
        expect(Array.isArray(found)).toBe(true)
        expect(found.map((element) => element.textContent)).toEqual(['1', '2'])
    })

    it('returns an empty array when nothing matches', () => {
        expect(qsa('i')).toEqual([])
    })
})

describe('on', () => {
    it('adds the listener and returns a function that removes it', () => {
        const button = document.createElement('button')
        const listener = vi.fn()
        const off = on(button, 'click', listener)
        button.click()
        expect(listener).toHaveBeenCalledTimes(1)
        off()
        button.click()
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('removes a capture listener', () => {
        document.body.innerHTML = '<div><button></button></div>'
        const listener = vi.fn()
        const off = on(qs('div'), 'click', listener, { capture: true })
        qs('button').click()
        off()
        qs('button').click()
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('passes the options to addEventListener', () => {
        const button = document.createElement('button')
        const listener = vi.fn()
        on(button, 'click', listener, { once: true })
        button.click()
        button.click()
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('works with the document, the window and other event targets', () => {
        const listener = vi.fn()
        const offs = [
            on(document, 'visibilitychange', listener),
            on(window, 'resize', listener),
            on<CustomEvent<number>>(new EventTarget(), 'tick', (event) => listener(event.detail)),
        ]
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('resize'))
        expect(listener).toHaveBeenCalledTimes(2)
        offs.forEach((off) => off())
        window.dispatchEvent(new Event('resize'))
        expect(listener).toHaveBeenCalledTimes(2)
    })
})

describe('cloneTemplate', () => {
    it('returns a new copy of the first element on each call', () => {
        document.body.innerHTML =
            '<template id="row"> <li class="row"><span>x</span></li> <li>other</li></template>'
        const first = cloneTemplate<HTMLLIElement>('row')
        const second = cloneTemplate('row')
        expect(first.outerHTML).toBe('<li class="row"><span>x</span></li>')
        expect(first.ownerDocument).toBe(document)
        expect(second).not.toBe(first)
        first.querySelector('span')!.textContent = 'changed'
        expect(cloneTemplate('row').textContent).toBe('x')
    })

    it('throws when the id is missing or is not a template', () => {
        document.body.innerHTML = '<div id="plain"></div>'
        expect(() => cloneTemplate('missing')).toThrow('No template has the id "missing"')
        expect(() => cloneTemplate('plain')).toThrow('No template has the id "plain"')
    })

    it('throws when the template has no element', () => {
        document.body.innerHTML = '<template id="empty">text</template>'
        expect(() => cloneTemplate('empty')).toThrow('The template "empty" has no element')
    })
})

describe('setIcon', () => {
    it('changes the symbol of the use element', () => {
        document.body.innerHTML = '<svg class="icon"><use href="#i-play"></use></svg>'
        const svg = qs<SVGSVGElement>('svg')
        setIcon(svg, 'pause')
        expect(svg.innerHTML).toBe('<use href="#i-pause"></use>')
    })

    it('adds a use element in the SVG namespace when there is none', () => {
        document.body.innerHTML = '<svg class="icon"></svg>'
        const svg = qs<SVGSVGElement>('svg')
        setIcon(svg, 'book')
        const use = svg.firstElementChild!
        expect(use.namespaceURI).toBe('http://www.w3.org/2000/svg')
        expect(use.getAttribute('href')).toBe('#i-book')
        expect(svg.childElementCount).toBe(1)
    })
})

describe('setRangeValue', () => {
    function range(attributes: Record<string, string>): HTMLInputElement {
        const input = document.createElement('input')
        input.type = 'range'
        for (const [name, value] of Object.entries(attributes)) input.setAttribute(name, value)
        return input
    }

    function fraction(input: HTMLInputElement): number {
        setRangeValue(input)
        return Number(input.style.getPropertyValue('--value'))
    }

    it('sets the fraction from the value, the minimum and the maximum', () => {
        expect(fraction(range({ min: '10', max: '30', value: '15' }))).toBe(0.25)
        expect(fraction(range({ min: '0.5', max: '2', step: '0.1', value: '2' }))).toBe(1)
        expect(fraction(range({ min: '-10', max: '10', value: '-10' }))).toBe(0)
    })

    it('uses 0 and 100 when the input has no minimum and maximum', () => {
        expect(fraction(range({ value: '40' }))).toBe(0.4)
    })

    it('follows a new value', () => {
        const input = range({ min: '0', max: '4', value: '1' })
        expect(fraction(input)).toBe(0.25)
        input.value = '3'
        expect(fraction(input)).toBe(0.75)
    })

    it('gives 0 when the maximum is not above the minimum', () => {
        expect(fraction(range({ min: '5', max: '5', value: '5' }))).toBe(0)
    })

    // The browser uses its default for a minimum or maximum that is not a number.
    it('uses 0 and 100 when the minimum or the maximum is not a number', () => {
        expect(fraction(range({ min: 'low', max: '50', value: '25' }))).toBe(0.5)
        expect(fraction(range({ min: '20', max: 'high', value: '60' }))).toBe(0.5)
    })

    it('never sets a value that CSS cannot use in calc()', () => {
        const input = document.createElement('input')
        input.value = 'not a number'
        setRangeValue(input)
        expect(input.style.getPropertyValue('--value')).toBe('0')
    })
})

describe('icon sprite', () => {
    const sprite = read('./icons.svg')
    const symbols = [...sprite.matchAll(/<symbol\b[^>]*>/g)].map((match) => match[0])

    it('has one symbol for each icon name, and no other symbol', () => {
        expect(allNamesListed).toBe(true)
        const ids = symbols.map((symbol) => /\bid="([^"]+)"/.exec(symbol)?.[1])
        expect(ids).toEqual(ICON_NAMES.map((name) => `i-${name}`))
    })

    it('draws each symbol on the 24 pixel grid with the stroke of the set', () => {
        for (const symbol of symbols) {
            expect(symbol).toContain('viewBox="0 0 24 24"')
            expect(symbol).toContain('stroke="currentColor"')
            expect(symbol).toContain('stroke-width="1.75"')
            expect(symbol).toContain('stroke-linecap="round"')
            expect(symbol).toContain('stroke-linejoin="round"')
        }
    })

    it('is well-formed XML with a shape in each symbol', () => {
        const parsed = new DOMParser().parseFromString(sprite, 'image/svg+xml')
        expect(parsed.querySelector('parsererror')).toBeNull()
        for (const symbol of parsed.querySelectorAll('symbol')) {
            expect(symbol.querySelector('path, rect, circle'), symbol.id).not.toBeNull()
        }
    })

    // kit.html has a copy of the sprite until the build puts the sprite into the pages.
    it('has the same shapes in the copy inside kit.html', () => {
        const kit = read('../../kit.html')
        if (!kit.includes('<symbol')) return
        const shapes = (text: string) =>
            [...text.matchAll(/\b(?:id|d|x|y|cx|cy|r|rx|width|height)="[^"]*"/g)]
                .map((match) => match[0])
                .filter((attribute) => !attribute.startsWith('id=') || attribute.includes('"i-'))
        const start = kit.indexOf('<symbol')
        const copy = kit.slice(start, kit.lastIndexOf('</symbol>'))
        expect(shapes(copy)).toEqual(shapes(sprite))
    })
})
