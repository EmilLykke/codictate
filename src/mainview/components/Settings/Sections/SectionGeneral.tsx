import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings, ThemePreference } from "../../../../shared/types";
import {
  fetchSettings,
  setMaxRecordingDuration,
  setSoundEffectsEnabled,
  setUserDisplayName,
} from "../../../rpc";
import { RecordingLimitPicker } from "../RecordingLimitPicker";
import { settingsHelperClass } from "../settings-shared";
import { useTheme } from "../../../hooks/useTheme";
import { Switch } from "../../Common/Switch";

type Props = {
  settings: AppSettings;
};

const SunIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

const MoonIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="none"
  >
    <path d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
  </svg>
);

const MonitorIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  icon: ReactNode;
}[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

export function SectionGeneral({ settings }: Props) {
  const queryClient = useQueryClient();
  const { preference: themePref, setPreference: setThemePref } = useTheme();
  const [userDisplayNameDraft, setUserDisplayNameDraft] = useState("");

  useEffect(() => {
    setUserDisplayNameDraft(settings.userDisplayName);
  }, [settings.userDisplayName]);

  const handleUserDisplayNameCommit = useCallback(async () => {
    const normalized = userDisplayNameDraft.trim();
    if (normalized === settings.userDisplayName) return;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, userDisplayName: normalized } : old,
    );
    const ok = await setUserDisplayName(normalized);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [queryClient, settings.userDisplayName, userDisplayNameDraft]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void handleUserDisplayNameCommit();
    }, 600);
    return () => clearTimeout(timer);
  }, [userDisplayNameDraft, handleUserDisplayNameCommit]);

  const handleMaxRecordingDurationChange = useCallback(
    async (maxRecordingDuration: number) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, maxRecordingDuration } : old,
      );
      await setMaxRecordingDuration(maxRecordingDuration);
    },
    [queryClient],
  );

  const handleSoundEffectsToggle = useCallback(async () => {
    const next = !settings.soundEffectsEnabled;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, soundEffectsEnabled: next } : old,
    );
    const ok = await setSoundEffectsEnabled(next);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [queryClient, settings.soundEffectsEnabled]);

  return (
    <>
      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
          Profile
        </h2>
        <label className="block">
          <span className="mb-2 block text-[13px] text-overlay/44 font-sans">
            Your name
          </span>
          <input
            type="text"
            value={userDisplayNameDraft}
            onChange={(event) => setUserDisplayNameDraft(event.target.value)}
            onBlur={() => void handleUserDisplayNameCommit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            placeholder="Your name"
            className="w-full rounded-lg border border-overlay/12 bg-surface-1 px-4 py-3.5 text-[17px] font-medium text-overlay/78 outline-none transition-[border-color,background-color,box-shadow] duration-200 placeholder:text-overlay/24 hover:border-overlay/18 hover:bg-surface-2 focus-visible:border-overlay/26 focus-visible:ring-2 focus-visible:ring-overlay/12 focus-visible:ring-offset-0"
          />
        </label>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
          Recording Limit
        </h2>
        <RecordingLimitPicker
          valueSeconds={settings.maxRecordingDuration}
          onChange={handleMaxRecordingDurationChange}
        />
        <p className={settingsHelperClass}>
          Longer limits use more disk space and increase transcription time.
        </p>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
          Sound Effects
        </h2>
        <div className="rounded-xl border border-overlay/11 bg-surface-1 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div className="flex-1 min-w-0">
              <span
                className={`block text-[17px] font-medium ${settings.soundEffectsEnabled ? "text-overlay/78" : "text-overlay/58"}`}
              >
                Dictation sounds
              </span>
              <span className="mt-0.5 block text-[13px] text-overlay/40 leading-snug">
                Play audio feedback when starting, stopping, or cancelling
                dictation.
              </span>
            </div>
            <Switch
              checked={settings.soundEffectsEnabled}
              onCheckedChange={() => void handleSoundEffectsToggle()}
              aria-label="Toggle dictation sound effects"
            />
          </div>
        </div>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
          Appearance
        </h2>
        <div className="flex gap-2">
          {THEME_OPTIONS.map(({ value, label, icon }) => {
            const selected = themePref === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setThemePref(value)}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[15px] font-medium cursor-pointer transition-all duration-200 ${
                  selected
                    ? "border-overlay/22 bg-surface-3 text-overlay/88"
                    : "border-overlay/8 bg-surface-1 text-overlay/40 opacity-55 hover:opacity-85 hover:border-overlay/14 hover:bg-surface-2 hover:text-overlay/65"
                }`}
              >
                {icon}
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
