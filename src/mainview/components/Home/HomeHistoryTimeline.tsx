import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryEntry } from "../../../shared/types";
import { fetchHistoryEntries } from "../../rpc";
import { appEvents } from "../../app-events";

const TRUNCATE_LENGTH = 120;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-1 rounded text-overlay/20 hover:text-overlay/60 transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100"
      aria-label="Copy transcript"
    >
      {copied ? (
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
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
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
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
    </button>
  );
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

function formatDateGroup(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  if (isToday) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();
  if (isYesterday) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function groupByDate(
  entries: HistoryEntry[],
): { label: string; entries: HistoryEntry[] }[] {
  const groups: { label: string; entries: HistoryEntry[] }[] = [];
  let currentLabel = "";
  for (const entry of entries) {
    const label = formatDateGroup(entry.timestamp);
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ label, entries: [] });
    }
    groups[groups.length - 1].entries.push(entry);
  }
  return groups;
}

interface Props {
  historyEnabled: boolean;
  onNavigateToHistory: () => void;
}

export function HomeHistoryTimeline({
  historyEnabled,
  onNavigateToHistory,
}: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchHistoryEntries();
      if (mountedRef.current) setEntries(result);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadEntries();
    return () => {
      mountedRef.current = false;
    };
  }, [loadEntries]);

  useEffect(() => {
    return appEvents.on("historyEntryAdded", () => {
      loadEntries();
    });
  }, [loadEntries]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const groups = groupByDate(entries);

  if (loading && entries.length === 0) {
    return <div className="text-[14px] text-overlay/25 py-8">Loading...</div>;
  }

  if (entries.length === 0) {
    return (
      <div className="text-[14px] text-overlay/25 py-8">
        {historyEnabled ? (
          "No dictation history yet. Start dictating to build your timeline."
        ) : (
          <span>
            No history items.{" "}
            <button
              type="button"
              onClick={onNavigateToHistory}
              className="text-accent-blue/60 hover:text-accent-blue cursor-pointer"
            >
              Enable history
            </button>{" "}
            to save a copy of each dictation.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-6">
      {groups.map((group) => (
        <div key={group.label}>
          <h3 className="text-[12px] font-semibold tracking-[0.12em] uppercase text-overlay/35 mb-2.5 sticky top-0 bg-codictate-page py-2 z-10">
            {group.label}
          </h3>
          <div className="rounded-xl bg-surface-1 border border-overlay/10 divide-y divide-overlay/8">
            {group.entries.map((entry) => {
              const needsTruncation = entry.transcript.length > TRUNCATE_LENGTH;
              const isExpanded = expandedIds.has(entry.id);
              const displayText =
                needsTruncation && !isExpanded
                  ? entry.transcript.slice(0, TRUNCATE_LENGTH) + "..."
                  : entry.transcript;

              return (
                <div
                  key={entry.id}
                  className="group flex items-baseline gap-6 px-5 py-3.5"
                >
                  <span className="text-[14px] text-overlay/35 tabular-nums shrink-0 min-w-[70px]">
                    {timeFormatter.format(entry.timestamp)}
                  </span>
                  <div className="flex-1 relative">
                    <span
                      onClick={async () => {
                        await navigator.clipboard.writeText(entry.transcript);
                        setCopiedId(entry.id);
                        setTimeout(
                          () =>
                            setCopiedId((prev) =>
                              prev === entry.id ? null : prev,
                            ),
                          1500,
                        );
                      }}
                      className="text-[15px] text-overlay/70 leading-relaxed cursor-pointer hover:text-overlay/80 transition-colors"
                    >
                      {displayText}
                      {needsTruncation && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(entry.id);
                          }}
                          className="ml-1.5 text-accent-blue/60 hover:text-accent-blue text-[13px] cursor-pointer"
                        >
                          {isExpanded ? "less" : "more"}
                        </button>
                      )}
                    </span>
                    {copiedId === entry.id && (
                      <span className="absolute -top-4 left-0 text-[11px] text-accent-green/80 font-medium">
                        Copied!
                      </span>
                    )}
                  </div>
                  <CopyButton text={entry.transcript} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
