import { useMemo } from "react";
import { motion } from "motion/react";
import type { AppStatus, AppSettings, DeviceInfo } from "../../../shared/types";
import {
  dictationReadyPttHintAfter,
  dictationReadyPttHintBefore,
  dictationShortcutSummaryHoldBody,
  dictationShortcutSummaryHoldTitle,
  shortcutDisplayKeys,
} from "../../../shared/shortcut-options";
import { Kbd } from "../Common/Kbd";
import {
  DictationShortcutStartHint,
  UnderlinedDictationTerm,
} from "../Common/DictationShortcutStartHint";
import {
  SPEECH_MODELS,
  getSpeechModel,
  supportsStreamMode,
} from "../../../shared/speech-models";
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from "../../../shared/transcription-languages";
import { InstantTooltip } from "../Common/InstantTooltip";

function DictationPttHoldHint({ className = "" }: { className?: string }) {
  return (
    <p
      className={`mt-3 max-w-[min(100%,15.5rem)] text-[15px] leading-snug text-white/50 font-sans text-balance text-left ${className}`}
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

export function HomeScreen({
  status,
  deviceInfo,
  settings,
  modelAvailability,
  onModelChange,
  onLanguageChange,
  onDeviceChange,
  onStreamToggle,
  onFormattingToggle,
  onTranslateToggle,
}: {
  status: AppStatus;
  deviceInfo?: DeviceInfo;
  settings?: AppSettings;
  modelAvailability: Record<string, boolean>;
  onModelChange: (modelId: string) => void;
  onLanguageChange: (languageId: string) => void;
  onDeviceChange: (index: number) => void;
  onStreamToggle: () => void;
  onFormattingToggle: () => void;
  onTranslateToggle: () => void;
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
    settings?.formatting?.modelInstalled ?? false;
  const formattingAvailable = formattingSupported && formattingModelInstalled;
  const isFormattingActive =
    (settings?.formatting?.enabled ?? false) && formattingAvailable;

  const isTranslateOn = settings?.translateToEnglish ?? false;

  return (
    <div className="flex flex-col h-full">
      <div className="mb-10">
        <h2 className="text-[34px] font-semibold text-white/90">
          Welcome back!
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-10">
        {/* Overview */}
        <div className="lg:col-span-2 rounded-2xl bg-white/5 border border-white/10 p-7">
          <div className="flex items-center justify-between mb-5">
            <div className="grid grid-cols-3 gap-y-5 gap-x-8">
              <div>
                <div className="text-[16px] text-white/40 mb-2">Model</div>
                <select
                  value={settings?.whisperModelId ?? ""}
                  onChange={(e) => onModelChange(e.target.value)}
                  className="home-select w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[19px] text-white/90 font-medium appearance-none cursor-pointer outline-none focus:border-white/20 transition-colors"
                >
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-[16px] text-white/40 mb-2">Language</div>
                <select
                  value={currentLanguageId}
                  onChange={(e) => onLanguageChange(e.target.value)}
                  className="home-select w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[19px] text-white/90 font-medium appearance-none cursor-pointer outline-none focus:border-white/20 transition-colors"
                >
                  {TRANSCRIPTION_LANGUAGE_OPTIONS.map((lang) => (
                    <option key={lang.id} value={lang.id}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-[16px] text-white/40 mb-2">Microphone</div>
                <select
                  value={deviceInfo?.selectedDevice ?? 0}
                  onChange={(e) => onDeviceChange(Number(e.target.value))}
                  className="home-select w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[19px] text-white/90 font-medium appearance-none cursor-pointer outline-none focus:border-white/20 transition-colors"
                >
                  {deviceInfo && Object.keys(deviceInfo.devices).length > 0 ? (
                    Object.entries(deviceInfo.devices).map(([idx, name]) => (
                      <option key={idx} value={idx}>
                        {name}
                      </option>
                    ))
                  ) : (
                    <option value={0}>No microphones found</option>
                  )}
                </select>
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
                      ? "Download a stream-capable model (Parakeet) to enable"
                      : isStreamMode
                        ? "Stream mode active"
                        : `Stream mode — continuous dictation (${streamModeLabel})`
                }
                side="bottom"
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
                    ? "Formatting active"
                    : !formattingModelInstalled
                      ? "Download a formatter model in Settings to enable"
                      : "Formatting — auto-format dictated text"
                }
                side="bottom"
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
                  aria-label="Toggle formatting"
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
                    : "Translate mode — transcribe and translate to English"
                }
                side="bottom"
              >
                <button
                  onClick={onTranslateToggle}
                  disabled={!isIdle}
                  className={`${TOGGLE_BASE} disabled:opacity-50 disabled:pointer-events-none ${
                    isTranslateOn ? TOGGLE_ON_BLUE : TOGGLE_OFF
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
          </div>
        </div>

        {/* Statistics */}
        <div className="rounded-2xl bg-white/5 border border-white/10 p-7 flex items-center justify-center">
          <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-5 items-baseline">
            <span className="text-[36px] font-semibold text-white/90 leading-none text-right">
              42,069
            </span>
            <span className="text-[18px] text-white/50">total words</span>
            <span className="text-[30px] font-semibold text-white/90 leading-none text-right">
              420
            </span>
            <span className="text-[18px] text-white/50">wpm</span>
            <span className="text-[30px] font-semibold text-white/90 leading-none text-right">
              4 day
            </span>
            <span className="text-[18px] text-white/50">streak</span>
          </div>
        </div>
      </div>

      {/* Shortcuts — left-aligned, no status text */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.35 }}
        className="flex w-full flex-col gap-5"
      >
        {holdDisplayKeys ? (
          <div className="flex flex-col gap-7 md:flex-row md:items-start md:gap-12">
            <div className="flex flex-col gap-2">
              <span className="text-[14px] font-semibold uppercase tracking-[0.12em] text-white/70">
                Main shortcut
              </span>
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
              <DictationShortcutStartHint align="start" />
            </div>

            <div className="flex flex-col gap-2 border-t border-white/10 pt-5 md:border-t-0 md:border-l md:border-white/12 md:pl-12 md:pt-0">
              <span className="text-[14px] font-semibold uppercase tracking-[0.12em] text-white/70">
                Push-to-talk
              </span>
              <div className="flex items-center gap-1.5">
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
          <div className="flex flex-col gap-3">
            <span className="text-[14px] font-semibold uppercase tracking-[0.12em] text-white/70">
              Shortcut
            </span>
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
            <DictationShortcutStartHint align="start" />
          </div>
        )}
      </motion.div>
    </div>
  );
}
