import { HIGHLIGHT_COLORS } from '$lib/types'
import type { HighlightColor } from '$lib/types'

export const HIGHLIGHT_COLOR_KEY = 'web-ereader:highlight-color'

export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = 'yellow'

export function isHighlightColor(value: unknown): value is HighlightColor {
    return HIGHLIGHT_COLORS.includes(value as HighlightColor)
}

/** The highlight colour that the user chose last. The default when storage is blocked or empty. */
export function readLastColor(): HighlightColor {
    try {
        const saved = localStorage.getItem(HIGHLIGHT_COLOR_KEY)
        return isHighlightColor(saved) ? saved : DEFAULT_HIGHLIGHT_COLOR
    } catch {
        // Access to localStorage throws when the browser blocks storage.
        return DEFAULT_HIGHLIGHT_COLOR
    }
}

export function saveLastColor(color: HighlightColor): void {
    try {
        localStorage.setItem(HIGHLIGHT_COLOR_KEY, color)
    } catch {
        // Storage is blocked or full. The caller keeps the colour in memory.
    }
}
