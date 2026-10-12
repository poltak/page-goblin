/**
 * The listen mode of the reader screen: read-aloud with the speech voices of the browser.
 * The reader screen loads this module when the user starts the mode for the first time, so
 * `$lib/speech` is not in the first load of the app.
 */

import { createWakeLock } from '$lib/pwa/wake-lock'
import { settings } from '$lib/settings'
import { createBrowserSpeechProvider } from '$lib/speech'
import type { ModeController, ModeOptions } from '../parts'
import { createListenBarWith } from './bar'

export function createListenBar(options: ModeOptions): ModeController {
    return createListenBarWith({
        ...options,
        provider: createBrowserSpeechProvider(),
        settings,
        wakeLock: createWakeLock(),
    })
}
