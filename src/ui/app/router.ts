/**
 * Hash routes of the app. '#/' is the library and '#/book/ID' is the reader.
 *
 * The service worker gives the cached page only for the root of the app, so the routes are in
 * the hash and not in the path.
 */

export type Route = { name: 'library' } | { name: 'book'; bookId: string }

const LIBRARY_HASH = '#/'
const BOOK_PREFIX = '#/book/'

/** Marks a history entry that the app pushed on top of its library entry. */
const PUSHED_KEY = 'webEreaderPushed'

/** The route of a location hash. A hash that is not known gives the library. */
export function parseHash(hash: string): Route {
    if (hash.startsWith(BOOK_PREFIX)) {
        const raw = hash.slice(BOOK_PREFIX.length)
        if (raw !== '' && !raw.includes('/')) {
            try {
                return { name: 'book', bookId: decodeURIComponent(raw) }
            } catch {
                // A bad percent escape is not a book id.
            }
        }
    }
    return { name: 'library' }
}

export function bookHash(bookId: string): string {
    return BOOK_PREFIX + encodeURIComponent(bookId)
}

/** The parts of `window` that the router uses. A test gives a fake. */
export interface RouterEnvironment {
    readonly location: { readonly hash: string }
    readonly history: {
        readonly state: unknown
        pushState(data: unknown, unused: string, url: string): void
        replaceState(data: unknown, unused: string, url: string): void
        back(): void
    }
    addEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
    removeEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
}

export interface RouterOptions {
    /** Called for the first route and then for each change. */
    onRoute(route: Route): void
    environment?: RouterEnvironment
}

export interface Router {
    readonly route: Route
    /** Reads the hash of the page, reports the first route and starts to listen. */
    start(): void
    /** Shows a book. From the library this adds a history entry, so Back closes the book. */
    openBook(bookId: string): void
    /** Goes back to the library. */
    closeBook(): void
    destroy(): void
}

function isSameRoute(a: Route, b: Route): boolean {
    if (a.name === 'book' && b.name === 'book') return a.bookId === b.bookId
    return a.name === b.name
}

function isPushedState(state: unknown): boolean {
    return (
        typeof state === 'object' &&
        state !== null &&
        (state as Record<string, unknown>)[PUSHED_KEY] === true
    )
}

export function createRouter({ onRoute, environment = window }: RouterOptions): Router {
    const { history, location } = environment
    let route: Route = { name: 'library' }
    // True from history.back() to the event that reports it. A second call in that time would
    // go back one entry too many and leave the app.
    let goingBack = false

    function setRoute(next: Route): void {
        goingBack = false
        if (isSameRoute(route, next)) return
        route = next
        onRoute(next)
    }

    function readLocation(): Route {
        const { hash } = location
        const next = parseHash(hash)
        // The address must show what is on screen, so an unknown hash becomes the library hash.
        if (next.name === 'library' && hash !== '' && hash !== '#' && hash !== LIBRARY_HASH) {
            history.replaceState(null, '', LIBRARY_HASH)
        }
        return next
    }

    // Back, forward and a hash that the user typed. Some of these send the two events, and the
    // second one finds the same route.
    const onChange = (): void => setRoute(readLocation())

    return {
        get route() {
            return route
        },
        start() {
            route = readLocation()
            environment.addEventListener('popstate', onChange)
            environment.addEventListener('hashchange', onChange)
            onRoute(route)
        },
        openBook(bookId) {
            const next: Route = { name: 'book', bookId }
            if (isSameRoute(route, next)) return
            if (route.name === 'library') {
                history.pushState({ [PUSHED_KEY]: true }, '', bookHash(bookId))
            } else {
                // From one book to the next the entry is replaced, so one Back still closes it.
                history.replaceState(history.state, '', bookHash(bookId))
            }
            setRoute(next)
        },
        closeBook() {
            if (route.name !== 'book' || goingBack) return
            // The state stays with the entry through a reload, so the mark is still correct then.
            if (isPushedState(history.state)) {
                goingBack = true
                history.back()
                return
            }
            // The page was loaded on the book address. There is no library entry to go back to.
            history.replaceState(null, '', LIBRARY_HASH)
            setRoute({ name: 'library' })
        },
        destroy() {
            environment.removeEventListener('popstate', onChange)
            environment.removeEventListener('hashchange', onChange)
        },
    }
}
