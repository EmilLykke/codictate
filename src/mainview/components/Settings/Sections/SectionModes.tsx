import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import type {
  AppSettings,
  StreamTranscriptionMode,
} from "../../../../shared/types";
import {
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
  formatModelSize,
  getWhisperModel,
  parakeetSupportsTranscriptionLanguageId,
} from "../../../../shared/whisper-models";
import {
  PARAKEET_FIRST_RUN_STREAM_HELPER,
  coerceTranscriptionLanguageIdForModel,
} from "../../../../shared/speech-models";
import {
  fetchSettings,
  setStreamMode,
  setStreamTranscriptionMode,
  setTranslateDefaultLanguage,
  setTranscriptionLanguage,
  setWhisperModel,
  downloadWhisperModel,
} from "../../../rpc";
import { LanguagePicker } from "../LanguagePicker";
import { settingsHelperClass } from "../settings-shared";
import { platformDisplayName } from "../../../../shared/platform";

/** Select value when translate default is still `auto` on disk — not a real language id. */
const TRANSLATE_DEFAULT_PLACEHOLDER = "__translate_pick__";

type Props = {
  settings: AppSettings;
  modelAvailability: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  translateDownloadModelId: string | null;
  onTranslateToggle: () => Promise<void> | void;
  onCancelDownload: (modelId: string) => void;
};

