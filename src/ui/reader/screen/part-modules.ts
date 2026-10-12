/**
 * The modules of the parts of the reader screen. Each one is a separate chunk that loads at
 * the first use of the part. The paths and the export names are in `../parts.ts`.
 *
 * Only `src/ui/reader/index.ts` imports this file. The tests of the screen give their own
 * parts.
 */

import type { PartFactories } from './screen'

export const partModules: PartFactories = {
    contents: async (options) => (await import('../panels/contents')).createContentsPanel(options),
    appearance: async (options) =>
        (await import('../panels/appearance')).createAppearancePanel(options),
    search: async (options) => (await import('../panels/search')).createSearchPanel(options),
    selection: async (options) =>
        (await import('../tools/selection')).createSelectionTools(options),
    notePopover: async (options) =>
        (await import('../tools/note-popover')).createNotePopover(options),
    imageViewer: async (options) =>
        (await import('../tools/image-viewer')).createImageViewer(options),
    speed: async (options) => (await import('../speed')).createSpeedReader(options),
    listen: async (options) => (await import('../listen')).createListenBar(options),
    shortcuts: async (options) => (await import('./shortcuts')).createShortcutsDialog(options),
}
