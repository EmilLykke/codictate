import { useCallback, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import type { AppSettings } from "../../../../shared/types";
import { Switch } from "../../Common/Switch";
import {
  fetchDevices,
  setAudioDevice,
  setAudioDuckingIncludeBuiltInSpeakers,
  setAudioDuckingIncludeHeadphones,
  setAudioDuckingLevel,
} from "../../../rpc";
import { DevicePicker } from "../DevicePicker";

type Props = {
  settings: AppSettings;
};

type AudioDuckingPatch = Partial<AppSettings["audioDucking"]>;

export function SectionAudio({ settings }: Props) {
  const queryClient = useQueryClient();
  const audioDucking = settings.audioDucking;
  const isAnyAudioDuckingEnabled =
    audioDucking.includeBuiltInSpeakers || audioDucking.includeHeadphones;
  const { data: deviceInfo } = useQuery({
    queryKey: ["devices"],
    queryFn: fetchDevices,
  });

  const handleDeviceChange = useCallback(
    async (index: number) => {
      if (!deviceInfo) return;
      queryClient.setQueryData(["devices"], {
        ...deviceInfo,
        selectedDevice: index,
      });
      await setAudioDevice(index);
    },
    [deviceInfo, queryClient],
  );

  const updateAudioDuckingSetting = useCallback(
    async (patch: AudioDuckingPatch, persist: () => Promise<boolean>) => {
      const settingsKey = ["settings"];
      const previous =
        queryClient.getQueryData<AppSettings>(settingsKey) ?? settings;

      queryClient.setQueryData(settingsKey, (old: AppSettings | undefined) =>
        old
          ? {
              ...old,
              audioDucking: {
                ...old.audioDucking,
                ...patch,
              },
            }
          : old,
      );

      const ok = await persist();
      if (ok) return;

      queryClient.setQueryData(
        settingsKey,
        (current: AppSettings | undefined) => {
          if (!current) return current;

          const next = { ...current };
          next.audioDucking = { ...current.audioDucking };
          let changed = false;

          if (
            patch.level !== undefined &&
            current.audioDucking.level === patch.level
          ) {
            next.audioDucking.level = previous.audioDucking.level;
            changed = true;
          }
          if (
            patch.includeHeadphones !== undefined &&
            current.audioDucking.includeHeadphones === patch.includeHeadphones
          ) {
            next.audioDucking.includeHeadphones =
              previous.audioDucking.includeHeadphones;
            changed = true;
          }
          if (
            patch.includeBuiltInSpeakers !== undefined &&
            current.audioDucking.includeBuiltInSpeakers ===
              patch.includeBuiltInSpeakers
          ) {
            next.audioDucking.includeBuiltInSpeakers =
              previous.audioDucking.includeBuiltInSpeakers;
            changed = true;
          }

          return changed ? next : current;
        },
      );
    },
    [queryClient, settings],
  );

  const handleAudioDuckingLevelChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const level = Number(event.target.value);
      await updateAudioDuckingSetting({ level }, () =>
        setAudioDuckingLevel(level),
      );
    },
    [updateAudioDuckingSetting],
  );

  const handleAudioDuckingIncludeHeadphonesToggle = useCallback(async () => {
    const newValue = !audioDucking.includeHeadphones;
    await updateAudioDuckingSetting({ includeHeadphones: newValue }, () =>
      setAudioDuckingIncludeHeadphones(newValue),
    );
  }, [audioDucking.includeHeadphones, updateAudioDuckingSetting]);

  const handleAudioDuckingIncludeBuiltInToggle = useCallback(async () => {
    const newValue = !audioDucking.includeBuiltInSpeakers;
    await updateAudioDuckingSetting({ includeBuiltInSpeakers: newValue }, () =>
      setAudioDuckingIncludeBuiltInSpeakers(newValue),
    );
  }, [audioDucking.includeBuiltInSpeakers, updateAudioDuckingSetting]);

  return (
    <>
      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
          Input Device
        </h2>
        <DevicePicker
          devices={deviceInfo?.devices ?? {}}
          selectedDevice={deviceInfo?.selectedDevice ?? 0}
          onChange={handleDeviceChange}
        />
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
          Audio Ducking
        </h2>
        <div className="rounded-xl border border-overlay/11 bg-surface-1 overflow-hidden divide-y divide-overlay/8">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div className="flex-1 min-w-0">
              <span
                className={`block text-[17px] font-medium ${audioDucking.includeBuiltInSpeakers ? "text-overlay/78" : "text-overlay/58"}`}
              >
                Built-in speakers
              </span>
              <span className="mt-0.5 block text-[13px] text-overlay/40 leading-snug">
                Mute Mac speaker output while dictating.
              </span>
            </div>
            <Switch
              checked={audioDucking.includeBuiltInSpeakers}
              onCheckedChange={() =>
                void handleAudioDuckingIncludeBuiltInToggle()
              }
              aria-label="Toggle ducking for built-in speakers"
            />
          </div>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div className="flex-1 min-w-0">
              <span
                className={`block text-[17px] font-medium ${audioDucking.includeHeadphones ? "text-overlay/78" : "text-overlay/58"}`}
              >
                Headphones & Bluetooth
              </span>
              <span className="mt-0.5 block text-[13px] text-overlay/40 leading-snug">
                Also lower headphone volume while dictating.
              </span>
            </div>
            <Switch
              checked={audioDucking.includeHeadphones}
              onCheckedChange={() =>
                void handleAudioDuckingIncludeHeadphonesToggle()
              }
              aria-label="Toggle ducking for headphones"
            />
          </div>
          <AnimatePresence>
            {isAnyAudioDuckingEnabled && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="border-t border-overlay/8 px-4 py-3.5"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px] text-overlay/44 font-sans">
                    Mute amount
                  </span>
                  <span className="text-[13px] text-overlay/55 font-medium tabular-nums">
                    {audioDucking.level === 0
                      ? "Fully mute"
                      : audioDucking.level === 100
                        ? "No change"
                        : `${100 - audioDucking.level}% quieter`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={audioDucking.level}
                  onChange={handleAudioDuckingLevelChange}
                  className="w-full accent-accent-blue cursor-pointer"
                  aria-label="Audio duck amount"
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[14px] text-overlay/28">
                    Fully mute
                  </span>
                  <span className="text-[14px] text-overlay/28">No change</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
