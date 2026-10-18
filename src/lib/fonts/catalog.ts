import type { FontFallback } from './sfnt'

export type FontCategory =
    'publisher' | 'serif' | 'sans' | 'accessible' | 'mono' | 'system' | 'book' | 'user'

export interface FontEntry {
    /**
     * The value of the `fontId` setting. A font of the open book has the id 'book:' + family,
     * and a font that the user added has the id 'user:' + the id of its family record.
     */
    id: string
    label: string
    category: FontCategory
    /** The CSS `font-family` value. Null keeps the fonts of the publisher. */
    stack: string | null
    /** Adds the font faces of a bundled font to the page. Other entries do not have it. */
    load?: () => Promise<unknown>
}

export interface FontGroup {
    label: string
    entries: FontEntry[]
}

/** The part of a font family that the user added (`FontRecord`) that the menu uses. */
export interface UserFont {
    id: string
    name: string
    fallback: FontFallback
}

export const PUBLISHER_FONT_ID = 'publisher'
export const BOOK_FONT_PREFIX = 'book:'
export const USER_FONT_PREFIX = 'user:'

/** The longest time that `ensureFontLoaded` waits. After it the text shows in a fallback font. */
export const FONT_LOAD_LIMIT_MS = 3000

const SERIF_FALLBACK = 'Georgia, "Times New Roman", serif'
const SANS_FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

interface BundledFont extends FontEntry {
    /** The family name that the font CSS declares, in quotation marks. */
    family: string
    load: () => Promise<unknown>
}

interface BundledFontOptions {
    id: string
    label: string
    category: FontCategory
    /** The exact `font-family` name in the `@font-face` rules of the Fontsource package. */
    family: string
    fallback: string
    load: () => Promise<unknown>
}

function bundled({ id, label, category, family, fallback, load }: BundledFontOptions): BundledFont {
    const quoted = `"${family}"`
    return { id, label, category, stack: `${quoted}, ${fallback}`, load, family: quoted }
}

// Each import() has a literal path, so the build makes one CSS file for each family and a
// family downloads only when a reader selects it.
const BUNDLED_FONTS: readonly BundledFont[] = [
    bundled({
        id: 'literata',
        label: 'Literata',
        category: 'serif',
        family: 'Literata Variable',
        fallback: SERIF_FALLBACK,
        load: () => import('./families/literata.css'),
    }),
    bundled({
        id: 'source-serif-4',
        label: 'Source Serif 4',
        category: 'serif',
        family: 'Source Serif 4 Variable',
        fallback: SERIF_FALLBACK,
        load: () => import('./families/source-serif-4.css'),
    }),
    bundled({
        id: 'eb-garamond',
        label: 'EB Garamond',
        category: 'serif',
        family: 'EB Garamond Variable',
        fallback: SERIF_FALLBACK,
        load: () => import('./families/eb-garamond.css'),
    }),
    bundled({
        id: 'lora',
        label: 'Lora',
        category: 'serif',
        family: 'Lora Variable',
        fallback: SERIF_FALLBACK,
        load: () => import('./families/lora.css'),
    }),
    bundled({
        id: 'merriweather',
        label: 'Merriweather',
        category: 'serif',
        family: 'Merriweather Variable',
        fallback: SERIF_FALLBACK,
        load: () => import('./families/merriweather.css'),
    }),
    bundled({
        id: 'crimson-pro',
        label: 'Crimson Pro',
        category: 'serif',
        family: 'Crimson Pro Variable',
        fallback: SERIF_FALLBACK,
        load: () => import('./families/crimson-pro.css'),
    }),
    bundled({
        id: 'newsreader',
        label: 'Newsreader',
        category: 'serif',
        family: 'Newsreader Variable',
        fallback: SERIF_FALLBACK,
        load: () => import('./families/newsreader.css'),
    }),
    bundled({
        id: 'libre-baskerville',
        label: 'Libre Baskerville',
        category: 'serif',
        family: 'Libre Baskerville',
        fallback: SERIF_FALLBACK,
        load: () => import('./families/libre-baskerville.css'),
    }),
    bundled({
        id: 'inter',
        label: 'Inter',
        category: 'sans',
        family: 'Inter Variable',
        fallback: SANS_FALLBACK,
        load: () => import('./families/inter.css'),
    }),
    bundled({
        id: 'source-sans-3',
        label: 'Source Sans 3',
        category: 'sans',
        family: 'Source Sans 3 Variable',
        fallback: SANS_FALLBACK,
        load: () => import('./families/source-sans-3.css'),
    }),
    bundled({
        id: 'atkinson-hyperlegible-next',
        label: 'Atkinson Hyperlegible Next',
        category: 'accessible',
        family: 'Atkinson Hyperlegible Next Variable',
        fallback: SANS_FALLBACK,
        load: () => import('./families/atkinson-hyperlegible-next.css'),
    }),
    bundled({
        id: 'lexend',
        label: 'Lexend',
        category: 'accessible',
        family: 'Lexend Variable',
        fallback: SANS_FALLBACK,
        load: () => import('./families/lexend.css'),
    }),
    bundled({
        id: 'opendyslexic',
        label: 'OpenDyslexic',
        category: 'accessible',
        family: 'OpenDyslexic',
        fallback: SANS_FALLBACK,
        load: () => import('./families/opendyslexic.css'),
    }),
    bundled({
        id: 'jetbrains-mono',
        label: 'JetBrains Mono',
        category: 'mono',
        family: 'JetBrains Mono Variable',
        fallback: MONO_FALLBACK,
        load: () => import('./families/jetbrains-mono.css'),
    }),
]

