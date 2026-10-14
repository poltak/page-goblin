# Page Goblin

An EPUB reader that runs fully in the browser. It has a book library, a paged view, a scroll view, a speed reader, and read-aloud with the voices of the browser. Books and reading data stay on the device in IndexedDB. The site is static and installs as a PWA.

Live site: https://poltak.github.io/page-goblin/

The app is plain HTML, CSS and TypeScript. It has no UI library and no runtime npm dependency. Vite, TypeScript and Vitest run at build time only.

## Features

- **Library.** Add EPUB files with the file dialog, with a drop on the window, or with "Open with" in the installed app. Sort, search, see details, remove.
- **Paged view.** Swipe, tap, use the keys or the wheel to turn the page. The page follows the finger. Wide screens show two columns.
- **Scroll view.** One continuous column through the whole book.
- **Themes.** Light, sepia, dark, and black for OLED screens. "Auto" follows the system.
- **Fonts.** 14 bundled open-licence families, system fonts, and the fonts that the book embeds. You can set the size, line height, margins, alignment and hyphenation.
- **Bookmarks and highlights.** Five highlight colours, with notes.
- **Search.** Search the whole book and see each match in its context.
- **Note popovers.** A tap on a footnote number shows the note on the same page.
- **Speed reader.** One word at a time with a pivot letter, punctuation pauses, hold to pause, hold to rewind, and sentence steps.
- **Listen.** The browser reads the book aloud. A marker follows the voice and the pages turn by themselves.
- **Export.** Highlights as Markdown or in the Kindle "My Clippings.txt" format. A backup file holds the positions, bookmarks and highlights of all books.
- **Offline.** After the first visit the app starts with no network.
- **Full screen.** The installed app on Android shows no status bar and no navigation bar.

## Run it

```bash
pnpm install
pnpm dev
```

| Command            | What it does                          |
| ------------------ | ------------------------------------- |
| `pnpm dev`         | Start the dev server                  |
| `pnpm build`       | Build the site into `dist/`           |
| `pnpm preview`     | Serve `dist/` with the service worker |
| `pnpm check`       | Check the types                       |
| `pnpm test:single` | Run all tests one time                |
| `pnpm lint`        | Check the formatting                  |
| `pnpm format`      | Format all files                      |

## Deploy to GitHub Pages

1. Create a repository on GitHub and push the `main` branch.
2. In the repository settings, open Pages and set the source to "GitHub Actions".
3. Each push to `main` runs `.github/workflows/deploy.yml`. It checks the types, runs the tests, builds the site and deploys `dist/`.

The build has a relative base path. The same build works at `user.github.io/any-name/` and on a custom domain.

## How it works

| Directory             | What is in it                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/epub`        | The EPUB engine. A ZIP reader on the browser `DecompressionStream` API, and the package, contents and font obfuscation readers. It reads one file of the book at a time. |
| `src/lib/content`     | Turns a chapter into safe DOM from an allow list, rewrites the book stylesheets, and gives the chapter text with character offsets.                                      |
| `src/lib/reader`      | The paged view and the scroll view.                                                                                                                                      |
| `src/lib/storage`     | The IndexedDB library: book files, covers, progress, bookmarks, highlights. The import of a book.                                                                        |
| `src/lib/rsvp`        | The speed reader engine.                                                                                                                                                 |
| `src/lib/speech`      | The read-aloud controller for the browser speech API.                                                                                                                    |
| `src/lib/settings`    | Settings with validation and persistence, and the themes.                                                                                                                |
| `src/lib/fonts`       | The font catalogue. Each bundled family loads when you select it.                                                                                                        |
| `src/lib/annotations` | Highlight export and the backup file.                                                                                                                                    |
| `src/lib/pwa`         | Service worker registration, the install prompt, the file handler, the wake lock.                                                                                        |
| `src/ui`              | The library screen, the reader screen and its parts.                                                                                                                     |
| `src/styles`          | The design system: tokens, base styles, component classes.                                                                                                               |
| `build`               | The Vite plugin for the service worker manifest and the Content Security Policy.                                                                                         |

Three decisions explain most of the code.

A position is a chapter index and a character offset into the chapter text. It does not depend on the font, the window size or the reading mode. Progress, bookmarks, highlights, the speed reader and speech all use it, so the place stays the same when you change a setting or switch modes.

A chapter is shown in a shadow root. The book stylesheets apply inside it and cannot touch the app. The paged view lays the chapter out in CSS columns and moves one strip with a transform. The previous and next chapters sit on the same strip, so a page turn across a chapter boundary is the same motion as one inside a chapter.

A book is untrusted input. The content pipeline builds each chapter again from an allow list of elements and attributes. The built site also has a Content Security Policy that stops scripts and remote requests.

## Tests

`pnpm test:single` runs the unit tests in jsdom.

Two tests open real books when you give them a directory of EPUB files. They only read the files.

```bash
EPUB_DIR=/path/to/books pnpm exec vitest run src/lib/epub/real-books.test.ts
```

```bash
EPUB_DIR=/path/to/books pnpm exec vitest run src/lib/content/real-books.test.ts
```

The dev server has two extra pages. `/kit.html` shows each component of the design system in each theme. `/dev/reader.html?book=NAME.epub` mounts a reader view on a book from the `local-books/` directory (ignored by git) and runs layout checks with `harness.selfTest()` in the console.

## Limits

- Books with DRM do not open.
- Books with a right-to-left page direction show their text in the right direction, but the pages turn left to right.
- Fixed-layout books, audio, video and scripts in books are not supported.
- Read-aloud uses the voices that the browser and the device have.
- Reading data is on one device. To move it, export a backup file and import it on the other device.
