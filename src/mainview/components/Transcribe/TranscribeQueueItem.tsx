import type { FileTranscriptionQueueItem } from "../../../shared/types";
import {
  queueItemCallerLabel,
  queueItemStatusLine,
} from "../../../shared/file-transcription-copy";
import { cancelFileTranscription } from "../../rpc";
import { BUTTON } from "./transcribe-styles";

/** A file waiting or running, from this window or the command line. */
export function TranscribeQueueItem({
  item,
  nowMs,
}: {
  item: FileTranscriptionQueueItem;
  nowMs: number;
}) {
  const running = item.state !== "queued";
  const caller = queueItemCallerLabel(item);
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <span
        className={`size-2 shrink-0 rounded-full ${
          running ? "bg-accent-blue/80 animate-pulse" : "bg-overlay/20"
        }`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-[15px] text-overlay/80"
          title={item.fileName}
        >
          {item.fileName}
        </p>
        <p className="mt-0.5 text-[13px] text-overlay/45 tabular-nums">
          {queueItemStatusLine(item, nowMs)}
          {caller && (
            <span className="ml-2 rounded-full border border-overlay/12 px-2 py-px text-[11px] text-overlay/50">
              {caller}
            </span>
          )}
        </p>
      </div>
      <button
        type="button"
        className={BUTTON}
        onClick={() => void cancelFileTranscription(item.id)}
      >
        Cancel
      </button>
    </div>
  );
}
