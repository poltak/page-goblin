import type { RelocateInfo } from '$lib/reader/types'
import type { ReaderSession } from '../types'

function samePosition(a: RelocateInfo, b: RelocateInfo): boolean {
    return (
        a.locator.spineIndex === b.locator.spineIndex &&
        a.locator.offset === b.locator.offset &&
        a.visible.start === b.visible.start &&
        a.visible.end === b.visible.end &&
        a.page === b.page &&
        a.pageCount === b.pageCount
    )
}

/**
 * Calls the listener when the visible text changed. The session also sends 'relocate' with
 * the same data when only the contents entry of the position changed, and a tool that is
 * open must stay open then. Returns the function that removes the listener.
 */
export function onPositionChange(session: ReaderSession, listener: () => void): () => void {
    let last = session.position
    return session.on('relocate', (info) => {
        const moved = !last || !samePosition(last, info)
        last = info
        if (moved) listener()
    })
}
