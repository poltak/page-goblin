import type { IconName } from '../../dom'

/**
 * Parses static markup one time, at the first call of the result. Each call gives a new copy
 * of the first element. The markup must have no book data.
 */
export function templateOf<T extends Element = HTMLElement>(markup: string): () => T {
    let template: HTMLTemplateElement | null = null
    return () => {
        if (!template) {
            template = document.createElement('template')
            template.innerHTML = markup
        }
        const first = template.content.firstElementChild
        if (!first) throw new Error('The markup has no element')
        return document.importNode(first, true) as T
    }
}

export function iconMarkup(name: IconName): string {
    return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`
}
