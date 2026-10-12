/** Helpers that the panels of the reader screen share. */

import {
    showToast,
    TOAST_ACTION_DURATION_MS,
    TOAST_DURATION_MS,
    TOAST_LEAVE_MS,
    TOAST_MIN_MS,
} from '../../app/toast'
import type { ToastOptions } from '../../app/toast'
import { qs } from '../../dom'
import './shared.css'

/** Parses the static markup of a panel. The markup must not have text from a book. */
export function parseMarkup(html: string): DocumentFragment {
    const template = document.createElement('template')
    template.innerHTML = html
    return template.content
}

/** A function that makes copies of the element in `<template data-row="NAME">`. */
export function rowFactory(markup: DocumentFragment, name: string): () => HTMLElement {
    const row = qs<HTMLTemplateElement>(`template[data-row="${name}"]`, markup).content
        .firstElementChild
    if (!row) throw new Error(`The row template "${name}" has no element`)
    return () => document.importNode(row, true) as HTMLElement
}

/** A position in the book as a whole percent, for example '41%'. */
export function percentText(fraction: number): string {
    const percent = Math.round(fraction * 100)
    return `${Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0}%`
}

/**
 * For the promise of a jump in the book. The session reports a chapter that does not load with
 * its 'error' event, so a rejection needs no second message.
 */
export function ignoreRejection(promise: Promise<unknown>): void {
    promise.catch(() => {})
}

/**
 * Runs the work when the browser has free time, or after one frame in a browser with no idle
 * callback (Safari). Returns the function that cancels the work.
 */
export function whenIdle(work: () => void): () => void {
    if (typeof requestIdleCallback === 'function') {
        const handle = requestIdleCallback(work, { timeout: 500 })
        return () => cancelIdleCallback(handle)
    }
    const timer = setTimeout(work, 16)
    return () => clearTimeout(timer)
}

/**
 * Moves the scroll position of `scroller` so that `row` is in its centre. The two boxes have
 * the same transform, so the result is correct while the sheet moves in. One layout read.
 */
export function centerInScroller(scroller: HTMLElement, row: HTMLElement): void {
    const box = scroller.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    scroller.scrollTop += rowBox.top - box.top - (box.height - rowBox.height) / 2
}

export interface KeyedListOptions<T> {
    list: HTMLElement
    key(item: T): string
    /** A new row with no data. */
    create(): HTMLElement
    /** Writes the data of an item into its row. */
    fill(row: HTMLElement, item: T): void
}

export interface KeyedList<T> {
    /** Makes the rows agree with the items. A row whose item did not change stays as it is. */
    render(items: readonly T[]): void
    /** The item of the row that holds this element, or null. */
    itemOf(element: Element): T | null
}

/**
 * A list that keeps its row elements between renders. A change of one record then writes one
 * row, and the row that has the focus keeps it.
 */
export function createKeyedList<T>({ list, key, create, fill }: KeyedListOptions<T>): KeyedList<T> {
    const rows = new Map<string, { row: HTMLElement; item: T }>()

    return {
        render(items) {
            // The rows of removed items go first. The rows that stay then keep their place,
            // and a row that is not moved keeps the focus.
            const seen = new Set(items.map(key))
            for (const [id, entry] of rows) {
                if (seen.has(id)) continue
                entry.row.remove()
                rows.delete(id)
            }
            // The element that must hold the next item, if the list has the correct order.
            let next = list.firstElementChild
            for (const item of items) {
                const id = key(item)
                let entry = rows.get(id)
                if (!entry) {
                    entry = { row: create(), item }
                    entry.row.dataset.key = id
                    fill(entry.row, item)
                    rows.set(id, entry)
                } else if (entry.item !== item) {
                    entry.item = item
                    fill(entry.row, item)
                }
                if (entry.row === next) next = next.nextElementSibling
                else list.insertBefore(entry.row, next)
            }
        },
        itemOf(element) {
            const row = element.closest<HTMLElement>('[data-key]')
            const id = row?.dataset.key
            return id === undefined ? null : (rows.get(id)?.item ?? null)
        },
    }
}

export interface KeepFocusOptions {
    list: HTMLElement
    render(): void
    /** Gets the focus when the list is empty after the render. */
    fallback: HTMLElement
}

/**
 * Runs a render of a list. When the render removes the row that has the focus, the focus goes
 * to the same control of the row that took its place, so a keyboard user stays in the list.
 */
