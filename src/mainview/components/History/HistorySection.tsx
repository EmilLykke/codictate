import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, HistoryEntry } from "../../../shared/types";
import { HistoryEmptyState } from "./HistoryEmptyState";
import { HistoryEntryCard } from "./HistoryEntryCard";
import {
  fetchHistoryEntries,
  openHistoryFolder,
  updateHistorySettings,
} from "../../rpc";
import { appEvents } from "../../app-events";
import { Switch } from "../Common/Switch";

interface Props {
  settings: AppSettings;
}

export function HistorySection({ settings }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadEntries = useCallback(async (query?: string) => {
    setLoading(true);
    try {
      const result = await fetchHistoryEntries(query);
      setEntries(result);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    if (!settings.history.enabled) return;
    return appEvents.on("historyEntryAdded", () => {
      loadEntries(search || undefined);
    });
  }, [settings.history.enabled, loadEntries, search]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadEntries(search || undefined);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, loadEntries]);

  if (!settings.history.enabled && !loading && entries.length === 0) {
    return <HistoryEmptyState storagePath={settings.history.storagePath} />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[13px] font-semibold tracking-widest text-white/40 uppercase">
          History
        </h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => openHistoryFolder()}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-white/15 text-[13px] text-white/60 hover:text-white/80 hover:border-white/25 transition-colors cursor-pointer"
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
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
            Open Recordings Folder
          </button>
          <Switch
            checked={settings.history.enabled}
            onCheckedChange={(checked) => {
              updateHistorySettings({ enabled: checked });
            }}
            aria-label="Enable dictation history"
          />
        </div>
      </div>

      <div className="mb-4">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transcripts..."
            className="w-full bg-white/8 border border-white/12 rounded-lg pl-9 pr-3 py-2.5 text-[15px] text-white/80 placeholder:text-white/35 outline-none focus:border-white/25 transition-colors"
          />
        </div>
      </div>

      {loading && entries.length === 0 ? (
        <div className="text-center py-16 text-[14px] text-white/30">
          Loading...
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-[14px] text-white/30">
            {search
              ? "No entries match your search."
              : "No dictation history yet. Start dictating to build your history."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {entries.map((entry) => (
            <HistoryEntryCard
              key={entry.id}
              entry={entry}
              onDeleted={() => loadEntries(search || undefined)}
            />
          ))}
        </div>
      )}

      <p className="text-[12px] text-white/20 mt-6 text-center">
        Audio recordings are saved to disk and take up storage space.
      </p>
    </div>
  );
}
