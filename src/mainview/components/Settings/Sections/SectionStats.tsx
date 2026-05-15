import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "../../../../shared/types";
import { Switch } from "../../Common/Switch";
import { updateStatsSettings } from "../../../rpc";

export function SectionStats({ settings }: { settings: AppSettings }) {
  const queryClient = useQueryClient();
  const stats = settings.stats;

  const update = useCallback(
    async (patch: Parameters<typeof updateStatsSettings>[0]) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, stats: { ...old.stats, ...patch } } : old,
      );
      const ok = await updateStatsSettings(patch);
      if (!ok) {
        queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
    },
    [queryClient],
  );

  return (
    <div className="flex flex-col gap-8">
      <p className="text-[14px] text-overlay/40 leading-relaxed">
        Track word count, speaking speed, and streaks. No transcript text is
        stored.
      </p>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-[16px] font-medium text-overlay/80">
            Enable stats
          </div>
          <div className="text-[14px] text-overlay/40 mt-1">
            Collect dictation metrics after each session
          </div>
        </div>
        <Switch
          checked={stats.enabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
          aria-label="Enable stats"
        />
      </div>
    </div>
  );
}
