import { describe, expect, it, vi } from 'vitest'
import { EpubError } from '$lib/epub/types'
import type { EpubErrorCode } from '$lib/epub/types'
import type { ImportProgress, ImportResult } from '$lib/storage/import'
import type { BookRecord } from '$lib/storage/types'
import {
    createImportQueue,
    describeImportError,
    hasZipSignature,
    IMPORT_MESSAGES,
    importFraction,
    notZipError,
    phaseLabel,
} from './import-queue'
import type { ImportFailure, ImportQueueOptions } from './import-queue'

function makeFile(name: string): File {
    return new File(['bytes'], name, { type: 'application/epub+zip' })
}

function makeRecord(id: string): BookRecord {
    return {
        id,
        title: `Title of ${id}`,
        author: 'Author',
        language: null,
        identifier: null,
        publisher: null,
        description: null,
        published: null,
        subjects: [],
        series: null,
        fileName: `${id}.epub`,
        fileSize: 5,
        fileHash: `hash-${id}`,
        hasCover: false,
        spineStats: [],
        totalChars: 0,
        totalWords: 0,
        addedAt: 1,
        lastOpenedAt: null,
    }
}

function added(id: string): ImportResult {
    return { book: makeRecord(id), duplicate: false }
}

/** A promise that the test settles by hand. */
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve
        reject = onReject
    })
    return { promise, resolve, reject }
}

/** A queue with a fake importer. `log` has each event in the order that it came. */
function setup(importFile: ImportQueueOptions['importFile']) {
    const log: string[] = []
    const failures: ImportFailure[] = []
    const queue = createImportQueue({
        importFile,
        onFileStart: ({ file, position, total }) =>
            log.push(`start ${file.name} ${position}/${total}`),
        onProgress: ({ phase, done, total }) => log.push(`progress ${phase} ${done}/${total}`),
        onAdded: (book) => log.push(`added ${book.id}`),
        onDuplicate: (book) => log.push(`duplicate ${book.id}`),
        onFailure(failure) {
            failures.push(failure)
            log.push(`failed ${failure.fileName}`)
        },
        onIdle: () => log.push('idle'),
    })
    return { queue, log, failures }
}

describe('describeImportError', () => {
    it.each<[EpubErrorCode, string]>([
        ['drm', 'This book has DRM protection and cannot be opened.'],
        ['not-zip', 'This file is not an EPUB file, or it is damaged.'],
        ['no-container', 'This EPUB file has a structure that the reader cannot read.'],
        ['invalid-package', 'This EPUB file has a structure that the reader cannot read.'],
        ['no-content', 'This EPUB file has a structure that the reader cannot read.'],
    ])('gives the sentence for the EPUB error "%s"', (code, message) => {
        expect(describeImportError(new EpubError(code, 'internal text'))).toEqual({
            message,
            detail: null,
        })
    })

    it.each<EpubErrorCode>(['missing-file', 'unsupported-compression'])(
        'gives the general sentence and the error text for the EPUB error "%s"',
        (code) => {
            expect(describeImportError(new EpubError(code, 'OEBPS/ch1.xhtml is missing'))).toEqual({
                message: 'The book was not added.',
                detail: 'OEBPS/ch1.xhtml is missing',
            })
        },
    )

    it('gives the storage sentence for a quota error', () => {
        const error = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        expect(describeImportError(error)).toEqual({
            message: 'There is not enough storage space on this device for this book.',
            detail: null,
        })
    })

    it('finds a quota error that is the cause of a different error', () => {
        const cause = new DOMException('full', 'QuotaExceededError')
        const error = new Error('The transaction was aborted.', { cause })
        expect(describeImportError(error).message).toBe(IMPORT_MESSAGES.quota)
    })

    it('gives the general sentence and the error text for other errors', () => {
        expect(describeImportError(new Error('Something broke'))).toEqual({
            message: 'The book was not added.',
            detail: 'Something broke',
        })
        expect(describeImportError('a text')).toEqual({
            message: 'The book was not added.',
            detail: 'a text',
        })
    })

    it('gives no detail when the error has no text', () => {
        expect(describeImportError(new Error(''))).toEqual({
            message: 'The book was not added.',
            detail: null,
        })
        expect(describeImportError(undefined).detail).toBeNull()
        expect(describeImportError(null).detail).toBeNull()
        expect(describeImportError({ code: 'drm' }).message).toBe(IMPORT_MESSAGES.other)
    })

    it('does not read a code that is the name of an object method', () => {
        const error = Object.assign(new Error('odd'), { name: 'EpubError', code: 'toString' })
        expect(describeImportError(error)).toEqual({
            message: 'The book was not added.',
            detail: 'odd',
        })
    })

    it('reads the error of the signature check as a file that is not an EPUB', () => {
        expect(describeImportError(notZipError()).message).toBe(IMPORT_MESSAGES.notEpub)
    })
})

