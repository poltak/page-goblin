import type { ColumnChoice, MarginSize, TextAlignChoice } from '$lib/reader/types'
import type { LayoutMode, PageTurnAnimation, ReadingTheme } from '$lib/types'

/** 'auto' is light, or the `darkTheme` value when the system prefers dark. */
export type ThemeChoice = 'auto' | ReadingTheme

export type DarkTheme = 'dark' | 'black'

/** The colour of the text in the black theme. */
export type BlackTint = 'neutral' | 'amber' | 'red'

export type LibrarySort = 'recent' | 'added' | 'title' | 'author'

export interface RsvpSettings {
    /** Words for each minute. */
    wpm: number
    /** Number of context words that show before the current word, and also after it. */
    contextWords: number
    periodMultiplier: number
    commaMultiplier: number
    semicolonMultiplier: number
    exclamationMultiplier: number
    paragraphMultiplier: number
    headingMultiplier: number
    longWordDelay: boolean
    rampUp: boolean
    showPivot: boolean
    pauseAtChapterStart: boolean
    /** Size of the word in CSS pixels. */
    fontSize: number
}

export interface SpeechSettings {
    /** Null uses the default voice of the browser. */
    voiceId: string | null
    rate: number
    pitch: number
    highlightWords: boolean
}

export interface Settings {
    theme: ThemeChoice
    darkTheme: DarkTheme
    /**
     * The brightness of all of the screen in the black theme, in percent. A value below 100 lets
     * the reader go darker than the lowest brightness of the device, for a dark room.
     */
    blackBrightness: number
    blackTint: BlackTint
    layout: LayoutMode
    /**
     * The id of a font catalogue entry, or 'book:' followed by a font family of the open book.
     * An unknown id stays as it is, because the fonts of a book are unknown until it opens.
     */
    fontId: string
    /** Body font size in CSS pixels. */
    fontSize: number
    /** Null keeps the publisher value. */
    lineHeight: number | null
    margin: MarginSize
    textAlign: TextAlignChoice
    hyphenate: boolean
    publisherStyles: boolean
    columns: ColumnChoice
    pageTurn: PageTurnAnimation
    /** Keep the screen on in the speed reader and during speech. */
    keepAwake: boolean
    /** Show the chapter title above the page. */
    runningHead: boolean
    /** Show the page number and the progress below the page. */
    runningFoot: boolean
    rsvp: RsvpSettings
    speech: SpeechSettings
    librarySort: LibrarySort
    /**
     * The measured reading speed in words for each minute. The reader updates it from the page
     * turns of the user and uses it for the time that is left in a chapter.
     */
    readingWpm: number
}

export const SETTINGS_VERSION = 1

export const THEME_CHOICES: readonly ThemeChoice[] = ['auto', 'light', 'sepia', 'dark', 'black']
export const DARK_THEMES: readonly DarkTheme[] = ['dark', 'black']
export const BLACK_TINTS: readonly BlackTint[] = ['neutral', 'amber', 'red']
export const LAYOUT_MODES: readonly LayoutMode[] = ['paged', 'scroll']
export const MARGIN_SIZES: readonly MarginSize[] = ['narrow', 'normal', 'wide']
export const TEXT_ALIGN_CHOICES: readonly TextAlignChoice[] = ['publisher', 'start', 'justify']
export const COLUMN_CHOICES: readonly ColumnChoice[] = ['auto', 1, 2]
export const PAGE_TURN_ANIMATIONS: readonly PageTurnAnimation[] = ['slide', 'fade', 'none']
export const LIBRARY_SORTS: readonly LibrarySort[] = ['recent', 'added', 'title', 'author']

export const BLACK_BRIGHTNESS_MIN = 20
export const BLACK_BRIGHTNESS_MAX = 100
export const BLACK_BRIGHTNESS_STEP = 5

export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 40
export const FONT_SIZE_STEP = 1

export const LINE_HEIGHT_MIN = 1
export const LINE_HEIGHT_MAX = 2.4
export const LINE_HEIGHT_STEP = 0.05

export const RSVP_WPM_MIN = 50
export const RSVP_WPM_MAX = 1000
export const RSVP_WPM_STEP = 10

export const RSVP_CONTEXT_WORDS_MIN = 0
export const RSVP_CONTEXT_WORDS_MAX = 100
export const RSVP_CONTEXT_WORDS_STEP = 1

/** The limits of each pause multiplier of the speed reader. */
export const RSVP_MULTIPLIER_MIN = 1
export const RSVP_MULTIPLIER_MAX = 10
export const RSVP_MULTIPLIER_STEP = 0.5