export function SectionModes({
  settings,
  modelAvailability,
  downloadProgress,
  translateDownloadModelId,
  onTranslateToggle,
  onCancelDownload,
}: Props) {
  const queryClient = useQueryClient();
  const [showSwitchToParakeet, setShowSwitchToParakeet] = useState(false);

  const isParakeetInstalled =
    modelAvailability[DEFAULT_STREAM_CAPABLE_MODEL_ID] ?? false;
  const isParakeetSelected =
    settings.whisperModelId === DEFAULT_STREAM_CAPABLE_MODEL_ID;
  const streamModeComingSoon = !settings.capabilities.supportsStreamMode;
  const parakeetWarmingUp =
    isParakeetInstalled && isParakeetSelected && !settings.parakeetCoreMlReady;

  const handleTranslateDefaultLanguageChange = useCallback(
    async (languageId: string) => {
      if (
        languageId === TRANSLATE_DEFAULT_PLACEHOLDER ||
        languageId === "auto"
      ) {
        return;
      }
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, translateDefaultLanguageId: languageId } : old,
      );
      await setTranslateDefaultLanguage(languageId);
    },
    [queryClient],
  );

  const handleStreamModeToggle = useCallback(async () => {
    if (streamModeComingSoon) return;
    if (settings.streamMode) {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, streamMode: false } : old,
      );
      const ok = await setStreamMode(false);
      if (!ok) {
        queryClient.setQueryData(["settings"], await fetchSettings());
      }
      return;
    }
    if (!isParakeetInstalled) {
      return;
    }
    if (parakeetWarmingUp) {
      return;
    }
    if (!isParakeetSelected) {
      setShowSwitchToParakeet(true);
      return;
    }
    setShowSwitchToParakeet(false);
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, streamMode: true } : old,
    );
    const ok = await setStreamMode(true);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [
    settings.streamMode,
    streamModeComingSoon,
    isParakeetInstalled,
    isParakeetSelected,
    parakeetWarmingUp,
    queryClient,
  ]);

  const handleSwitchToParakeetAndEnableStream = useCallback(async () => {
    setShowSwitchToParakeet(false);
    const nextLang = coerceTranscriptionLanguageIdForModel(
      DEFAULT_STREAM_CAPABLE_MODEL_ID,
      settings.transcriptionLanguageId,
    );
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old
        ? {
            ...old,
            whisperModelId: DEFAULT_STREAM_CAPABLE_MODEL_ID,
            transcriptionLanguageId: nextLang,
          }
        : old,
    );
    await setWhisperModel(DEFAULT_STREAM_CAPABLE_MODEL_ID);
    if (nextLang !== settings.transcriptionLanguageId) {
      await setTranscriptionLanguage(nextLang);
    }
    const fresh = await fetchSettings();
    if (!fresh.parakeetCoreMlReady) {
      queryClient.setQueryData(["settings"], fresh);
      return;
    }
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, streamMode: true } : old,
    );
    const ok = await setStreamMode(true);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [queryClient, settings.transcriptionLanguageId]);

  const handleStreamTranscriptionModeChange = useCallback(
    async (mode: StreamTranscriptionMode) => {
      if (streamModeComingSoon) return;
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old ? { ...old, streamTranscriptionMode: mode } : old,
      );
      await setStreamTranscriptionMode(mode);
    },
    [queryClient, streamModeComingSoon],
  );

  return (
    <>
      <div className="mb-8">
        <h2 className="text-[18px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Translate to English
        </h2>
        <div className="rounded-xl border border-white/11 bg-white/4 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div className="flex-1 min-w-0">
              <span
                className={`block text-[21px] font-medium ${settings.translateToEnglish ? "text-white/78" : "text-white/58"}`}
              >
                {settings.translateToEnglish
                  ? "Translation active"
                  : "Translate to English"}
              </span>
            </div>
            <button
              onClick={() => void onTranslateToggle()}
              disabled={translateDownloadModelId !== null}
              className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                settings.translateToEnglish
                  ? "bg-blue-500/30 border-blue-400/30"
                  : "bg-white/7 border-white/14"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
              aria-label="Toggle translate to English"
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full transition-all duration-200 ${
                  settings.translateToEnglish
                    ? "left-4 bg-blue-400/90"
                    : "left-0.5 bg-white/40"
                }`}
              />
            </button>
          </div>

          <AnimatePresence>
            {translateDownloadModelId !== null && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="border-t border-white/10 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <p className="text-[18px] text-white/55 font-sans leading-relaxed">
                      Downloading the{" "}
                      {getWhisperModel(translateDownloadModelId)?.label ??
                        translateDownloadModelId}{" "}
                      model (
                      {formatModelSize(
                        getWhisperModel(translateDownloadModelId)?.sizeMB ?? 0,
                      )}
                      )…
                    </p>
                    <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-blue-400/60"
                        animate={{
                          width: `${Math.round((downloadProgress[translateDownloadModelId] ?? 0) * 100)}%`,
                        }}
                        transition={{ duration: 0.2 }}
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => onCancelDownload(translateDownloadModelId)}
                    className="shrink-0 px-2.5 py-1 rounded-lg text-[17px] font-medium border border-white/12 hover:border-white/22 bg-white/4 hover:bg-white/8 text-white/44 hover:text-white/64 transition-colors duration-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-3">
          <p className="text-[17px] text-white/44 font-sans mb-2">
            Default source language
          </p>
          <LanguagePicker
            value={
              settings.translateDefaultLanguageId === "auto"
                ? TRANSLATE_DEFAULT_PLACEHOLDER
                : settings.translateDefaultLanguageId
            }
            onChange={handleTranslateDefaultLanguageChange}
            leadingDisabledOption={{
              value: TRANSLATE_DEFAULT_PLACEHOLDER,
              label: "Choose source language (required for translate mode)…",
            }}
            excludeAuto
            ariaLabel="Default source language for translation"
          />
        </div>

        <p className={settingsHelperClass}>
          Translate mode requires a fixed source language and a Small or Large
          Whisper model (not Turbo). Download models under <b>Transcription</b>.
        </p>
      </div>

      <div className="mb-8">
        <h2 className="text-[18px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Stream mode
        </h2>
        <div className="rounded-xl border border-white/11 bg-white/4 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div className="flex-1 min-w-0">
              <span
                className={`block text-[21px] font-medium ${settings.streamMode ? "text-white/78" : "text-white/58"}`}
              >
                {settings.streamMode ? "Stream mode active" : "Stream mode"}
              </span>
              {streamModeComingSoon && (
                <span className="mt-1.5 inline-flex rounded-full border border-amber-400/28 bg-amber-500/10 px-2 py-0.5 text-[13px] font-medium uppercase tracking-wide text-amber-100/75">
                  Coming soon on{" "}
                  {platformDisplayName(settings.capabilities.platform)}
                </span>
              )}
            </div>
            {!streamModeComingSoon && (
              <button
                onClick={handleStreamModeToggle}
                className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                  settings.streamMode
                    ? "bg-blue-500/30 border-blue-400/30"
                    : "bg-white/7 border-white/14"
                } ${!settings.streamMode && !isParakeetInstalled ? "disabled:opacity-40 disabled:cursor-not-allowed" : ""}`}
                disabled={
                  !settings.streamMode &&
                  (!isParakeetInstalled || parakeetWarmingUp)
                }
                aria-label="Toggle stream mode"
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full transition-all duration-200 ${
                    settings.streamMode
                      ? "left-4 bg-blue-400/90"
                      : "left-0.5 bg-white/40"
                  }`}
                />
              </button>
            )}
          </div>
        </div>
        <p className={settingsHelperClass}>
          {streamModeComingSoon
            ? "Hands-free stream dictation is planned for Windows after the one-shot dictation path lands."
            : "Press shortcut to start streaming, again (or Esc) to stop. Requires Parakeet model."}{" "}
          {!streamModeComingSoon && (
            <span className="text-amber-200/55">
              {PARAKEET_FIRST_RUN_STREAM_HELPER}
            </span>
          )}
        </p>
        {!streamModeComingSoon && parakeetWarmingUp && (
          <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/8 px-4 py-3">
            <div className="flex items-center gap-2">
              <svg
                className="animate-spin h-4 w-4 shrink-0 text-amber-400/70"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <p className="text-[17px] text-white/70 leading-snug">
                Preparing Parakeet for your Mac — this takes 1-2 minutes on
                first use. Stream mode will be available once preparation
                completes.
              </p>
            </div>
          </div>
        )}
        {!streamModeComingSoon &&
          !modelAvailability[DEFAULT_STREAM_CAPABLE_MODEL_ID] && (
            <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-500/8 px-4 py-3">
              <p className="text-[17px] text-white/70 leading-snug">
                Install{" "}
                <strong className="text-white/85 font-medium">
                  Parakeet TDT v3
                </strong>{" "}
                to use stream mode. After install, the first transcription or
                stream may take several minutes while Core ML prepares on your
                Mac.
              </p>
              <button
                type="button"
                onClick={() =>
                  downloadWhisperModel(DEFAULT_STREAM_CAPABLE_MODEL_ID)
                }
                className="mt-3 px-3 py-2 rounded-lg text-[17px] font-medium border border-amber-400/35 bg-amber-500/15 hover:bg-amber-500/25 text-amber-100/90 transition-colors cursor-pointer"
              >
                Download Parakeet
              </button>
            </div>
          )}
        <AnimatePresence>
          {showSwitchToParakeet && (
            <motion.div
              key="switch-parakeet-prompt"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/8 px-4 py-3">
                <p className="text-[17px] text-white/70 leading-snug">
                  Stream mode requires{" "}
                  <strong className="text-white/85 font-medium">
                    Parakeet TDT v3
                  </strong>{" "}
                  as your transcription model.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSwitchToParakeetAndEnableStream()}
                    className="px-3 py-2 rounded-lg text-[17px] font-medium border border-amber-400/35 bg-amber-500/15 hover:bg-amber-500/25 text-amber-100/90 transition-colors cursor-pointer"
                  >
                    Switch to Parakeet
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSwitchToParakeet(false)}
                    className="px-3 py-2 rounded-lg text-[17px] font-medium border border-white/12 hover:border-white/22 bg-white/4 hover:bg-white/8 text-white/44 hover:text-white/64 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {!streamModeComingSoon &&
          settings.streamMode &&
          !parakeetSupportsTranscriptionLanguageId(
            settings.transcriptionLanguageId,
          ) && (
            <p className={`${settingsHelperClass} text-amber-200/55`}>
              Parakeet supports auto-detect or 25 European languages. Change
              transcription language for stream mode.
            </p>
          )}
        <div
          className={`mt-4 rounded-xl border border-white/11 bg-black/10 p-2 ${streamModeComingSoon ? "opacity-55" : ""}`}
        >
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                {
                  id: "vad",
                  title: "VAD / Stable",
                  body: "Waits for a pause, then pastes completed sentences.",
                },
                {
                  id: "live",
                  title: "Live",
                  body: "Pastes words as you speak them",
                },
              ] as const
            ).map((mode) => {
              const active = settings.streamTranscriptionMode === mode.id;
              return (
                <button
                  key={mode.id}
                  disabled={streamModeComingSoon}
                  onClick={() =>
                    void handleStreamTranscriptionModeChange(mode.id)
                  }
                  className={`rounded-xl border px-3 py-3 text-left transition-colors duration-200 ${
                    active
                      ? "border-blue-400/30 bg-blue-500/15 text-white/88"
                      : "border-white/10 bg-white/4 text-white/62 hover:border-white/18 hover:bg-white/7"
                  }`}
                >
                  <span className="block text-[18px] font-medium">
                    {mode.title}
                  </span>
                  <span className="mt-1 block text-[15px] leading-snug text-white/48">
                    {mode.body}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
