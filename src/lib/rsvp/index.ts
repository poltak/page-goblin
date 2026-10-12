export { createRsvpEngine } from './engine'
export {
    clampWordIndex,
    isSentenceStart,
    nextSentenceIndex,
    previousSentenceIndex,
    sentenceStartIndex,
    wordIndexAtOffset,
} from './navigation'
export { splitAtPivot, pivotIndexForLength } from './pivot'
export type { PivotParts } from './pivot'
export {
    DEFAULT_PUNCTUATION_MULTIPLIERS,
    endsSentence,
    getPunctuationMultiplier,
} from './punctuation'
export type { PunctuationMultipliers } from './punctuation'
export {
    DEFAULT_RSVP_SETTINGS,
    RSVP_MULTIPLIER_MAX,
    RSVP_MULTIPLIER_MIN,
    RSVP_WPM_MAX,
    RSVP_WPM_MIN,
    normalizeRsvpSettings,
} from './settings'
export { rampFactorAt, rewindIntervalMs, wordDelayMs } from './timing'
export type { WordDelayOptions } from './timing'
export type {
    RsvpCallbacks,
    RsvpDirection,
    RsvpEngine,
    RsvpEngineOptions,
    RsvpLoadOptions,
    RsvpSettings,
    RsvpState,
    RsvpStatus,
    RsvpTimer,
    RsvpWordEvent,
} from './types'
