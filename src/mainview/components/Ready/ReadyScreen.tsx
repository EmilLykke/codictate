"use client";

import { useMemo, useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import type { AppStatus, AppSettings, DeviceInfo } from "../../../shared/types";
import {
  setTranscriptionLanguage,
  setTranslateToEnglish,
  fetchSettings,
} from "../../rpc";
import {
  WHISPER_MODELS,
  TRANSLATE_MODEL_ID,
} from "../../../shared/whisper-models";
import { appEvents } from "../../app-events";
import { Kbd } from "../Common/Kbd";
import { InstantTooltip } from "../Common/InstantTooltip";
import { WordmarkCodictate } from "../Brand/WordmarkCodictate";
import {
  LanguagePicker,
  READY_BAR_PY_CLASS,
  READY_BAR_TEXT_CLASS,
} from "../Settings/LanguagePicker";
import { TranscriptionLanguageHintButton } from "../Settings/TranscriptionLanguageHintButton";
import { RecordingOrb } from "./RecordingOrb";

const SHORTCUT_DISPLAY: Record<string, string[]> = {
  "option-space": ["⌥", "Space"],
  "right-option": ["Right ⌥"],
  "option-f1": ["⌥", "F1"],
  "option-f2": ["⌥", "F2"],
  "option-enter": ["⌥", "Enter"],
};

export function ReadyScreen({
  status,
  deviceInfo,
  settings,
  onOpenSettings,
}: {
  status: AppStatus;
  deviceInfo?: DeviceInfo;
  settings?: AppSettings;
  onOpenSettings: () => void;
}) {
  const isRecording = status === "recording";
  const isTranscribing = status === "transcribing";
  const isIdle = status === "ready";

  const queryClient = useQueryClient();
  const languageId = settings?.transcriptionLanguageId ?? "auto";

  // Model availability — seeded from query cache, updated via events.
  const [modelAvailability, setModelAvailability] = useState<
    Record<string, boolean>
  >(
    () =>
      queryClient.getQueryData<Record<string, boolean>>([
        "modelAvailability",
      ]) ??
      Object.fromEntries(WHISPER_MODELS.map((m) => [m.id, m.bundled ?? false])),
  );

  useEffect(() => {
    return appEvents.on("modelAvailability", ({ modelId, available }) => {
      setModelAvailability((prev) => ({ ...prev, [modelId]: available }));
    });
  }, []);

  const translateModelAvailable =
    modelAvailability[TRANSLATE_MODEL_ID] ?? false;
  const languageIsAuto = languageId === "auto";
  const isTranslateOn = settings?.translateToEnglish ?? false;

  const handleLanguageChange = useCallback(
    async (transcriptionLanguageId: string) => {
      if (settings) {
        queryClient.setQueryData(["settings"], {
          ...settings,
          transcriptionLanguageId,
        });
      }
      await setTranscriptionLanguage(transcriptionLanguageId);
    },
    [queryClient, settings],
  );

  const handleTranslateToggle = useCallback(async () => {
    if (!settings || !isIdle) return;
    if (isTranslateOn) {
      // Turning off — optimistically update UI; backend atomically resets lang to auto.
      queryClient.setQueryData(["settings"], {
        ...settings,
        translateToEnglish: false,
        transcriptionLanguageId: "auto",
      });
      await setTranslateToEnglish(false);
      return;
    }
    // Model not available → open Settings so the user can download it.
    if (!translateModelAvailable) {
      onOpenSettings();
      return;
    }
    // Language is auto but a default language is configured → apply it first.
    if (languageIsAuto && settings.translateDefaultLanguageId) {
      const defaultLang = settings.translateDefaultLanguageId;
      queryClient.setQueryData(["settings"], {
        ...settings,
        transcriptionLanguageId: defaultLang,
        translateToEnglish: true,
      });
      await setTranscriptionLanguage(defaultLang);
      const ok = await setTranslateToEnglish(true);
      if (!ok) {
        queryClient.setQueryData(["settings"], await fetchSettings());
      }
      return;
    }
    // Auto source language but no default for translate → open Settings to set one.
    if (languageIsAuto) {
      onOpenSettings();
      return;
    }
    queryClient.setQueryData(["settings"], {
      ...settings,
      translateToEnglish: true,
    });
    const ok = await setTranslateToEnglish(true);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [
    settings,
    isIdle,
    isTranslateOn,
    translateModelAvailable,
    languageIsAuto,
    queryClient,
    onOpenSettings,
  ]);

  const micName = deviceInfo
    ? (deviceInfo.devices[String(deviceInfo.selectedDevice)] ?? "Default")
    : null;

  const displayKeys = useMemo(
    () =>
      SHORTCUT_DISPLAY[settings?.shortcutId ?? "option-space"] ?? [
        "⌥",
        "Space",
      ],
    [settings?.shortcutId],
  );

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-codictate-page text-white select-none">
      <div className="electrobun-webkit-app-region-drag absolute top-0 left-0 right-0 h-7 hover:bg-white/3 transition-colors duration-200" />
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="mb-7"
      >
        <RecordingOrb status={status} />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col items-center mb-10"
      >
        <WordmarkCodictate
          as="h1"
          className="text-[30px] font-semibold tracking-[-0.02em] text-white/90"
        />
        <AnimatePresence mode="wait">
          <motion.p
            key={status}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className={`text-[19px] mt-0.5 font-medium font-sans ${
              isRecording
                ? "text-red-400/85"
                : isTranscribing
                  ? "text-amber-400/78"
                  : "text-white/52"
            }`}
          >
            {isRecording
              ? "Listening…"
              : isTranscribing
                ? "Transcribing…"
                : "Ready"}
          </motion.p>
        </AnimatePresence>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: isIdle ? 1 : 0.2, y: 0 }}
        transition={{ delay: 0.18, duration: 0.35 }}
        className="flex flex-col items-center gap-5"
      >
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-1.5">
            {displayKeys.map((key, i) => (
              <span key={key} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span className="text-white/42 text-[18px] font-light">
                    +
                  </span>
                )}
                <Kbd>{key}</Kbd>
              </span>
            ))}
          </div>
          <span className="text-[18px] text-white/50 font-sans">
            Start / stop recording
          </span>
        </div>

        <div className="w-px h-3 bg-white/14" />

        <div className="flex flex-col items-center gap-2">
          <Kbd>Esc</Kbd>
          <span className="text-[18px] text-white/50 font-sans">Cancel</span>
        </div>
      </motion.div>

      {/* Bottom bar: language | mic | settings */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.3 }}
        className="absolute bottom-7 left-6 right-6 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-3 pointer-events-none"
      >
        <div
          className={`min-w-0 max-w-[min(100%,240px)] pointer-events-auto justify-self-start flex items-stretch gap-1.5 ${!isIdle ? "opacity-50" : ""}`}
        >
          <div className="min-w-0 flex-1">
            <LanguagePicker
              compact
              value={languageId}
              onChange={handleLanguageChange}
              className={!isIdle ? "pointer-events-none" : undefined}
            />
          </div>
          <TranscriptionLanguageHintButton
            className={!isIdle ? "pointer-events-none opacity-60" : ""}
          />
        </div>

        <AnimatePresence>
          {micName ? (
            <motion.div
              key="mic"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="pointer-events-none flex items-center gap-1.5 justify-center justify-self-center max-w-[200px]"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                className="text-white/45 shrink-0"
                fill="currentColor"
              >
                <rect x="3" y="0" width="4" height="6" rx="2" />
                <path
                  d="M1.5 5.5a3.5 3.5 0 0 0 7 0"
                  stroke="currentColor"
                  strokeWidth="1"
                  fill="none"
                  strokeLinecap="round"
                />
                <line
                  x1="5"
                  y1="9"
                  x2="5"
                  y2="8.5"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeLinecap="round"
                />
              </svg>
              <span className="text-[17px] text-white/50 font-sans truncate">
                {micName}
              </span>
            </motion.div>
          ) : (
            <div className="justify-self-center" />
          )}
        </AnimatePresence>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.3 }}
          className="pointer-events-auto justify-self-end flex items-stretch gap-1.5"
        >
          {settings !== undefined &&
            (() => {
              const hasDefaultLang = Boolean(
                settings.translateDefaultLanguageId,
              );
              const tooltipText = isTranslateOn
                ? "Translate mode active — click to disable"
                : !translateModelAvailable
                  ? "Download the Large model in Settings to enable translate mode"
                  : languageIsAuto && !hasDefaultLang
                    ? "Select a source language (or set a default in Settings) to enable translate mode"
                    : "Translate mode — transcribe and translate to English";

              const isDimmed =
                !translateModelAvailable || (languageIsAuto && !hasDefaultLang);

              return (
                <InstantTooltip text={tooltipText} side="top">
                  <button
                    onClick={handleTranslateToggle}
                    disabled={!isIdle}
                    className={`inline-flex items-center ${READY_BAR_PY_CLASS} px-3.5 rounded-lg border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${READY_BAR_TEXT_CLASS} transition-[border-color,background-color,box-shadow] duration-200 disabled:opacity-50 disabled:pointer-events-none ${
                      isTranslateOn
                        ? "cursor-pointer border-blue-400/30 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400/80"
                        : isDimmed
                          ? "cursor-pointer border-white/8 bg-white/3 text-white/30 hover:border-white/14 hover:text-white/44"
                          : "cursor-pointer border-white/12 bg-white/5 hover:border-white/18 hover:bg-white/7 text-white/78 hover:text-white/88"
                    }`}
                    aria-label={tooltipText}
                  >
                    Translate mode
                  </button>
                </InstantTooltip>
              );
            })()}
          <button
            onClick={onOpenSettings}
            className="inline-flex aspect-square w-10 shrink-0 self-stretch items-center justify-center rounded-lg border border-white/12 bg-white/5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:border-white/18 hover:bg-white/7 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12 focus-visible:ring-offset-0 transition-[border-color,background-color,box-shadow] duration-200 cursor-pointer"
            aria-label="Settings"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-white/48"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </motion.div>
      </motion.div>
    </div>
  );
}
