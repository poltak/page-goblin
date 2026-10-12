import { describe, expect, it, vi } from 'vitest'
import { bookHash, createRouter, parseHash } from './router'
import type { Route, RouterEnvironment } from './router'

interface Entry {
    hash: string
    state: unknown
}

/** A history stack. Like a browser, `back()` does its work later, in `flush()`. */
function createFakeEnvironment(initial: Entry[] = [{ hash: '', state: null }]) {
    const entries = [...initial]
    let index = entries.length - 1
    let pendingBack = 0
    const listeners = {
        popstate: new Set<() => void>(),
        hashchange: new Set<() => void>(),
    }
    const fire = (type: 'popstate' | 'hashchange') => {
        for (const listener of [...listeners[type]]) listener()
    }
    const environment: RouterEnvironment = {
        location: {
            get hash() {
                return entries[index].hash
            },
        },
        history: {
            get state() {
                return entries[index].state
            },
            pushState(state, _unused, url) {
                entries.splice(index + 1)
                entries.push({ hash: url, state })
                index += 1
            },
            replaceState(state, _unused, url) {
                entries[index] = { hash: url, state }
            },
            back() {
                pendingBack += 1
            },
        },
        addEventListener: (type, listener) => listeners[type].add(listener),
        removeEventListener: (type, listener) => listeners[type].delete(listener),
    }
    return {
        environment,
        entries,
        get index() {
            return index
        },
        /** True when a traversal went below the first entry, which leaves the app. */
        leftApp: false,
        flush() {
            while (pendingBack > 0) {
                pendingBack -= 1
                if (index === 0) {
                    this.leftApp = true
                    continue
                }
                index -= 1
                fire('popstate')
            }
        },
        forward() {
            index += 1
            fire('popstate')
        },
        /** The user types a new hash in the address bar. */
        typeHash(hash: string) {
            entries.splice(index + 1)
            entries.push({ hash, state: null })
            index += 1
            fire('popstate')
            fire('hashchange')
        },
        listenerCount: () => listeners.popstate.size + listeners.hashchange.size,
    }
}

function startRouter(fake: ReturnType<typeof createFakeEnvironment>) {
    const routes: Route[] = []
    const router = createRouter({
        onRoute: (route) => routes.push(route),
        environment: fake.environment,
    })
    router.start()
    return { router, routes }
}

describe('parseHash', () => {
    it('reads the library hash', () => {
        expect(parseHash('')).toEqual({ name: 'library' })
        expect(parseHash('#')).toEqual({ name: 'library' })
        expect(parseHash('#/')).toEqual({ name: 'library' })
    })

    it('reads a book hash', () => {
        expect(parseHash('#/book/abc-123')).toEqual({ name: 'book', bookId: 'abc-123' })
    })

    it('decodes the book id', () => {
        expect(parseHash(bookHash('a b/c'))).toEqual({ name: 'book', bookId: 'a b/c' })
    })

    it('gives the library for an unknown hash', () => {
        expect(parseHash('#/settings')).toEqual({ name: 'library' })
        expect(parseHash('#/book/')).toEqual({ name: 'library' })
        expect(parseHash('#/book/abc/notes')).toEqual({ name: 'library' })
        expect(parseHash('#/book/%E0%A4%A')).toEqual({ name: 'library' })
        expect(parseHash('#book/abc')).toEqual({ name: 'library' })
    })
})

