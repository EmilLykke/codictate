import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "../../../../shared/types";
import { Switch } from "../../Common/Switch";
import { fetchSettings, setFunModeEnabled } from "../../../rpc";

type Props = {
  settings: AppSettings;
  onBackToSettings: () => void;
};

export function SectionFun({ settings, onBackToSettings }: Props) {
  const queryClient = useQueryClient();

  const handleFunModeToggle = useCallback(async () => {
    const next = !settings.funModeEnabled;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, funModeEnabled: next } : old,
    );
    const ok = await setFunModeEnabled(next);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [queryClient, settings.funModeEnabled]);

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <span className="block text-[16px] uppercase tracking-[0.18em] text-amber-300/55">
            Hidden Settings
          </span>
          <h2 className="mt-2 text-[28px] tracking-tight text-white/90">
            Fun Mode
          </h2>
        </div>
        <button
          type="button"
          onClick={onBackToSettings}
          className="rounded-lg border border-white/12 bg-white/5 px-4 py-2 text-[16px] font-medium text-white/62 transition-colors duration-200 hover:border-white/18 hover:bg-white/7 hover:text-white/80"
        >
          Back to settings
        </button>
      </div>

      <div className="mb-8 overflow-hidden rounded-xl border border-white/11 bg-white/4">
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <span
              className={`block text-[18px] font-medium ${settings.funModeEnabled ? "text-amber-100" : "text-white/68"}`}
            >
              {settings.funModeEnabled ? "Fun Mode enabled" : "Fun Mode"}
            </span>
            <span className="mt-1 block text-[13px] leading-snug text-white/46">
              Swaps the normal dictation start and stop sounds for the secret
              set.
            </span>
          </div>
          <Switch
            checked={settings.funModeEnabled}
            onCheckedChange={() => void handleFunModeToggle()}
            aria-label="Toggle Fun Mode"
          />
        </div>
      </div>
    </>
  );
}
