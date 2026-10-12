import { expect, it } from 'vitest'
import * as annotations from './index'

it('exports the public functions of the annotations module', () => {
    const functions = Object.entries(annotations)
        .filter(([, value]) => typeof value === 'function')
        .map(([name]) => name)
        .sort()

    expect(functions).toEqual([
        'copyText',
        'createBackup',
        'downloadTextFile',
        'highlightsToKindleClippings',
        'highlightsToMarkdown',
        'parseBackup',
        'restoreBackup',
    ])
    expect(annotations.BACKUP_FORMAT).toBe('page-goblin-backup')
    expect(annotations.BACKUP_VERSION).toBe(1)
})
