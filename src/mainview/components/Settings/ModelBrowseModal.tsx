import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  type SpeechModel,
  formatModelSize,
  formatRamSize,
} from "../../../shared/speech-models";
import { MODEL_RATINGS } from "../../../shared/model-ratings";
import { TRANSCRIPTION_LANGUAGE_OPTIONS } from "../../../shared/transcription-languages";

/**
 * The tags shown beside a Speech Model: its Quantization, then what it can transcribe.
 *
 * Takes the whole SpeechModel rather than just the Model ID, because both tags were
 * previously guessed from the ID string and both guesses were wrong for hviske:
 *
 * - The Quantization pattern was `q\d+_\d+`, which matches `q8_0` and `q5_0` but not the
 *   k-quants `q6_k` and `q4_k`, nor an explicit float width like `f16`. Anything it missed
 *   fell through to "full", so two genuinely quantized models advertised themselves as full
 *   precision. The suffix is still read off the ID, since that is where the Quantization is
 *   encoded, but it now allows a letter suffix and is anchored to the end.
 * - The language tag was "anything without `.en` is multilingual", which labelled the
 *   Danish-only hviske models Multilingual. A single-language model has no marker in its ID,
 *   so the language has to come from the catalog. `.en` is checked first because the
 *   English-only Whisper models predate `supportedTranscriptionLanguageIds` and do not set
 *   it; where the field is present it wins.
 */
export function parseModelTags(model: SpeechModel): string[] {
  const tags: string[] = [];

  const qMatch = model.id.match(/-(q\d+_[0-9a-z]+|f16|f32)$/);
  if (qMatch) tags.push(qMatch[1]);
  else tags.push("full");

  const languageIds = model.supportedTranscriptionLanguageIds;
  if (model.id.includes(".en")) tags.push("\u{1F1EC}\u{1F1E7} (only)");
  else if (languageIds?.length === 1)
    tags.push(transcriptionLanguageLabel(languageIds[0]));
  else tags.push("Multilingual");

  if (model.id.includes("-tdrz")) tags.push("TDRZ");

  return tags;
}

/** The display name for a language id, falling back to the raw id if it is not in the list. */
function transcriptionLanguageLabel(id: string): string {
  return (
    TRANSCRIPTION_LANGUAGE_OPTIONS.find((option) => option.id === id)?.label ??
    id
  );
}

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
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-overlay/40 w-18 text-right whitespace-nowrap">
        {label}
      </span>
      <div className="h-[4px] w-14 rounded-full bg-overlay/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-blue/50 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function TagBadge({ children }: { children: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-overlay/8 text-overlay/50">
      {children}
    </span>
  );
}

export function ModelBrowseModal({
  isOpen,
  onClose,
  models,
  modelAvailability,
  downloadProgress,
  onDownload,
  onCancelDownload,
}: {
  isOpen: boolean;
  onClose: () => void;
  models: SpeechModel[];
  modelAvailability: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  onDownload: (modelId: string) => void;
  onCancelDownload: (modelId: string) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return models;
    const q = query.toLowerCase();
    return models.filter((m) => {
      const tags = parseModelTags(m);
      const searchable = [m.id, m.label, ...tags].join(" ").toLowerCase();
      return searchable.includes(q);
    });
  }, [models, query]);

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
          onClose();
        }
      }}
    >
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm"
              />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="fixed inset-0 z-[60] m-auto flex max-h-[80vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-overlay/10 bg-surface-elevated shadow-2xl"
              >
                <Dialog.Title className="sr-only">
                  Browse Whisper Models
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  Search and download additional Whisper speech-to-text models
                </Dialog.Description>

                <div className="flex items-center justify-between px-6 pt-5 pb-3">
                  <h2 className="text-[18px] font-semibold text-overlay/90">
                    Browse Whisper Models
                  </h2>
                  <Dialog.Close asChild>
                    <button
                      className="rounded-lg p-1.5 text-overlay/40 hover:bg-surface-3 hover:text-overlay/80 transition-colors cursor-pointer"
                      aria-label="Close"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </Dialog.Close>
                </div>

                <div className="px-6 pb-3">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search models..."
                    autoFocus
                    className="w-full rounded-lg border border-overlay/12 bg-surface-1 px-3 py-2 text-[14px] text-overlay/80 placeholder:text-overlay/30 outline-none focus:border-overlay/25 transition-colors"
                  />
                </div>

                <div className="flex-1 overflow-y-auto px-6 pb-5 [scrollbar-gutter:stable]">
                  {filtered.length === 0 && (
                    <p className="py-8 text-center text-[14px] text-overlay/40">
                      No models match your search.
                    </p>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {filtered.map((model) => {
                      const isAvailable =
                        modelAvailability[model.id] ?? model.bundled ?? false;
                      const progress = downloadProgress[model.id];
                      const isDownloading = progress !== undefined;
                      const tags = parseModelTags(model);

                      const stats = MODEL_RATINGS[model.id];

                      return (
                        <div
                          key={model.id}
                          className="rounded-xl border border-overlay/8 bg-surface-1 px-4 py-3 transition-colors hover:border-overlay/14 hover:bg-surface-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[15px] font-medium text-overlay/80">
                                  {model.label}
                                </span>
                                {tags.map((tag) => (
                                  <TagBadge key={tag}>{tag}</TagBadge>
                                ))}
                                <TagBadge>
                                  {formatRamSize(model.peakRamMB)}
                                </TagBadge>
                              </div>
                              {stats && (
                                <div className="flex gap-3 mt-1.5">
                                  <StatBar
                                    label={
                                      model.id.includes(".en")
                                        ? "accuracy (en)"
                                        : "accuracy"
                                    }
                                    value={stats.accuracy}
                                  />
                                  <StatBar label="speed" value={stats.speed} />
                                  <StatBar
                                    label="languages"
                                    value={stats.languages}
                                  />
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2.5 shrink-0">
                              <span className="text-[13px] text-overlay/35 tabular-nums">
                                {formatModelSize(model.downloadSizeMB)}
                              </span>

                              {isAvailable && (
                                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-accent-blue/15 text-accent-blue/80 border border-accent-blue/20">
                                  Downloaded
                                </span>
                              )}

                              {!isAvailable && !isDownloading && (
                                <button
                                  onClick={() => onDownload(model.id)}
                                  className="px-2.5 py-1 rounded-lg text-[12px] font-medium border border-overlay/12 hover:border-overlay/22 bg-surface-1 hover:bg-surface-3 text-overlay/48 hover:text-overlay/68 transition-colors duration-200 cursor-pointer"
                                >
                                  Download
                                </button>
                              )}
                            </div>
                          </div>

                          {isDownloading && (
                            <div className="mt-2">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[12px] text-overlay/30 tabular-nums">
                                  {Math.round(progress * 100)}%
                                </span>
                                <button
                                  onClick={() => onCancelDownload(model.id)}
                                  className="text-[12px] font-medium text-overlay/28 hover:text-overlay/50 transition-colors cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                              <div className="h-1 rounded-full bg-overlay/10 overflow-hidden">
                                <motion.div
                                  className="h-full rounded-full bg-accent-blue/40"
                                  initial={{ width: 0 }}
                                  animate={{
                                    width: `${Math.round(progress * 100)}%`,
                                  }}
                                  transition={{ duration: 0.2 }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
