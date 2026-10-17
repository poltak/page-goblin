# Page Goblin sync server

The sync server of [Page Goblin](https://github.com/poltak/page-goblin), an EPUB reader that runs in the browser. It is a Cloudflare Worker with one D1 database and one R2 bucket. One server holds the books, reading positions, bookmarks and highlights of one person.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/poltak/page-goblin/tree/main/sync-server)

Or with the command line:

```bash
pnpm install
pnpm exec wrangler login
pnpm run deploy
pnpm exec wrangler secret put SETUP_CODE
```

The first deploy makes the database and the bucket. The Worker makes its tables at the first request.

## Settings

| Name              | Kind     | What it does                                                                                                                      |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_CODE`      | Secret   | 16 or more characters. The first device of the app needs it one time, to set the sync code. Make one with `openssl rand -hex 16`. |
| `ALLOWED_ORIGINS` | Variable | The addresses of the app that may call the server, separated by commas. `*` allows all.                                           |

## Connect the app

In the app, open the menu, choose Sync, and enter the address of the Worker. On the first device, choose "First device" and enter the setup code. The app then shows a sync code for your other devices.

## API

`src/protocol.ts` has the routes and the types. `src/handler.ts` has the logic. The tests in `test/` run the handler on the SQLite of Node, from the root of the app repository with `pnpm test:single`.
