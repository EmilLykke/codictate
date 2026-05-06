import { useState } from "react";
import { motion } from "motion/react";
import {
  SPEECH_MODELS,
  type SpeechModel,
  formatModelSize,
  parakeetSupportedLanguagesTooltipText,
} from "../../../shared/speech-models";
import { InstantTooltip } from "../Common/InstantTooltip";

const MODEL_STATS: Record<string, { speed: number; accuracy: number }> = {
  "small-q5_1": { speed: 8, accuracy: 5 },
  "large-v3-turbo-q5_0": { speed: 8, accuracy: 8 },
  "large-v3-q5_0": { speed: 6, accuracy: 10 },
  "parakeet-tdt-0.6b-v3": { speed: 10, accuracy: 8 },
};

const SHORT_DESC: Record<string, string> = {
  "small-q5_1": "Lightweight and capable.",
  "large-v3-turbo-q5_0": "Balanced accuracy and speed.",
  "large-v3-q5_0": "Highest accuracy, best for translation.",
  "parakeet-tdt-0.6b-v3": "Fast and accurate with live dictation.",
};

function StatBar({
  label,
  value,
  max = 10,
}: {
  label: string;
  value: number;
  max?: number;
}) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[13px] text-white/45 w-16 text-right">{label}</span>
      <div className="h-[5px] w-20 rounded-full bg-white/8 overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-400/50 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ModelPicker({
  value,
  models,
  modelAvailability,
  downloadProgress,
  onSelect,
  onDownload,
  onCancelDownload,
  onDelete,
}: {
  value: string;
  models?: SpeechModel[];
  modelAvailability: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  onSelect: (modelId: string) => void;
  onDownload: (modelId: string) => void;
  onCancelDownload: (modelId: string) => void;
  onDelete: (modelId: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const parakeetLangsTooltip = parakeetSupportedLanguagesTooltipText();

  return (
    <div className="flex flex-col gap-2">
      {(models ?? SPEECH_MODELS).map((model) => {
        const isSelected = model.id === value;
        const isAvailable =
          modelAvailability[model.id] ?? model.bundled ?? false;
        const progress = downloadProgress[model.id];
        const isDownloading = progress !== undefined;
        const isDeletable = isAvailable && !model.bundled && !isSelected;
        const isPendingDelete = confirmDelete === model.id;
        const stats = MODEL_STATS[model.id];
        const desc = SHORT_DESC[model.id] ?? "";
        const isStream =
          model.modeSupport === "both" || model.modeSupport === "stream";
        const isMultilang =
          !model.supportedTranscriptionLanguageIds ||
          model.supportedTranscriptionLanguageIds.length > 1;

        return (
          <div
            key={model.id}
            className={`relative rounded-xl border transition-colors duration-200 overflow-hidden ${
              isSelected
                ? "border-blue-400/25 bg-white/7"
                : "border-white/11 bg-white/4"
            } ${isAvailable && !isSelected ? "hover:border-white/16 hover:bg-white/6 cursor-pointer" : ""}`}
            onClick={() => {
              if (confirmDelete) {
                setConfirmDelete(null);
                return;
              }
              if (isAvailable) onSelect(model.id);
            }}
          >
            <div className="px-4 pt-3.5 pb-3">
              {/* Top: name + badge | stats */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`text-[16px] font-semibold transition-colors duration-200 ${
                        isSelected ? "text-white/85" : "text-white/60"
                      }`}
                    >
                      {model.label}
                    </span>
                    {isSelected && isAvailable && (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-500/15 text-blue-300/80 border border-blue-400/20">
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[14px] text-white/48 leading-snug">
                    {desc}
                  </p>
                </div>

                {stats && (
                  <div className="flex flex-col gap-1 shrink-0 pt-0.5">
                    <StatBar label="accuracy" value={stats.accuracy} />
                    <StatBar label="speed" value={stats.speed} />
                  </div>
                )}
              </div>

              {/* Bottom: capabilities | size + action */}
              <div className="flex items-center justify-between mt-3">
                <div className="flex items-center gap-2">
                  {isMultilang && (
                    <span className="flex items-center gap-1 text-[13px] text-white/48">
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                        <path d="M2 12h20" />
                      </svg>
                      Multi-language
                      {model.engine === "whisperkit" && (
                        <InstantTooltip
                          text={parakeetLangsTooltip}
                          side="bottom"
                          tooltipClassName="pointer-events-auto w-[min(100vw-2rem,26rem)] max-h-[min(55vh,22rem)] overflow-y-auto whitespace-pre-line"
                        >
                          <button
                            type="button"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center justify-center rounded text-white/48 hover:text-white/70 transition-colors cursor-pointer"
                            aria-label="Supported languages"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden
                            >
                              <circle cx="12" cy="12" r="10" />
                              <path d="M12 16v-4" />
                              <path d="M12 8h.01" />
                            </svg>
                          </button>
                        </InstantTooltip>
                      )}
                    </span>
                  )}
                  {model.translationSupport && (
                    <span className="flex items-center gap-1 text-[13px] text-white/48">
                      <svg
                        width="13"
                        height="13"
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
                      Translate
                    </span>
                  )}
                  {isStream && (
                    <span className="flex items-center gap-1 text-[13px] text-white/48">
                      <svg
                        width="13"
                        height="13"
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
                      Stream
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  <span className="text-[13px] text-white/35 tabular-nums">
                    {formatModelSize(model.downloadSizeMB)}
                  </span>

                  {!isAvailable && !isDownloading && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownload(model.id);
                      }}
                      className="shrink-0 px-2.5 py-1 rounded-lg text-[12px] font-medium border border-white/12 hover:border-white/22 bg-white/4 hover:bg-white/8 text-white/48 hover:text-white/68 transition-colors duration-200 cursor-pointer"
                    >
                      Download
                    </button>
                  )}

                  {isDeletable && !isPendingDelete && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(model.id);
                      }}
                      className="shrink-0 px-2.5 py-1 rounded-lg text-[12px] font-medium border border-red-400/30 bg-red-500/8 text-red-400/70 hover:border-red-400/40 hover:bg-red-500/14 hover:text-red-400/90 transition-colors duration-200 cursor-pointer"
                      aria-label={`Remove ${model.label} model`}
                    >
                      Remove
                    </button>
                  )}

                  {isDeletable && isPendingDelete && (
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-white/30">Sure?</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(null);
                          onDelete(model.id);
                        }}
                        className="text-[12px] font-medium text-red-400/75 hover:text-red-400 transition-colors cursor-pointer"
                      >
                        Delete
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(null);
                        }}
                        className="text-[12px] font-medium text-white/28 hover:text-white/50 transition-colors cursor-pointer"
                      >
                        Keep
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {isDownloading && (
              <div className="px-4 pb-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[12px] text-white/30 tabular-nums">
                    {Math.round(progress * 100)}%
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancelDownload(model.id);
                    }}
                    className="text-[12px] font-medium text-white/28 hover:text-white/50 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
                <div className="h-1 rounded-full bg-white/8 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-blue-400/40"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.round(progress * 100)}%` }}
                    transition={{ duration: 0.2 }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
