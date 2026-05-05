import {
  dictationReadyStartHintAfterTap,
  dictationReadyStartHintBeforeHold,
  dictationReadyStartHintBetween,
  dictationShortcutSummaryHoldBody,
  dictationShortcutSummaryHoldTitle,
  dictationShortcutSummaryTapBody,
  dictationShortcutSummaryTapTitle,
} from "../../../shared/shortcut-options";
import { InstantTooltip } from "./InstantTooltip";

/** Keeps hint copy in a narrow measure so it stays near the keys, not full column width. */
const READY_SHORTCUT_HINT_MAX_W_CLASS = "max-w-[min(100%,15.5rem)]";

export function UnderlinedDictationTerm({
  label,
  tooltipText,
}: {
  label: string;
  tooltipText: string;
}) {
  return (
    <InstantTooltip text={tooltipText}>
      <span
        tabIndex={0}
        className="cursor-help font-medium text-white/72 underline decoration-white/45 decoration-2 underline-offset-[5px] transition-[color,text-decoration-color] hover:text-white/88 hover:decoration-white/70 focus-visible:rounded-sm focus-visible:text-white/88 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
      >
        {label}
      </span>
    </InstantTooltip>
  );
}

export function DictationShortcutStartHint({
  align,
  className = "",
}: {
  align: "start" | "center" | "end";
  className?: string;
}) {
  const alignClass =
    align === "end"
      ? "text-center md:text-right md:ml-auto"
      : align === "start"
        ? "text-left"
        : "mx-auto text-center";

  return (
    <p
      className={`mt-3 ${READY_SHORTCUT_HINT_MAX_W_CLASS} text-[15px] leading-snug text-white/50 font-sans text-balance ${alignClass} ${className}`}
    >
      {dictationReadyStartHintBeforeHold}
      <UnderlinedDictationTerm
        label={dictationShortcutSummaryHoldTitle}
        tooltipText={dictationShortcutSummaryHoldBody}
      />
      {dictationReadyStartHintBetween}
      <UnderlinedDictationTerm
        label={dictationShortcutSummaryTapTitle}
        tooltipText={dictationShortcutSummaryTapBody}
      />
      {dictationReadyStartHintAfterTap}
    </p>
  );
}
