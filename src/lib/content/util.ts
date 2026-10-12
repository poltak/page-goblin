import type { EpubBook, ResolvedHref } from '$lib/epub/types'

export interface HrefSource {
    book: EpubBook
    /** Container path of the document that has the href. */
    from: string
    href: string
}

/** `book.resolve` for hrefs from the book. A bad percent escape gives null, not an error. */
export function resolveHref({ book, from, href }: HrefSource): ResolvedHref | null {
    try {
        return book.resolve(from, href)
    } catch {
        return null
    }
}

/** The target of an href when it is a file in the book, else null. */
export function resolveFile(source: HrefSource): ResolvedHref | null {
    const target = resolveHref(source)
    return target && source.book.has(target.path) ? target : null
}

export function wordSet(names: string): ReadonlySet<string> {
    return new Set(names.split(' '))
}
