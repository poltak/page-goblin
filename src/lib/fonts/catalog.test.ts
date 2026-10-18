import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '$lib/settings/schema'
import {
    bookFontEntries,
    ensureFontLoaded,
    userFontEntries,
    userFontIdOf,
    FONT_CATALOG,
    FONT_LOAD_LIMIT_MS,
    groupedFontEntries,
    PUBLISHER_FONT_ID,
    resolveFontStack,
} from './catalog'
import type { FontEntry } from './catalog'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../../..')

const BUNDLED_CATEGORIES = ['serif', 'sans', 'accessible', 'mono']
const bundled = FONT_CATALOG.filter((entry) => BUNDLED_CATEGORIES.includes(entry.category))

function entryOf(id: string): Required<FontEntry> {
    const entry = FONT_CATALOG.find((candidate) => candidate.id === id)
    if (!entry) throw new Error(`No font entry ${id}`)
    return entry as Required<FontEntry>
}

function labelsIn(category: string): string[] {
    return FONT_CATALOG.filter((entry) => entry.category === category).map((entry) => entry.label)
}

/** The first family of a stack, without the quotation marks. */
function firstFamily(stack: string): string {
    return /^"([^"]+)"/.exec(stack)?.[1] ?? ''
}

function stubDocumentFonts(load: (font: string) => Promise<unknown>) {
    const mock = vi.fn(load)
    Object.defineProperty(document, 'fonts', { value: { load: mock }, configurable: true })
    return mock
}

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'fonts')
})

