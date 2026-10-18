/**
 * The fonts that the user added, for the reader. The registry keeps the list of families in
 * memory, and it adds the faces of a family to `document.fonts` when the reader needs them.
 *
 * Each face gets a `blob:` URL for its file in storage, so the browser reads only the faces
 * that the text uses. The Content Security Policy allows `blob:` in `font-src`.
 */

import type { FontRecord, LibraryStorage, NewFont } from '$lib/storage/types'
import {
    ensureFontLoaded,
    FONT_LOAD_LIMIT_MS,
    loadFace,
    quoteFamily,
    settleWithin,
    userFontFamily,
    userFontIdOf,
} from './catalog'

export type UserFontSource = Pick<
    LibraryStorage,
    'listFonts' | 'getFontFile' | 'putFont' | 'deleteFont'
>

export interface UserFonts {
    /** The families that have all their files on this device, sorted by name. */
    readonly list: readonly FontRecord[]
    /**
     * Reads the list from storage again. A call during a read starts one more read after it,
     * so the list is never older than the call. Never rejects.
     */
    refresh(): Promise<void>
    /** The listener runs after each change of the list. Returns the function that removes it. */
    subscribe(listener: (list: readonly FontRecord[]) => void): () => void
    /**
     * Makes the font of a `fontId` setting ready for layout. For a font of the user, it adds
     * the faces to `document.fonts` and waits for the regular face. For a different font it
     * is `ensureFontLoaded`. Waits `FONT_LOAD_LIMIT_MS` at most. Never rejects.
     */
    ensureLoaded(fontId: string): Promise<void>
    /** Writes the families, one transaction each, and then reads the list again. */
    save(fonts: readonly NewFont[]): Promise<void>
    /**
     * Removes a family and reads the list again. Resolves with a copy of the family and its
     * files, so a `save` of it puts the family back. Null when the family is not there.
     */
    remove(id: string): Promise<NewFont | null>
}

interface Registered {
    /** The faces of the family when it was added. A different value needs new faces. */
    signature: string
    faces: FontFace[]
    urls: string[]
    /** True after `unregister`. A registration that is still on its way then adds nothing. */
    dropped: boolean
    ready: Promise<void>
}

function byName(a: FontRecord, b: FontRecord): number {
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

function canRegister(): boolean {
    return (
        typeof FontFace === 'function' &&
        typeof document !== 'undefined' &&
        document.fonts !== undefined &&
        typeof URL.createObjectURL === 'function'
    )
}

function createFace(family: string, source: string, descriptors: FontFaceDescriptors) {
    try {
        const face = new FontFace(family, source, descriptors)
        // A file that the browser refuses rejects this promise. The text then shows in the
        // fallback font, and nothing reads the error.
        face.loaded.catch(() => {})
        return face
    } catch {
        return null
    }
}

export function createUserFonts(source: UserFontSource): UserFonts {
    let list: readonly FontRecord[] = []
    let loaded = false
    let reading: Promise<void> | null = null
    let again = false
    const listeners = new Set<(list: readonly FontRecord[]) => void>()
    const registered = new Map<string, Registered>()

    function find(id: string): FontRecord | undefined {
        return list.find((family) => family.id === id)
    }

    function unregister(id: string): void {
        const entry = registered.get(id)
        if (!entry) return
        entry.dropped = true
        registered.delete(id)
        for (const face of entry.faces) document.fonts.delete(face)
        for (const url of entry.urls) URL.revokeObjectURL(url)
    }

    async function addFaces(family: FontRecord, entry: Registered): Promise<void> {
        const files = await Promise.all(
            family.faces.map((face) => source.getFontFile(face.hash).catch(() => undefined)),
        )
        if (entry.dropped) return
        const name = userFontFamily(family.id)
        family.faces.forEach((face, index) => {
            const file = files[index]
            if (!file) return
            const url = URL.createObjectURL(file)
            entry.urls.push(url)
            const fontFace = createFace(name, `url("${url}") format("${face.format}")`, {
                weight: face.weight,
                style: face.style,
                stretch: face.stretch,
            })
            if (!fontFace) return
            entry.faces.push(fontFace)
            document.fonts.add(fontFace)
        })
    }

    function register(family: FontRecord): Promise<void> {
        const signature = JSON.stringify(family.faces)
        const current = registered.get(family.id)
        if (current?.signature === signature) return current.ready
        unregister(family.id)
        if (!canRegister()) return Promise.resolve()
        const entry: Registered = {
            signature,
            faces: [],
            urls: [],
            dropped: false,
            ready: Promise.resolve(),
        }
        entry.ready = addFaces(family, entry).catch((error: unknown) => console.error(error))
        registered.set(family.id, entry)
        return entry.ready
    }

    async function readOnce(): Promise<void> {
        let records: FontRecord[]
        try {
            records = await source.listFonts()
        } catch (error) {
            console.error(error)
            return
        }
        loaded = true
        const next = [...records].sort(byName)
        if (JSON.stringify(next) === JSON.stringify(list)) return
        list = next
        // The faces of a removed or changed family leave the page. A changed family gets new
        // faces at its next `ensureLoaded`.
        for (const [id, entry] of [...registered]) {
            const family = find(id)
            if (!family || JSON.stringify(family.faces) !== entry.signature) unregister(id)
        }
        for (const listener of [...listeners]) {
            try {
                listener(list)
            } catch (error) {
                console.error(error)
            }
        }
    }

    function refresh(): Promise<void> {
        if (reading) {
            again = true
            return reading
        }
        reading = (async () => {
            do {
                again = false
                await readOnce()
            } while (again)
        })().finally(() => {
            reading = null
        })
        return reading
    }

    async function loadUserFont(id: string): Promise<void> {
        // A different tab or the sync can add a family that the list does not have yet.
        if (!loaded || !find(id)) await refresh()
        const family = find(id)
        if (!family) return
        await register(family)
        await loadFace(quoteFamily(userFontFamily(id)))
    }

    async function save(fonts: readonly NewFont[]): Promise<void> {
        try {
            for (const font of fonts) await source.putFont(font)
        } finally {
            await refresh()
        }
    }

    async function remove(id: string): Promise<NewFont | null> {
        if (!loaded) await refresh()
        const record = find(id)
        if (!record) return null
        // The bytes go into memory, because a file that leaves storage can stop being readable.
        const files = new Map<string, Blob>()
        for (const face of record.faces) {
            const file = await source.getFontFile(face.hash)
            if (file)
                files.set(face.hash, new Blob([await file.arrayBuffer()], { type: file.type }))
        }
        try {
            await source.deleteFont(id)
        } finally {
            await refresh()
        }
        return { record, files }
    }

    return {
        get list() {
            return list
        },
        refresh,
        save,
        remove,
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        ensureLoaded(fontId) {
            const id = userFontIdOf(fontId)
            if (id === null) return ensureFontLoaded(fontId)
            return settleWithin(loadUserFont(id), FONT_LOAD_LIMIT_MS)
        },
    }
}

const registries = new WeakMap<UserFontSource, UserFonts>()

/**
 * The one registry of the page for a storage. The faces of a font stay in the page from one
 * book to the next.
 */
export function userFontsFor(source: UserFontSource): UserFonts {
    let fonts = registries.get(source)
    if (!fonts) {
        fonts = createUserFonts(source)
        registries.set(source, fonts)
    }
    return fonts
}
