/**
 * Public interface of the annotations module: export of highlights and the backup file.
 *
 * Only the export and backup actions need this module. To keep it out of the first load, load
 * it with a dynamic import when the user starts one of these actions.
 */

export { highlightsToMarkdown } from './markdown'
export { highlightsToKindleClippings } from './kindle'
export { BACKUP_FORMAT, BACKUP_VERSION, createBackup, parseBackup, restoreBackup } from './backup'
export type { CreateBackupOptions, RestoreBackupOptions } from './backup'
export { copyText, downloadTextFile } from './download'
export type { DownloadTextFileOptions } from './download'
export type {
    BackupBook,
    BackupBookmark,
    BackupFile,
    BackupHighlight,
    BackupStorage,
    ExportSource,
    RestoreResult,
} from './types'
