import type { Appearance } from '$lib/reader/types'
import type { ReadingTheme } from '$lib/types'
import type { Settings } from './schema'

export interface ToAppearanceOptions {
    settings: Settings
    /** The result of `resolveTheme`. */
    resolvedTheme: ReadingTheme
    /** The result of `resolveFontStack`. Null keeps the publisher font. */
    fontFamily: string | null
}

/** The part of the settings that the reader views use. */
export function toAppearance({
    settings,
    resolvedTheme,
    fontFamily,
}: ToAppearanceOptions): Appearance {
    return {
        theme: resolvedTheme,
        fontFamily,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        margin: settings.margin,
        textAlign: settings.textAlign,
        hyphenate: settings.hyphenate,
        publisherStyles: settings.publisherStyles,
        columns: settings.columns,
        pageTurn: settings.pageTurn,
    }
}