describe('hasZipSignature', () => {
    it('is true for a file that starts with a ZIP local file header', async () => {
        const zip = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])])
        expect(await hasZipSignature(zip)).toBe(true)
    })

    it('is false for other files', async () => {
        expect(await hasZipSignature(new Blob(['%PDF-1.7']))).toBe(false)
        expect(await hasZipSignature(new Blob([]))).toBe(false)
        expect(await hasZipSignature(new Blob(['PK']))).toBe(false)
        // The end record of an empty archive. An EPUB file is never empty.
        expect(await hasZipSignature(new Blob([new Uint8Array([0x50, 0x4b, 0x05, 0x06])]))).toBe(
            false,
        )
    })

    it('is false for a file that cannot be read', async () => {
        const broken = {
            slice: () => ({ arrayBuffer: () => Promise.reject(new Error('gone')) }),
        } as unknown as Blob
        expect(await hasZipSignature(broken)).toBe(false)
    })
})

describe('import progress', () => {
    it('names each phase in plain words', () => {
        expect(phaseLabel('hash')).toBe('Reading the file')
        expect(phaseLabel('open')).toBe('Opening the book')
        expect(phaseLabel('cover')).toBe('Making the cover')
        expect(phaseLabel('measure')).toBe('Measuring the chapters')
        expect(phaseLabel('save')).toBe('Saving to the library')
    })

    it('goes from 0 to 1 through the phases and never goes back', () => {
        const events: ImportProgress[] = [
            { phase: 'hash', done: 0, total: 1 },
            { phase: 'hash', done: 1, total: 1 },
            { phase: 'open', done: 0, total: 1 },
            { phase: 'open', done: 1, total: 1 },
            { phase: 'cover', done: 0, total: 1 },
            { phase: 'cover', done: 1, total: 1 },
            { phase: 'measure', done: 0, total: 4 },
            { phase: 'measure', done: 2, total: 4 },
            { phase: 'measure', done: 4, total: 4 },
            { phase: 'save', done: 0, total: 1 },
            { phase: 'save', done: 1, total: 1 },
        ]
        const fractions = events.map(importFraction)

        expect(fractions[0]).toBe(0)
        expect(fractions.at(-1)).toBeCloseTo(1)
        expect(fractions[7]).toBeCloseTo(0.6)
        // The small number covers the rounding of the sums.
        for (let index = 1; index < fractions.length; index++) {
            expect(fractions[index] + 1e-9).toBeGreaterThanOrEqual(fractions[index - 1])
        }
    })

    it('does not divide by a total of 0', () => {
        expect(importFraction({ phase: 'measure', done: 0, total: 0 })).toBeCloseTo(0.3)
    })
})

