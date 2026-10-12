/**
 * Short messages at the bottom of the screen, in `div#toasts`. One shows at a time. While a
 * toast waits, the one on screen stays only for a short minimum time.
 */

export interface ToastAction {
    label: string
    onSelect: () => void
}

export interface ToastOptions {
    message: string
    action?: ToastAction
    /** Milliseconds on screen. A toast with an action stays longer by default. */
    duration?: number
    /** 'error' gives the toast the error look. */
    tone?: 'info' | 'error'
}

export const TOAST_DURATION_MS = 4000
export const TOAST_ACTION_DURATION_MS = 8000
/**
 * A toast leaves after this time on screen when a different toast waits. Without it, some
 * quick actions give a row of toasts that show for many seconds after the last action.
 */
export const TOAST_MIN_MS = 2000
// components.css asks for a timer of 200 ms or more. With reduced motion there is no
// transition, so no transitionend event comes.
export const TOAST_LEAVE_MS = 250

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

interface QueuedToast {
    options: ToastOptions
    /** The toast left early one time and came back. It then stays for its full time. */
    returned: boolean
}

interface ShownToast extends QueuedToast {
    element: HTMLElement
    timer: ReturnType<typeof setTimeout>
    shownAt: number
    endsAt: number
    /** A toast that waits made this one leave before its time. */
    hurried: boolean
}

const waiting: QueuedToast[] = []
let shown: ShownToast | null = null
let leaving = false
let blockingDialog: Element | null = null

function container(): HTMLElement {
    const found = document.getElementById('toasts')
    if (found) return found
    const made = document.createElement('div')
    made.id = 'toasts'
    made.setAttribute('aria-live', 'polite')
    document.body.append(made)
    return made
}

function openModalDialog(): Element | null {
    try {
        return document.querySelector('dialog:modal')
    } catch {
        // An engine that does not know the :modal selector.
        return null
    }
}

function build(options: ToastOptions): HTMLElement {
    const element = document.createElement('div')
    element.className = options.tone === 'error' ? 'toast toast-error' : 'toast'

    if (options.tone === 'error') {
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
        // A second tap while the toast leaves must not run the action again.
        button.addEventListener(
            'click',
            () => {
                dismiss({ byUser: true })
                action.onSelect()
            },
            { once: true },
        )
        element.append(button)
    }
    return element
}

function showNext(): void {
    if (shown || waiting.length === 0) return

    // The browser makes a toast below a modal dialog inert, and a bottom sheet can cover it.
    // The toast waits until the dialog is closed.
    const dialog = openModalDialog()
    if (dialog) {
        if (blockingDialog !== dialog) {
            blockingDialog = dialog
            dialog.addEventListener(
                'close',
                () => {
                    blockingDialog = null
                    showNext()
                },
                { once: true },
            )
        }
        return
    }

    const { options, returned } = waiting.shift()!
    const element = build(options)
    container().append(element)
    const duration =
        options.duration ?? (options.action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS)
    const shownAt = Date.now()
    shown = {
        options,
        returned,
        element,
        timer: setTimeout(dismiss, duration),
        shownAt,
        endsAt: shownAt + duration,
        hurried: false,
    }
    hurry()
}

/** Makes the toast on screen leave early when a different toast waits for its place. */
function hurry(): void {
    if (!shown || leaving || waiting.length === 0) return
    if (shown.hurried || shown.returned) return
    const now = Date.now()
    const earliest = Math.max(now, shown.shownAt + TOAST_MIN_MS)
    // The toast leaves before that time without help.
    if (shown.endsAt <= earliest) return
    clearTimeout(shown.timer)
    shown.hurried = true
    shown.timer = setTimeout(dismiss, earliest - now)
}

function dismiss({ byUser = false }: { byUser?: boolean } = {}): void {
    if (!shown || leaving) return
    const current = shown
    clearTimeout(current.timer)
    // The user did not get the full time to use the action, so the toast comes back after
    // the toasts that wait. It comes back one time only, or two such toasts would go round.
    if (current.hurried && current.options.action && !byUser) {
        waiting.push({ options: current.options, returned: true })
    }
    leaving = true
    current.element.classList.add('is-leaving')
    setTimeout(() => {
        current.element.remove()
        // clearToasts can run in this time, and a new toast can be on screen after it.
        if (shown !== current) return
        shown = null
        leaving = false
        showNext()
    }, TOAST_LEAVE_MS)
}

/**
 * Shows a message. When a toast is on screen, the new one waits for its turn, and the toast
 * on screen leaves early for it. A message that is on screen or in the queue already is not
 * added a second time.
 */
export function showToast(options: ToastOptions): void {
    const isOnScreen = !leaving && shown?.options.message === options.message
    if (isOnScreen || waiting.some((item) => item.options.message === options.message)) return
    waiting.push({ options, returned: false })
    showNext()
    hurry()
}

/** Removes all toasts at once. For tests. */
export function clearToasts(): void {
    if (shown) {
        clearTimeout(shown.timer)
        shown.element.remove()
    }
    shown = null
    leaving = false
    blockingDialog = null
    waiting.length = 0
}
