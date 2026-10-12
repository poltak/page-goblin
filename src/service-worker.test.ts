import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type WorkerModule = typeof import('./service-worker')
type Listener = (event: never) => void

const SCOPE = 'https://example.com/page-goblin/'
const MANIFEST = {
    version: 'abc123',
    files: [
        './',
        'assets/index-DkTr3x1Z.css',
        'assets/index-P2Xu9kJm.js',
        'icons/icon-192.png',
        'manifest.webmanifest',
        'theme-init.js',
    ],
}
const CURRENT_CACHE = 'page-goblin-abc123'
const FONT_URL = `${SCOPE}assets/literata-latin-wght-normal-C8sHkM2a.woff2`

function keyOf(request: string | { url: string }): string {
    return typeof request === 'string' ? request : request.url
}

function createCacheStorage() {
    const stores = new Map<string, Map<string, Response>>()
    const added: Array<string | Request> = []
    const storage = {
        stores,
        added,
        open: vi.fn(async (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map())
            const store = stores.get(name)!
            return {
                addAll: async (requests: Array<string | Request>) => {
                    added.push(...requests)
                    for (const request of requests) store.set(keyOf(request), new Response('x'))
                },
                match: async (request: string | { url: string }) => store.get(keyOf(request)),
                put: async (request: string | { url: string }, response: Response) => {
                    store.set(keyOf(request), response)
                },
            }
        }),
        keys: vi.fn(async () => [...stores.keys()]),
        delete: vi.fn(async (name: string) => stores.delete(name)),
        // The worker must read one named cache. This call searches all caches.
        match: vi.fn(),
    }
    return storage
}