describe('createRouter', () => {
    it('reports the library as the first route', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)

        expect(routes).toEqual([{ name: 'library' }])
        expect(router.route).toEqual({ name: 'library' })
    })

    it('opens the book again after a reload on a book address', () => {
        const fake = createFakeEnvironment([{ hash: '#/book/b1', state: null }])
        const { routes } = startRouter(fake)

        expect(routes).toEqual([{ name: 'book', bookId: 'b1' }])
    })

    it('replaces an unknown hash with the library hash', () => {
        const fake = createFakeEnvironment([{ hash: '#/nothing-here', state: null }])
        const { routes } = startRouter(fake)

        expect(routes).toEqual([{ name: 'library' }])
        expect(fake.entries).toEqual([{ hash: '#/', state: null }])
    })

    it('does not change an empty hash', () => {
        const fake = createFakeEnvironment()
        startRouter(fake)

        expect(fake.entries).toEqual([{ hash: '', state: null }])
    })

    it('pushes a history entry when a book opens from the library', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)

        router.openBook('b1')

        expect(fake.entries.map((entry) => entry.hash)).toEqual(['', '#/book/b1'])
        expect(fake.index).toBe(1)
        expect(routes.at(-1)).toEqual({ name: 'book', bookId: 'b1' })
    })

    it('does nothing when the same book opens a second time', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)

        router.openBook('b1')
        router.openBook('b1')

        expect(fake.entries).toHaveLength(2)
        expect(routes).toHaveLength(2)
    })

    it('closes the book with history.back() when the app pushed the entry', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)
        router.openBook('b1')

        router.closeBook()
        // The route changes when the browser reports the traversal, not before.
        expect(router.route).toEqual({ name: 'book', bookId: 'b1' })
        fake.flush()

        expect(fake.index).toBe(0)
        expect(routes.at(-1)).toEqual({ name: 'library' })
        // The entry is still there, so Forward opens the book again.
        expect(fake.entries).toHaveLength(2)
    })

    it('goes back only one entry when the book is closed two times', () => {
        const fake = createFakeEnvironment()
        const { router } = startRouter(fake)
        router.openBook('b1')

        router.closeBook()
        router.closeBook()
        fake.flush()

        expect(fake.leftApp).toBe(false)
        expect(fake.index).toBe(0)
    })

    it('closes the book when the user goes back in the browser', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)
        router.openBook('b1')

        fake.environment.history.back()
        fake.flush()

        expect(routes.at(-1)).toEqual({ name: 'library' })
        expect(router.route).toEqual({ name: 'library' })
    })

    it('opens the book again on Forward, and closes it with history.back()', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)
        router.openBook('b1')
        router.closeBook()
        fake.flush()

        fake.forward()
        expect(routes.at(-1)).toEqual({ name: 'book', bookId: 'b1' })

        router.closeBook()
        fake.flush()
        expect(fake.index).toBe(0)
        expect(fake.entries).toHaveLength(2)
        expect(routes.at(-1)).toEqual({ name: 'library' })
    })

    it('replaces the hash when the page was loaded on the book address', () => {
        const fake = createFakeEnvironment([{ hash: '#/book/b1', state: null }])
        const { router, routes } = startRouter(fake)

        router.closeBook()

        expect(fake.entries).toEqual([{ hash: '#/', state: null }])
        expect(routes.at(-1)).toEqual({ name: 'library' })
        fake.flush()
        expect(fake.leftApp).toBe(false)
    })

    it('uses history.back() after a reload on an entry that the app pushed', () => {
        const first = createFakeEnvironment()
        startRouter(first).router.openBook('b1')

        // A reload keeps the entries and their state. Only the script starts again.
        const reloaded = createFakeEnvironment(first.entries)
        const { router, routes } = startRouter(reloaded)
        expect(routes).toEqual([{ name: 'book', bookId: 'b1' }])

        router.closeBook()
        reloaded.flush()

        expect(reloaded.index).toBe(0)
        expect(routes.at(-1)).toEqual({ name: 'library' })
    })

    it('follows a hash that the user types and reports it one time', () => {
        const fake = createFakeEnvironment()
        const { routes } = startRouter(fake)

        fake.typeHash('#/book/b2')

        expect(routes).toEqual([{ name: 'library' }, { name: 'book', bookId: 'b2' }])
    })

    it('replaces the hash when a typed book address closes', () => {
        const fake = createFakeEnvironment()
        const { router } = startRouter(fake)
        fake.typeHash('#/book/b2')

        router.closeBook()

        expect(fake.entries.map((entry) => entry.hash)).toEqual(['', '#/'])
        expect(router.route).toEqual({ name: 'library' })
    })

    it('goes to the library when the user types an unknown hash', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)
        router.openBook('b1')

        fake.typeHash('#/elsewhere')

        expect(routes.at(-1)).toEqual({ name: 'library' })
        expect(fake.entries.at(-1)).toEqual({ hash: '#/', state: null })
    })

    it('keeps one entry when a second book replaces the open book', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)
        router.openBook('b1')

        router.openBook('b2')
        expect(fake.entries.map((entry) => entry.hash)).toEqual(['', '#/book/b2'])
        expect(routes.at(-1)).toEqual({ name: 'book', bookId: 'b2' })

        router.closeBook()
        fake.flush()
        expect(fake.index).toBe(0)
        expect(routes.at(-1)).toEqual({ name: 'library' })
    })

    it('ignores closeBook in the library', () => {
        const fake = createFakeEnvironment()
        const { router, routes } = startRouter(fake)

        router.closeBook()
        fake.flush()

        expect(routes).toHaveLength(1)
        expect(fake.leftApp).toBe(false)
    })

    it('stops to listen after destroy', () => {
        const fake = createFakeEnvironment()
        const onRoute = vi.fn()
        const router = createRouter({ onRoute, environment: fake.environment })
        router.start()
        expect(fake.listenerCount()).toBe(2)

        router.destroy()
        fake.typeHash('#/book/b1')

        expect(fake.listenerCount()).toBe(0)
        expect(onRoute).toHaveBeenCalledTimes(1)
    })
})
