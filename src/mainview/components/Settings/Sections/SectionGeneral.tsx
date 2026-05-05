import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "../../../../shared/types";
import {
  fetchSettings,
  setMaxRecordingDuration,
  setUserDisplayName,
} from "../../../rpc";
import { formatRecordingDurationLabel } from "../../../../shared/recording-duration-presets";
import { RecordingLimitPicker } from "../RecordingLimitPicker";
import { settingsHelperClass } from "../settings-shared";

type Props = {
  settings: AppSettings;
};

export function SectionGeneral({ settings }: Props) {
  const queryClient = useQueryClient();
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

  const durationLabel = formatRecordingDurationLabel(
    settings.maxRecordingDuration,
  );

  return (
    <>
      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Profile
        </h2>
        <label className="block">
          <span className="mb-2 block text-[13px] text-white/44 font-sans">
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
            className="w-full rounded-lg border border-white/12 bg-white/5 px-4 py-3.5 text-[17px] font-medium text-white/78 outline-none transition-[border-color,background-color,box-shadow] duration-200 placeholder:text-white/24 hover:border-white/18 hover:bg-white/7 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12 focus-visible:ring-offset-0"
          />
        </label>
        <p className={settingsHelperClass}>
          Stored as a general profile value. Formatting can use it for email
          sign-offs, and future features can reuse it elsewhere.
        </p>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Recording Limit
        </h2>
        <RecordingLimitPicker
          valueSeconds={settings.maxRecordingDuration}
          onChange={handleMaxRecordingDurationChange}
        />
        <p className={settingsHelperClass}>
          Recording stops automatically after {durationLabel} to maintain speed
          and accuracy. Longer limits use more disk space and increase
          transcription time.
        </p>
      </div>
    </>
  );
}