describe('service worker', () => {
    const listeners = new Map<string, Listener>()
    let worker: WorkerModule
    let storage: ReturnType<typeof createCacheStorage>
    let skipWaiting: ReturnType<typeof vi.fn>
    let claim: ReturnType<typeof vi.fn>
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        vi.resetModules()
        listeners.clear()
        storage = createCacheStorage()
        skipWaiting = vi.fn(async () => undefined)
        claim = vi.fn(async () => undefined)
        fetchMock = vi.fn(async () => new Response('from network'))
        vi.stubGlobal('self', {
            __SW_MANIFEST: MANIFEST,
            registration: { scope: SCOPE },
            clients: { claim },
            skipWaiting,
            addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
        })
        vi.stubGlobal('caches', storage)
        vi.stubGlobal('fetch', fetchMock)
        worker = await import('./service-worker')
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    /** Runs a lifecycle listener and waits for the work that it gave to `waitUntil`. */
    async function dispatch(type: string, data: object = {}): Promise<void> {
        const pending: Array<Promise<unknown>> = []
        const event = { ...data, waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
        listeners.get(type)!(event as never)
        await Promise.all(pending)
    }

    /** Runs the fetch listener. The result is null when the worker lets the request pass. */
    async function dispatchFetch(request: {
        url: string
        mode?: string
        method?: string
    }): Promise<Response | null> {
        let response: Promise<Response> | null = null
        const pending: Array<Promise<unknown>> = []
        listeners.get('fetch')!({
            request: { method: 'GET', mode: 'cors', ...request },
            respondWith: (promise: Promise<Response>) => {
                response = promise
            },
            waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        } as never)
        const result = await (response as Promise<Response> | null)
        await Promise.all(pending)
        return result
    }

    describe('pathInScope', () => {
        it('gives the path below the scope', () => {
            expect(worker.pathInScope(SCOPE, SCOPE)).toBe('')
            expect(worker.pathInScope(`${SCOPE}assets/a.js?v=1#top`, SCOPE)).toBe('assets/a.js')
            expect(worker.pathInScope(`${SCOPE}my%20file.js`, SCOPE)).toBe('my file.js')
        })

        it('gives null outside the scope', () => {
            expect(worker.pathInScope('https://other.example/page-goblin/', SCOPE)).toBeNull()
            expect(worker.pathInScope('https://example.com/other-app/a.js', SCOPE)).toBeNull()
            expect(worker.pathInScope('https://example.com/', SCOPE)).toBeNull()
        })
    })

    describe('routeRequest', () => {
        const files = new Set(MANIFEST.files)
        const route = (url: string, method = 'GET') =>
            worker.routeRequest({ method, url, scope: SCOPE, files })

        it('sends a request for the page to the cached page', () => {
            const shell = { kind: 'precache', file: './' }
            expect(route(SCOPE)).toEqual(shell)
            expect(route(`${SCOPE}?source=pwa#library`)).toEqual(shell)
            expect(route(`${SCOPE}index.html`)).toEqual(shell)
        })

        it('sends a precached file to the cache, with or without a query', () => {
            expect(route(`${SCOPE}assets/index-P2Xu9kJm.js`)).toEqual({
                kind: 'precache',
                file: 'assets/index-P2Xu9kJm.js',
            })
            expect(route(`${SCOPE}theme-init.js?v=2`)).toEqual({
                kind: 'precache',
                file: 'theme-init.js',
            })
        })

        it('sends a font file below assets to the font cache', () => {
            expect(route(FONT_URL)).toEqual({
                kind: 'font',
                file: 'assets/literata-latin-wght-normal-C8sHkM2a.woff2',
            })
            expect(route(`${SCOPE}assets/OpenDyslexic-Regular-B2xY9kQa.WOFF`)).toEqual({
                kind: 'font',
                file: 'assets/OpenDyslexic-Regular-B2xY9kQa.WOFF',
            })
            expect(route(`${SCOPE}assets/mono-Ab3dE5gH.ttf`)).toEqual({
                kind: 'font',
                file: 'assets/mono-Ab3dE5gH.ttf',
            })
        })

        it('gives one file name for each spelling of a font URL', () => {
            const font = { kind: 'font', file: 'assets/mono-Ab3dE5gH.ttf' }
            expect(route(`${SCOPE}assets/mono-Ab3dE5gH.ttf?copy=1#x`)).toEqual(font)
            expect(route(`${SCOPE}assets/m%6Fno-Ab3dE5gH.ttf`)).toEqual(font)
            // A server can read two slashes as one, so this spelling gets no cache entry.
            expect(route(`${SCOPE}assets//mono-Ab3dE5gH.ttf`)).toEqual({ kind: 'network' })
        })

        it('lets all other requests pass to the network', () => {
            const network = { kind: 'network' }
            // A chunk of an older build, a book, a font outside assets, and the worker file.
            expect(route(`${SCOPE}assets/reader-Zz9Yy8Xx.js`)).toEqual(network)
            expect(route(`${SCOPE}books/sample.epub`)).toEqual(network)
            expect(route(`${SCOPE}fonts/custom.woff2`)).toEqual(network)
            expect(route(`${SCOPE}sw.js`)).toEqual(network)
            // A page of a different project, below a scope at the domain root.
            expect(route(`${SCOPE}other-project/`)).toEqual(network)
            expect(route('https://example.com/other-app/')).toEqual(network)
            expect(route('https://cdn.example/assets/index-P2Xu9kJm.js')).toEqual(network)
            expect(route(SCOPE, 'POST')).toEqual(network)
            expect(route(`${SCOPE}assets/index-P2Xu9kJm.js`, 'HEAD')).toEqual(network)
        })
    })

    describe('isHashedFile', () => {
        it('is true only for a build file with a hash in its name', () => {
            expect(worker.isHashedFile('assets/index-P2Xu9kJm.js')).toBe(true)
            expect(worker.isHashedFile('assets/reader-engine-B_x-9kQa.css')).toBe(true)
            expect(worker.isHashedFile('./')).toBe(false)
            expect(worker.isHashedFile('theme-init.js')).toBe(false)
            expect(worker.isHashedFile('manifest.webmanifest')).toBe(false)
            expect(worker.isHashedFile('icons/icon-192.png')).toBe(false)
            expect(worker.isHashedFile('assets/logo.svg')).toBe(false)
        })
    })

    describe('staleCacheNames', () => {
        it('names the caches of older builds only', () => {
            expect(
                worker.staleCacheNames({
                    names: [
                        'page-goblin-old111',
                        CURRENT_CACHE,
                        'page-goblin-fonts',
                        'other-app-cache',
                    ],
                    current: CURRENT_CACHE,
                }),
            ).toEqual(['page-goblin-old111'])
        })
    })

    describe('install', () => {
        it('caches each file and reloads the files that have no hash in the name', async () => {
            await dispatch('install')

            expect(storage.open).toHaveBeenCalledWith(CURRENT_CACHE)
            expect(
                storage.added.map((request) =>
                    typeof request === 'string' ? request : [request.url, request.cache],
                ),
            ).toEqual([
                [SCOPE, 'reload'],
                `${SCOPE}assets/index-DkTr3x1Z.css`,
                `${SCOPE}assets/index-P2Xu9kJm.js`,
                [`${SCOPE}icons/icon-192.png`, 'reload'],
                [`${SCOPE}manifest.webmanifest`, 'reload'],
                [`${SCOPE}theme-init.js`, 'reload'],
            ])
        })

        it('does not take control from the old version', async () => {
            await dispatch('install')

            expect(skipWaiting).not.toHaveBeenCalled()
        })
    })

    describe('message', () => {
        it('starts the new version when the page asks for it', async () => {
            await dispatch('message', { data: { type: 'SKIP_WAITING' } })

            expect(skipWaiting).toHaveBeenCalledOnce()
        })

        it('ignores other messages', async () => {
            await dispatch('message', { data: { type: 'PING' } })
            await dispatch('message', { data: null })

            expect(skipWaiting).not.toHaveBeenCalled()
        })
    })

    describe('activate', () => {
        it('deletes the caches of older builds and then takes control', async () => {
            for (const name of ['page-goblin-old111', 'page-goblin-fonts', 'other-app-cache']) {
                await storage.open(name)
            }
            await dispatch('install')

            await dispatch('activate')

            expect([...storage.stores.keys()].sort()).toEqual([
                'other-app-cache',
                CURRENT_CACHE,
                'page-goblin-fonts',
            ])
            expect(claim).toHaveBeenCalledOnce()
        })
    })

    describe('fetch', () => {
        it('answers a page load from the cache with no network request', async () => {
            await dispatch('install')
            storage.stores.get(CURRENT_CACHE)!.set(SCOPE, new Response('cached page'))

            const response = await dispatchFetch({ url: `${SCOPE}?source=pwa`, mode: 'navigate' })

            expect(await response!.text()).toBe('cached page')
            expect(fetchMock).not.toHaveBeenCalled()
            expect(storage.match).not.toHaveBeenCalled()
        })

        it('uses the network for a page load when the cache has no page', async () => {
            const response = await dispatchFetch({ url: SCOPE, mode: 'navigate' })

            expect(await response!.text()).toBe('from network')
        })

        it('uses the network for a page load when the cache storage fails', async () => {
            await dispatch('install')
            storage.open.mockRejectedValue(new DOMException('Internal error', 'UnknownError'))

            const response = await dispatchFetch({ url: SCOPE, mode: 'navigate' })

            expect(await response!.text()).toBe('from network')
        })

        it('uses the network for a page load when the cache read fails', async () => {
            await dispatch('install')
            storage.open.mockResolvedValue({
                match: async () => {
                    throw new DOMException('Internal error', 'UnknownError')
                },
            } as never)

            const response = await dispatchFetch({ url: SCOPE, mode: 'navigate' })

            expect(await response!.text()).toBe('from network')
        })

        it('uses the network for a font when the cache storage fails', async () => {
            storage.open.mockRejectedValue(new DOMException('Internal error', 'UnknownError'))
            fetchMock.mockImplementation(async () => new Response('font bytes'))

            const response = await dispatchFetch({ url: FONT_URL })

            expect(await response!.text()).toBe('font bytes')
        })

        it('gives a page load a copy of a redirected response', async () => {
            const redirected = new Response('cached page', { status: 200 })
            Object.defineProperty(redirected, 'redirected', { value: true })
            await dispatch('install')
            storage.stores.get(CURRENT_CACHE)!.set(SCOPE, redirected)

            const response = await dispatchFetch({ url: SCOPE, mode: 'navigate' })

            expect(response).not.toBe(redirected)
            expect(response!.redirected).toBe(false)
            expect(await response!.text()).toBe('cached page')
        })

        it('answers a precached file from the cache of this build', async () => {
            const url = `${SCOPE}assets/index-P2Xu9kJm.js`
            await dispatch('install')
            storage.stores.get(CURRENT_CACHE)!.set(url, new Response('this build'))

            const response = await dispatchFetch({ url })

            expect(await response!.text()).toBe('this build')
            expect(fetchMock).not.toHaveBeenCalled()
            expect(storage.match).not.toHaveBeenCalled()
        })

        it('keeps a font after its first download', async () => {
            fetchMock.mockImplementation(async () => new Response('font bytes'))

            const first = await dispatchFetch({ url: FONT_URL })
            const second = await dispatchFetch({ url: FONT_URL })

            expect(await first!.text()).toBe('font bytes')
            expect(await second!.text()).toBe('font bytes')
            expect(fetchMock).toHaveBeenCalledOnce()
            expect([...storage.stores.get('page-goblin-fonts')!.keys()]).toEqual([FONT_URL])
        })

        it('keeps one copy of a font for requests with different spellings of its URL', async () => {
            // Book content is not trusted. Without this rule it can fill the storage with
            // copies of one font file.
            fetchMock.mockImplementation(async () => new Response('font bytes'))

            const first = await dispatchFetch({ url: `${FONT_URL}?copy=1` })
            const second = await dispatchFetch({ url: `${FONT_URL}?copy=2#x` })
            const third = await dispatchFetch({ url: FONT_URL.replace('literata', 'liter%61ta') })

            // The fake cache gives the same response object for the second and third request.
            expect(await first!.text()).toBe('font bytes')
            expect(second).toBe(third)
            expect(await third!.text()).toBe('font bytes')
            expect(fetchMock).toHaveBeenCalledOnce()
            expect([...storage.stores.get('page-goblin-fonts')!.keys()]).toEqual([FONT_URL])
        })

        it('does not keep a font response that is not a full success', async () => {
            fetchMock.mockImplementation(async () => new Response('missing', { status: 404 }))

            const response = await dispatchFetch({ url: FONT_URL })

            expect(response!.status).toBe(404)
            expect(storage.stores.get('page-goblin-fonts')!.size).toBe(0)
        })

        it('lets other requests pass and puts nothing in a cache', async () => {
            expect(await dispatchFetch({ url: `${SCOPE}books/sample.epub` })).toBeNull()
            expect(await dispatchFetch({ url: `${SCOPE}assets/reader-Zz9Yy8Xx.js` })).toBeNull()
            expect(await dispatchFetch({ url: 'https://cdn.example/font.woff2' })).toBeNull()
            expect(
                await dispatchFetch({ url: `${SCOPE}other-project/`, mode: 'navigate' }),
            ).toBeNull()
            expect(await dispatchFetch({ url: SCOPE, mode: 'navigate', method: 'POST' })).toBeNull()

            expect(fetchMock).not.toHaveBeenCalled()
            expect(storage.open).not.toHaveBeenCalled()
        })
    })
})
