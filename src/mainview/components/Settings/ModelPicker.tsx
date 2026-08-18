import { useState } from "react";
import { motion } from "motion/react";
import {
  SPEECH_MODELS,
  type SpeechModel,
  formatModelSize,
  parakeetSupportedLanguagesTooltipText,
} from "../../../shared/speech-models";
import { MODEL_RATINGS } from "../../../shared/model-ratings";
import { InstantTooltip } from "../Common/InstantTooltip";
import { parseModelTags } from "./ModelBrowseModal";

const SHORT_DESC: Record<string, string> = {
  "parakeet-tdt-0.6b-v3": "Fastest. 3-10x faster, 80 MB RAM.",
  "small.en-q5_1": "Best lightweight English. 475 MB RAM.",
  "medium.en-q5_0": "Best English accuracy. 1.1 GB RAM.",
  "small-q5_1": "Lightweight multilingual. 475 MB RAM.",
  "large-v3-turbo-q5_0": "Daily driver multilingual. 800 MB RAM.",
  "large-v3-q5_0": "Highest accuracy, multilingual. 2.0 GB RAM.",
  // The five hviske Quantizations differ only in size and speed. The Benchmark Run
  // 2026-08-18_08-17-28_hviske-vs-main-models measured Danish WER from 11.29 to 11.67
  // across all five, a spread inside the noise on 197 utterances, so the model card's
  // claim of one WER for every Quantization holds and the trade-off is the whole story.
  // RAM figures are that run's average peak RSS, not estimates.
  "hviske-v5-tiny-f16": "Danish only, full precision. 601 MB RAM.",
  "hviske-v5-tiny-q8_0": "Danish only, near-full precision. 368 MB RAM.",
  "hviske-v5-tiny-q6_k": "Danish only, balanced. 332 MB RAM.",
  "hviske-v5-tiny-q5_0": "Danish only, compact. 282 MB RAM.",
  "hviske-v5-tiny-q4_k": "Danish only, smallest and fastest. 253 MB RAM.",
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
      <span className="text-[13px] text-overlay/45 w-22 text-right whitespace-nowrap">
        {label}
      </span>
      <div className="h-[5px] w-20 rounded-full bg-overlay/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-blue/50 transition-all duration-300"
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
        const isDeletable = isAvailable && !model.bundled;
        const isPendingDelete = confirmDelete === model.id;
        const stats = MODEL_RATINGS[model.id];
        // SHORT_DESC covers the curated models and the hviske Quantizations. Anything else
        // reaching this picker is an extra Quantization downloaded from the browse modal, and
        // falls back to its catalog description rather than rendering a blank line. The two
        // are written in different registers (catalog descriptions carry an engine prefix),
        // so the fallback reads as slightly out of place by design, not by accident.
        const desc = SHORT_DESC[model.id] ?? model.description;
        const quantTag = parseModelTags(model)[0];
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
                ? "border-overlay/18 bg-surface-3"
                : "border-overlay/8 bg-surface-1 opacity-65"
            } ${isAvailable && !isSelected ? "hover:opacity-90 hover:border-overlay/14 hover:bg-surface-2 cursor-pointer" : ""}`}
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
                        isSelected ? "text-overlay/85" : "text-overlay/60"
                      }`}
                    >
                      {model.label}
                    </span>
                    {quantTag && (
                      <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-overlay/8 text-overlay/45">
                        {quantTag}
                      </span>
                    )}
                    {isSelected && isAvailable && (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-accent-blue/15 text-accent-blue/80 border border-accent-blue/20">
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
                  <p className="mt-1 text-[14px] text-overlay/48 leading-snug">
                    {desc}
                  </p>
                </div>

                {stats && (
                  <div className="flex flex-col gap-1 shrink-0 pt-0.5">
                    <StatBar
                      label={
                        model.id.includes(".en") ? "accuracy (en)" : "accuracy"
                      }
                      value={stats.accuracy}
                    />
                    <StatBar label="speed" value={stats.speed} />
                    <StatBar label="languages" value={stats.languages} />
                  </div>
                )}
              </div>

              {/* Bottom: capabilities | size + action */}
              <div className="flex items-center justify-between mt-3">
                <div className="flex items-center gap-2">
                  {isMultilang && (
                    <span className="flex items-center gap-1 text-[13px] text-overlay/48">
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
                            className="inline-flex items-center justify-center rounded text-overlay/48 hover:text-overlay/70 transition-colors cursor-pointer"
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
                    <span className="flex items-center gap-1 text-[13px] text-overlay/48">
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
                    <span className="flex items-center gap-1 text-[13px] text-overlay/48">
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
                      Live
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  <span className="text-[13px] text-overlay/35 tabular-nums">
                    {formatModelSize(model.downloadSizeMB)}
                  </span>

                  {!isAvailable && !isDownloading && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownload(model.id);
                      }}
                      className="shrink-0 px-2.5 py-1 rounded-lg text-[12px] font-medium border border-overlay/12 hover:border-overlay/22 bg-surface-1 hover:bg-surface-3 text-overlay/48 hover:text-overlay/68 transition-colors duration-200 cursor-pointer"
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
                      className="shrink-0 px-2.5 py-1 rounded-lg text-[12px] font-medium border border-accent-red/30 bg-accent-red/8 text-accent-red/70 hover:border-accent-red/40 hover:bg-accent-red/14 hover:text-accent-red/90 transition-colors duration-200 cursor-pointer"
                      aria-label={`Remove ${model.label} model`}
                    >
                      Remove
                    </button>
                  )}

                  {isDeletable && isPendingDelete && (
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-overlay/30">Sure?</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(null);
                          if (isSelected) {
                            const fallback = (models ?? SPEECH_MODELS).find(
                              (m) =>
                                m.id !== model.id &&
                                (modelAvailability[m.id] ?? m.bundled ?? false),
                            );
                            if (fallback) onSelect(fallback.id);
                          }
                          onDelete(model.id);
                        }}
                        className="text-[12px] font-medium text-accent-red/75 hover:text-accent-red transition-colors cursor-pointer"
                      >
                        Delete
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(null);
                        }}
                        className="text-[12px] font-medium text-overlay/28 hover:text-overlay/50 transition-colors cursor-pointer"
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
                  <span className="text-[12px] text-overlay/30 tabular-nums">
                    {Math.round(progress * 100)}%
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancelDownload(model.id);
                    }}
                    className="text-[12px] font-medium text-overlay/28 hover:text-overlay/50 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
                <div className="h-1 rounded-full bg-overlay/10 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-accent-blue/40"
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
