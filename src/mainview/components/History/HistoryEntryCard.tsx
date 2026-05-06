import { useState } from "react";
import type { HistoryEntry } from "../../../shared/types";
import { AudioPlayer } from "./AudioPlayer";
import { deleteHistoryEntry } from "../../rpc";

interface Props {
  entry: HistoryEntry;
  onDeleted: () => void;
}

const TRUNCATE_LENGTH = 180;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function HistoryEntryCard({ entry, onDeleted }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const needsTruncation = entry.transcript.length > TRUNCATE_LENGTH;
  const displayText =
    needsTruncation && !expanded
      ? entry.transcript.slice(0, TRUNCATE_LENGTH) + "..."
      : entry.transcript;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(entry.transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDelete = async () => {
    await deleteHistoryEntry(entry.id);
    onDeleted();
  };

  return (
    <div className="bg-white/8 rounded-lg border border-white/12 p-4">
      <div className="flex items-start justify-between mb-3">
        <span className="text-[14px] font-medium text-white/60">
          {dateFormatter.format(entry.timestamp)}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className="p-1.5 rounded-md text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
            aria-label="Copy transcript"
          >
            {copied ? (
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="p-1.5 rounded-md text-white/30 hover:text-red-400/80 hover:bg-white/10 transition-colors cursor-pointer"
            aria-label="Delete entry"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      <p className="text-[15px] text-white/70 italic leading-relaxed mb-3">
        {displayText}
        {needsTruncation && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="ml-1 text-blue-400/70 hover:text-blue-400 text-[13px] not-italic cursor-pointer"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </p>

      <AudioPlayer entryId={entry.id} durationMs={entry.durationMs ?? 0} />
    </div>
  );
}
