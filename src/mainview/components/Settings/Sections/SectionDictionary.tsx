import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import type {
  AppSettings,
  DictionaryCandidate,
  DictionaryEntry,
} from "../../../../shared/types";
import {
  addDictionaryEntry,
  editDictionaryEntry,
  fetchSettings,
  removeDictionaryCandidate,
  removeDictionaryEntry,
  setDictionaryAutoLearn,
} from "../../../rpc";
import { platformDisplayName } from "../../../../shared/platform";

type Props = {
  settings: AppSettings;
};

function SparkleIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-label="Auto-learned"
    >
      <path d="M12 2l2.09 6.26L21 10l-6.91 1.74L12 18l-2.09-6.26L3 10l6.91-1.74L12 2z" />
    </svg>
  );
}

export function SectionDictionary({ settings }: Props) {
  const queryClient = useQueryClient();
  const dictionary = settings.dictionary;
  const autoLearnComingSoon = !settings.capabilities.supportsCorrectionObserver;
  const [entryKind, setEntryKind] = useState<DictionaryEntry["kind"]>("fuzzy");
  const [inputValue, setInputValue] = useState("");
  const [replacementFromValue, setReplacementFromValue] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editFrom, setEditFrom] = useState("");
  const [editKind, setEditKind] =
    useState<DictionaryEntry["kind"]>("fuzzy");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAddForm) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [showAddForm, entryKind]);

  const entryKey = useCallback(
    (entry: Pick<DictionaryEntry, "kind" | "text" | "from">) => {
      return entry.kind === "replacement"
        ? `replacement:${(entry.from ?? "").trim().toLowerCase()}=>${entry.text
            .trim()
            .toLowerCase()}`
        : `fuzzy:${entry.text.trim().toLowerCase()}`;
    },
    [],
  );

  const resetForm = useCallback(() => {
    setInputValue("");
    setReplacementFromValue("");
    setEntryKind("fuzzy");
  }, []);

  const handleAdd = useCallback(async () => {
    const text = inputValue.trim();
    const from = replacementFromValue.trim();
    if (!text) return;
    if (entryKind === "replacement" && !from) return;

    const nextEntry: DictionaryEntry =
      entryKind === "replacement"
        ? { kind: "replacement", from, text, source: "manual" }
        : { kind: "fuzzy", text, source: "manual" };

    if (dictionary.entries.some((e) => entryKey(e) === entryKey(nextEntry))) {
      resetForm();
      setShowAddForm(false);
      return;
    }

    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old
        ? {
            ...old,
            dictionary: {
              ...old.dictionary,
              entries: [...old.dictionary.entries, nextEntry],
            },
          }
        : old,
    );
    resetForm();
    setShowAddForm(false);

    const ok = await addDictionaryEntry(
      entryKind === "replacement"
        ? { kind: "replacement", from, text }
        : { kind: "fuzzy", text },
    );
    if (!ok) {
      const fresh = await fetchSettings();
      queryClient.setQueryData(["settings"], fresh);
    }
  }, [
    entryKind,
    entryKey,
    inputValue,
    queryClient,
    replacementFromValue,
    dictionary.entries,
    resetForm,
  ]);

  const handleRemove = useCallback(
    async (entry: DictionaryEntry) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old
          ? {
              ...old,
              dictionary: {
                ...old.dictionary,
                entries: old.dictionary.entries.filter(
                  (e) => entryKey(e) !== entryKey(entry),
                ),
              },
            }
          : old,
      );

      const ok = await removeDictionaryEntry({
        kind: entry.kind,
        text: entry.text,
        from: entry.from,
      });
      if (!ok) {
        const fresh = await fetchSettings();
        queryClient.setQueryData(["settings"], fresh);
      }
    },
    [entryKey, queryClient],
  );

  const startEditing = useCallback(
    (entry: DictionaryEntry) => {
      const key = entryKey(entry);
      setEditingKey(key);
      setEditText(entry.text);
      setEditFrom(entry.from ?? "");
      setEditKind(entry.kind);
      setTimeout(() => editInputRef.current?.focus(), 50);
    },
    [entryKey],
  );

  const cancelEditing = useCallback(() => {
    setEditingKey(null);
    setEditText("");
    setEditFrom("");
  }, []);

  const handleEditSave = useCallback(
    async (originalEntry: DictionaryEntry) => {
      const text = editText.trim();
      const from = editFrom.trim();
      if (!text) return;
      if (editKind === "replacement" && !from) return;

      const newEntry =
        editKind === "replacement"
          ? { kind: "replacement" as const, from, text }
          : { kind: "fuzzy" as const, text };

      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) => {
        if (!old) return old;
        const entries = old.dictionary.entries.map((e) =>
          entryKey(e) === entryKey(originalEntry)
            ? {
                ...e,
                kind: newEntry.kind,
                text: newEntry.text,
                from: newEntry.kind === "replacement" ? newEntry.from : undefined,
              }
            : e,
        );
        return { ...old, dictionary: { ...old.dictionary, entries } };
      });
      setEditingKey(null);

      const ok = await editDictionaryEntry(
        { kind: originalEntry.kind, text: originalEntry.text, from: originalEntry.from },
        newEntry,
      );
      if (!ok) {
        const fresh = await fetchSettings();
        queryClient.setQueryData(["settings"], fresh);
      }
    },
    [editFrom, editKind, editText, entryKey, queryClient],
  );

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, entry: DictionaryEntry) => {
      if (e.key === "Enter") handleEditSave(entry);
      if (e.key === "Escape") cancelEditing();
    },
    [handleEditSave, cancelEditing],
  );

  const handleAutoLearnToggle = useCallback(async () => {
    const next = !dictionary.autoLearn;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old
        ? {
            ...old,
            dictionary: {
              ...old.dictionary,
              autoLearn: next,
            },
          }
        : old,
    );
    const ok = await setDictionaryAutoLearn(next);
    if (!ok) {
      const fresh = await fetchSettings();
      queryClient.setQueryData(["settings"], fresh);
    }
  }, [dictionary.autoLearn, queryClient]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") handleAdd();
      if (e.key === "Escape") {
        resetForm();
        setShowAddForm(false);
      }
    },
    [handleAdd, resetForm],
  );

  const hasAutoEntries = dictionary.entries.some((e) => e.source === "auto");

  const handleRemoveCandidate = useCallback(
    async (candidate: DictionaryCandidate) => {
      queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
        old
          ? {
              ...old,
              dictionary: {
                ...old.dictionary,
                candidates: old.dictionary.candidates.filter(
                  (entry) =>
                    !(
                      entry.from.trim().toLowerCase() ===
                        candidate.from.trim().toLowerCase() &&
                      entry.to.trim().toLowerCase() ===
                        candidate.to.trim().toLowerCase()
                    ),
                ),
              },
            }
          : old,
      );

      const ok = await removeDictionaryCandidate(candidate);
      if (!ok) {
        const fresh = await fetchSettings();
        queryClient.setQueryData(["settings"], fresh);
      }
    },
    [queryClient],
  );

  const canAdd =
    inputValue.trim().length > 0 &&
    (entryKind === "fuzzy" || replacementFromValue.trim().length > 0);

  return (
    <>
      <div className="mb-6">
        <span className="block text-[16px] uppercase tracking-[0.18em] text-white/38">
          Settings
        </span>
        <h2 className="mt-2 text-[34px] tracking-tight text-white/90">
          Dictionary
        </h2>
        <p className="mt-3 text-[18px] text-white/44 leading-relaxed font-sans font-normal">
          Teach Codictate how to spell your terms and abbreviations.
        </p>
      </div>

      {/* Auto-learn toggle */}
      <div className="mb-6 overflow-hidden rounded-xl border border-white/11 bg-white/4">
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <span className="block text-[18px] font-medium text-white/85">
              Auto-learn corrections
            </span>
            <span className="mt-1 block text-[15px] leading-snug text-white/44">
              {autoLearnComingSoon
                ? "Learns replacements from post-dictation edits once Windows text observation lands."
                : "Learns replacements from corrections you make after dictating."}
            </span>
            {autoLearnComingSoon && (
              <span className="mt-2 inline-flex rounded-full border border-amber-400/28 bg-amber-500/10 px-2 py-0.5 text-[13px] font-medium uppercase tracking-wide text-amber-100/75">
                Coming soon on{" "}
                {platformDisplayName(settings.capabilities.platform)}
              </span>
            )}
          </div>
          {!autoLearnComingSoon && (
            <button
              type="button"
              onClick={handleAutoLearnToggle}
              className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-200 ${
                dictionary.autoLearn
                  ? "border-emerald-400/45 bg-emerald-500/35"
                  : "border-white/14 bg-white/7"
              }`}
              aria-label="Toggle auto-learn corrections"
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full transition-all duration-200 ${
                  dictionary.autoLearn
                    ? "left-[21px] bg-white/90"
                    : "left-0.5 bg-white/40"
                }`}
              />
            </button>
          )}
        </div>
      </div>

      {/* Header row: label + Add word button */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] uppercase tracking-[0.14em] text-white/35">
          Words
        </span>
        {!showAddForm && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="rounded-lg border border-white/12 bg-white/5 px-3 py-1.5 text-[14px] font-medium text-white/50 transition-colors duration-200 hover:border-white/20 hover:bg-white/8 hover:text-white/75 cursor-pointer"
          >
            + Add word
          </button>
        )}
      </div>

      {/* Inline add form */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div
            key="add-form"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden rounded-xl border border-white/14 bg-white/5"
          >
            {/* Type selector */}
            <div className="flex gap-2 border-b border-white/10 px-4 pt-4 pb-3">
              <button
                type="button"
                onClick={() => {
                  setEntryKind("fuzzy");
                  setInputValue("");
                  setReplacementFromValue("");
                }}
                className={`rounded-lg border px-3 py-1.5 text-[15px] transition-colors duration-200 ${
                  entryKind === "fuzzy"
                    ? "border-white/24 bg-white/12 text-white/88"
                    : "border-white/10 bg-transparent text-white/42 hover:border-white/16 hover:text-white/65"
                }`}
              >
                Fuzzy term
              </button>
              <button
                type="button"
                onClick={() => {
                  setEntryKind("replacement");
                  setInputValue("");
                  setReplacementFromValue("");
                }}
                className={`rounded-lg border px-3 py-1.5 text-[15px] transition-colors duration-200 ${
                  entryKind === "replacement"
                    ? "border-white/24 bg-white/12 text-white/88"
                    : "border-white/10 bg-transparent text-white/42 hover:border-white/16 hover:text-white/65"
                }`}
              >
                Exact replacement
              </button>
            </div>

            {/* Inputs */}
            <div className="flex gap-3 px-4 py-4">
              {entryKind === "replacement" && (
                <input
                  type="text"
                  value={replacementFromValue}
                  onChange={(e) => setReplacementFromValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Replace this, e.g. BTW"
                  className="min-w-0 flex-1 rounded-xl border border-white/12 bg-white/5 px-4 py-3 text-[18px] text-white/90 placeholder-white/28 outline-none transition-[border-color,background-color] duration-200 hover:border-white/18 hover:bg-white/7 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12"
                />
              )}
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  entryKind === "replacement"
                    ? "With this, e.g. by the way"
                    : "Canonical term, e.g. Electrobun"
                }
                className="min-w-0 flex-1 rounded-xl border border-white/12 bg-white/5 px-4 py-3 text-[18px] text-white/90 placeholder-white/28 outline-none transition-[border-color,background-color] duration-200 hover:border-white/18 hover:bg-white/7 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowAddForm(false);
                }}
                className="rounded-xl border border-white/10 bg-transparent px-4 py-2 text-[16px] text-white/48 transition-colors duration-200 hover:border-white/18 hover:text-white/72 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={!canAdd}
                className="rounded-xl border border-white/14 bg-white/7 px-5 py-2 text-[16px] font-medium text-white/75 transition-colors duration-200 hover:border-white/20 hover:bg-white/10 hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              >
                Add
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Entries list */}
      <div className="overflow-hidden rounded-xl border border-white/11 bg-white/4">
        {dictionary.entries.length === 0 ? (
          <div className="px-5 py-8 text-center text-[17px] text-white/34">
            No words added yet.
          </div>
        ) : (
          <>
            {hasAutoEntries && (
              <div className="flex items-center gap-2 border-b border-white/8 px-5 py-3">
                <span className="text-[13px] text-amber-300/60">
                  <SparkleIcon />
                </span>
                <span className="text-[14px] text-white/34">
                  learned automatically from your corrections
                </span>
              </div>
            )}
            <ul>
              {dictionary.entries.map((entry, i) => {
                const key = entryKey(entry);
                const isEditing = editingKey === key;

                return (
                  <li
                    key={key}
                    className={`px-5 py-4 ${
                      i > 0 || hasAutoEntries ? "border-t border-white/8" : ""
                    }`}
                  >
                    {isEditing ? (
                      <div className="flex flex-col gap-3">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setEditKind("fuzzy")}
                            className={`rounded-lg border px-2.5 py-1 text-[14px] transition-colors duration-200 ${
                              editKind === "fuzzy"
                                ? "border-white/24 bg-white/12 text-white/88"
                                : "border-white/10 bg-transparent text-white/42 hover:border-white/16 hover:text-white/65"
                            }`}
                          >
                            Fuzzy
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditKind("replacement")}
                            className={`rounded-lg border px-2.5 py-1 text-[14px] transition-colors duration-200 ${
                              editKind === "replacement"
                                ? "border-white/24 bg-white/12 text-white/88"
                                : "border-white/10 bg-transparent text-white/42 hover:border-white/16 hover:text-white/65"
                            }`}
                          >
                            Replacement
                          </button>
                        </div>
                        <div className="flex gap-3">
                          {editKind === "replacement" && (
                            <input
                              type="text"
                              value={editFrom}
                              onChange={(e) => setEditFrom(e.target.value)}
                              onKeyDown={(e) => handleEditKeyDown(e, entry)}
                              placeholder="From"
                              className="min-w-0 flex-1 rounded-xl border border-white/12 bg-white/5 px-3 py-2.5 text-[18px] text-white/90 placeholder-white/28 outline-none transition-[border-color,background-color] duration-200 hover:border-white/18 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12"
                            />
                          )}
                          <input
                            ref={editInputRef}
                            type="text"
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => handleEditKeyDown(e, entry)}
                            placeholder={
                              editKind === "replacement" ? "To" : "Term"
                            }
                            className="min-w-0 flex-1 rounded-xl border border-white/12 bg-white/5 px-3 py-2.5 text-[18px] text-white/90 placeholder-white/28 outline-none transition-[border-color,background-color] duration-200 hover:border-white/18 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={cancelEditing}
                            className="rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[15px] text-white/48 transition-colors duration-200 hover:border-white/18 hover:text-white/72 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEditSave(entry)}
                            disabled={
                              !editText.trim() ||
                              (editKind === "replacement" && !editFrom.trim())
                            }
                            className="rounded-xl border border-white/14 bg-white/7 px-4 py-1.5 text-[15px] font-medium text-white/75 transition-colors duration-200 hover:border-white/20 hover:bg-white/10 hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {entry.source === "auto" && (
                            <span
                              className="shrink-0 text-amber-300/55"
                              title="Added automatically from a correction"
                            >
                              <SparkleIcon />
                            </span>
                          )}
                          {entry.source === "auto" &&
                            entry.confidence !== undefined &&
                            entry.confidence < 3 && (
                              <span
                                className="shrink-0 rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.1em] text-amber-300/70"
                                title={`Provisional — accepted ${entry.timesAccepted ?? 0} time${(entry.timesAccepted ?? 0) !== 1 ? "s" : ""} without revert`}
                              >
                                provisional
                              </span>
                            )}
                          <div className="min-w-0">
                            {entry.kind === "replacement" ? (
                              <div
                                className={`truncate text-[18px] font-medium ${
                                  entry.source === "auto"
                                    ? "text-amber-100/80"
                                    : "text-white/85"
                                }`}
                              >
                                {entry.from?.toLowerCase()} {"→"} {entry.text}
                              </div>
                            ) : (
                              <span
                                className={`text-[18px] font-medium truncate ${
                                  entry.source === "auto"
                                    ? "text-amber-100/80"
                                    : "text-white/85"
                                }`}
                              >
                                {entry.text}
                              </span>
                            )}
                            <div className="mt-1 text-[13px] uppercase tracking-[0.12em] text-white/30">
                              {entry.kind === "replacement"
                                ? "exact replacement"
                                : "fuzzy match"}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => startEditing(entry)}
                            aria-label={`Edit ${entry.kind === "replacement" ? `${entry.from} to ${entry.text}` : entry.text}`}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/40 transition-colors duration-200 hover:border-white/18 hover:bg-white/8 hover:text-white/70"
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemove(entry)}
                            aria-label={`Remove ${entry.kind === "replacement" ? `${entry.from} to ${entry.text}` : entry.text}`}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/40 transition-colors duration-200 hover:border-white/18 hover:bg-white/8 hover:text-white/70"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* Pending auto-learn candidates — shown at bottom */}
      {dictionary.candidates.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-xl border border-amber-200/12 bg-amber-200/[0.04]">
          <div className="border-b border-amber-200/10 px-5 py-4">
            <div className="text-[18px] font-medium text-amber-50/88">
              Pending auto-learn
            </div>
            <div className="mt-1 text-[15px] leading-snug text-white/44">
              These were pending before auto-learn was updated. They won't be
              applied automatically.
            </div>
          </div>
          <ul>
            {dictionary.candidates.map((candidate, i) => (
              <li
                key={`${candidate.from}=>${candidate.to}`}
                className={`flex items-center justify-between gap-4 px-5 py-4 ${
                  i > 0 ? "border-t border-amber-200/10" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[18px] font-medium text-amber-50/82">
                    {candidate.from.toLowerCase()} {"→"} {candidate.to}
                  </div>
                  <div className="mt-1 text-[13px] uppercase tracking-[0.12em] text-white/34">
                    {candidate.corrections} of 2 confirmations
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveCandidate(candidate)}
                  aria-label={`Dismiss candidate ${candidate.from} to ${candidate.to}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/40 transition-colors duration-200 hover:border-white/18 hover:bg-white/8 hover:text-white/70"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
