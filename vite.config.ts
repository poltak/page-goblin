import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
// Vite warns about a config import with no file extension. TypeScript maps .js to the .ts file.
import { pwaPlugin } from './build/pwa-plugin.js'

const packageJson = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
    define: {
        // The About dialog shows this.
        'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version),
    },
    // A relative base lets the same build run from any GitHub Pages path.
    base: './',
    plugins: [pwaPlugin()],
    resolve: {
        alias: {
            $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
        },
    },
    build: {
        target: 'es2022',
        // Each target browser has modulepreload, so the polyfill is code that never runs.
        modulePreload: { polyfill: false },
    },
    test: {
        include: [
            'src/**/*.{test,spec}.{js,ts}',
            'build/**/*.{test,spec}.{js,ts}',
            'sync-server/test/**/*.{test,spec}.ts',
        ],
        environment: 'jsdom',
        passWithNoTests: true,
    },
})
