# Page Goblin

An EPUB reader that runs fully in the browser. It has a book library, a paged view, a scroll view, a speed reader, and read-aloud with the voices of the browser. Books and reading data stay on the device in IndexedDB. An optional sync copies them between your devices through a server in your own Cloudflare account. The site is static and installs as a PWA.

Live site: https://poltak.github.io/page-goblin/

The app is plain HTML, CSS and TypeScript. It has no UI library and no runtime npm dependency. Vite, TypeScript and Vitest run at build time only.

## Features

- **Library.** Add EPUB files with the file dialog, with a drop on the window, or with "Open with" in the installed app. Sort, search, see details, remove.
- **Paged view.** Swipe, tap, use the keys or the wheel to turn the page. The page follows the finger. Wide screens show two columns.
- **Scroll view.** One continuous column through the whole book.
- **Themes.** Light, sepia, dark, and black for OLED screens. "Auto" follows the system.
- **Fonts.** 14 bundled open-licence families, system fonts, the fonts that the book embeds, and your own fonts (TTF, OTF, WOFF or WOFF2 files). You can set the size, line height, margins, alignment and hyphenation.
- **Bookmarks and highlights.** Five highlight colours, with notes.
- **Search.** Search the whole book and see each match in its context.
- **Note popovers.** A tap on a footnote number shows the note on the same page.
- **Speed reader.** One word at a time with a pivot letter, punctuation pauses, hold to pause, hold to rewind, and sentence steps.
- **Listen.** The browser reads the book aloud. A marker follows the voice and the pages turn by themselves.
- **Export.** Highlights as Markdown or in the Kindle "My Clippings.txt" format. A backup file holds the positions, bookmarks and highlights of all books.
- **Sync.** Optional. Books, reading positions, bookmarks, highlights, your fonts and your font choice go to your other devices through your own sync server. With sync off, nothing leaves the device.
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

## Sync

Sync is off until you turn it on. Then the app copies these items between your devices:

- the books (the EPUB files, the covers and the details)
- the reading position of each book
- the bookmarks and the highlights, with their notes
- the fonts that you added, and the font that you chose

The other settings stay on each device, because a phone and a laptop need different font sizes.

Sync uses a server that you run in your own Cloudflare account: one Worker, one D1 database and one R2 bucket. The free plan of Cloudflare is sufficient for one reader. It has 10 GB in R2 (about 2,000 books of 5 MB) and 100,000 requests each day. One server holds the data of one person.

### Make your sync server

The quick way needs a GitHub account and a Cloudflare account. It needs no command line.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/poltak/page-goblin/tree/main/sync-server)

1. Click the button. Cloudflare copies `sync-server/` into a new repository in your GitHub account, and makes the database and the bucket.
2. Set `SETUP_CODE` to a secret of 16 or more characters. To make one, run `openssl rand -hex 16`. Keep it in your password manager.
3. Keep `ALLOWED_ORIGINS` as `https://poltak.github.io` to use the public app. For your own copy of the app, use its address.
4. Deploy. Copy the address of the Worker, for example `https://page-goblin-sync.yourname.workers.dev`.

The other way uses the command line:

```bash
cd sync-server
pnpm install
pnpm exec wrangler login
pnpm run deploy
pnpm exec wrangler secret put SETUP_CODE
```

The first deploy makes the D1 database and the R2 bucket. The Worker makes its tables at the first request.

### Update your sync server

A sync server from before version 0.2.0 does not keep fonts. The app then syncs your other data, and the Sync dialog tells you to update the server. To update, copy the new `sync-server/` files into your repository and deploy again. Your data stays on the server.

### Connect your devices

1. On the first device, open the app menu and choose Sync. Enter the address of the Worker, choose "First device", and enter the setup code.
2. The app makes a sync code, for example `7K3Q-M9XA-....`. Keep it in your password manager.
3. On each other device, choose Sync and enter the address and the sync code. Or use "Copy link" on the first device and open the link on the other device.

A book that another device added shows a cloud mark. Its file downloads when you open the book. With sync on, Remove deletes a book on all devices, and Remove download removes only the file from this device.

When you open a book that you read further on a different device, the reader offers to go to that position. It does not move by itself.

### Security

- The sync code never goes to the server. The app derives a token from the code with HKDF, and the server keeps only the SHA-256 of the token.
- Anyone with the sync code can read and change your synced data. To stop a lost device, turn sync off on a device that you have. Then choose "First device" with the setup code, and choose "Make a new code". Enter the new code on your other devices.
- The server stores the data as it gets it. It does not encrypt it. The protocol has a format number on each record, so a later version can add encryption that the server cannot read.
- The app can connect only to `https://*.workers.dev`. The Content Security Policy blocks all other servers, so a Worker on a custom domain does not work with the public app.

### Run the server on this computer

```bash
cd sync-server
pnpm install
cp .dev.vars.example .dev.vars   # then set SETUP_CODE, and add ALLOWED_ORIGINS=http://localhost:5173
pnpm run dev
```

The app accepts `http://127.0.0.1:8787` as a server address. Only the dev server of the app can use it, because the built app has the Content Security Policy.

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
| `src/lib/storage`     | The IndexedDB library: book files, covers, progress, bookmarks, highlights. The import of a book. The outbox of the sync.                                                |
| `src/lib/sync`        | The sync engine, the client of the sync server, the sync code and its token.                                                                                             |
| `src/lib/rsvp`        | The speed reader engine.                                                                                                                                                 |
| `src/lib/speech`      | The read-aloud controller for the browser speech API.                                                                                                                    |
| `src/lib/settings`    | Settings with validation and persistence, and the themes.                                                                                                                |
| `src/lib/fonts`       | The font catalogue. Each bundled family loads when you select it. Your own fonts: the reader of font files, the import, and the registry that adds them to the page.     |
| `src/lib/annotations` | Highlight export and the backup file.                                                                                                                                    |
| `src/lib/pwa`         | Service worker registration, the install prompt, the file handler, the wake lock.                                                                                        |
| `src/ui`              | The library screen, the reader screen and its parts. `src/ui/sync` has the sync dialog and the timing of the sync.                                                       |
| `sync-server`         | The sync server: a Cloudflare Worker with D1 and R2. `src/protocol.ts` is its API.                                                                                       |
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
- Without sync, reading data is on one device. To move it, export a backup file and import it on the other device.
- The backup file does not have your fonts. Add them again on the other device, or use sync.
- A font collection (`.ttc`) does not work. Use the `.ttf` or `.otf` files of the font.
- Sync uses "last write wins" with the clocks of the devices. When two devices change the same highlight before a sync, the later change wins.
- A sync server holds the data of one person.
