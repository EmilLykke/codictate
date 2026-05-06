import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "../../../../shared/types";
import { Switch } from "../../Common/Switch";
import { updateHistorySettings } from "../../../rpc";
import { DropdownSelect } from "../../Common/DropdownSelect";

const MAX_ENTRIES_OPTIONS = [
  { value: "0", label: "Unlimited" },
  { value: "50", label: "50 entries" },
  { value: "100", label: "100 entries" },
  { value: "250", label: "250 entries" },
  { value: "500", label: "500 entries" },
  { value: "1000", label: "1,000 entries" },
];

export function SectionHistory({ settings }: { settings: AppSettings }) {
  const queryClient = useQueryClient();
  const history = settings.history;

  const update = useCallback(
    async (patch: Parameters<typeof updateHistorySettings>[0]) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, history: { ...old.history, ...patch } } : old,
      );
      const ok = await updateHistorySettings(patch);
      if (!ok) {
        queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
    },
    [queryClient],
  );

  return (
    <div className="flex flex-col gap-8">
      <p className="text-[14px] text-white/40 leading-relaxed">
        Audio recordings are saved to disk and take up storage space.
      </p>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-[16px] font-medium text-white/80">
            Enable history
          </div>
          <div className="text-[14px] text-white/40 mt-1">
            Save a copy of each dictation for later review
          </div>
        </div>
        <Switch
          checked={history.enabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
          aria-label="Enable history"
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-[16px] font-medium text-white/80">
            Save audio recordings
          </div>
          <div className="text-[14px] text-white/40 mt-1">
            When off, only transcripts are saved
          </div>
        </div>
        <Switch
          checked={history.saveAudio}
          onCheckedChange={(checked) => update({ saveAudio: checked })}
          aria-label="Save audio recordings"
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-[16px] font-medium text-white/80">
            Maximum entries
          </div>
          <div className="text-[14px] text-white/40 mt-1">
            Oldest entries are removed when the limit is reached
          </div>
        </div>
        <DropdownSelect
          value={String(history.maxEntries)}
          onChange={(v) => update({ maxEntries: Number(v) })}
          ariaLabel="Maximum history entries"
          options={MAX_ENTRIES_OPTIONS}
        />
      </div>

      <div>
        <div className="text-[16px] font-medium text-white/80">
          Storage location
        </div>
        <div className="text-[14px] text-white/40 mt-1 font-mono">
          {history.storagePath}
        </div>
      </div>
    </div>
  );
}
