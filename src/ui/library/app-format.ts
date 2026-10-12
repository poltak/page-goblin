/** Text for the actions of the app menu. All functions are pure. */

import type { RestoreResult } from '$lib/annotations/types'
import { plural } from './format'

/** The number of megabytes: one decimal below 100, none from 100. */
export function formatMegabytes(bytes: number): string {
    const megabytes = Math.max(0, bytes) / 1_000_000
    return megabytes < 100 ? megabytes.toFixed(1) : String(Math.round(megabytes))
}

function twoDigits(value: number): string {
    return String(value).padStart(2, '0')
}

/** 'page-goblin-backup-YYYY-MM-DD.json' with the local date. */
export function backupFileName(now: Date): string {
    const date = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
    return `page-goblin-backup-${date}.json`
}

function joinList(parts: string[]): string {
    if (parts.length <= 1) return parts.join('')
    return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** The numbers of a restore in one sentence. */
export function describeRestore(result: RestoreResult): string {
    const missing =
        result.booksMissing > 0
            ? `${plural(result.booksMissing, 'book', 'books')} of the backup ${
                  result.booksMissing === 1 ? 'is' : 'are'
              } not in this library`
            : ''
    if (result.booksMatched === 0) {
        return missing ? `Nothing was restored: ${missing}.` : 'The backup has no books.'
    }

    const changes: string[] = []
    if (result.progressUpdated > 0) {
        changes.push(plural(result.progressUpdated, 'reading position', 'reading positions'))
    }
    if (result.bookmarksAdded > 0) {
        changes.push(plural(result.bookmarksAdded, 'bookmark', 'bookmarks'))
    }
    if (result.highlightsAdded > 0) {
        changes.push(plural(result.highlightsAdded, 'highlight', 'highlights'))
    }
    if (result.highlightsUpdated > 0) {
        changes.push(plural(result.highlightsUpdated, 'changed highlight', 'changed highlights'))
    }

    const books = plural(result.booksMatched, 'book', 'books')
    const restored =
        changes.length > 0
            ? `Restored ${joinList(changes)} for ${books}`
            : `The backup has nothing new for ${books}`
    return missing ? `${restored}; ${missing}.` : `${restored}.`
}
