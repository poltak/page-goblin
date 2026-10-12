/**
 * Dev only. See add-book.html.
 */

import { openEpub } from '$lib/epub'
import { createLibraryStorage } from '$lib/storage'
import { importBook } from '$lib/storage/import'

const log = document.getElementById('log')

function say(text: string): void {
    if (log) log.textContent += `\n${text}`
}

async function main(): Promise<void> {
    const params = new URLSearchParams(location.search)
    const names = params.getAll('book')
    if (!names.length) {
        say('No book parameter. Example: ?book=quick-start.epub&open=1')
        return
    }

    const storage = createLibraryStorage()
    let lastId = ''
    for (const name of names) {
        const response = await fetch(`/local-books/${encodeURIComponent(name)}`)
        if (!response.ok) {
            say(`${name}: not found in local-books/ (status ${response.status})`)
            continue
        }
        const file = new File([await response.blob()], name, { type: 'application/epub+zip' })
        const result = await importBook({ file, storage, open: openEpub })
        lastId = result.book.id
        say(
            `${name}: ${result.duplicate ? 'already in the library' : 'added'} (${result.book.title})`,
        )
    }
    storage.close()

    if (!lastId) return
    location.href = params.get('open') ? `/#/book/${lastId}` : '/'
}

main().catch((error: unknown) => say(String(error)))
