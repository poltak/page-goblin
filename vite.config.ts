import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    // A relative base lets the same build run from any GitHub Pages path.
    base: './',
    plugins: [svelte()],
    resolve: {
        alias: {
            $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
        },
        // Vitest must load the browser build of Svelte, not the server build.
        conditions: process.env.VITEST ? ['browser'] : undefined,
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
