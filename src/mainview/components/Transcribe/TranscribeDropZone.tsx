import { useEffect, useRef, useState } from "react";
import { chooseFilesToTranscribe } from "../../rpc";
import {
  addDroppedFiles,
  cancelDroppedFileUpload,
  dismissDroppedFileUpload,
  useDroppedFileUploads,
  type DroppedFileUpload,
} from "./dropped-file-uploads";
import { BUTTON } from "./transcribe-styles";

/** How long after the last `dragover` the highlight lets go. */
const DRAG_IDLE_MS = 250;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * The dropped files, and the names of dropped folders. Read during the `drop` event: the
 * data transfer is empty afterwards. A folder comes through as a `File` too, so the entry
 * tells it apart (WebKit and Chromium both have `webkitGetAsEntry`).
 */
function readDrop(transfer: DataTransfer): {
  files: File[];
  folders: string[];
} {
  const files: File[] = [];
  const folders: string[] = [];
  const items = Array.from(transfer.items ?? []).filter(
    (item) => item.kind === "file",
  );
  if (items.length === 0) {
    return { files: Array.from(transfer.files), folders };
  }
  for (const item of items) {
    const file = item.getAsFile();
    if (file === null) continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) folders.push(file.name);
    else files.push(file);
  }
  return { files, folders };
}

function percent(upload: DroppedFileUpload): number {
  if (upload.size === 0) return 100;
  return Math.floor((upload.sent / upload.size) * 100);
}

/**
 * Drop files, or choose some.
 *
 * Neither WKWebView (macOS) nor WebView2 (Windows) tells a page where a dropped file is on
 * disk, and Electrobun has no native file-drop API, so the page takes the drop itself: it
 * cancels `dragover` and `drop` on the window whenever files are dragged, reads each dropped
 * `File` in chunks and sends the bytes to the main process, which queues a temporary copy
 * (dropped-file-uploads.ts, src/shared/dropped-file-upload.ts). Several files per drop. A
 * drag that carries no files is left alone, so text still drops into a text field.
 */
export function TranscribeDropZone({ compact }: { compact: boolean }) {
  const [dragging, setDragging] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploads = useDroppedFileUploads();

  useEffect(() => {
    const release = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = null;
      setDragging(false);
    };
    const onDrag = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Cancelling `dragover` is what makes the window a drop target.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragging(true);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(release, DRAG_IDLE_MS);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event) || !event.dataTransfer) return;
      // Never let the webview open the file itself.
      event.preventDefault();
      release();
      const { files, folders } = readDrop(event.dataTransfer);
      addDroppedFiles(files, folders);
    };
    window.addEventListener("dragenter", onDrag);
    window.addEventListener("dragover", onDrag);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("dragenter", onDrag);
      window.removeEventListener("dragover", onDrag);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", release);
      window.removeEventListener("blur", release);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  const adding = uploads.find((u) => u.state === "adding");
  const waiting = uploads.filter((u) => u.state === "waiting");
  const failed = uploads.filter((u) => u.state === "failed");

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed text-center transition-colors duration-200 ${
        compact ? "px-6 py-6" : "px-6 py-14"
      } ${
        dragging
          ? "border-accent-blue/60 bg-accent-blue/8"
          : "border-overlay/14 bg-surface-1"
      }`}
    >
      {!compact && (
        <div
          className={`mb-4 transition-colors ${dragging ? "text-accent-blue/70" : "text-overlay/25"}`}
        >
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
            <path d="M14 2v4a2 2 0 0 0 2 2h4" />
            <path d="M8 12v4" />
            <path d="M12 10v8" />
            <path d="M16 13v2" />
          </svg>
        </div>
      )}
      <p className="text-[15px] text-overlay/70">
        {dragging ? "Let go to transcribe" : "Drop audio or video files here"}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <span className="text-[13px] text-overlay/35">or</span>
        <button
          type="button"
          className={BUTTON}
          onClick={() => chooseFilesToTranscribe()}
        >
          Choose files
        </button>
      </div>

      {(adding || waiting.length > 0 || failed.length > 0) && (
        <div className="mt-5 flex w-full max-w-md flex-col gap-2 text-left">
          {adding && (
            <div className="flex items-center gap-3">
              <p
                className="min-w-0 flex-1 truncate text-[13px] text-overlay/62 tabular-nums"
                title={adding.name}
              >
                Adding {adding.name}… {percent(adding)}%
                {waiting.length > 0 && (
                  <span className="text-overlay/40">
                    {" "}
                    ({waiting.length} more waiting)
                  </span>
                )}
              </p>
              <button
                type="button"
                className={BUTTON}
                onClick={() => cancelDroppedFileUpload(adding.key)}
              >
                Cancel
              </button>
            </div>
          )}
          {failed.map((upload) => (
            <div key={upload.key} className="flex items-center gap-3">
              <p
                className="min-w-0 flex-1 text-[13px] text-accent-red/80"
                title={upload.name}
              >
                <span className="block truncate">
                  Couldn't add {upload.name}
                </span>
                {upload.message && (
                  <span className="block text-overlay/45">
                    {upload.message}
                  </span>
                )}
              </p>
              <button
                type="button"
                className={BUTTON}
                onClick={() => dismissDroppedFileUpload(upload.key)}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
