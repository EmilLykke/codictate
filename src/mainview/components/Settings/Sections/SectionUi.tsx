import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AppSettings,
  RecordingIndicatorMode,
} from "../../../../shared/types";
import { fetchSettings, setRecordingIndicatorMode } from "../../../rpc";
import { platformDisplayName } from "../../../../shared/platform";
import { VoiceActivityCore } from "../../Common/VoiceActivityCore";

type Props = {
  settings: AppSettings;
};

const INDICATOR_OPTIONS = [
  {
    mode: "off" as const,
    label: "Off",
    hint: "No floating indicator on the desktop.",
  },
  {
    mode: "when-active" as const,
    label: "When recording",
    hint: "Shows while dictating or transcribing.",
  },
  {
    mode: "always" as const,
    label: "Always",
    hint: "Always visible in the corner (subtle when idle).",
  },
];

export function SectionUi({ settings }: Props) {
  const queryClient = useQueryClient();
  const indicatorComingSoon = !settings.capabilities.supportsNativeIndicator;

  const handleRecordingIndicatorModeChange = useCallback(
    async (mode: RecordingIndicatorMode) => {
      queryClient.setQueryData(["settings"], {
        ...settings,
        recordingIndicatorMode: mode,
      });
      const ok = await setRecordingIndicatorMode(mode);
      if (!ok) {
        const fresh = await fetchSettings();
        queryClient.setQueryData(["settings"], fresh);
      }
    },
    [queryClient, settings],
  );

  return (
    <>
      <div className="mb-8 flex justify-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black border border-white/10 shadow-lg shadow-black/40">
          <VoiceActivityCore status="recording" variant="indicator" />
        </div>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Recording indicator
        </h2>
        <div className="flex flex-col gap-2">
        {indicatorComingSoon && (
          <div className="rounded-xl border border-amber-400/25 bg-amber-500/8 px-4 py-3">
            <span className="inline-flex rounded-full border border-amber-400/28 bg-amber-500/10 px-2 py-0.5 text-[13px] font-medium uppercase tracking-wide text-amber-100/75">
              Coming soon on{" "}
              {platformDisplayName(settings.capabilities.platform)}
            </span>
            <p className="mt-2 text-[13px] text-white/60 leading-snug">
              The floating desktop indicator will arrive after the Windows
              dictation core is in place.
            </p>
          </div>
        )}
        {INDICATOR_OPTIONS.map(({ mode, label, hint }) => {
          const selected = settings.recordingIndicatorMode === mode;
          return (
            <button
              key={mode}
              type="button"
              disabled={indicatorComingSoon}
              onClick={() => handleRecordingIndicatorModeChange(mode)}
              className={`w-full text-left rounded-xl border px-4 py-3.5 transition-colors duration-200 ${
                selected
                  ? "border-white/22 bg-white/8"
                  : "border-white/11 bg-white/4 hover:border-white/16 hover:bg-white/6"
              } ${indicatorComingSoon ? "cursor-not-allowed opacity-55" : "cursor-pointer"}`}
            >
              <span
                className={`block text-[17px] font-medium ${selected ? "text-white/88" : "text-white/62"}`}
              >
                {label}
              </span>
              <span className="mt-0.5 block text-[13px] text-white/40 leading-snug">
                {hint}
              </span>
            </button>
          );
        })}
      </div>
    </div>
    </>
  );
}
