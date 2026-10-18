import { describe, expect, it } from 'vitest'
import type { FontFaceRecord, FontRecord } from '$lib/storage/types'
import {
    faceLabel,
    guessFromFileName,
    MAX_FONT_FACES,
    MAX_FONT_FILE_BYTES,
    planFontImport,
    readFontFile,
} from './import'
import type { FontFile } from './import'
import { buildFont, familyNames } from './testing/build-font'

const accept = async () => true

function face(hash: string, changes: Partial<FontFaceRecord> = {}): FontFaceRecord {
    return {
        hash,
        format: 'truetype',
        weight: '400',
        style: 'normal',
        stretch: '100%',
        size: 10,
        ...changes,
    }
}

function fontFile(family: string, hash: string, changes: Partial<FontFaceRecord> = {}): FontFile {
    return {
        fileName: `${hash}.ttf`,
        family,
        fallback: 'serif',
        face: face(hash, changes),
        blob: new Blob([hash]),
    }
}

function family(id: string, name: string, faces: FontFaceRecord[]): FontRecord {
    return { id, name, fallback: 'serif', faces, addedAt: 1, updatedAt: 1 }
}

let ids = 0
function plan(options: Omit<Parameters<typeof planFontImport>[0], 'now' | 'createId'>) {
    ids = 0
    return planFontImport({ ...options, now: 50, createId: () => `new-${++ids}` })
}

describe('guessFromFileName', () => {
    it.each([
        ['Lora-BoldItalic.woff2', 'Lora', '700', 'italic'],
        ['Lora-Regular.ttf', 'Lora', '400', 'normal'],
        ['Lora-Italic.otf', 'Lora', '400', 'italic'],
        ['OpenSans-ExtraBoldItalic.woff2', 'Open Sans', '800', 'italic'],
        ['SourceSerif4_SemiBold.woff', 'Source Serif4', '600', 'normal'],
        ['Inter[opsz,wght].woff2', 'Inter', '400', 'normal'],
        ['Inter-Italic[wght].woff2', 'Inter', '400', 'italic'],
        ['Roboto Light.ttf', 'Roboto', '300', 'normal'],
        ['Source-Serif.ttf', 'Source Serif', '400', 'normal'],
        ['font.woff2', 'font', '400', 'normal'],
        ['-Bold.woff2', 'Font', '700', 'normal'],
    ])('reads %s', (fileName, familyName, weight, style) => {
        expect(guessFromFileName(fileName)).toEqual({ family: familyName, weight, style })
    })
})

describe('readFontFile', () => {
    it('reads the family, the style and the hash of a font file', async () => {
        const bytes = buildFont({
            names: familyNames('Merriweather', 'Bold'),
            os2: { weight: 700, panose: [2, 11] },
        })
        const file = new File([bytes], 'Whatever.ttf')

        const read = await readFontFile(file, { check: accept })

        expect(read).toMatchObject({
            fileName: 'Whatever.ttf',
            family: 'Merriweather',
            fallback: 'sans-serif',
            face: {
                format: 'truetype',
                weight: '700',
                style: 'normal',
                stretch: '100%',
                size: bytes.length,
            },
        })
        expect(read.face.hash).toMatch(/^[0-9a-f]{64}$/)
        expect(read.blob.type).toBe('font/ttf')
        expect(read.blob.size).toBe(bytes.length)
    })

    it('takes the name and the style of a WOFF2 file from its file name', async () => {
        const file = new File(['wOF2' + '\x00'.repeat(60)], 'Lora-SemiBoldItalic.woff2')
        const read = await readFontFile(file, { check: accept })
        expect(read.family).toBe('Lora')
        expect(read.face).toMatchObject({ format: 'woff2', weight: '600', style: 'italic' })
        expect(read.blob.type).toBe('font/woff2')
    })

    it('refuses a file that is not a font, a collection and an empty file', async () => {
        await expect(readFontFile(new File(['hello'], 'a.ttf'), { check: accept })).rejects.toThrow(
            'This file is not a font. Use a .ttf, .otf, .woff or .woff2 file.',
        )
        const ttc = new File(['ttcf\x00\x01\x00\x00'], 'Helvetica.ttc')
        await expect(readFontFile(ttc, { check: accept })).rejects.toThrow('.ttc')
        await expect(readFontFile(new File([], 'a.ttf'), { check: accept })).rejects.toThrow(
            'The file is empty.',
        )
    })

    it('refuses a file larger than the limit before it reads it', async () => {
        const file = new File(['x'], 'big.ttf')
        Object.defineProperty(file, 'size', { value: MAX_FONT_FILE_BYTES + 1 })
        Object.defineProperty(file, 'arrayBuffer', {
            value: () => Promise.reject(new Error('must not read')),
        })
        await expect(readFontFile(file)).rejects.toThrow('The file is larger than 25 MB.')
    })

    it('refuses a font that the browser cannot use', async () => {
        const file = new File([buildFont()], 'a.ttf')
        await expect(readFontFile(file, { check: async () => false })).rejects.toThrow(
            'This browser cannot use this font.',
        )
    })

    it('accepts a font in a page with no FontFace', async () => {
        const read = await readFontFile(new File([buildFont()], 'a.ttf'))
        expect(read.family).toBe('Test Serif')
    })
})

