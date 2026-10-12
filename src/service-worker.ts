/// <reference lib="webworker" />

// This file must have no import. The build writes it to one classic script, sw.js.

export interface PrecacheManifest {
    /** A short hash of the names and contents of `files`. */
    version: string
    /** Paths relative to the service worker scope. The page itself is './'. */
    files: string[]
}

export type Route =
    | { kind: 'network' }
    /** Answer from the cache of this build. `file` is a key of the precache list. */
    | { kind: 'precache'; file: string }
    /** Answer from the font cache. `file` is the decoded path of the font below the scope. */
    | { kind: 'font'; file: string }

export interface RouteInput {
    method: string
    url: string
    /** The scope URL of the registration. It ends with a slash. */
    scope: string
    files: ReadonlySet<string>
}

declare const self: ServiceWorkerGlobalScope & { __SW_MANIFEST: PrecacheManifest }

const CACHE_PREFIX = 'web-ereader-'
const FONT_CACHE = `${CACHE_PREFIX}fonts`
const SHELL = './'
// The build plugin has the same rule in build/pwa-plugin.ts.
const FONT_FILE = /\.(?:woff2?|ttf|otf)$/i
// Vite puts a hash of 8 characters before the extension of each file that it writes to assets/.
const HASHED_FILE = /^assets\/.+-[\w-]{8}\.\w+$/

/**
 * The path of a URL below the scope, or null when the URL is not in the scope. Both values are
 * full URLs as the browser writes them, and the scope ends with a slash, so a text comparison
 * also checks the origin.
 */
export function pathInScope(url: string, scope: string): string | null {
    if (!url.startsWith(scope)) return null
    const path = url.slice(scope.length).split(/[?#]/, 1)[0]
    try {
        return decodeURIComponent(path)
    } catch {
        return path
    }
}

export function routeRequest({ method, url, scope, files }: RouteInput): Route {
    if (method !== 'GET') return { kind: 'network' }
    const path = pathInScope(url, scope)
    if (path === null) return { kind: 'network' }
    // The app is one page at the scope root. Other paths in the scope are not page loads of the
    // app. On a site at the domain root they can be pages of other projects.
    if (path === '' || path === 'index.html') return { kind: 'precache', file: SHELL }
    if (files.has(path)) return { kind: 'precache', file: path }
    // A path with an empty part is a second spelling of a file on a server that reads two
    // slashes as one. The font cache must have one entry for each file.
    if (path.startsWith('assets/') && FONT_FILE.test(path) && !path.includes('//')) {
        return { kind: 'font', file: path }
    }
    return { kind: 'network' }
}

/** True when the file name changes each time the content changes. */
export function isHashedFile(file: string): boolean {
    return HASHED_FILE.test(file)
}

export function staleCacheNames({
    names,
    current,
}: {
    names: readonly string[]
    current: string
}): string[] {
    return names.filter(
        (name) => name.startsWith(CACHE_PREFIX) && name !== current && name !== FONT_CACHE,
    )
}

const MANIFEST = self.__SW_MANIFEST
const CACHE_NAME = CACHE_PREFIX + MANIFEST.version
const SCOPE = self.registration.scope
const FILES: ReadonlySet<string> = new Set(MANIFEST.files)

function fileUrl(file: string): string {
    return new URL(file, SCOPE).href
}

async function precache(): Promise<void> {
    const cache = await caches.open(CACHE_NAME)
    // A file without a hash in its name must come from the network. A copy from the HTTP cache
    // can be the page of the previous deployment, which names chunks that this cache does not have.
    await cache.addAll(
        MANIFEST.files.map((file) =>
            isHashedFile(file) ? fileUrl(file) : new Request(fileUrl(file), { cache: 'reload' }),
        ),
    )
}

async function removeStaleCaches(): Promise<void> {
    const stale = staleCacheNames({ names: await caches.keys(), current: CACHE_NAME })
    await Promise.all(stale.map((name) => caches.delete(name)))
    await self.clients.claim()
}

/** A browser refuses a redirected response for a page load, so make a plain copy. */
function withoutRedirect(response: Response): Response {
    if (!response.redirected) return response
    return new Response(response.body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
    })
}

// Cache Storage can fail, for example with a full disk. A failed read must not stop a request
// that the network can answer, so each read error counts as "not in the cache".
async function respondFromPrecache(file: string, request: Request): Promise<Response> {
    let cached: Response | undefined
    try {
        // The worker reads only the cache of this build. `caches.match` searches all caches,
        // so it can return a file of an older build.
        const cache = await caches.open(CACHE_NAME)
        cached = await cache.match(fileUrl(file), { ignoreVary: true })
    } catch {
        // Use the network.
    }
    return cached ? withoutRedirect(cached) : fetch(request)
}

async function respondWithFont(file: string, event: FetchEvent): Promise<Response> {
    const { request } = event
    // The key comes from the decoded path, with no query. Book content is not trusted, and a
    // different spelling of the URL on each request must not fill the storage with copies.
    const key = fileUrl(file)
    let cache: Cache | undefined
    try {
        cache = await caches.open(FONT_CACHE)
        const cached = await cache.match(key, { ignoreVary: true })
        if (cached) return cached
    } catch {
        // Use the network.
    }
    const response = await fetch(request)
    if (cache && response.status === 200) {
        event.waitUntil(cache.put(key, response.clone()).catch(() => undefined))
    }
    return response
}

// No skipWaiting here. A page of the old version loads its lazy chunks from the old cache, so
// the old worker must stay until the user accepts the update.
self.addEventListener('install', (event) => {
    event.waitUntil(precache())
})

self.addEventListener('activate', (event) => {
    event.waitUntil(removeStaleCaches())
})

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting())
})

self.addEventListener('fetch', (event) => {
    const { request } = event
    const route = routeRequest({
        method: request.method,
        url: request.url,
        scope: SCOPE,
        files: FILES,
    })
    if (route.kind === 'precache') event.respondWith(respondFromPrecache(route.file, request))
    else if (route.kind === 'font') event.respondWith(respondWithFont(route.file, event))
})
