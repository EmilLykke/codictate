import { useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import type {
  AppStatus,
  AppSettings,
  DeviceInfo,
  StreamTranscriptionMode,
} from "../../../shared/types";
import { DropdownSelect } from "../Common/DropdownSelect";
import {
  dictationShortcutSummaryHoldBody,
  dictationShortcutSummaryTapBody,
  shortcutDisplayKeys,
} from "../../../shared/shortcut-options";
import { Kbd } from "../Common/Kbd";
import {
  SPEECH_MODELS,
  getSpeechModel,
  supportsStreamMode,
  DEFAULT_STREAM_CAPABLE_MODEL_ID,
} from "../../../shared/speech-models";
import {
  getWhisperModel,
  formatModelSize,
  isTranslateCapableModelId,
} from "../../../shared/whisper-models";
import { LanguagePicker } from "../Settings/LanguagePicker";
import { InstantTooltip } from "../Common/InstantTooltip";
import { HomeHistoryTimeline } from "./HomeHistoryTimeline";

function ShortcutHelpIcon({ tooltip }: { tooltip: React.ReactNode }) {
  return (
    <InstantTooltip
      text={tooltip}
      side="bottom"
      tooltipClassName="max-w-[20rem]"
    >
      <button
        type="button"
        className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[5px] border border-white/15 bg-white/5 text-white/40 hover:text-white/70 hover:border-white/25 transition-colors cursor-help"
        aria-label="Shortcut help"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" strokeWidth="2" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
      </button>
    </InstantTooltip>
  );
}

const TOGGLE_BASE =
  "inline-flex aspect-square w-10 shrink-0 items-center justify-center rounded-lg border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-[border-color,background-color,box-shadow] duration-200 cursor-pointer";
const TOGGLE_ON_BLUE =
  "border-blue-400/30 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400/80";
const TOGGLE_ON_PURPLE =
  "border-purple-400/30 bg-purple-500/15 hover:bg-purple-500/25 text-purple-400/80";
const TOGGLE_OFF =
  "border-white/12 bg-white/5 hover:border-white/18 hover:bg-white/7 text-white/48 hover:text-white/70";
const TOGGLE_DIMMED =
  "border-white/8 bg-white/3 text-white/20 hover:border-white/14 hover:text-white/30";

const TRANSLATE_DEFAULT_PLACEHOLDER = "__translate_pick__";

export function HomeScreen({
  status,
  deviceInfo,
  settings,
  modelAvailability,
  downloadProgress,
  translateDownloadModelId,
  onModelChange,
  onLanguageChange,
  onDeviceChange,
  onStreamToggle,
  onStreamTranscriptionModeChange,
  onFormattingToggle,
  onTranslateToggle,
  onTranslateDefaultLanguageChange,
  onCancelDownload,
  onOpenSettings,
}: {
  status: AppStatus;
  deviceInfo?: DeviceInfo;
  settings?: AppSettings;
  modelAvailability: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  translateDownloadModelId: string | null;
  onModelChange: (modelId: string) => void;
  onLanguageChange: (languageId: string) => void;
  onDeviceChange: (index: number) => void;
  onStreamToggle: () => void;
  onStreamTranscriptionModeChange: (mode: StreamTranscriptionMode) => void;
  onFormattingToggle: () => void;
  onTranslateToggle: () => void;
  onTranslateDefaultLanguageChange: (languageId: string) => void;
  onCancelDownload: (modelId: string) => void;
  onOpenSettings: () => void;
}) {
  const isRecording = status === "recording";
  const isTranscribing = status === "transcribing";
  const isStreaming = status === "streaming";
  const isIdle = status === "ready";

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

  const currentModel = settings?.whisperModelId
    ? getSpeechModel(settings.whisperModelId)
    : null;
  const canStream = currentModel ? supportsStreamMode(currentModel) : false;

  const availableModels = SPEECH_MODELS.filter(
    (m) => modelAvailability[m.id] || m.bundled,
  );

  const currentLanguageId = settings?.transcriptionLanguageId ?? "auto";

  const isStreamMode = settings?.streamMode ?? false;
  const streamModeSupported = settings?.capabilities.supportsStreamMode ?? true;
  const streamModeLabel =
    settings?.streamTranscriptionMode === "live" ? "Live" : "VAD";

  const formattingSupported =
    settings?.capabilities?.supportsFormatting ?? false;
  const formattingModelInstalled =
    settings?.formatting?.modelAvailability?.[
      settings.formatting.formatterModelTier
    ] ?? false;
  const formattingAvailable = formattingSupported && formattingModelInstalled;
  const isFormattingActive =
    (settings?.formatting?.enabled ?? false) && formattingAvailable;

  const isTranslateOn = settings?.translateToEnglish ?? false;
  const parakeetInstalled =
    modelAvailability[DEFAULT_STREAM_CAPABLE_MODEL_ID] ?? false;

  const canTranslate =
    isTranslateOn || isTranslateCapableModelId(settings?.whisperModelId ?? "");

  const historyEnabled = settings?.history?.enabled ?? false;

  const overviewCard = (
    <div className="rounded-2xl bg-white/5 border border-white/10 p-7">
      <div className="flex items-center justify-between mb-5">
        <div className="grid grid-cols-3 gap-y-5 gap-x-8">
          <div>
            <div className="text-[16px] text-white/40 mb-2">Model</div>
            <DropdownSelect
              value={settings?.whisperModelId ?? ""}
              onChange={onModelChange}
              ariaLabel="Speech model"
              align="start"
              options={availableModels.map((m) => ({
                value: m.id,
                label: m.label,
              }))}
            />
          </div>
          <div>
            <div className="text-[16px] text-white/40 mb-2">Language</div>
            <LanguagePicker
              value={currentLanguageId}
              onChange={onLanguageChange}
              speechModelId={settings?.whisperModelId ?? null}
            />
          </div>
          <div>
            <div className="text-[16px] text-white/40 mb-2">Microphone</div>
            <DropdownSelect
              value={String(deviceInfo?.selectedDevice ?? 0)}
              onChange={(v) => onDeviceChange(Number(v))}
              ariaLabel="Microphone"
              placeholder="No microphones found"
              options={
                deviceInfo && Object.keys(deviceInfo.devices).length > 0
                  ? Object.entries(deviceInfo.devices).map(([idx, name]) => ({
                      value: idx,
                      label: name,
                    }))
                  : []
              }
            />
          </div>
        </div>
      </div>

      {/* Quick-action toggles */}
      <div className="flex items-center gap-1.5">
        {settings !== undefined && (
          <InstantTooltip
            text={
              !streamModeSupported
                ? "Stream mode coming soon on this platform"
                : !canStream
                  ? parakeetInstalled
                    ? "Select the Parakeet model to enable stream mode"
                    : "Download a stream-capable model (Parakeet) to enable"
                  : isStreamMode
                    ? "Stream mode active"
                    : `Stream mode: continuous dictation (${streamModeLabel})`
            }
            side="bottom"
            floatInViewport
          >
            <button
              onClick={onStreamToggle}
              disabled={
                isRecording ||
                isTranscribing ||
                !streamModeSupported ||
                !canStream
              }
              className={`${TOGGLE_BASE} disabled:opacity-50 disabled:pointer-events-none ${
                isStreamMode && streamModeSupported && canStream
                  ? TOGGLE_ON_BLUE
                  : !streamModeSupported || !canStream
                    ? TOGGLE_DIMMED
                    : TOGGLE_OFF
              }`}
              aria-label="Toggle stream mode"
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
        {settings !== undefined && formattingSupported && (
          <InstantTooltip
            text={
              isFormattingActive
                ? "Auto-polish active"
                : !formattingModelInstalled
                  ? "Download a formatter model in Settings to enable"
                  : "Auto-polish: cleans up dictated text for the app you're in"
            }
            side="bottom"
            floatInViewport
          >
            <button
              onClick={onFormattingToggle}
              disabled={
                isRecording ||
                isTranscribing ||
                isStreaming ||
                !formattingAvailable
              }
              className={`${TOGGLE_BASE} disabled:opacity-50 disabled:pointer-events-none ${
                isFormattingActive
                  ? TOGGLE_ON_PURPLE
                  : !formattingAvailable
                    ? TOGGLE_DIMMED
                    : TOGGLE_OFF
              }`}
              aria-label="Toggle auto-polish"
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
        {settings !== undefined && (
          <InstantTooltip
            text={
              isTranslateOn
                ? "Translate mode active"
                : !canTranslate
                  ? "Select a translate-capable model (Small or Large Whisper) to enable"
                  : "Translate mode: transcribe and translate to English"
            }
            side="bottom"
            floatInViewport
          >
            <button
              onClick={onTranslateToggle}
              disabled={!isIdle || !canTranslate}
              className={`${TOGGLE_BASE} disabled:opacity-50 disabled:pointer-events-none ${
                isTranslateOn
                  ? TOGGLE_ON_BLUE
                  : !canTranslate
                    ? TOGGLE_DIMMED
                    : TOGGLE_OFF
              }`}
              aria-label="Toggle translate mode"
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
        )}

        {(isStreamMode || isTranslateOn) && (
          <div className="ml-auto flex items-center gap-3">
            {isStreamMode && (
              <div className="flex items-center gap-1.5">
                {(
                  [
                    {
                      id: "vad",
                      label: "VAD",
                      tip: "Transcribes in pauses",
                    },
                    {
                      id: "live",
                      label: "Live",
                      tip: "Streams continuously",
                    },
                  ] as const
                ).map((mode) => {
                  const active = settings?.streamTranscriptionMode === mode.id;
                  return (
                    <InstantTooltip key={mode.id} text={mode.tip} side="bottom">
                      <button
                        onClick={() => onStreamTranscriptionModeChange(mode.id)}
                        className={`rounded-lg border px-3 py-1.5 text-[14px] font-medium transition-colors duration-200 cursor-pointer ${
                          active
                            ? "border-blue-400/30 bg-blue-500/15 text-blue-300/90"
                            : "border-white/12 bg-transparent text-white/40 hover:border-white/20 hover:text-white/60"
                        }`}
                      >
                        {mode.label}
                      </button>
                    </InstantTooltip>
                  );
                })}
              </div>
            )}
            {isTranslateOn && (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-white/38 shrink-0">
                  Source
                </span>
                <LanguagePicker
                  value={
                    settings?.translateDefaultLanguageId === "auto"
                      ? TRANSLATE_DEFAULT_PLACEHOLDER
                      : (settings?.translateDefaultLanguageId ??
                        TRANSLATE_DEFAULT_PLACEHOLDER)
                  }
                  onChange={onTranslateDefaultLanguageChange}
                  leadingDisabledOption={{
                    value: TRANSLATE_DEFAULT_PLACEHOLDER,
                    label: "Choose source language...",
                  }}
                  excludeAuto
                  ariaLabel="Default source language for translation"
                />
              </div>
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {translateDownloadModelId !== null && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1">
                <p className="text-[13px] text-white/50 leading-relaxed">
                  Downloading{" "}
                  {getWhisperModel(translateDownloadModelId)?.label ??
                    translateDownloadModelId}{" "}
                  (
                  {formatModelSize(
                    getWhisperModel(translateDownloadModelId)?.sizeMB ?? 0,
                  )}
                  )
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
                className="shrink-0 px-2.5 py-1 rounded-lg text-[13px] font-medium border border-white/12 hover:border-white/22 bg-white/4 hover:bg-white/8 text-white/44 hover:text-white/64 transition-colors duration-200 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  const statsCard = (
    <div className="rounded-2xl bg-white/5 border border-white/10 p-7 flex flex-col items-center justify-center gap-2">
      <span className="text-[15px] font-medium text-white/40">
        Statistics coming soon
      </span>
      <span className="text-[13px] text-white/25">
        Word count, speed, streaks and more
      </span>
    </div>
  );

  const shortcutsBlock = (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.18, duration: 0.35 }}
      className="flex flex-wrap items-start gap-6 @container"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <span className="text-[14px] font-semibold uppercase tracking-[0.12em] text-white/70 whitespace-nowrap">
            Main shortcut
          </span>
          <ShortcutHelpIcon
            tooltip={
              <span className="text-[15px] leading-snug">
                <span className="font-bold text-white/80">Hold</span>
                {" - "}
                {dictationShortcutSummaryHoldBody}
                <br />
                <br />
                <span className="font-bold text-white/80">Tap</span>
                {" - "}
                {dictationShortcutSummaryTapBody}
              </span>
            }
          />
        </div>
        <div className="flex items-center gap-1.5">
          {displayKeys.map((key, i) => (
            <span
              key={`main-${i}-${key}`}
              className="flex items-center gap-1.5"
            >
              {i > 0 && (
                <span className="text-white/30 text-[18px] font-light">+</span>
              )}
              <Kbd>{key}</Kbd>
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="self-start text-[13px] text-white/35 hover:text-white/60 transition-colors cursor-pointer"
        >
          Edit →
        </button>
      </div>

      {holdDisplayKeys && (
        <>
          <div className="flex flex-col gap-3 @sm:border-l @xs:border-white/12 @sm:pl-6">
            <span className="text-[14px] font-semibold uppercase tracking-[0.12em] text-white/70 whitespace-nowrap">
              Push-to-talk
            </span>
            <div className="flex items-center gap-1.5">
              {holdDisplayKeys.map((key, i) => (
                <span
                  key={`hold-${i}-${key}`}
                  className="flex items-center gap-1.5"
                >
                  {i > 0 && (
                    <span className="text-white/30 text-[18px] font-light">
                      +
                    </span>
                  )}
                  <Kbd>{key}</Kbd>
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </motion.div>
  );

  if (historyEnabled) {
    return (
      <div className="flex flex-col h-full">
        <div className="mb-10">
          <h2 className="text-[28px] font-semibold text-white/90">
            Welcome back!
          </h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div className="lg:col-span-2">{overviewCard}</div>
          {statsCard}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-0 flex-1">
          <div className="lg:col-span-2 min-h-0 overflow-y-auto scrollbar-hidden">
            <HomeHistoryTimeline />
          </div>
          <div className="hidden lg:flex flex-col gap-6">{shortcutsBlock}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="mb-10">
        <h2 className="text-[28px] font-semibold text-white/90">
          Welcome back!
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-10">
        <div className="lg:col-span-2">{overviewCard}</div>
        {statsCard}
      </div>

      {shortcutsBlock}
    </div>
  );
}
