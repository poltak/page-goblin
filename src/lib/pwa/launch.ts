/** The file handling API of an installed app (Chromium). It is not in the DOM types. */
interface LaunchParams {
    readonly files?: readonly FileSystemHandle[]
}

interface LaunchQueue {
    setConsumer(consumer: (params: LaunchParams) => void): void
}

function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
    return handle.kind === 'file'
}

/**
 * Calls the listener with the files that the user opened with the installed app, for example
 * from the file manager. The manifest names the app as a handler for EPUB files. The listener
 * can get a second call while the app is open. A browser without this API never calls it.
 */
export function onFilesLaunched(listener: (files: File[]) => void): void {
    const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue
    if (!queue) return
    queue.setConsumer((params) => {
        const handles = (params.files ?? []).filter(isFileHandle)
        if (handles.length === 0) return
        // A file can be moved or deleted before the app reads it. The other files still open.
        void Promise.all(handles.map((handle) => handle.getFile().catch(() => null))).then(
            (results) => {
                const files = results.filter((file) => file !== null)
                if (files.length > 0) listener(files)
            },
        )
    })
}
