/**
 * Export of highlights as a Markdown document for note applications.
 *
 * The escape rules follow CommonMark, in which a backslash before a punctuation character makes
 * that character plain text.
 */

import type { BookmarkRecord } from '$lib/storage/types'
import { clampFraction, collapseWhiteSpace } from './shared'
import type { ExportSource } from './types'

/**
 * Characters that can start syntax at any place in a line: emphasis, code, links, HTML tags,
 * HTML entities, headings and tags, strikethrough, mathematics and marked text. Note
 * applications add the last four to CommonMark.
 *
 * The colon of "://" is also here. Many renderers make a link of a plain address, and they read
 * the address before they read the escapes, so a backslash in the address shows in the link. A
 * backslash in the start of the address stops that link, and then the escapes work.
 */
const INLINE_CONTROL = /[\\`*_[\]<#~$]|&(?=#?[0-9a-zA-Z]+;)|=(?==)|:(?=\/\/)/g
/**
 * The other start of an address that renderers make a link of. It does not follow a letter, so
 * "Awww..." is not one.
 */
const WWW_ADDRESS = /(^|[^\p{L}\p{N}])(www)\.(?=\S)/giu

/** A web address in running text: no white space, no angle bracket, no control character. */
const WEB_ADDRESS = /\bhttps?:\/\/[\p{L}\p{N}][^\s<>\u0000-\u001f\u007f]*/giu
const ENTITY = /&#?[0-9a-zA-Z]+;/
/** Punctuation that follows an address in a sentence and is not a part of the address. */
const AFTER_ADDRESS = '.,;:!?\'"*_~]'

/**
 * The address without the punctuation of the sentence. A closing parenthesis stays when the
 * address has its opening parenthesis.
 */
function trimAddress(address: string): string {
    let opening = 0
    let closing = 0
    for (const character of address) {
        if (character === '(') opening++
        else if (character === ')') closing++
    }
    let end = address.length
    for (; end > 0; end--) {
        const character = address[end - 1]
        if (character === ')' && closing > opening) closing--
        else if (!AFTER_ADDRESS.includes(character)) break
    }
    return address.slice(0, end)
}

/** Book text that has no address for angle brackets. No renderer makes a link in it. */
function escapeText(text: string): string {
    return text.replace(INLINE_CONTROL, '\\$&').replace(WWW_ADDRESS, '$1$2\\.')
}

/**
 * Book text for a place in a line. An address in angle brackets is a link in each renderer, and
 * its text needs no escapes. An address that starts with "www." cannot go into angle brackets,
 * so it is plain text.
 */
function escapeInline(text: string): string {
    let output = ''
    let position = 0
    for (const match of text.matchAll(WEB_ADDRESS)) {
        const address = trimAddress(match[0])
        // Some renderers decode an entity in the angle brackets, so this address is plain text.
        if (ENTITY.test(address)) continue
        output += `${escapeText(text.slice(position, match.index))}<${address}>`
        position = match.index + address.length
    }
    return output + escapeText(text.slice(position))
}

/** Book text for the start of a block, where a quote, a list or a rule can also start. */
function escapeBlock(text: string): string {
    return escapeInline(text)
        .replace(/^[>+-]/, '\\$&')
        .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
}

function bookmarkItem(bookmark: BookmarkRecord): string {
    const chapter = collapseWhiteSpace(bookmark.chapterTitle)
    const excerpt = collapseWhiteSpace(bookmark.excerpt)
    const percent = `${Math.round(clampFraction(bookmark.fraction) * 100)}%`
    const place = chapter ? `${escapeBlock(chapter)}, ${percent}` : percent
    return excerpt ? `- ${place}: *${escapeInline(excerpt)}*` : `- ${place}`
}

/**
 * A note on one line. It is the text of the user, so its Markdown stays as typed. It can also
 * come from a backup file that is not trusted, so it must not put HTML into the document: an
 * open tag can hide all that follows it. A less-than sign after an odd number of backslashes
 * has its escape already.
 */
function writeNote(note: string): string {
    // The pattern takes each run of backslashes one time, so a long run costs linear time.
    return note.replace(/\\+<?|</g, (run) =>
        run.endsWith('<') && run.length % 2 === 1 ? `${run.slice(0, -1)}\\<` : run,
    )
}

/**
 * The highlights of one book as a Markdown document. Book text is escaped, so it reads the same
 * after rendering.
 */
export function highlightsToMarkdown({ book, highlights, bookmarks }: ExportSource): string {
    const blocks = [`# ${escapeInline(collapseWhiteSpace(book.title)) || 'Untitled'}`]
    const author = collapseWhiteSpace(book.author)
    if (author) blocks.push(`Author: ${escapeInline(author)}`)

    // Highlights are in reading order, so a new chapter title starts a new group.
    let currentChapter: string | null = null
    for (const highlight of highlights) {
        const chapter = collapseWhiteSpace(highlight.chapterTitle)
        if (chapter !== currentChapter) {
            currentChapter = chapter
            if (chapter) blocks.push(`## ${escapeInline(chapter)}`)
        }
        const text = collapseWhiteSpace(highlight.text)
        if (text) blocks.push(`> ${escapeBlock(text)}`)
        const note = collapseWhiteSpace(highlight.note)
        if (note) blocks.push(`Note: ${writeNote(note)}`)
    }

    if (bookmarks && bookmarks.length > 0) {
        blocks.push('## Bookmarks', bookmarks.map(bookmarkItem).join('\n'))
    }
    return `${blocks.join('\n\n')}\n`
}
