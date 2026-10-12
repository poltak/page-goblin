# AGENTS.md

Quickstart for coding sessions in `page-goblin`.

## Project summary

- A static EPUB reader that runs fully in the browser and installs as a PWA. GitHub Pages hosts it.
- Plain HTML, CSS and TypeScript. No UI library. No runtime npm dependency.
- Vite builds it, Vitest with jsdom tests it, Prettier formats it.
- `README.md` has the feature list and the directory map.

## Rules

- Do not add a UI library or a runtime package. Ask the owner first if one looks necessary.
- Speed is a primary requirement. Do not read layout in loops or pointer move handlers. Animate only `transform` and `opacity`. Load code at its first use with a dynamic `import()`.
- A function with more than two inputs takes one options object.
- Book text, titles, author names and notes are untrusted. Put them in the page with `textContent`, never with `innerHTML`.
- TypeScript is strict with `verbatimModuleSyntax`. Import types with `import type`.
- The alias `$lib` points to `src/lib`.

## Commands

- `pnpm dev` starts the dev server.
- `pnpm check` checks the types.
- `pnpm test:single` runs all tests one time.
- `pnpm build` builds `dist/`.
- `pnpm format` formats all files.

## Where things are

- Contracts between modules are type files. Read them first: `src/lib/types.ts`, `src/lib/epub/types.ts`, `src/lib/content/types.ts`, `src/lib/reader/types.ts`, `src/lib/storage/types.ts`, `src/ui/reader/types.ts`, `src/ui/reader/parts.ts`.
- `src/lib/epub` has no imports from the rest of the app. Keep it that way, so it can move to the `poltak-epub-parser` package.
- `src/main.ts` imports only what the first paint of the library needs. The importer, the EPUB engine, the reader and its parts load on demand.
- The reader screen is `src/ui/reader`. `session/` is the model of one open book. `screen/` is the layout, bars and keyboard. `panels/`, `tools/`, `speed/` and `listen/` are parts that the screen loads at their first use.

## How UI code is written

- Static markup is in `index.html` or in an HTML string of the module. Lists are made by cloning `template` elements.
- A UI part is a function that makes its elements, adds listeners and returns an object with `destroy()`.
- Styles use the tokens in `src/styles/tokens.css` and the component classes in `src/styles/components.css`. `kit.html` shows each class with its markup.
- Icons come from the sprite `src/ui/icons.svg`: `<svg class="icon" aria-hidden="true"><use href="#i-NAME"/></svg>`.

## A position in a book

`Locator` is `{ spineIndex, offset }`. The offset counts characters through the text of the chapter, by the rule in the comment of `TextModel` in `src/lib/content/types.ts`. Progress, bookmarks, highlights, the speed reader and speech all use it. Do not save a page number or a scroll offset.

## Tests

- Unit tests are next to the code as `name.test.ts`.
- jsdom has no layout. The reader views have a dev page for layout checks: `/dev/reader.html?book=NAME.epub&mode=paged`, then `harness.selfTest()` in the console. It reads books from `local-books/`, which git ignores.
- `EPUB_DIR=/path/to/books pnpm exec vitest run src/lib/epub/real-books.test.ts` opens each real book in a directory. `src/lib/content/real-books.test.ts` does the same for the content pipeline.
- The Content Security Policy is only in the production build. Test a change that touches styles, fonts, images or dynamic imports with `pnpm build` and `pnpm preview` too.
