import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
// Vite warns about a config import with no file extension. TypeScript maps .js to the .ts file.
import { pwaPlugin } from './build/pwa-plugin.js'

export default defineConfig({
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
        include: ['src/**/*.{test,spec}.{js,ts}', 'build/**/*.{test,spec}.{js,ts}'],
        environment: 'jsdom',
        passWithNoTests: true,
    },
})