export function renderKeepingFocus({ list, render, fallback }: KeepFocusOptions): void {
    const active = document.activeElement
    const row = active instanceof HTMLElement ? active.closest('[data-key]') : null
    if (!(active instanceof HTMLElement) || !row || row.parentElement !== list) {
        render()
        return
    }
    const index = Array.prototype.indexOf.call(list.children, row)
    const control = Array.prototype.indexOf.call(row.querySelectorAll('button'), active)
    render()
    if (active.isConnected) return
    const replacement = list.children[Math.min(index, list.children.length - 1)]
    const buttons = replacement?.querySelectorAll<HTMLElement>('button')
    ;(buttons?.[control] ?? buttons?.[0] ?? fallback).focus()
}

export interface Notice {
    /** The message that is on screen in the sheet, or null. */
    readonly current: ToastOptions | null
    /**
     * True while the user can still get this message: it is on screen in the sheet, or it went
     * to the toasts of the app a short time ago and can be on screen there.
     */
    isLive(options: ToastOptions): boolean
    /** Shows a message in the sheet. It replaces the message that is there. */
    show(options: ToastOptions): void
    /** Removes the message and the listeners. A later `show` does nothing. */
    destroy(): void
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

function durationOf(options: ToastOptions): number {
    return options.duration ?? (options.action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS)
}

/**
 * Messages for an open sheet. The toasts of the app are below a modal dialog and cannot take a
 * tap there, so the app keeps them back until the dialog closes. A sheet shows its messages in
 * itself, with the look of a toast. A message that is on screen when the sheet closes moves to
 * the toasts of the app, so its action stays available.
 */
export function createNotice(dialog: HTMLDialogElement): Notice {
    const region = document.createElement('div')
    region.className = 'panel-notice'
    region.setAttribute('aria-live', 'polite')
    dialog.append(region)

    let shown: { options: ToastOptions; timer: ReturnType<typeof setTimeout> } | null = null
    /** The last message that went to the toasts of the app, and the end of its time there. */
    let handed: { options: ToastOptions; until: number } | null = null
    let destroyed = false

    function remove(): ToastOptions | null {
        if (!shown) return null
        const { options, timer } = shown
        shown = null
        clearTimeout(timer)
        region.replaceChildren()
        return options
    }

    function handOver(options: ToastOptions): void {
        showToast(options)
        // The toast can wait for the toast that is on screen to leave.
        const wait = TOAST_MIN_MS + TOAST_LEAVE_MS
        handed = { options, until: Date.now() + wait + durationOf(options) }
    }

    function build(options: ToastOptions): HTMLElement {
        const element = document.createElement('div')
        element.className = options.tone === 'error' ? 'toast toast-error' : 'toast'
        if (options.tone === 'error') {
            // The same icon as an error toast of the app.
            const icon = document.createElementNS(SVG_NAMESPACE, 'svg')
            icon.setAttribute('class', 'icon')
            icon.setAttribute('aria-hidden', 'true')
            icon.appendChild(document.createElementNS(SVG_NAMESPACE, 'use')).setAttribute(
                'href',
                '#i-info',
            )
            element.append(icon)
        }
        const text = document.createElement('span')
        text.textContent = options.message
        element.append(text)

        const { action } = options
        if (action) {
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'btn btn-quiet btn-sm'
            button.textContent = action.label
            // A second tap must not run the action again.
            button.addEventListener(
                'click',
                () => {
                    remove()
                    action.onSelect()
                },
                { once: true },
            )
            element.append(button)
        }
        return element
    }

    const onClose = (): void => {
        const options = remove()
        if (options) handOver(options)
    }
    dialog.addEventListener('close', onClose)

    return {
        get current() {
            return shown?.options ?? null
        },
        isLive(options) {
            if (shown?.options === options) return true
            return handed?.options === options && Date.now() < handed.until
        },
        show(options) {
            // The work that gives the message can end after the reader closed the book.
            if (destroyed) return
            // It can also end after the sheet closed.
            if (!dialog.open) {
                handOver(options)
                return
            }
            remove()
            region.append(build(options))
            shown = { options, timer: setTimeout(remove, durationOf(options)) }
        },
        destroy() {
            destroyed = true
            dialog.removeEventListener('close', onClose)
            remove()
            region.remove()
        },
    }
}
