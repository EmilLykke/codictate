import { useSyncExternalStore } from 'react'
import { uploadDroppedFile } from '../../../shared/dropped-file-upload'
import { droppedFileTransport } from '../../rpc'

/**
 * Files dropped on the window, while the page sends them to the main process. Kept outside
 * React so a send carries on when the user leaves the Transcribe page and comes back. One
 * file at a time, in drop order; each leaves this list once it is queued (it then shows in
 * "In progress" like any other File Transcription) or cancelled, and stays with its message
 * when it failed, until dismissed.
 */
export interface DroppedFileUpload {
  key: string
  name: string
  size: number
  /** Bytes the main process has acknowledged. */
  sent: number
  state: 'waiting' | 'adding' | 'failed'
  /** Why it failed, one finished sentence. */
  message: string | null
}

let uploads: DroppedFileUpload[] = []
const files = new Map<string, File>()
const controllers = new Map<string, AbortController>()
const listeners = new Set<() => void>()
let running = false
let nextKey = 0

function set(next: DroppedFileUpload[]): void {
  uploads = next
  for (const listener of listeners) listener()
}

function update(key: string, patch: Partial<DroppedFileUpload>): void {
  set(uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)))
}

function remove(key: string): void {
  files.delete(key)
  controllers.delete(key)
  set(uploads.filter((u) => u.key !== key))
}

async function run(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      const next = uploads.find((u) => u.state === 'waiting')
      if (next === undefined) break
      const file = files.get(next.key)
      if (file === undefined) {
        remove(next.key)
        continue
      }
      const controller = new AbortController()
      controllers.set(next.key, controller)
      update(next.key, { state: 'adding' })
      const result = await uploadDroppedFile(file, droppedFileTransport, {
        signal: controller.signal,
        onProgress: (sent) => update(next.key, { sent }),
      })
      if (result.status === 'failed') {
        files.delete(next.key)
        controllers.delete(next.key)
        update(next.key, { state: 'failed', message: result.message })
      } else {
        remove(next.key)
      }
    }
  } finally {
    running = false
  }
}

/** Queue dropped files for sending, and folders as failures: only files can be transcribed. */
export function addDroppedFiles(dropped: File[], folderNames: string[]): void {
  const added: DroppedFileUpload[] = []
  for (const file of dropped) {
    const key = `drop-${++nextKey}`
    files.set(key, file)
    added.push({
      key,
      name: file.name,
      size: file.size,
      sent: 0,
      state: 'waiting',
      message: null,
    })
  }
  for (const name of folderNames) {
    added.push({
      key: `drop-${++nextKey}`,
      name,
      size: 0,
      sent: 0,
      state: 'failed',
      message: "That's a folder. Drop the files inside it instead.",
    })
  }
  if (added.length === 0) return
  set([...uploads, ...added])
  void run()
}

/** Stop sending a file, or take a waiting one off the list. */
export function cancelDroppedFileUpload(key: string): void {
  const upload = uploads.find((u) => u.key === key)
  if (upload === undefined) return
  if (upload.state === 'adding') {
    // The send stops after the chunk in flight and tells the main process to delete the copy.
    controllers.get(key)?.abort()
    return
  }
  remove(key)
}

/** Forget a failed one. */
export function dismissDroppedFileUpload(key: string): void {
  remove(key)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDroppedFileUploads(): DroppedFileUpload[] {
  return useSyncExternalStore(subscribe, () => uploads)
}

/** Whether a drag carries files (text and links are left alone). */
export function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

/**
 * The dropped files, and the names of dropped folders. Read during the `drop` event: the
 * data transfer is empty afterwards. A folder comes through as a `File` too, so the entry
 * tells it apart (WebKit and Chromium both have `webkitGetAsEntry`).
 */
export function readDrop(transfer: DataTransfer): {
  files: File[]
  folders: string[]
} {
  const files: File[] = []
  const folders: string[] = []
  const items = Array.from(transfer.items ?? []).filter(
    (item) => item.kind === 'file'
  )
  if (items.length === 0) {
    return { files: Array.from(transfer.files), folders }
  }
  for (const item of items) {
    const file = item.getAsFile()
    if (file === null) continue
    if (item.webkitGetAsEntry?.()?.isDirectory) folders.push(file.name)
    else files.push(file)
  }
  return { files, folders }
}
