/**
 * The speed reader mode (RSVP). It shows one word at a time at a fixed place, in an overlay on
 * top of the book. The reader screen loads this module when the user starts the mode.
 */

import './speed.css'

import { createWakeLock } from '$lib/pwa/wake-lock'
import type { RsvpTimer } from '$lib/rsvp'
import { settings } from '$lib/settings'
import type { ModeController, ModeOptions } from '../parts'
import { createSpeedController } from './controller'
import { createCanvasMeasure } from './word-fit'

// The browser throws when a timer function runs as a method of an object that is not the window.
const browserTimer: RsvpTimer = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => performance.now(),
}

export function createSpeedReader(options: ModeOptions): ModeController {
    return createSpeedController(options, {
        settings,
        createWakeLock,
        timer: browserTimer,
        measure: createCanvasMeasure(),
    })
}
