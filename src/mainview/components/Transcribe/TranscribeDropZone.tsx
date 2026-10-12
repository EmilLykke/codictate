import { useEffect, useRef, useState } from "react";
import { chooseFilesToTranscribe } from "../../rpc";
import { BUTTON } from "./transcribe-styles";

/** How long after the last `dragover` the highlight lets go. */
const DRAG_IDLE_MS = 250;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Drop a file, or choose some.
 *
 * The drop itself is not handled here. WKWebView and WebView2 never give a page a dropped
 * file's real path, so the page deliberately leaves `dragover` uncancelled: the webview then
 * tries to open the file, the main process blocks that navigation and queues the path it
 * names (setup-window.ts). This component only lights up while a file is over the window.
 * One file per drop; "Choose files" takes several.
 */
export function TranscribeDropZone({ compact }: { compact: boolean }) {
  const [dragging, setDragging] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const release = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = null;
      setDragging(false);
    };
    const onDrag = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      setDragging(true);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(release, DRAG_IDLE_MS);
    };
    window.addEventListener("dragenter", onDrag);
    window.addEventListener("dragover", onDrag);
    window.addEventListener("dragend", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("dragenter", onDrag);
      window.removeEventListener("dragover", onDrag);
      window.removeEventListener("dragend", release);
      window.removeEventListener("blur", release);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

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
        {dragging
          ? "Let go to transcribe it"
          : "Drop an audio or video file here"}
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
    </div>
  );
}
