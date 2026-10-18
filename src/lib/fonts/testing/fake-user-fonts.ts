/** A registry of user fonts for tests. It has no storage and adds no faces to the page. */

import type { FontRecord, NewFont } from '$lib/storage/types'
import type { UserFonts } from '../user-fonts'

export interface FakeUserFonts extends UserFonts {
    /** Changes the list and calls the listeners, as a read after a change does. */
    setList(list: readonly FontRecord[]): void
    /** The ids of each `ensureLoaded` call, in order. */
    readonly loads: readonly string[]
    /** The number of `refresh` calls. */
    readonly refreshes: number
    /** The families of each `save` call, in order. */
    readonly saved: readonly NewFont[]
}

export interface FakeUserFontsOptions {
    list?: readonly FontRecord[]
    /** Runs at each `ensureLoaded` call. The default resolves at once. */
    load?: (fontId: string) => Promise<unknown>
}

export function createFakeUserFonts(options: FakeUserFontsOptions = {}): FakeUserFonts {
    let list = options.list ?? []
    let refreshes = 0
    const loads: string[] = []
    const saved: NewFont[] = []
    const listeners = new Set<(list: readonly FontRecord[]) => void>()
    return {
        get list() {
            return list
        },
        get loads() {
            return loads
        },
        get refreshes() {
            return refreshes
        },
        get saved() {
            return saved
        },
        async refresh() {
            refreshes++
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        async ensureLoaded(fontId) {
            loads.push(fontId)
            await options.load?.(fontId)
        },
        async save(fonts) {
            saved.push(...fonts)
            const ids = new Set(fonts.map((font) => font.record.id))
            this.setList([
                ...list.filter((font) => !ids.has(font.id)),
                ...fonts.map((f) => f.record),
            ])
        },
        async remove(id) {
            const record = list.find((font) => font.id === id)
            if (!record) return null
            this.setList(list.filter((font) => font.id !== id))
            return { record, files: new Map() }
        },
        setList(next) {
            list = next
            for (const listener of [...listeners]) listener(list)
        },
    }
}
