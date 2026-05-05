import { useLayoutEffect, useMemo } from "react";
import {
  PARAKEET_TRANSCRIPTION_LANGUAGE_LOCK_TOOLTIP,
  TRANSCRIPTION_LANGUAGE_OPTIONS,
} from "../../../shared/transcription-languages";
import { speechModelLocksTranscriptionLanguage } from "../../../shared/speech-models";
import { InstantTooltip } from "../Common/InstantTooltip";
import { SearchableSelect } from "../Common/SearchableSelect";

/** Ready bar: match compact LanguagePicker padding + type size on translate / icon buttons. */
export const READY_BAR_PY_CLASS = "py-1";
export const READY_BAR_TEXT_CLASS = "text-[17px] font-medium leading-snug";

export function LanguagePicker({
  value,
  onChange,
  excludeAuto = false,
  leadingDisabledOption,
  speechModelId = null,
  ariaLabel = "Transcription language",
}: {
  value: string;
  onChange: (transcriptionLanguageId: string) => void;
  /** Merged after defaults; extra classes (e.g. pointer-events-none). */
  className?: string;
  /** Shorter control for tight toolbars (Ready screen). */
  compact?: boolean;
  /** Show a leading empty option (value ""). */
  allowEmpty?: boolean;
  /** Omit the auto-detect option from the list. */
  excludeAuto?: boolean;
  /** Disabled first row (e.g. "pick a language") — value must match when nothing chosen yet. */
  leadingDisabledOption?: { value: string; label: string };
  /** When set to Parakeet (whisperkit), transcription language is fixed to automatic — control is disabled. */
  speechModelId?: string | null;
  ariaLabel?: string;
}) {
  const languageLocked =
    speechModelId != null &&
    speechModelLocksTranscriptionLanguage(speechModelId);

  const langOptions = useMemo(
    () =>
      TRANSCRIPTION_LANGUAGE_OPTIONS.filter(
        (o) => !(excludeAuto && o.id === "auto"),
      ),
    [excludeAuto],
  );

  const valueAllowed =
    (leadingDisabledOption && value === leadingDisabledOption.value) ||
    langOptions.some((o) => o.id === value);

  useLayoutEffect(() => {
    if (!languageLocked || value === "auto") return;
    onChange("auto");
  }, [languageLocked, value, onChange]);

  useLayoutEffect(() => {
    if (languageLocked || valueAllowed) return;
    const fallback = excludeAuto ? langOptions[0]?.id : "auto";
    if (fallback != null && fallback !== value) onChange(fallback);
  }, [languageLocked, valueAllowed, value, excludeAuto, langOptions, onChange]);

  const selectValue = languageLocked
    ? "auto"
    : leadingDisabledOption && value === leadingDisabledOption.value
      ? value
      : langOptions.some((o) => o.id === value)
        ? value
        : excludeAuto
          ? (langOptions[0]?.id ?? value)
          : "auto";

  const dropdownOptions = useMemo(() => {
    const opts = [];
    if (leadingDisabledOption) {
      opts.push({
        value: leadingDisabledOption.value,
        label: leadingDisabledOption.label,
        disabled: true,
      });
    }
    for (const o of langOptions) {
      opts.push({ value: o.id, label: o.label });
    }
    return opts;
  }, [langOptions, leadingDisabledOption]);

  const picker = (
    <SearchableSelect
      value={selectValue}
      options={dropdownOptions}
      onChange={onChange}
      disabled={languageLocked}
      searchPlaceholder="Search languages…"
      ariaLabel={
        languageLocked
          ? `${ariaLabel} — not available with Parakeet; language is detected automatically`
          : ariaLabel
      }
    />
  );

  if (languageLocked) {
    return (
      <InstantTooltip
        text={PARAKEET_TRANSCRIPTION_LANGUAGE_LOCK_TOOLTIP}
        side="bottom"
        floatInViewport
        className="block w-full max-w-full"
      >
        {picker}
      </InstantTooltip>
    );
  }

  return picker;
}
