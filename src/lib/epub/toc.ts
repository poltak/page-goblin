/**
 * The part of the table of contents code that the nav document and the NCX file share.
 */

import type { ResolvedHref, TocItem } from './types'

export interface TocContext {
    /** Container path of the nav document or the NCX file. Targets are relative to it. */
    fromPath: string
    resolve(fromPath: string, href: string): ResolvedHref | null
    spineIndexOf(path: string): number
}

export interface TocEntry {
    title: string
    /** The link target as written, or null for a heading with no link. */
    href: string | null
    children: TocItem[]
}

/**
 * Add an entry to a list. An entry with an empty title is left out, and its children move up
 * one level so that they are not lost.
 */
export function addTocEntry(list: TocItem[], entry: TocEntry, context: TocContext): void {
    if (!entry.title) {
        list.push(...entry.children)
        return
    }

    const target = entry.href ? context.resolve(context.fromPath, entry.href) : null
    list.push({
        title: entry.title,
        path: target?.path ?? null,
        fragment: target?.fragment ?? null,
        spineIndex: target ? context.spineIndexOf(target.path) : -1,
        children: entry.children,
    })
}
