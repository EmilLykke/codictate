import { useState } from "react";
import type { FileTranscriptionOutcome } from "../../../shared/types";
import {
  describeFileTranscriptionFailure,
  resultSummaryLine,
} from "../../../shared/file-transcription-copy";
import { dismissFileTranscription } from "../../rpc";
import { TranscriptSaveMenu } from "./TranscriptSaveMenu";
import { BUTTON, CARD, LINK } from "./transcribe-styles";

function DismissButton({ id }: { id: string }) {
  return (
    <button
      type="button"
      onClick={() => void dismissFileTranscription(id)}
      className="p-1.5 rounded-md text-overlay/30 hover:text-overlay/70 hover:bg-surface-3 transition-colors cursor-pointer"
      aria-label="Remove from this list"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}

/** A finished File Transcription from this window: the transcript, or what went wrong. */
export function TranscribeResultCard({
  outcome,
  onOpenModels,
}: {
  outcome: FileTranscriptionOutcome;
  onOpenModels: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (outcome.status === "failed") {
    const copy = describeFileTranscriptionFailure(
      outcome.code,
      outcome.message,
    );
    const cancelled = outcome.code === "cancelled";
    return (
      <div className={`${CARD} px-4 py-3.5`}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-[15px] text-overlay/70"
              title={outcome.fileName}
            >
              {outcome.fileName}
            </p>
            <p
              className={`mt-1 text-[14px] ${cancelled ? "text-overlay/45" : "text-accent-red/85"}`}
            >
              {copy.title}
            </p>
            {copy.detail && (
              <p className="mt-0.5 text-[13px] text-overlay/45 select-text">
                {copy.detail}
              </p>
            )}
            {copy.action === "open-models" && (
              <button
                type="button"
                onClick={onOpenModels}
                className={`mt-1.5 text-[13px] ${LINK}`}
              >
                Go to Models
              </button>
            )}
          </div>
          <DismissButton id={outcome.id} />
        </div>
      </div>
    );
  }

  const empty = outcome.text.trim() === "";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(outcome.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={CARD}>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[15px] text-overlay/80"
            title={outcome.fileName}
          >
            {outcome.fileName}
          </p>
          <p className="mt-0.5 text-[13px] text-overlay/40 tabular-nums">
            {resultSummaryLine(outcome.audioSeconds, outcome.processingSeconds)}
            {outcome.savedToHistory && " · Saved to History"}
          </p>
        </div>
        <DismissButton id={outcome.id} />
      </div>

      <div className="px-4 py-3">
        {empty ? (
          <p className="text-[14px] text-overlay/40">
            No speech found in this file.
          </p>
        ) : (
          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-[15px] leading-relaxed text-overlay/75 select-text">
            {outcome.text}
          </p>
        )}
      </div>

      {!empty && (
        <div className="flex flex-wrap items-center gap-2 border-t border-overlay/8 px-4 py-2.5">
          <button type="button" className={BUTTON} onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <TranscriptSaveMenu
            target={{ kind: "window", id: outcome.id }}
            facts={{
              speechModelId: outcome.speechModelId,
              hasTimedTranscript: outcome.hasTimedTranscript,
            }}
            lastExport={outcome.lastExport}
          />
        </div>
      )}
    </div>
  );
}