describe('planFontImport', () => {
    it('makes one family for each family name, with sorted faces', () => {
        const result = plan({
            files: [
                fontFile('Lora', 'lb', { weight: '700' }),
                fontFile('Inter', 'ir'),
                fontFile('Lora', 'li', { style: 'italic' }),
                fontFile('lora', 'lr'),
            ],
            existing: [],
        })

        expect(result.problems).toEqual([])
        expect(result.writes.map(({ record }) => record)).toEqual(
            [
                family('new-1', 'Lora', [
                    face('lr'),
                    face('lb', { weight: '700' }),
                    face('li', { style: 'italic' }),
                ]),
                family('new-2', 'Inter', [face('ir')]),
            ].map((record) => ({ ...record, addedAt: 50, updatedAt: 50 })),
        )
        expect([...result.writes[0].files.keys()].sort()).toEqual(['lb', 'li', 'lr'])
    })

    it('takes the fallback of the regular face', () => {
        const files = [
            { ...fontFile('Mono', 'b', { weight: '700' }), fallback: 'serif' as const },
            { ...fontFile('Mono', 'r'), fallback: 'monospace' as const },
        ]
        expect(plan({ files, existing: [] }).writes[0].record.fallback).toBe('monospace')
    })

    it('adds a file to the family with the same name', () => {
        const existing = [family('f', 'Lora', [face('lr')])]
        const result = plan({ files: [fontFile('LORA', 'lb', { weight: '700' })], existing })

        expect(result.writes).toHaveLength(1)
        expect(result.writes[0].record).toEqual({
            ...existing[0],
            faces: [face('lr'), face('lb', { weight: '700' })],
            updatedAt: 50,
        })
        expect([...result.writes[0].files.keys()]).toEqual(['lb'])
    })

    it('puts each file into the target family, whatever its name', () => {
        const existing = [family('f', 'My Font', [face('r')])]
        const result = plan({
            files: [fontFile('Other', 'i', { style: 'italic' })],
            existing,
            targetId: 'f',
        })
        expect(result.writes.map(({ record }) => record.id)).toEqual(['f'])
        expect(result.writes[0].record.name).toBe('My Font')
    })

    it('counts a file that the family has already and writes nothing for it', () => {
        const existing = [family('f', 'Lora', [face('lr')])]
        const result = plan({ files: [fontFile('Lora', 'lr'), fontFile('Lora', 'lr')], existing })
        expect(result).toEqual({ writes: [], problems: [], duplicates: 2 })
    })

    it('replaces a face with the same weight, style and width', () => {
        const existing = [family('f', 'Lora', [face('old'), face('i', { style: 'italic' })])]
        const result = plan({
            files: [fontFile('Lora', 'first'), fontFile('Lora', 'new')],
            existing,
        })
        expect(result.writes[0].record.faces.map((item) => item.hash)).toEqual(['new', 'i'])
        expect([...result.writes[0].files.keys()]).toEqual(['new'])
    })

    it('keeps a condensed face next to the normal face', () => {
        const existing = [family('f', 'Roboto', [face('r')])]
        const result = plan({ files: [fontFile('Roboto', 'c', { stretch: '75%' })], existing })
        expect(result.writes[0].record.faces.map((item) => item.hash)).toEqual(['c', 'r'])
    })

    it('refuses the files after the largest number of faces', () => {
        const faces = Array.from({ length: MAX_FONT_FACES }, (_, index) =>
            face(`f${index}`, { weight: String(100 + index) }),
        )
        const existing = [family('f', 'Big', faces)]
        const result = plan({
            files: [
                fontFile('Big', 'extra', { weight: '999' }),
                fontFile('Big', 'swap', { weight: '100' }),
            ],
            existing,
        })
        expect(result.problems).toEqual([
            { fileName: 'extra.ttf', message: `A font can have ${MAX_FONT_FACES} files at most.` },
        ])
        expect(result.writes[0].record.faces).toHaveLength(MAX_FONT_FACES)
        expect(result.writes[0].record.faces[0].hash).toBe('swap')
    })
})

describe('faceLabel', () => {
    it.each([
        [{}, 'Regular'],
        [{ style: 'italic' as const }, 'Italic'],
        [{ weight: '700' }, 'Bold'],
        [{ weight: '700', style: 'italic' as const }, 'Bold Italic'],
        [{ weight: '350' }, 'Regular'],
        [{ weight: '100 900' }, 'Variable'],
        [{ weight: '100 900', style: 'italic' as const }, 'Variable Italic'],
        [{ weight: '1000' }, '1000'],
    ])('names %o as %s', (changes, label) => {
        expect(faceLabel(face('x', changes))).toBe(label)
    })
})