describe('createImportQueue', () => {
    it('imports the files one after the other, in the order of the list', async () => {
        const running: string[] = []
        let active = 0
        let mostActive = 0
        const { queue, log } = setup(async (file) => {
            active += 1
            mostActive = Math.max(mostActive, active)
            running.push(file.name)
            await Promise.resolve()
            active -= 1
            return added(file.name)
        })

        const summary = await queue.add([
            makeFile('a.epub'),
            makeFile('b.epub'),
            makeFile('c.epub'),
        ])

        expect(running).toEqual(['a.epub', 'b.epub', 'c.epub'])
        expect(mostActive).toBe(1)
        expect(summary.added.map((book) => book.id)).toEqual(['a.epub', 'b.epub', 'c.epub'])
        expect(log).toEqual([
            'start a.epub 1/3',
            'added a.epub',
            'start b.epub 2/3',
            'added b.epub',
            'start c.epub 3/3',
            'added c.epub',
            'idle',
        ])
    })

    it('does not start the second file before the first one is done', async () => {
        const first = deferred<ImportResult>()
        const importFile = vi
            .fn<ImportQueueOptions['importFile']>()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce(added('b'))
        const { queue } = setup(importFile)

        const done = queue.add([makeFile('a.epub'), makeFile('b.epub')])
        await Promise.resolve()
        expect(importFile).toHaveBeenCalledTimes(1)
        expect(queue.busy).toBe(true)

        first.resolve(added('a'))
        await done
        expect(importFile).toHaveBeenCalledTimes(2)
        expect(queue.busy).toBe(false)
    })

    it('passes the progress of the importer on', async () => {
        const { queue, log } = setup(async (_file, onProgress) => {
            onProgress({ phase: 'hash', done: 0, total: 1 })
            onProgress({ phase: 'measure', done: 3, total: 9 })
            return added('a')
        })

        await queue.add([makeFile('a.epub')])

        expect(log).toEqual([
            'start a.epub 1/1',
            'progress hash 0/1',
            'progress measure 3/9',
            'added a',
            'idle',
        ])
    })

    it('reports a file that fails and continues with the next file', async () => {
        const { queue, log, failures } = setup(async (file) => {
            if (file.name === 'locked.epub') throw new EpubError('drm', 'encrypted')
            if (file.name === 'notes.pdf') throw new EpubError('not-zip', 'no signature')
            if (file.name === 'odd.epub') throw new Error('Unexpected end of data')
            return added(file.name)
        })

        const summary = await queue.add([
            makeFile('locked.epub'),
            makeFile('good.epub'),
            makeFile('notes.pdf'),
            makeFile('odd.epub'),
            makeFile('last.epub'),
        ])

        expect(summary.added.map((book) => book.id)).toEqual(['good.epub', 'last.epub'])
        expect(failures).toEqual([
            {
                fileName: 'locked.epub',
                message: 'This book has DRM protection and cannot be opened.',
                detail: null,
            },
            {
                fileName: 'notes.pdf',
                message: 'This file is not an EPUB file, or it is damaged.',
                detail: null,
            },
            {
                fileName: 'odd.epub',
                message: 'The book was not added.',
                detail: 'Unexpected end of data',
            },
        ])
        expect(summary.failures).toEqual(failures)
        expect(log.filter((line) => !line.startsWith('start'))).toEqual([
            'failed locked.epub',
            'added good.epub',
            'failed notes.pdf',
            'failed odd.epub',
            'added last.epub',
            'idle',
        ])
    })

    it('reports a duplicate with the stored record and does not count it as added', async () => {
        const stored = makeRecord('stored')
        const { queue, log } = setup(async (file) =>
            file.name === 'again.epub' ? { book: stored, duplicate: true } : added(file.name),
        )

        const summary = await queue.add([makeFile('again.epub'), makeFile('new.epub')])

        expect(summary.duplicates).toEqual([stored])
        expect(summary.added.map((book) => book.id)).toEqual(['new.epub'])
        expect(summary.failures).toEqual([])
        expect(log).toEqual([
            'start again.epub 1/2',
            'duplicate stored',
            'start new.epub 2/2',
            'added new.epub',
            'idle',
        ])
    })

    it('puts files that come during an import at the end, with their own summary', async () => {
        const first = deferred<ImportResult>()
        const { queue, log } = setup((file) =>
            file.name === 'a.epub' ? first.promise : Promise.resolve(added(file.name)),
        )

        const one = queue.add([makeFile('a.epub'), makeFile('b.epub')])
        await Promise.resolve()
        const two = queue.add([makeFile('c.epub')])
        first.resolve(added('a.epub'))

        expect((await one).added.map((book) => book.id)).toEqual(['a.epub', 'b.epub'])
        expect((await two).added.map((book) => book.id)).toEqual(['c.epub'])
        expect(log).toEqual([
            'start a.epub 1/2',
            'added a.epub',
            'start b.epub 2/3',
            'added b.epub',
            'start c.epub 3/3',
            'added c.epub',
            'idle',
        ])
    })

    it('counts from 1 again after the queue was idle', async () => {
        const { queue, log } = setup(async (file) => added(file.name))

        await queue.add([makeFile('a.epub')])
        await queue.add([makeFile('b.epub')])

        expect(log).toEqual([
            'start a.epub 1/1',
            'added a.epub',
            'idle',
            'start b.epub 1/1',
            'added b.epub',
            'idle',
        ])
    })

    it('resolves at once for an empty list', async () => {
        const importFile = vi.fn<ImportQueueOptions['importFile']>()
        const { queue, log } = setup(importFile)

        expect(await queue.add([])).toEqual({ added: [], duplicates: [], failures: [] })
        expect(importFile).not.toHaveBeenCalled()
        expect(log).toEqual([])
    })

    it('continues when a listener throws', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const names: string[] = []
        const queue = createImportQueue({
            importFile: async (file) => added(file.name),
            onAdded(book) {
                names.push(book.id)
                if (book.id === 'a.epub') throw new Error('listener')
            },
        })

        const summary = await queue.add([makeFile('a.epub'), makeFile('b.epub')])

        expect(names).toEqual(['a.epub', 'b.epub'])
        expect(summary.added).toHaveLength(2)
        expect(queue.busy).toBe(false)
        expect(error).toHaveBeenCalledTimes(1)
        error.mockRestore()
    })

    it('still imports each file and becomes idle when the start listener throws', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const onIdle = vi.fn<() => void>()
        const queue = createImportQueue({
            importFile: async (file) => added(file.name),
            onFileStart({ file }) {
                if (file.name === 'a.epub') throw new Error('listener')
            },
            onIdle,
        })

        const summary = await queue.add([makeFile('a.epub'), makeFile('b.epub')])

        expect(summary.added.map((book) => book.id)).toEqual(['a.epub', 'b.epub'])
        expect(queue.busy).toBe(false)
        expect(onIdle).toHaveBeenCalledTimes(1)
        error.mockRestore()
    })

    it('takes new files after the idle listener throws', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const queue = createImportQueue({
            importFile: async (file) => added(file.name),
            onIdle() {
                throw new Error('listener')
            },
        })

        await queue.add([makeFile('a.epub')])
        const summary = await queue.add([makeFile('b.epub')])

        expect(summary.added.map((book) => book.id)).toEqual(['b.epub'])
        expect(error).toHaveBeenCalledTimes(2)
        error.mockRestore()
    })
})
