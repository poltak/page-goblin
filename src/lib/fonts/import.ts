/**
 * Turns font files that the user chose into font families for storage. The font registry
 * loads this file at the first import, so the reader chunk does not have it.
 *
 * The files of one family go together by the family name in the files. A file with no name
 * that the app can read, for example a WOFF2 file, gets its name and style from its file name.
 */

import { sha256Hex } from '$lib/storage/crypto'
import type { FontFaceRecord, FontRecord, NewFont } from '$lib/storage/types'
import { cleanFontName, FontFileError, readFontInfo } from './sfnt'
import type { FontFallback, FontFormat, FontStyle } from './sfnt'

/** The largest font file. It is the same limit as `MAX_FONT_BYTES` of the sync server. */
export const MAX_FONT_FILE_BYTES = 25 * 1024 * 1024
/** The largest number of files in one family. A family needs 4 files for most books. */
export const MAX_FONT_FACES = 16

/** The media type of each format, for the Blob of a stored font file. */
export const FONT_MEDIA_TYPES: Record<FontFormat, string> = {
    truetype: 'font/ttf',
    opentype: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
}

/** A font file that the import read and checked. */
export interface FontFile {
    fileName: string
    /** The family name from the file, or from the file name. */
    family: string
    fallback: FontFallback
    face: FontFaceRecord
    blob: Blob
}

/** A file that the import refused, with a message for the user. */
export interface FontFileProblem {
    fileName: string
    message: string
}

export interface ReadFontFileOptions {
    /**
     * Resolves true when the browser can show the font. The default loads it as a FontFace.
     * The browser then does the full check of the file.
     */
    check?: (bytes: ArrayBuffer) => Promise<boolean>
}

async function browserAccepts(bytes: ArrayBuffer): Promise<boolean> {
    // jsdom has no FontFace. The reader checks the font again when it loads it.
    if (typeof FontFace !== 'function') return true
    try {
        // The copy keeps the bytes of the caller as they are.
        await new FontFace('pg-font-check', bytes.slice(0)).load()
        return true
    } catch {
        return false
    }
}

const WEIGHT_WORDS: readonly [RegExp, number][] = [
    [/^(hairline|thin)$/, 100],
    [/^(extra|ultra)light$/, 200],
    [/^light$/, 300],
    [/^(regular|book|normal|roman|plain)$/, 400],
    [/^medium$/, 500],
    [/^(semi|demi)bold$/, 600],
    [/^bold$/, 700],
    [/^(extra|ultra)bold$/, 800],
    [/^(black|heavy)$/, 900],
]

const STYLE_WORD =
    /^(?:(?:hairline|thin|(?:extra|ultra)?light|regular|book|normal|roman|plain|medium|(?:semi|demi|extra|ultra)?bold|black|heavy)?(?:italic|oblique)?)$/i

export interface FileNameGuess {
    family: string
    weight: string
    style: FontStyle
}

/**
 * The family and the style from a file name such as `Lora-BoldItalic.woff2`. The part after
 * the last hyphen or underscore is the style when it has only style words.
 */
export function guessFromFileName(fileName: string): FileNameGuess {
    const base = fileName
        .replace(/\.[^.]*$/, '')
        // A variable font often has its axes in the name: `Inter[opsz,wght]`.
        .replace(/\[[^\]]*\]/g, '')
        .trim()
    const match = /^(.*?)[-_ ]+([A-Za-z]+)$/.exec(base)
    const styleText = match && STYLE_WORD.test(match[2]) ? match[2] : ''
    const familyText = styleText ? match![1] : base
    const words = styleText
        .toLowerCase()
        .replace(/(italic|oblique)$/, ' $1')
        .trim()
        .split(' ')
    let weight = 400
    for (const word of words) {
        const found = WEIGHT_WORDS.find(([pattern]) => pattern.test(word))
        if (found) weight = found[1]
    }
    const family =
        cleanFontName(
            familyText
                .replace(/[-_]+/g, ' ')
                // `SourceSerif` becomes `Source Serif`.
                .replace(/([a-z])([A-Z])/g, '$1 $2'),
        ) ?? 'Font'
    return {
        family,
        weight: String(weight),
        style: /italic|oblique/i.test(styleText) ? 'italic' : 'normal',
    }
}

function problemText(error: unknown): string {
    if (error instanceof FontFileError) {
        if (error.code === 'not-a-font') {
            return 'This file is not a font. Use a .ttf, .otf, .woff or .woff2 file.'
        }
        return error.message
    }
    return 'The file could not be read.'
}

