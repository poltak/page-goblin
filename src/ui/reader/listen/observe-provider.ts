import type { SpeechProvider } from '$lib/speech'

export interface ObservedProvider extends SpeechProvider {
    /** Number of `speak` calls. */
    readonly speakCount: number
}

/**
 * A provider that tells when the browser really speaks. The controller has the status
 * "playing" from its `speak` call, but iOS Safari drops an utterance that does not start in
 * the task of a user action, and sends no event for it. `onSound` runs for each start, word
 * and end event of the last utterance.
 */
export function observeProvider(provider: SpeechProvider, onSound: () => void): ObservedProvider {
    let speakCount = 0

    return {
        get speakCount() {
            return speakCount
        },
        isSupported: () => provider.isSupported(),
        getVoices: () => provider.getVoices(),
        onVoicesChanged: (listener) => provider.onVoicesChanged(listener),
        pause: () => provider.pause(),
        resume: () => provider.resume(),
        cancel: () => provider.cancel(),
        speak(options) {
            const call = ++speakCount
            // A cancelled utterance can send its end event after the next one started.
            const heard = (): void => {
                if (call === speakCount) onSound()
            }
            provider.speak({
                ...options,
                onStart() {
                    heard()
                    options.onStart()
                },
                onBoundary(boundary) {
                    heard()
                    options.onBoundary(boundary)
                },
                onEnd() {
                    heard()
                    options.onEnd()
                },
            })
        },
    }
}