export const RSVP_FONT_SIZE_MIN = 24
export const RSVP_FONT_SIZE_MAX = 96
export const RSVP_FONT_SIZE_STEP = 1

export const SPEECH_RATE_MIN = 0.5
export const SPEECH_RATE_MAX = 2
export const SPEECH_RATE_STEP = 0.1

export const SPEECH_PITCH_MIN = 0.5
export const SPEECH_PITCH_MAX = 2
export const SPEECH_PITCH_STEP = 0.1

export const READING_WPM_MIN = 60
export const READING_WPM_MAX = 900
export const READING_WPM_STEP = 1

export const DEFAULT_SETTINGS: Settings = Object.freeze({
    theme: 'auto',
    darkTheme: 'dark',
    blackBrightness: 100,
    blackTint: 'neutral',
    layout: 'paged',
    fontId: 'publisher',
    fontSize: 19,
    lineHeight: 1.55,
    margin: 'normal',
    textAlign: 'publisher',
    hyphenate: false,
    publisherStyles: true,
    columns: 'auto',
    pageTurn: 'slide',
    keepAwake: true,
    runningHead: true,
    runningFoot: true,
    rsvp: Object.freeze({
        wpm: 250,
        contextWords: 5,
        periodMultiplier: 3,
        commaMultiplier: 2,
        semicolonMultiplier: 2.5,
        exclamationMultiplier: 3,
        paragraphMultiplier: 3.5,
        headingMultiplier: 4,
        longWordDelay: true,
        rampUp: true,
        showPivot: true,
        pauseAtChapterStart: true,
        fontSize: 48,
    }),
    speech: Object.freeze({
        voiceId: null,
        rate: 1,
        pitch: 1,
        highlightWords: true,
    }),
    librarySort: 'recent',
    readingWpm: 230,
})

interface NumberLimits {
    min: number
    max: number
    step: number
}

const BLACK_BRIGHTNESS: NumberLimits = {
    min: BLACK_BRIGHTNESS_MIN,
    max: BLACK_BRIGHTNESS_MAX,
    step: BLACK_BRIGHTNESS_STEP,
}
const FONT_SIZE: NumberLimits = { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: FONT_SIZE_STEP }
const LINE_HEIGHT: NumberLimits = {
    min: LINE_HEIGHT_MIN,
    max: LINE_HEIGHT_MAX,
    step: LINE_HEIGHT_STEP,
}
const RSVP_WPM: NumberLimits = { min: RSVP_WPM_MIN, max: RSVP_WPM_MAX, step: RSVP_WPM_STEP }
const RSVP_CONTEXT_WORDS: NumberLimits = {
    min: RSVP_CONTEXT_WORDS_MIN,
    max: RSVP_CONTEXT_WORDS_MAX,
    step: RSVP_CONTEXT_WORDS_STEP,
}
const RSVP_MULTIPLIER: NumberLimits = {
    min: RSVP_MULTIPLIER_MIN,
    max: RSVP_MULTIPLIER_MAX,
    step: RSVP_MULTIPLIER_STEP,
}
const RSVP_FONT_SIZE: NumberLimits = {
    min: RSVP_FONT_SIZE_MIN,
    max: RSVP_FONT_SIZE_MAX,
    step: RSVP_FONT_SIZE_STEP,
}
const SPEECH_RATE: NumberLimits = {
    min: SPEECH_RATE_MIN,
    max: SPEECH_RATE_MAX,
    step: SPEECH_RATE_STEP,
}
const SPEECH_PITCH: NumberLimits = {
    min: SPEECH_PITCH_MIN,
    max: SPEECH_PITCH_MAX,
    step: SPEECH_PITCH_STEP,
}
const READING_WPM: NumberLimits = {
    min: READING_WPM_MIN,
    max: READING_WPM_MAX,
    step: READING_WPM_STEP,
}

type UnknownRecord = Record<string, unknown>

const EMPTY: UnknownRecord = Object.freeze({})

function toRecord(value: unknown): UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as UnknownRecord)
        : EMPTY
}

function oneOf<T>(value: unknown, choices: readonly T[]): T | undefined {
    return choices.includes(value as T) ? (value as T) : undefined
}

function toBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined
}

function toText(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined
}