/** All fonts that do not come from the open book, in menu sequence. */
export const FONT_CATALOG: readonly FontEntry[] = [
    { id: PUBLISHER_FONT_ID, label: 'Publisher font', category: 'publisher', stack: null },
    ...BUNDLED_FONTS,
    {
        id: 'system-serif',
        label: 'System serif',
        category: 'system',
        stack: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
    },
    {
        id: 'system-sans',
        label: 'System sans',
        category: 'system',
        stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    },
    {
        id: 'georgia',
        label: 'Georgia',
        category: 'system',
        stack: 'Georgia, "Times New Roman", serif',
    },
    {
        id: 'charter',
        label: 'Charter',
        category: 'system',
        stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
    },
]

const catalogById = new Map(FONT_CATALOG.map((entry) => [entry.id, entry]))
const bundledById = new Map(BUNDLED_FONTS.map((font) => [font.id, font]))

/** A CSS string for a family name that can have any characters. */
export function quoteFamily(family: string): string {
    const escaped = family.replace(/["\\\0-\x1f\x7f]/g, (char) =>
        char === '"' || char === '\\' ? '\\' + char : '\\' + char.charCodeAt(0).toString(16) + ' ',
    )
    return `"${escaped}"`
}

function bookFontStack(family: string): string {
    return `${quoteFamily(family)}, serif`
}

/**
 * The CSS family name of the faces of a font that the user added. The name in the font file
 * is untrusted text, so CSS never gets it.
 */
export function userFontFamily(id: string): string {
    return `pg-font-${id}`
}

function userFontStack(font: UserFont): string {
    return `${quoteFamily(userFontFamily(font.id))}, ${font.fallback}`
}

/** The id of the family record for a `fontId` setting, or null for a different font. */
export function userFontIdOf(fontId: string): string | null {
    return fontId.startsWith(USER_FONT_PREFIX) ? fontId.slice(USER_FONT_PREFIX.length) : null
}

/** Entries for the fonts that the user added, sorted by name. */
export function userFontEntries(fonts: readonly UserFont[]): FontEntry[] {
    return fonts
        .map((font): FontEntry => ({
            id: USER_FONT_PREFIX + font.id,
            label: font.name,
            category: 'user',
            stack: userFontStack(font),
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
}

/** Entries for the embedded fonts of the open book (`ContentLoader.bookFonts`). */
export function bookFontEntries(families: readonly string[]): FontEntry[] {
    return families.map((family) => ({
        id: BOOK_FONT_PREFIX + family,
        label: family,
        category: 'book',
        stack: bookFontStack(family),
    }))
}

export interface ResolveFontStackOptions {
    fontId: string
    /** The embedded font families of the open book. */
    bookFonts: readonly string[]
    /** The fonts that the user added and that have all their files on this device. */
    userFonts?: readonly UserFont[]
}

/**
 * The CSS `font-family` value for a `fontId` setting. Null keeps the publisher font. An id
 * that is not known, a book font that the open book does not have, and a font that the user
 * removed also give null.
 */
export function resolveFontStack({
    fontId,
    bookFonts,
    userFonts = [],
}: ResolveFontStackOptions): string | null {
    if (fontId.startsWith(BOOK_FONT_PREFIX)) {
        const family = fontId.slice(BOOK_FONT_PREFIX.length)
        return bookFonts.includes(family) ? bookFontStack(family) : null
    }
    const userId = userFontIdOf(fontId)
    if (userId !== null) {
        const font = userFonts.find((candidate) => candidate.id === userId)
        return font ? userFontStack(font) : null
    }
    return catalogById.get(fontId)?.stack ?? null
}

/**
 * The entries for the font menu. The first group has the publisher font and the fonts of the
 * open book. The fonts of the user come next, in a group that shows only when it has fonts.
 */
export function groupedFontEntries(
    bookFonts: readonly string[],
    userFonts: readonly UserFont[] = [],
): FontGroup[] {
    const inCategory = (category: FontCategory) =>
        FONT_CATALOG.filter((entry) => entry.category === category)
    const yours = userFontEntries(userFonts)
    return [
        {
            label: 'This book',
            entries: [...inCategory('publisher'), ...bookFontEntries(bookFonts)],
        },
        ...(yours.length > 0 ? [{ label: 'Your fonts', entries: yours }] : []),
        { label: 'Serif', entries: inCategory('serif') },
        { label: 'Sans serif', entries: inCategory('sans') },
        { label: 'Accessibility', entries: inCategory('accessible') },
        { label: 'Monospace', entries: inCategory('mono') },
        { label: 'On this device', entries: inCategory('system') },
    ]
}

/** Resolves when the promise settles or the time limit ends. Never rejects. */
export function settleWithin(promise: Promise<unknown>, limitMs: number): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer)
            resolve()
        }
        const timer = setTimeout(done, limitMs)
        promise.then(done, done)
    })
}

