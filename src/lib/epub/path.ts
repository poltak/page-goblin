/**
 * Paths inside the EPUB container. A container path has no leading slash and no escapes.
 */

import type { ResolvedHref } from './types'

const SCHEME = /^[a-z][a-z\d+.-]*:/i

/** The directory of a container path with its last '/', or '' for a file at the root. */
export function dirname(path: string): string {
    return path.slice(0, path.lastIndexOf('/') + 1)
}

/** Split an href at the first '#'. The parts stay as written. An empty fragment gives null. */
export function splitHref(href: string): { path: string; fragment: string | null } {
    const hashIndex = href.indexOf('#')
    if (hashIndex < 0) return { path: href, fragment: null }
    return { path: href.slice(0, hashIndex), fragment: href.slice(hashIndex + 1) || null }
}

/**
 * Resolve an href against a container directory ('' or a path that ends with '/').
 * Returns null for an empty href, a URL with a scheme and a path that leaves the container.
 */
export function resolvePath(baseDirectory: string, href: string): string | null {
    const cleaned = cleanHref(href)
    if (isExternal(cleaned)) return null
    return normalise(baseDirectory, splitHref(cleaned).path)
}

/** Resolve an href that is written in the file at `fromPath`. See `EpubBook.resolve`. */
export function resolveHref(fromPath: string, href: string): ResolvedHref | null {
    const cleaned = cleanHref(href)
    if (!cleaned || isExternal(cleaned)) return null

    const parts = splitHref(cleaned)
    const fragment = parts.fragment === null ? null : decodeSafely(parts.fragment)
    if (!withoutQuery(parts.path)) return { path: fromPath, fragment }

    const path = normalise(dirname(fromPath), parts.path)
    return path === null ? null : { path, fragment }
}

/** Browsers remove tabs and line breaks from a URL before they parse it. */
function cleanHref(href: string): string {
    return href.replace(/[\t\n\r]/g, '').trim()
}

function isExternal(href: string): boolean {
    return SCHEME.test(href) || /^[\\/]{2}/.test(href)
}

function withoutQuery(path: string): string {
    const queryIndex = path.indexOf('?')
    return queryIndex < 0 ? path : path.slice(0, queryIndex)
}

function normalise(baseDirectory: string, rawPath: string): string | null {
    // Books from Windows tools write '\' between the directories, and browsers read it as
    // '/'. A container path has no '\', so an escaped one (%5C) is a separator too.
    const decoded = decodeSafely(withoutQuery(rawPath)).replace(/\\/g, '/')
    if (!decoded || decoded.includes('\0')) return null

    const base = baseDirectory && !baseDirectory.endsWith('/') ? `${baseDirectory}/` : baseDirectory
    const combined = decoded.startsWith('/') ? decoded : base + decoded
    const parts: string[] = []
    for (const part of combined.split('/')) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (!parts.length) return null
            parts.pop()
            continue
        }
        parts.push(part)
    }

    return parts.length ? parts.join('/') : null
}

function decodeSafely(value: string): string {
    if (!value.includes('%')) return value
    try {
        return decodeURIComponent(value)
    } catch {
        // One bad escape must not stop the decoding of the other escapes.
        return value.replace(/(?:%[\da-f]{2})+/gi, (escapes) => {
            try {
                return decodeURIComponent(escapes)
            } catch {
                return escapes
            }
        })
    }
}
