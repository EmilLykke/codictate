"use client";

import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import type { AppStatus, AppSettings, DeviceInfo } from "../../../shared/types";
import {
  dictationReadyPttHintAfter,
  dictationReadyPttHintBefore,
  dictationShortcutSummaryHoldBody,
  dictationShortcutSummaryHoldTitle,
  shortcutDisplayKeys,
} from "../../../shared/shortcut-options";
import { platformDisplayName } from "../../../shared/platform";
import {
  setTranscriptionLanguage,
  setTranslateDefaultLanguage,
  setTranslateToEnglish,
  setStreamMode,
  setFormattingEnabled,
  fetchSettings,
} from "../../rpc";
import {
  WHISPER_MODELS,
  getTranslateReadiness,
  getWhisperModel,
} from "../../../shared/whisper-models";
import {
  PARAKEET_COREML_PREP_STORAGE_KEY,
  PARAKEET_FIRST_RUN_READY_SUBTITLE,
  getSpeechModel,
  speechModelLocksTranscriptionLanguage,
} from "../../../shared/speech-models";
import { appEvents } from "../../app-events";
import { Kbd } from "../Common/Kbd";
import {
  DictationShortcutStartHint,
  UnderlinedDictationTerm,
} from "../Common/DictationShortcutStartHint";
import { InstantTooltip } from "../Common/InstantTooltip";
import {
  WordmarkCodictate,
  wordmarkCodictateTypographyClass,
} from "../Brand/WordmarkCodictate";
import { LanguagePicker } from "../Settings/LanguagePicker";
import { TranscriptionLanguageHintButton } from "../Settings/TranscriptionLanguageHintButton";
import { RecordingOrb } from "./RecordingOrb";
import type { SettingsCategory } from "../Settings/SettingsScreen";

function DictationPttHoldHint({ className = "" }: { className?: string }) {
  return (
    <p
      className={`mt-3 max-w-[min(100%,15.5rem)] text-[15px] leading-snug text-white/50 font-sans text-balance text-center md:text-left ${className}`}
    >
      {dictationReadyPttHintBefore}
      <UnderlinedDictationTerm
        label={dictationShortcutSummaryHoldTitle}
        tooltipText={dictationShortcutSummaryHoldBody}
      />
      {dictationReadyPttHintAfter}
    </p>
  );
}