/** Waits for the regular face of a family. The name must be in quotation marks. */
export async function loadFace(quotedFamily: string): Promise<void> {
    // jsdom has no document.fonts.
    await document.fonts?.load(`1em ${quotedFamily}`)
}

async function loadBundled(font: BundledFont): Promise<void> {
    await font.load()
    await loadFace(font.family)
}

const bundledLoads = new Map<string, Promise<void>>()

/**
 * Makes the font of a `fontId` setting ready for layout. A bundled font gets its CSS one time,
 * and then the function waits for the regular font file. A font of the open book only gets the
 * wait. The wait stops after `FONT_LOAD_LIMIT_MS`, and the text then shows in a fallback font
 * until the font file arrives. The promise never rejects.
 *
 * A font that the user added needs its files from storage. `UserFonts.ensureLoaded` loads it.
 * This function does nothing for it.
 */
export function ensureFontLoaded(id: string): Promise<void> {
    if (id.startsWith(BOOK_FONT_PREFIX)) {
        // There is no cache, because a different book can have a font with the same family name.
        const family = quoteFamily(id.slice(BOOK_FONT_PREFIX.length))
        return settleWithin(loadFace(family), FONT_LOAD_LIMIT_MS)
    }
    const font = bundledById.get(id)
    if (!font) return Promise.resolve()
    let ready = bundledLoads.get(id)
    if (!ready) {
        ready = settleWithin(loadBundled(font), FONT_LOAD_LIMIT_MS)
        bundledLoads.set(id, ready)
    }
    return ready
}
