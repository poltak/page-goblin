import { afterEach, describe, expect, it, vi } from 'vitest'
import { onFilesLaunched } from './launch'

type Consumer = (params: { files?: unknown[] }) => void

/** Adds a launch queue to the window and returns a function that sends a launch to the app. */
function addLaunchQueue(): (params: { files?: unknown[] }) => void {
    let consumer: Consumer | undefined
    Object.defineProperty(window, 'launchQueue', {
        value: { setConsumer: (next: Consumer) => (consumer = next) },
        configurable: true,
    })
    return (params) => consumer!(params)
}

function fileHandle(file: File) {
    return { kind: 'file', getFile: async () => file }
}

describe('onFilesLaunched', () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve))

    afterEach(() => {
        Reflect.deleteProperty(window, 'launchQueue')
    })

    it('does nothing in a browser without a launch queue', () => {
        const listener = vi.fn()

        expect(() => onFilesLaunched(listener)).not.toThrow()
        expect(listener).not.toHaveBeenCalled()
    })

    it('gives the listener the files of each launch', async () => {
        const launch = addLaunchQueue()
        const listener = vi.fn()
        const first = new File(['a'], 'first.epub')
        const second = new File(['b'], 'second.epub')
        onFilesLaunched(listener)

        launch({ files: [fileHandle(first), fileHandle(second)] })
        await settle()
        launch({ files: [fileHandle(second)] })
        await settle()

        expect(listener.mock.calls).toEqual([[[first, second]], [[second]]])
    })

    it('ignores a file that cannot be read and a directory', async () => {
        const launch = addLaunchQueue()
        const listener = vi.fn()
        const good = new File(['a'], 'good.epub')
        const missing = {
            kind: 'file',
            getFile: async () => {
                throw new DOMException('gone', 'NotFoundError')
            },
        }
        onFilesLaunched(listener)

        launch({ files: [missing, { kind: 'directory' }, fileHandle(good)] })
        await settle()

        expect(listener).toHaveBeenCalledExactlyOnceWith([good])
    })

    it('does not call the listener for a launch with no readable file', async () => {
        const launch = addLaunchQueue()
        const listener = vi.fn()
        onFilesLaunched(listener)

        launch({})
        launch({ files: [] })
        launch({ files: [{ kind: 'directory' }] })
        await settle()

        expect(listener).not.toHaveBeenCalled()
    })
})
