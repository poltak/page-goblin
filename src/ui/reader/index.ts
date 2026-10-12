/**
 * Entry point of the reader screen. The app shell loads this module on demand.
 *
 * This file is a placeholder until the reader screen is built.
 */

import type { MountedReader, ReaderMountOptions } from './types'

export type * from './types'

export async function mountReader(options: ReaderMountOptions): Promise<MountedReader> {
    const { root, onExit } = options

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn'
    button.textContent = 'Back to the library'
    button.addEventListener('click', onExit)
    root.replaceChildren(button)

    return {
        destroy: async () => {
            root.replaceChildren()
        },
    }
}