export function ReadyScreen({
  status,
  deviceInfo,
  settings,
  onOpenSettings,
}: {
  status: AppStatus;
  deviceInfo?: DeviceInfo;
  settings?: AppSettings;
  onOpenSettings: (section?: SettingsCategory) => void;
}) {
  const isRecording = status === "recording";
  const isTranscribing = status === "transcribing";
  const isStreaming = status === "streaming";
  const isIdle = status === "ready";

  const isWhisperKitModel =
    settings?.whisperModelId != null &&
    getSpeechModel(settings.whisperModelId)?.engine === "whisperkit";

  const [parakeetCoreMlPrepDone, setParakeetCoreMlPrepDone] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return (
        window.localStorage.getItem(PARAKEET_COREML_PREP_STORAGE_KEY) === "1"
      );
    } catch {
      return true;
    }
  });

  const prevStatusRef = useRef<AppStatus>(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (
      (prev === "transcribing" || prev === "streaming") &&
      status !== "transcribing" &&
      status !== "streaming" &&
      isWhisperKitModel
    ) {
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(PARAKEET_COREML_PREP_STORAGE_KEY, "1");
        }
      } catch {
        /* ignore */
      }
      setParakeetCoreMlPrepDone(true);
    }
    prevStatusRef.current = status;
  }, [status, isWhisperKitModel]);

  const showParakeetFirstRunHint =
    (isTranscribing || isStreaming) &&
    isWhisperKitModel &&
    !parakeetCoreMlPrepDone;

  const queryClient = useQueryClient();
  const languageId = settings?.transcriptionLanguageId ?? "auto";
  const transcriptionLanguageLocked =
    settings?.whisperModelId != null &&
    speechModelLocksTranscriptionLanguage(settings.whisperModelId);

  // Model availability - seeded from query cache, updated via events.
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

  const isTranslateOn = settings?.translateToEnglish ?? false;

  const translateReadiness = useMemo(() => {
    if (!settings) return null;
    const isModelAvail = (id: string) =>
      modelAvailability[id] ?? getWhisperModel(id)?.bundled ?? false;
    return getTranslateReadiness(
      settings.whisperModelId,
      settings.transcriptionLanguageId,
      settings.translateDefaultLanguageId,
      isModelAvail,
    );
  }, [settings, modelAvailability]);

  const handleLanguageChange = useCallback(
    async (transcriptionLanguageId: string) => {
      if (settings) {
        queryClient.setQueryData(
          ["settings"],
          (old: AppSettings | undefined) =>
            old
              ? {
                  ...old,
                  transcriptionLanguageId,
                  ...(isTranslateOn && transcriptionLanguageId !== "auto"
                    ? { translateDefaultLanguageId: transcriptionLanguageId }
                    : {}),
                }
              : old,
        );
      }
      await setTranscriptionLanguage(transcriptionLanguageId);
      if (isTranslateOn && transcriptionLanguageId !== "auto") {
        await setTranslateDefaultLanguage(transcriptionLanguageId);
      }
    },
    [isTranslateOn, queryClient, settings],
  );

  const handleTranslateToggle = useCallback(async () => {
    if (!settings || !isIdle) return;
    if (isTranslateOn) {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old
          ? {
              ...old,
              translateToEnglish: false,
              transcriptionLanguageId: "auto",
            }
          : old,
      );
      await setTranslateToEnglish(false);
      return;
    }

    const isModelAvail = (id: string) =>
      modelAvailability[id] ?? getWhisperModel(id)?.bundled ?? false;
    const readiness = getTranslateReadiness(
      settings.whisperModelId,
      settings.transcriptionLanguageId,
      settings.translateDefaultLanguageId,
      isModelAvail,
    );

    if (readiness.kind !== "ready") {
      onOpenSettings();
      return;
    }

    const sourceLanguageId =
      settings.transcriptionLanguageId === "auto"
        ? settings.translateDefaultLanguageId
        : settings.transcriptionLanguageId;

    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old
        ? {
            ...old,
            translateToEnglish: true,
            transcriptionLanguageId: sourceLanguageId,
          }
        : old,
    );
    const ok = await setTranslateToEnglish(true);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [
    settings,
    isIdle,
    isTranslateOn,
    modelAvailability,
    queryClient,
    onOpenSettings,
  ]);

  const isStreamMode = settings?.streamMode ?? false;
  const streamModeSupported = settings?.capabilities.supportsStreamMode ?? true;
  const streamModeLabel =
    settings?.streamTranscriptionMode === "live" ? "Live" : "VAD";

  const handleStreamToggle = useCallback(async () => {
    if (!settings || !streamModeSupported) return;
    const newValue = !isStreamMode;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, streamMode: newValue } : old,
    );
    const ok = await setStreamMode(newValue);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
      if (newValue) onOpenSettings();
    }
  }, [isStreamMode, onOpenSettings, queryClient, settings, streamModeSupported]);

  const formattingAvailable = settings?.formatting.available ?? false;
  const formattingSupported = settings?.capabilities.supportsFormatting ?? true;
  const isFormattingForced =
    (settings?.formatting.forceModeId ?? null) !== null;
  const isFormattingActive =
    (settings?.formatting.enabled ?? false) || isFormattingForced;

  const handleFormattingToggle = useCallback(async () => {
    if (!settings || !formattingAvailable) return;
    const nextEnabled = !settings.formatting.enabled;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old
        ? {
            ...old,
            formatting: {
              ...old.formatting,
              enabled: nextEnabled,
            },
          }
        : old,
    );
    const ok = await setFormattingEnabled(nextEnabled);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [settings, formattingAvailable, queryClient]);

  const micName = deviceInfo
    ? (deviceInfo.devices[String(deviceInfo.selectedDevice)] ?? "Default")
    : null;

  const displayKeys = useMemo(
    () =>
      shortcutDisplayKeys(
        settings?.shortcutId ?? "option-space",
        settings?.capabilities.platform ?? "macos",
      ),
    [settings?.capabilities.platform, settings?.shortcutId],
  );

  const holdDisplayKeys = useMemo(() => {
    const id = settings?.shortcutHoldOnlyId;
    return id
      ? shortcutDisplayKeys(id, settings?.capabilities.platform ?? "macos")
      : null;
  }, [settings?.capabilities.platform, settings?.shortcutHoldOnlyId]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-codictate-page text-white select-none overflow-hidden">
      <div className="electrobun-webkit-app-region-drag absolute top-0 left-0 right-0 h-7 hover:bg-white/10 transition-colors duration-200" />
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="mb-7 flex h-20 w-20 shrink-0 items-center justify-center"
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
          className={`text-[30px] ${wordmarkCodictateTypographyClass}`}
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
                  : isStreaming
                    ? "text-blue-400/85"
                    : "text-white/52"
            }`}
          >
            {isRecording
              ? "Listening…"
              : isTranscribing
                ? "Transcribing…"
                : isStreaming
                  ? "Streaming…"
                  : "Ready"}
          </motion.p>
        </AnimatePresence>
        <AnimatePresence>
          {showParakeetFirstRunHint && (
            <motion.p
              key="parakeet-coreml-hint"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
              className="text-[15px] mt-2 max-w-[min(22rem,calc(100vw-2rem))] text-center text-balance font-sans leading-snug text-white/46 px-2"
            >
              {PARAKEET_FIRST_RUN_READY_SUBTITLE}
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: isIdle ? 1 : 0.2, y: 0 }}
        transition={{ delay: 0.18, duration: 0.35 }}
        className="flex w-full max-w-full flex-col items-center gap-5"
      >
        {holdDisplayKeys ? (
          <div className="mx-auto grid w-full max-w-[min(1080px,calc(100%-1.5rem))] grid-cols-1 gap-7 md:grid-cols-2 md:items-start md:gap-x-0 md:gap-y-0">
            <div className="flex flex-col items-center gap-2 md:items-end md:pr-7">
              <div className="flex w-full max-w-full flex-col gap-2 items-center md:w-fit md:items-end">
                <span className="text-center text-[12px] font-semibold uppercase tracking-[0.12em] text-white/70 md:text-right">
                  Main shortcut
                </span>
                <div className="flex flex-nowrap items-center justify-center gap-1.5 md:justify-end">
                  {displayKeys.map((key, i) => (
                    <span
                      key={`main-${i}-${key}`}
                      className="flex items-center gap-1.5"
                    >
                      {i > 0 && (
                        <span className="text-white/42 text-[18px] font-light">
                          +
                        </span>
                      )}
                      <Kbd>{key}</Kbd>
                    </span>
                  ))}
                </div>
              </div>
              <DictationShortcutStartHint align="end" />
            </div>

            <div className="flex flex-col items-center gap-2 border-t border-white/10 pt-5 md:items-start md:border-t-0 md:border-l md:border-white/12 md:pl-7 md:pt-0">
              <span className="text-center text-[12px] font-semibold uppercase tracking-[0.12em] text-white/70 md:text-left">
                Push-to-talk
              </span>
              <div className="flex flex-nowrap items-center justify-center gap-1.5 md:justify-start">
                {holdDisplayKeys.map((key, i) => (
                  <span
                    key={`hold-${i}-${key}`}
                    className="flex items-center gap-1.5"
                  >
                    {i > 0 && (
                      <span className="text-white/42 text-[18px] font-light">
                        +
                      </span>
                    )}
                    <Kbd>{key}</Kbd>
                  </span>
                ))}
              </div>
              <DictationPttHoldHint />
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[min(440px,calc(100%-1.5rem))] flex-col items-center gap-6">
            <div className="flex items-center gap-1.5">
              {displayKeys.map((key, i) => (
                <span
                  key={`main-${i}-${key}`}
                  className="flex items-center gap-1.5"
                >
                  {i > 0 && (
                    <span className="text-white/42 text-[18px] font-light">
                      +
                    </span>
                  )}
                  <Kbd>{key}</Kbd>
                </span>
              ))}
            </div>
            <DictationShortcutStartHint align="center" />
          </div>
        )}

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
              excludeAuto={isTranslateOn}
              speechModelId={settings?.whisperModelId}
              className={!isIdle ? "pointer-events-none" : undefined}
            />
          </div>
          {!transcriptionLanguageLocked && (
            <TranscriptionLanguageHintButton
              className={!isIdle ? "pointer-events-none opacity-60" : ""}
            />
          )}
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
          {settings !== undefined && (
            <InstantTooltip
              text={
                !streamModeSupported
                  ? `Stream mode is coming soon on ${platformDisplayName(settings.capabilities.platform)}`
                  : isStreamMode
                    ? "Stream mode active — press shortcut to start, again to stop"
                    : `Stream mode — continuous hands-free dictation (${streamModeLabel})`
              }
              side="top"
              floatInViewport
            >
              <button
                onClick={handleStreamToggle}
                disabled={isRecording || isTranscribing || !streamModeSupported}
                className={`inline-flex aspect-square w-10 shrink-0 self-stretch items-center justify-center rounded-lg border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-[border-color,background-color,box-shadow] duration-200 disabled:opacity-50 disabled:pointer-events-none cursor-pointer ${
                  isStreamMode && streamModeSupported
                    ? "border-blue-400/30 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400/80"
                    : "border-white/12 bg-white/5 hover:border-white/18 hover:bg-white/7 text-white/48 hover:text-white/70"
                }`}
                aria-label={
                  !streamModeSupported
                    ? `Stream mode coming soon on ${platformDisplayName(settings.capabilities.platform)}`
                    : isStreamMode
                      ? "Stream mode active - click to disable"
                      : `Stream mode - continuous hands-free dictation (${streamModeLabel})`
                }
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
                >
                  <path d="M2 10v3" />
                  <path d="M6 6v11" />
                  <path d="M10 3v18" />
                  <path d="M14 8v7" />
                  <path d="M18 5v13" />
                  <path d="M22 10v3" />
                </svg>
              </button>
            </InstantTooltip>
          )}
          {settings !== undefined && (formattingAvailable || !formattingSupported) && (
            <InstantTooltip
              text={
                !formattingSupported
                  ? `Formatting is coming soon on ${platformDisplayName(settings.capabilities.platform)}`
                  : isFormattingForced
                    ? `Force formatting: ${settings?.formatting.forceModeId} — clear from tray to disable`
                    : isFormattingActive
                      ? "Formatting on — click to disable"
                      : "Format output — reshape transcription with Apple Intelligence"
              }
              side="top"
              floatInViewport
            >
              <button
                onClick={handleFormattingToggle}
                disabled={isRecording || isTranscribing || isStreaming || !formattingSupported}
                className={`inline-flex aspect-square w-10 shrink-0 self-stretch items-center justify-center rounded-lg border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-[border-color,background-color,box-shadow] duration-200 disabled:opacity-50 disabled:pointer-events-none cursor-pointer ${
                  isFormattingActive && formattingSupported
                    ? "border-purple-400/30 bg-purple-500/15 hover:bg-purple-500/25 text-purple-400/80"
                    : "border-white/12 bg-white/5 hover:border-white/18 hover:bg-white/7 text-white/48 hover:text-white/70"
                }`}
                aria-label={
                  !formattingSupported
                    ? `Formatting coming soon on ${platformDisplayName(settings.capabilities.platform)}`
                    : isFormattingActive
                      ? "Formatting on — click to disable"
                      : "Format output with Apple Intelligence"
                }
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
                >
                  <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                  <path d="m15 5 4 4" />
                </svg>
              </button>
            </InstantTooltip>
          )}
          {settings !== undefined &&
            (() => {
              const r = translateReadiness?.kind;
              const tooltipText = isTranslateOn
                ? "Translate mode active - click to disable"
                : r === "need_download"
                  ? "Download Small or Large in Settings - Turbo cannot translate"
                  : r === "need_switch_model"
                    ? "Switch transcription model to Small or Large in Settings"
                    : r === "need_language"
                      ? "Select a source language (or set a default in Settings) to enable translate mode"
                      : "Translate mode - transcribe and translate to English";

              const isDimmed =
                !isTranslateOn &&
                (translateReadiness == null ||
                  translateReadiness.kind !== "ready");

              return (
                <InstantTooltip text={tooltipText} side="top" floatInViewport>
                  <button
                    onClick={handleTranslateToggle}
                    disabled={!isIdle}
                    className={`inline-flex aspect-square w-10 shrink-0 self-stretch items-center justify-center rounded-lg border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-[border-color,background-color,box-shadow] duration-200 disabled:opacity-50 disabled:pointer-events-none cursor-pointer ${
                      isTranslateOn
                        ? "border-blue-400/30 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400/80"
                        : isDimmed
                          ? "border-white/8 bg-white/3 text-white/20 hover:border-white/14 hover:text-white/30"
                          : "border-white/12 bg-white/5 hover:border-white/18 hover:bg-white/7 text-white/48 hover:text-white/70"
                    }`}
                    aria-label={tooltipText}
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
                    >
                      <path d="m5 8 6 6" />
                      <path d="m4 14 6-6 2-3" />
                      <path d="M2 5h12" />
                      <path d="M7 2h1" />
                      <path d="m22 22-5-10-5 10" />
                      <path d="M14 18h6" />
                    </svg>
                  </button>
                </InstantTooltip>
              );
            })()}
          <InstantTooltip text="Dictionary" side="top" floatInViewport>
            <button
              onClick={() => onOpenSettings("dictionary")}
              className="inline-flex aspect-square w-10 shrink-0 self-stretch items-center justify-center rounded-lg border border-white/12 bg-white/5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:border-white/18 hover:bg-white/7 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12 focus-visible:ring-offset-0 transition-[border-color,background-color,box-shadow] duration-200 cursor-pointer text-white/48 hover:text-white/70"
              aria-label="Open dictionary"
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
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </button>
          </InstantTooltip>
          <InstantTooltip text="Settings" side="top" floatInViewport>
            <button
              onClick={() => onOpenSettings()}
              className="inline-flex aspect-square w-10 shrink-0 self-stretch items-center justify-center rounded-lg border border-white/12 bg-white/5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:border-white/18 hover:bg-white/7 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12 focus-visible:ring-offset-0 transition-[border-color,background-color,box-shadow] duration-200 cursor-pointer text-white/48 hover:text-white/70"
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
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </InstantTooltip>
        </motion.div>
      </motion.div>
    </div>
  );
}
