/** Marks a History entry that came from a File Transcription, with the file's name. */
export function HistoryFileBadge({ fileName }: { fileName?: string }) {
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-overlay/12 bg-surface-2 px-2 py-0.5 text-[12px] text-overlay/55"
      title={fileName}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden
      >
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      </svg>
      <span className="truncate">{fileName ?? "File"}</span>
    </span>
  );
}
