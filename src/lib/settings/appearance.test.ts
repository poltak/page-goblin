import { describe, expect, it } from 'vitest'
import type { Appearance } from '$lib/reader/types'
import { toAppearance } from './appearance'
import { DEFAULT_SETTINGS, normalizeSettings } from './schema'

describe('toAppearance', () => {
    it('maps the default settings', () => {
        const appearance = toAppearance({
            settings: DEFAULT_SETTINGS,
            resolvedTheme: 'light',
            fontFamily: null,
        })
        expect(appearance).toEqual({
            theme: 'light',
            fontFamily: null,
            fontSize: 19,
            lineHeight: 1.55,
            margin: 'normal',
            textAlign: 'publisher',
            hyphenate: false,
            publisherStyles: true,
            columns: 'auto',
            pageTurn: 'slide',
        } satisfies Appearance)
    })

    it('maps each appearance setting', () => {
        const settings = normalizeSettings({
            theme: 'auto',
            fontId: 'literata',
            fontSize: 26,
            lineHeight: null,
            margin: 'wide',
            textAlign: 'justify',
            hyphenate: true,
            publisherStyles: false,
            columns: 2,
            pageTurn: 'none',
        })
        const appearance = toAppearance({
            settings,
            resolvedTheme: 'black',
            fontFamily: '"Literata Variable", Georgia, serif',
        })
        expect(appearance).toEqual({
            theme: 'black',
            fontFamily: '"Literata Variable", Georgia, serif',
            fontSize: 26,
            lineHeight: null,
            margin: 'wide',
            textAlign: 'justify',
            hyphenate: true,
            publisherStyles: false,
            columns: 2,
            pageTurn: 'none',
        } satisfies Appearance)
    })

    it('uses the resolved theme and the font family, not the theme and font settings', () => {
        const settings = normalizeSettings({ theme: 'sepia', fontId: 'inter' })
        const appearance = toAppearance({ settings, resolvedTheme: 'dark', fontFamily: null })
        expect(appearance.theme).toBe('dark')
        expect(appearance.fontFamily).toBeNull()
    })

    it('has no setting that the reader views do not use', () => {
        const appearance = toAppearance({
            settings: DEFAULT_SETTINGS,
            resolvedTheme: 'light',
            fontFamily: null,
        })
        expect(Object.keys(appearance).sort()).toEqual([
            'columns',
            'fontFamily',
            'fontSize',
            'hyphenate',
            'lineHeight',
            'margin',
            'pageTurn',
            'publisherStyles',
            'textAlign',
            'theme',
        ])
    })
})