describe('FONT_CATALOG', () => {
    it('has unique ids and unique labels', () => {
        const ids = FONT_CATALOG.map((entry) => entry.id)
        const labels = FONT_CATALOG.map((entry) => entry.label)
        expect(new Set(ids).size).toBe(ids.length)
        expect(new Set(labels).size).toBe(labels.length)
        for (const entry of FONT_CATALOG) {
            expect(entry.id).toMatch(/^[a-z0-9-]+$/)
            expect(entry.label).not.toBe('')
        }
    })

    it('starts with the publisher font, which has no stack and no load function', () => {
        expect(FONT_CATALOG[0]).toEqual({
            id: 'publisher',
            label: 'Publisher font',
            category: 'publisher',
            stack: null,
        })
        expect(labelsIn('publisher')).toEqual(['Publisher font'])
    })

    it('has the specified fonts in each category', () => {
        expect(labelsIn('serif')).toEqual([
            'Literata',
            'Source Serif 4',
            'EB Garamond',
            'Lora',
            'Merriweather',
            'Crimson Pro',
            'Newsreader',
            'Libre Baskerville',
        ])
        expect(labelsIn('sans')).toEqual(['Inter', 'Source Sans 3'])
        expect(labelsIn('accessible')).toEqual([
            'Atkinson Hyperlegible Next',
            'Lexend',
            'OpenDyslexic',
        ])
        expect(labelsIn('mono')).toEqual(['JetBrains Mono'])
        expect(labelsIn('system')).toEqual(['System serif', 'System sans', 'Georgia', 'Charter'])
        expect(labelsIn('book')).toEqual([])
    })

    it('has the specified system stacks', () => {
        expect(entryOf('system-serif').stack).toBe(
            'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
        )
        expect(entryOf('system-sans').stack).toBe(
            'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        )
        expect(entryOf('georgia').stack).toMatch(/^Georgia, .*serif$/)
        expect(entryOf('charter').stack).toBe(
            'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
        )
    })

    it('gives a load function only to the bundled fonts', () => {
        expect(bundled).toHaveLength(14)
        for (const entry of FONT_CATALOG) {
            expect(typeof entry.load, entry.id).toBe(
                bundled.includes(entry) ? 'function' : 'undefined',
            )
        }
    })

    it('has no URL in a stack, so a stack never starts a download itself', () => {
        for (const entry of FONT_CATALOG) {
            expect(entry.stack ?? '').not.toMatch(/url\(|https?:/i)
        }
    })

    it.each(bundled.map((entry) => [entry.id, entry] as const))(
        '%s: the stack ends with a generic family of the same class',
        (_id, entry) => {
            const generic = entry.category === 'serif' ? 'serif' : 'sans-serif'
            const expected = entry.category === 'mono' ? 'monospace' : generic
            expect(entry.stack!.split(', ').at(-1)).toBe(expected)
        },
    )

    // A wrong family name fails with no error in the browser: the text only shows in the
    // fallback font. So compare the names with the CSS of the installed packages.
    it.each(bundled.map((entry) => [entry.id, entry] as const))(
        '%s: the stack starts with the family name of the package CSS',
        (id, entry) => {
            const wrapper = readFileSync(resolve(here, 'families', `${id}.css`), 'utf8')
            const imports = [...wrapper.matchAll(/@import '([^']+)';/g)].map((match) => match[1])
            expect(imports.length).toBeGreaterThan(0)
            expect(wrapper.replace(/@import '[^']+';\s*/g, '')).toBe('')

            const family = firstFamily(entry.stack!)
            expect(family).not.toBe('')
            for (const specifier of imports) {
                const file = resolve(projectRoot, 'node_modules', specifier)
                expect(existsSync(file), specifier).toBe(true)
                const declared = new Set(
                    [...readFileSync(file, 'utf8').matchAll(/font-family:\s*'([^']+)'/g)].map(
                        (match) => match[1],
                    ),
                )
                expect([...declared], specifier).toEqual([family])
            }
        },
    )

    // An entry that imports the file of a different family shows the fallback font with no error.
    it('gives each bundled entry the CSS file that has its id as the name', () => {
        const code = readFileSync(resolve(here, 'catalog.ts'), 'utf8')
        const pairs = [
            ...code.matchAll(
                /bundled\(\{\s*id: '([^']+)',[^}]*?import\('\.\/families\/([^']+)\.css'\)/g,
            ),
        ].map((match) => [match[1], match[2]])
        expect(pairs.map(([id]) => id)).toEqual(bundled.map((entry) => entry.id))
        for (const [id, file] of pairs) expect(file).toBe(id)
        expect(code.match(/import\('/g)).toHaveLength(bundled.length)
    })

    it('imports the weight files and the italic files that each package has', () => {
        const importsOf = (id: string) =>
            [
                ...readFileSync(resolve(here, 'families', `${id}.css`), 'utf8').matchAll(
                    /@import '([^']+)';/g,
                ),
            ].map((match) => match[1])

        for (const entry of bundled) {
            const imports = importsOf(entry.id)
            const packageName = imports[0].split('/').slice(0, 2).join('/')
            const packageDir = resolve(projectRoot, 'node_modules', packageName)
            const wanted = packageName.startsWith('@fontsource-variable/')
                ? ['wght.css', 'wght-italic.css']
                : ['400.css', '400-italic.css', '700.css', '700-italic.css']
            const available = wanted.filter((file) => existsSync(resolve(packageDir, file)))
            expect(imports, entry.id).toEqual(available.map((file) => `${packageName}/${file}`))
        }
        expect(importsOf('lexend')).toEqual(['@fontsource-variable/lexend/wght.css'])
    })
})

describe('bookFontEntries', () => {
    it('makes one entry for each font family of the book', () => {
        expect(bookFontEntries(['Minion Pro', 'Zapfino'])).toEqual([
            {
                id: 'book:Minion Pro',
                label: 'Minion Pro',
                category: 'book',
                stack: '"Minion Pro", serif',
            },
            { id: 'book:Zapfino', label: 'Zapfino', category: 'book', stack: '"Zapfino", serif' },
        ])
        expect(bookFontEntries([])).toEqual([])
    })

    it('escapes the characters that end a CSS string', () => {
        const [entry] = bookFontEntries(['Bad "Name"\\ \n x'])
        expect(entry.id).toBe('book:Bad "Name"\\ \n x')
        expect(entry.stack).toBe('"Bad \\"Name\\"\\\\ \\a  x", serif')
    })
})

describe('resolveFontStack', () => {
    const bookFonts = ['Minion Pro', 'Zapfino']

    it('gives null for the publisher font, which is the default setting', () => {
        expect(resolveFontStack({ fontId: 'publisher', bookFonts })).toBeNull()
        expect(DEFAULT_SETTINGS.fontId).toBe(PUBLISHER_FONT_ID)
        expect(resolveFontStack({ fontId: DEFAULT_SETTINGS.fontId, bookFonts })).toBeNull()
    })

    it('gives the stack of each catalogue entry', () => {
        for (const entry of FONT_CATALOG) {
            expect(resolveFontStack({ fontId: entry.id, bookFonts: [] })).toBe(entry.stack)
        }
        expect(resolveFontStack({ fontId: 'literata', bookFonts })).toBe(
            '"Literata Variable", Georgia, "Times New Roman", serif',
        )
    })

    it('gives the stack of a font that the open book has', () => {
        expect(resolveFontStack({ fontId: 'book:Minion Pro', bookFonts })).toBe(
            '"Minion Pro", serif',
        )
        for (const entry of bookFontEntries(bookFonts)) {
            expect(resolveFontStack({ fontId: entry.id, bookFonts })).toBe(entry.stack)
        }
    })

    it('gives null for a book font that the open book does not have', () => {
        expect(resolveFontStack({ fontId: 'book:Minion Pro', bookFonts: [] })).toBeNull()
        expect(resolveFontStack({ fontId: 'book:Minion Pro', bookFonts: ['Zapfino'] })).toBeNull()
        expect(resolveFontStack({ fontId: 'book:minion pro', bookFonts })).toBeNull()
        expect(resolveFontStack({ fontId: 'book:', bookFonts })).toBeNull()
    })

    it('does not use a catalogue font for a book id, or a book font for a plain id', () => {
        expect(resolveFontStack({ fontId: 'book:literata', bookFonts })).toBeNull()
        expect(resolveFontStack({ fontId: 'Minion Pro', bookFonts })).toBeNull()
    })

    it('gives null for an id that is not known', () => {
        for (const fontId of ['', 'removed-font', 'Literata', 'toString', '__proto__']) {
            expect(resolveFontStack({ fontId, bookFonts })).toBeNull()
        }
    })
})

describe('fonts of the user', () => {
    const userFonts = [
        { id: 'b', name: 'Zed Serif', fallback: 'serif' as const },
        { id: 'a', name: 'My Mono', fallback: 'monospace' as const },
    ]

    it('makes entries sorted by name with an internal family name', () => {
        expect(userFontEntries(userFonts)).toEqual([
            {
                id: 'user:a',
                label: 'My Mono',
                category: 'user',
                stack: '"pg-font-a", monospace',
            },
            { id: 'user:b', label: 'Zed Serif', category: 'user', stack: '"pg-font-b", serif' },
        ])
    })

    it('gives the stack of a font of the user, and null for a font that is gone', () => {
        expect(resolveFontStack({ fontId: 'user:b', bookFonts: [], userFonts })).toBe(
            '"pg-font-b", serif',
        )
        expect(resolveFontStack({ fontId: 'user:c', bookFonts: [], userFonts })).toBeNull()
        expect(resolveFontStack({ fontId: 'user:b', bookFonts: [] })).toBeNull()
        expect(resolveFontStack({ fontId: 'user:', bookFonts: [], userFonts })).toBeNull()
    })

    it('never puts the name from the font file into the stack', () => {
        const hostile = [{ id: 'x', name: '"; } body { color: red', fallback: 'serif' as const }]
        expect(resolveFontStack({ fontId: 'user:x', bookFonts: [], userFonts: hostile })).toBe(
            '"pg-font-x", serif',
        )
    })

    it('reads the record id from a setting', () => {
        expect(userFontIdOf('user:abc')).toBe('abc')
        expect(userFontIdOf('book:abc')).toBeNull()
        expect(userFontIdOf('literata')).toBeNull()
    })

    it('puts the fonts of the user in their own group after the fonts of the book', () => {
        const groups = groupedFontEntries(['Minion Pro'], userFonts)
        expect(groups.map((group) => group.label)).toEqual([
            'This book',
            'Your fonts',
            'Serif',
            'Sans serif',
            'Accessibility',
            'Monospace',
            'On this device',
        ])
        expect(groups[1].entries.map((entry) => entry.id)).toEqual(['user:a', 'user:b'])
    })
})

describe('groupedFontEntries', () => {
    it('gives the groups in menu sequence with their labels', () => {
        expect(groupedFontEntries([]).map((group) => group.label)).toEqual([
            'This book',
            'Serif',
            'Sans serif',
            'Accessibility',
            'Monospace',
            'On this device',
        ])
    })

    it('has each catalogue entry one time and no empty group', () => {
        const groups = groupedFontEntries([])
        const entries = groups.flatMap((group) => group.entries)
        expect(entries).toHaveLength(FONT_CATALOG.length)
        expect(new Set(entries)).toEqual(new Set(FONT_CATALOG))
        for (const group of groups) expect(group.entries.length).toBeGreaterThan(0)
    })

    it('lists Atkinson Hyperlegible Next and Lexend one time, with the accessibility fonts', () => {
        const groups = groupedFontEntries([])
        for (const label of ['Atkinson Hyperlegible Next', 'Lexend']) {
            const found = groups.filter((group) => group.entries.some((e) => e.label === label))
            expect(found.map((group) => group.label)).toEqual(['Accessibility'])
        }
    })

    it('puts the fonts of the book after the publisher font', () => {
        const [first, ...rest] = groupedFontEntries(['Minion Pro', 'Zapfino'])
        expect(first.entries.map((entry) => entry.id)).toEqual([
            'publisher',
            'book:Minion Pro',
            'book:Zapfino',
        ])
        expect(rest.flatMap((group) => group.entries).some((e) => e.category === 'book')).toBe(
            false,
        )
    })

    it('gives new arrays, so a caller cannot change the catalogue', () => {
        const groups = groupedFontEntries([])
        groups[1].entries.length = 0
        expect(groupedFontEntries([])[1].entries).toHaveLength(8)
        expect(FONT_CATALOG).toHaveLength(19)
    })
})

describe('ensureFontLoaded', () => {
    it('loads the CSS one time for each id and then waits for the font file', async () => {
        const fontsLoad = stubDocumentFonts(() => Promise.resolve([]))
        const literata = vi.spyOn(entryOf('literata'), 'load').mockResolvedValue(undefined)
        const inter = vi.spyOn(entryOf('inter'), 'load').mockResolvedValue(undefined)

        const first = ensureFontLoaded('literata')
        const second = ensureFontLoaded('literata')
        expect(second).toBe(first)
        await expect(first).resolves.toBeUndefined()
        await ensureFontLoaded('literata')
        await ensureFontLoaded('inter')

        expect(literata).toHaveBeenCalledTimes(1)
        expect(inter).toHaveBeenCalledTimes(1)
        expect(fontsLoad.mock.calls).toEqual([
            ['1em "Literata Variable"'],
            ['1em "Inter Variable"'],
        ])
    })

    it('asks for the font file only after the CSS is there', async () => {
        const fontsLoad = stubDocumentFonts(() => Promise.resolve([]))
        let cssLoaded!: () => void
        vi.spyOn(entryOf('lora'), 'load').mockReturnValue(
            new Promise<void>((done) => (cssLoaded = done)),
        )

        const ready = ensureFontLoaded('lora')
        await Promise.resolve()
        expect(fontsLoad).not.toHaveBeenCalled()
        cssLoaded()
        await ready
        expect(fontsLoad).toHaveBeenCalledWith('1em "Lora Variable"')
    })

    it('uses quotation marks, because a family name can have a word that starts with a digit', async () => {
        const fontsLoad = stubDocumentFonts(() => Promise.resolve([]))
        vi.spyOn(entryOf('source-serif-4'), 'load').mockResolvedValue(undefined)
        await ensureFontLoaded('source-serif-4')
        expect(fontsLoad).toHaveBeenCalledWith('1em "Source Serif 4 Variable"')
    })

    it('resolves when the CSS does not load', async () => {
        const fontsLoad = stubDocumentFonts(() => Promise.resolve([]))
        vi.spyOn(entryOf('merriweather'), 'load').mockRejectedValue(new Error('offline'))
        await expect(ensureFontLoaded('merriweather')).resolves.toBeUndefined()
        expect(fontsLoad).not.toHaveBeenCalled()
    })

    it('resolves when the load function throws', async () => {
        stubDocumentFonts(() => Promise.resolve([]))
        vi.spyOn(entryOf('crimson-pro'), 'load').mockImplementation(() => {
            throw new Error('no import')
        })
        await expect(ensureFontLoaded('crimson-pro')).resolves.toBeUndefined()
    })

    it('resolves when the font file does not load', async () => {
        stubDocumentFonts(() => Promise.reject(new DOMException('bad font', 'NetworkError')))
        vi.spyOn(entryOf('newsreader'), 'load').mockResolvedValue(undefined)
        await expect(ensureFontLoaded('newsreader')).resolves.toBeUndefined()
    })

    it('stops the wait after 3 seconds when the font file does not arrive', async () => {
        vi.useFakeTimers()
        stubDocumentFonts(() => new Promise(() => {}))
        vi.spyOn(entryOf('eb-garamond'), 'load').mockResolvedValue(undefined)
        const settled = vi.fn()
        void ensureFontLoaded('eb-garamond').then(settled)

        await vi.advanceTimersByTimeAsync(FONT_LOAD_LIMIT_MS - 1)
        expect(settled).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(settled).toHaveBeenCalledTimes(1)
        expect(FONT_LOAD_LIMIT_MS).toBe(3000)
    })

    it('stops the wait after 3 seconds when the CSS does not arrive', async () => {
        vi.useFakeTimers()
        const fontsLoad = stubDocumentFonts(() => Promise.resolve([]))
        vi.spyOn(entryOf('libre-baskerville'), 'load').mockReturnValue(new Promise(() => {}))
        const settled = vi.fn()
        void ensureFontLoaded('libre-baskerville').then(settled)

        await vi.advanceTimersByTimeAsync(FONT_LOAD_LIMIT_MS)
        expect(settled).toHaveBeenCalledTimes(1)
        expect(fontsLoad).not.toHaveBeenCalled()
    })

    it('leaves no timer when the font is ready before the limit', async () => {
        vi.useFakeTimers()
        stubDocumentFonts(() => Promise.resolve([]))
        vi.spyOn(entryOf('source-sans-3'), 'load').mockResolvedValue(undefined)
        await ensureFontLoaded('source-sans-3')
        expect(vi.getTimerCount()).toBe(0)
    })

    it('resolves immediately for fonts that need no download', async () => {
        const fontsLoad = stubDocumentFonts(() => Promise.resolve([]))
        for (const id of ['publisher', 'system-serif', 'georgia', 'removed-font', '']) {
            await expect(ensureFontLoaded(id)).resolves.toBeUndefined()
        }
        expect(fontsLoad).not.toHaveBeenCalled()
    })

    it('waits for a font of the open book each time, with no CSS load', async () => {
        const fontsLoad = stubDocumentFonts(() => Promise.resolve([]))
        await ensureFontLoaded('book:Minion Pro')
        await ensureFontLoaded('book:Minion Pro')
        await ensureFontLoaded('book:Bad "Name"')
        expect(fontsLoad.mock.calls).toEqual([
            ['1em "Minion Pro"'],
            ['1em "Minion Pro"'],
            ['1em "Bad \\"Name\\""'],
        ])
    })

    it('resolves for a book font that does not load, and after the time limit', async () => {
        stubDocumentFonts(() => Promise.reject(new SyntaxError('bad family')))
        await expect(ensureFontLoaded('book:Broken')).resolves.toBeUndefined()

        vi.useFakeTimers()
        stubDocumentFonts(() => new Promise(() => {}))
        const settled = vi.fn()
        void ensureFontLoaded('book:Slow').then(settled)
        await vi.advanceTimersByTimeAsync(FONT_LOAD_LIMIT_MS)
        expect(settled).toHaveBeenCalledTimes(1)
    })

    it('works in an environment with no document.fonts, with the real CSS import', async () => {
        expect(document.fonts).toBeUndefined()
        await expect(ensureFontLoaded('lexend')).resolves.toBeUndefined()
        await expect(ensureFontLoaded('opendyslexic')).resolves.toBeUndefined()
        await expect(ensureFontLoaded('book:Minion Pro')).resolves.toBeUndefined()
    })
})
