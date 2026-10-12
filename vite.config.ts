import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    // A relative base lets the same build run from any GitHub Pages path.
    base: './',
    resolve: {
        alias: {
            $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
        },
    },
    build: {
        target: 'es2022',
    },
    test: {
        include: ['src/**/*.{test,spec}.{js,ts}'],
        environment: 'jsdom',
        passWithNoTests: true,
    },
})