/** Clamps a finite number to the limits and rounds it to the step. */
function toNumber(value: unknown, { min, max, step }: NumberLimits): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    const clamped = Math.min(max, Math.max(min, value))
    const stepped = min + Math.round((clamped - min) / step) * step
    // Two decimals remove binary noise such as 1.5500000000000003. No step is smaller than 0.01.
    return Math.min(max, Math.round(stepped * 100) / 100)
}

/**
 * Makes valid settings from any JSON value. A valid field stays, an invalid field gets its
 * default, and a number is clamped to its limits and rounded to its step. Never throws.
 */
export function normalizeSettings(raw: unknown): Settings {
    const source = toRecord(raw)
    const rsvp = toRecord(source.rsvp)
    const speech = toRecord(source.speech)
    const defaults = DEFAULT_SETTINGS

    const multiplier = (key: keyof RsvpSettings & `${string}Multiplier`): number =>
        toNumber(rsvp[key], RSVP_MULTIPLIER) ?? defaults.rsvp[key]

    return {
        theme: oneOf(source.theme, THEME_CHOICES) ?? defaults.theme,
        darkTheme: oneOf(source.darkTheme, DARK_THEMES) ?? defaults.darkTheme,
        blackBrightness:
            toNumber(source.blackBrightness, BLACK_BRIGHTNESS) ?? defaults.blackBrightness,
        blackTint: oneOf(source.blackTint, BLACK_TINTS) ?? defaults.blackTint,
        layout: oneOf(source.layout, LAYOUT_MODES) ?? defaults.layout,
        fontId: toText(source.fontId) ?? defaults.fontId,
        fontSize: toNumber(source.fontSize, FONT_SIZE) ?? defaults.fontSize,
        lineHeight:
            source.lineHeight === null
                ? null
                : (toNumber(source.lineHeight, LINE_HEIGHT) ?? defaults.lineHeight),
        margin: oneOf(source.margin, MARGIN_SIZES) ?? defaults.margin,
        textAlign: oneOf(source.textAlign, TEXT_ALIGN_CHOICES) ?? defaults.textAlign,
        hyphenate: toBoolean(source.hyphenate) ?? defaults.hyphenate,
        publisherStyles: toBoolean(source.publisherStyles) ?? defaults.publisherStyles,
        columns: oneOf(source.columns, COLUMN_CHOICES) ?? defaults.columns,
        pageTurn: oneOf(source.pageTurn, PAGE_TURN_ANIMATIONS) ?? defaults.pageTurn,
        keepAwake: toBoolean(source.keepAwake) ?? defaults.keepAwake,
        runningHead: toBoolean(source.runningHead) ?? defaults.runningHead,
        runningFoot: toBoolean(source.runningFoot) ?? defaults.runningFoot,
        rsvp: {
            wpm: toNumber(rsvp.wpm, RSVP_WPM) ?? defaults.rsvp.wpm,
            contextWords:
                toNumber(rsvp.contextWords, RSVP_CONTEXT_WORDS) ?? defaults.rsvp.contextWords,
            periodMultiplier: multiplier('periodMultiplier'),
            commaMultiplier: multiplier('commaMultiplier'),
            semicolonMultiplier: multiplier('semicolonMultiplier'),
            exclamationMultiplier: multiplier('exclamationMultiplier'),
            paragraphMultiplier: multiplier('paragraphMultiplier'),
            headingMultiplier: multiplier('headingMultiplier'),
            longWordDelay: toBoolean(rsvp.longWordDelay) ?? defaults.rsvp.longWordDelay,
            rampUp: toBoolean(rsvp.rampUp) ?? defaults.rsvp.rampUp,
            showPivot: toBoolean(rsvp.showPivot) ?? defaults.rsvp.showPivot,
            pauseAtChapterStart:
                toBoolean(rsvp.pauseAtChapterStart) ?? defaults.rsvp.pauseAtChapterStart,
            fontSize: toNumber(rsvp.fontSize, RSVP_FONT_SIZE) ?? defaults.rsvp.fontSize,
        },
        speech: {
            voiceId: toText(speech.voiceId) ?? null,
            rate: toNumber(speech.rate, SPEECH_RATE) ?? defaults.speech.rate,
            pitch: toNumber(speech.pitch, SPEECH_PITCH) ?? defaults.speech.pitch,
            highlightWords: toBoolean(speech.highlightWords) ?? defaults.speech.highlightWords,
        },
        librarySort: oneOf(source.librarySort, LIBRARY_SORTS) ?? defaults.librarySort,
        readingWpm: toNumber(source.readingWpm, READING_WPM) ?? defaults.readingWpm,
    }
}
