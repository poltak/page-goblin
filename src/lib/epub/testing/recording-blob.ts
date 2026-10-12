/**
 * A Blob wrapper for tests that records each byte range that is read from the Blob.
 */

export interface RecordingBlob {
    /** Give this to the code under test. */
    blob: Blob
    /** Start and end (exclusive) of each read, in order. A slice that is not read is not here. */
    reads: Array<[start: number, end: number]>
    bytesRead(): number
}

export function recordReads(source: Blob): RecordingBlob {
    const reads: RecordingBlob['reads'] = []
    const blob = {
        size: source.size,
        type: source.type,
        slice(start = 0, end = source.size, type?: string) {
            const part = source.slice(start, end, type)
            const read = part.arrayBuffer.bind(part)
            part.arrayBuffer = () => {
                reads.push([start, Math.min(end, source.size)])
                return read()
            }
            return part
        },
    } as Blob

    return {
        blob,
        reads,
        bytesRead: () => reads.reduce((total, [start, end]) => total + end - start, 0),
    }
}

/** Bytes that deflate cannot make smaller. The same seed gives the same bytes. */
export function noiseBytes(length: number, seed = 1): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length)
    let state = seed >>> 0 || 1
    for (let index = 0; index < length; index++) {
        // xorshift32
        state ^= state << 13
        state >>>= 0
        state ^= state >>> 17
        state ^= state << 5
        state >>>= 0
        bytes[index] = state & 0xff
    }
    return bytes
}
