import { expect, it } from 'vitest'
import * as storage from './index'

it('exports the public functions of the storage module', () => {
    const functions = Object.entries(storage)
        .filter(([, value]) => typeof value === 'function')
        .map(([name]) => name)
        .sort()

    expect(functions).toEqual([
        'bookFraction',
        'createId',
        'createLibraryStorage',
        'estimateTextStats',
        'getStorageEstimate',
        'importBook',
        'isQuotaError',
        'locateFraction',
        'makeCoverThumbnail',
        'requestPersistentStorage',
        'wordsRemaining',
    ])
    expect(storage.DATABASE_NAME).toBe('page-goblin')
    expect(storage.DATABASE_VERSION).toBe(2)
})
