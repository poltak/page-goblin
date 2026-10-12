import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingTheme } from '$lib/types'
import { DARK_THEMES, THEME_CHOICES } from './schema'
import { createSettingsStore, loadSettings, SETTINGS_STORAGE_KEY } from './store'
import { resolveTheme, systemPrefersDark, THEME_PAGE_COLORS } from './theme'

const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/theme-init.js'),
    'utf8',
)

/** Runs the script as a classic script against the jsdom globals. */
function runThemeInit(): void {
    new Function(source)()
}

function stubSystemDark(systemDark: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: systemDark && query === '(prefers-color-scheme: dark)',
    }))
}

/** The theme that the app shows for the same storage and the same system preference. */
function appTheme(): ReadingTheme {
    const { theme, darkTheme } = loadSettings()
    return resolveTheme({ theme, darkTheme, systemDark: systemPrefersDark() })
}

function expectPageTheme(theme: ReadingTheme): void {
    expect(document.documentElement.getAttribute('data-theme')).toBe(theme)
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
        THEME_PAGE_COLORS[theme],
    )
}

beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#123456" />'
})

afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    document.head.innerHTML = ''
    delete document.documentElement.dataset.theme
})

describe('public/theme-init.js', () => {
    const combinations = THEME_CHOICES.flatMap((theme) =>
        DARK_THEMES.flatMap((darkTheme) =>
            [false, true].map((systemDark) => ({ theme, darkTheme, systemDark })),
        ),
    )

    it.each(combinations)(
        'gives the result of resolveTheme for theme $theme, dark theme $darkTheme, system dark $systemDark',
        ({ theme, darkTheme, systemDark }) => {
            // The real store writes the data, so the test also covers the storage format.
            const store = createSettingsStore()
            store.update({ theme, darkTheme })
            store.destroy()
            stubSystemDark(systemDark)

            runThemeInit()

            expectPageTheme(resolveTheme({ theme, darkTheme, systemDark }))
            expect(appTheme()).toBe(resolveTheme({ theme, darkTheme, systemDark }))
        },
    )

    const storedTexts = [
        null,
        '',
        '{not-json',
        'null',
        'true',
        '42',
        '"dark"',
        '[]',
        '["dark"]',
        '{}',
        '{"theme":"neon"}',
        '{"theme":"Dark"}',
        '{"theme":"dark "}',
        '{"theme":42,"darkTheme":["black"]}',
        '{"theme":["dark"]}',
        '{"theme":{"dark":true}}',
        '{"theme":"toString"}',
        '{"theme":"constructor","darkTheme":"black"}',
        '{"theme":"__proto__","darkTheme":"black"}',
        '{"theme":"auto","darkTheme":"light"}',
        '{"theme":"auto","darkTheme":"sepia"}',
        '{"theme":"auto","darkTheme":null}',
        '{"darkTheme":"black"}',
        '{"theme":null,"darkTheme":"black"}',
        '{"version":0,"theme":"sepia"}',
        '{"version":99,"theme":"black","darkTheme":"dark"}',
        '{"rsvp":{"theme":"dark"}}',
    ]

    it.each(
        storedTexts.flatMap((stored) =>
            [false, true].map((systemDark) => ({ stored, systemDark })),
        ),
    )(
        'gives the theme of the app for the stored text $stored with system dark $systemDark',
        ({ stored, systemDark }) => {
            if (stored !== null) localStorage.setItem(SETTINGS_STORAGE_KEY, stored)
            stubSystemDark(systemDark)

            runThemeInit()

            expectPageTheme(appTheme())
        },
    )

    it.each([false, true])(
        'follows the system when storage is blocked (system dark %s)',
        (systemDark) => {
            const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
            Object.defineProperty(globalThis, 'localStorage', {
                configurable: true,
                get() {
                    throw new DOMException('The operation is insecure.', 'SecurityError')
                },
            })
            stubSystemDark(systemDark)
            try {
                expect(() => runThemeInit()).not.toThrow()
                expectPageTheme(appTheme())
                expectPageTheme(systemDark ? 'dark' : 'light')
            } finally {
                Object.defineProperty(globalThis, 'localStorage', original)
            }
        },
    )

    it('uses the light theme for auto when the browser has no matchMedia', () => {
        vi.stubGlobal('matchMedia', undefined)
        localStorage.setItem(SETTINGS_STORAGE_KEY, '{"theme":"auto","darkTheme":"black"}')
        expect(() => runThemeInit()).not.toThrow()
        expectPageTheme(appTheme())
        expectPageTheme('light')
    })

    it('sets data-theme when the page has no theme-color tag', () => {
        document.head.innerHTML = ''
        localStorage.setItem(SETTINGS_STORAGE_KEY, '{"theme":"sepia"}')
        stubSystemDark(true)
        expect(() => runThemeInit()).not.toThrow()
        expect(document.documentElement.dataset.theme).toBe('sepia')
    })

    it('does not throw when the DOM call fails', () => {
        stubSystemDark(false)
        const querySelector = vi.spyOn(document, 'querySelector').mockImplementation(() => {
            throw new Error('no DOM')
        })
        try {
            expect(() => runThemeInit()).not.toThrow()
        } finally {
            querySelector.mockRestore()
        }
    })

    it('is a small classic script with no syntax newer than ES2017', () => {
        const code = source.replace(/^\s*\/\/.*$/gm, '')
        expect(code).not.toMatch(/\b(import|export)\b/)
        // Optional chaining, nullish coalescing and a catch with no binding are newer.
        expect(code).not.toMatch(/\?\.|\?\?|catch\s*\{/)
        expect(source.length).toBeLessThan(2000)
    })
})
