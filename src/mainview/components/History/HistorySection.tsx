import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, HistoryEntry } from "../../../shared/types";
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
  onOpenHistorySettings?: () => void;
}

export function HistorySection({ settings, onOpenHistorySettings }: Props) {
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

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[13px] font-semibold tracking-widest text-white/40 uppercase">
            History
          </h2>
          <Switch
            checked={settings.history.enabled}
            onCheckedChange={(checked) => {
              updateHistorySettings({ enabled: checked });
            }}
            aria-label="Enable dictation history"
          />
        </div>
        <div className="flex items-center gap-3">
          {onOpenHistorySettings && (
            <button
              type="button"
              onClick={onOpenHistorySettings}
              className="p-1.5 rounded-md text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="History settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          )}
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
              : settings.history.enabled
                ? "No dictation history yet. Start dictating to build your history."
                : "No history items. Enable history to start saving your dictations."}
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-white/5 border border-white/10 divide-y divide-white/8">
          {entries.map((entry) => (
            <HistoryEntryCard
              key={entry.id}
              entry={entry}
              onDeleted={() => loadEntries(search || undefined)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