/** Reads and checks one file. Rejects with an Error that has a message for the user. */
export async function readFontFile(
    file: File,
    options: ReadFontFileOptions = {},
): Promise<FontFile> {
    if (file.size > MAX_FONT_FILE_BYTES) {
        throw new Error('The file is larger than 25 MB.')
    }
    if (file.size === 0) throw new Error('The file is empty.')
    let bytes: ArrayBuffer
    try {
        bytes = await file.arrayBuffer()
    } catch {
        throw new Error('The file could not be read.')
    }
    let info
    try {
        info = await readFontInfo(bytes)
    } catch (error) {
        throw new Error(problemText(error))
    }
    if (!(await (options.check ?? browserAccepts)(bytes))) {
        throw new Error('This browser cannot use this font. The file can be damaged.')
    }
    const guess = guessFromFileName(file.name)
    // A file with no readable names gets its style from its file name too.
    const fromName = info.family === null
    return {
        fileName: file.name,
        family: info.family ?? guess.family,
        fallback: info.fallback,
        face: {
            hash: await sha256Hex(bytes),
            format: info.format,
            weight: fromName ? guess.weight : info.weight,
            style: fromName ? guess.style : info.style,
            stretch: info.stretch,
            size: bytes.byteLength,
        },
        blob: new Blob([bytes], { type: FONT_MEDIA_TYPES[info.format] }),
    }
}

function sameSlot(a: FontFaceRecord, b: FontFaceRecord): boolean {
    return a.weight === b.weight && a.style === b.style && a.stretch === b.stretch
}

function firstWeight(face: FontFaceRecord): number {
    return Number.parseFloat(face.weight)
}

/** Normal before italic, light before bold. */
function compareFaces(a: FontFaceRecord, b: FontFaceRecord): number {
    return (
        Number(a.style === 'italic') - Number(b.style === 'italic') ||
        firstWeight(a) - firstWeight(b) ||
        Number.parseFloat(a.stretch) - Number.parseFloat(b.stretch)
    )
}

/** The fallback of the regular face, or of the first face. */
function fallbackOf(files: readonly FontFile[]): FontFallback {
    const regular = files.find((file) => file.face.style === 'normal' && file.face.weight === '400')
    return (regular ?? files[0]).fallback
}

function nameKey(name: string): string {
    return name.trim().toLocaleLowerCase()
}

export interface PlanFontImportOptions {
    files: readonly FontFile[]
    /** The families that are in storage now. */
    existing: readonly FontRecord[]
    /** Puts all files into this family. Without it, each file goes to the family of its name. */
    targetId?: string
    now: number
    createId(): string
}

export interface FontImportPlan {
    /** The families to write, with the files that storage does not have yet. */
    writes: NewFont[]
    problems: FontFileProblem[]
    /** The number of files that a family has already. */
    duplicates: number
}

/**
 * Puts the files into families. A file goes into the family with the same name, or into a
 * new family. A file with the weight, style and width of a face that the family has replaces
 * that face.
 */
export function planFontImport(options: PlanFontImportOptions): FontImportPlan {
    const { files, existing, targetId, now } = options
    const target = targetId === undefined ? undefined : existing.find((f) => f.id === targetId)
    const groups = new Map<string, FontFile[]>()
    for (const file of files) {
        const key = target ? target.id : nameKey(file.family)
        const group = groups.get(key)
        if (group) group.push(file)
        else groups.set(key, [file])
    }

    const writes: NewFont[] = []
    const problems: FontFileProblem[] = []
    let duplicates = 0
    for (const [key, group] of groups) {
        const current = target ?? existing.find((family) => nameKey(family.name) === key)
        const faces = [...(current?.faces ?? [])]
        const blobs = new Map<string, Blob>()
        for (const file of group) {
            if (faces.some((face) => face.hash === file.face.hash)) {
                duplicates++
                continue
            }
            const slot = faces.findIndex((face) => sameSlot(face, file.face))
            if (slot >= 0) {
                faces[slot] = file.face
            } else if (faces.length >= MAX_FONT_FACES) {
                problems.push({
                    fileName: file.fileName,
                    message: `A font can have ${MAX_FONT_FACES} files at most.`,
                })
                continue
            } else {
                faces.push(file.face)
            }
            blobs.set(file.face.hash, file.blob)
        }
        if (blobs.size === 0) continue
        faces.sort(compareFaces)
        // Two files of the same slot in one import: the last one stays.
        const kept = new Set(faces.map((face) => face.hash))
        for (const hash of [...blobs.keys()]) if (!kept.has(hash)) blobs.delete(hash)
        const record: FontRecord = current
            ? { ...current, faces, updatedAt: now }
            : {
                  id: options.createId(),
                  name: group[0].family,
                  fallback: fallbackOf(group),
                  faces,
                  addedAt: now,
                  updatedAt: now,
              }
        writes.push({ record, files: blobs })
    }
    return { writes, problems, duplicates }
}

const STYLE_NAMES: Record<number, string> = {
    100: 'Thin',
    200: 'Extra Light',
    300: 'Light',
    400: 'Regular',
    500: 'Medium',
    600: 'Semibold',
    700: 'Bold',
    800: 'Extra Bold',
    900: 'Black',
}

/** A short name of a face for the font sheet, for example 'Bold Italic' or 'Variable'. */
export function faceLabel(face: FontFaceRecord): string {
    const italic = face.style === 'italic'
    if (face.weight.includes(' ')) return italic ? 'Variable Italic' : 'Variable'
    const weight = Math.round(Number(face.weight) / 100) * 100
    const name = STYLE_NAMES[weight] ?? face.weight
    if (!italic) return name
    return name === 'Regular' ? 'Italic' : `${name} Italic`
}
