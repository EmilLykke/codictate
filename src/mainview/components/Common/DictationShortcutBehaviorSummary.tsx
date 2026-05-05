"use client";

import {
  dictationShortcutSummaryHoldBody,
  dictationShortcutSummaryHoldTitle,
  dictationShortcutSummaryTapBody,
  dictationShortcutSummaryTapTitle,
} from "../../../shared/shortcut-options";
import { InstantTooltip } from "./InstantTooltip";

export type DictationShortcutSegment = "hold" | "tap";

function SummaryLabel({
  title,
  tooltipText,
  labelClass,
}: {
  title: string;
  tooltipText: string;
  labelClass: string;
}) {
  return (
    <InstantTooltip text={tooltipText} side="top">
      <span
        tabIndex={0}
        className={`cursor-help rounded-sm outline-offset-2 outline-none transition-colors duration-150 hover:text-white/95 focus-visible:ring-2 focus-visible:ring-white/28 ${labelClass}`}
      >
        {title}
      </span>
    </InstantTooltip>
  );
}

const styles = {
  ready: {
    wrapSplit:
      "mx-auto grid w-full max-w-[min(440px,100%)] grid-cols-1 gap-8 text-left sm:grid-cols-2 sm:gap-x-10 sm:gap-y-0",
    wrapStack: "flex w-full flex-col gap-6 text-left",
    wrapPair:
      "grid w-full grid-cols-2 items-start gap-0 text-left [&>*:first-child]:border-r [&>*:first-child]:border-white/12 [&>*:first-child]:pr-4 sm:[&>*:first-child]:pr-5 [&>*:last-child]:pl-4 sm:[&>*:last-child]:pl-5",
    wrapSingle: "w-full min-w-0 text-left",
    label:
      "font-sans text-[18px] font-semibold tracking-[-0.02em] text-white/82 sm:text-[20px]",
    labelPair:
      "font-sans text-[16px] font-semibold tracking-[-0.02em] text-white/80 sm:text-[18px]",
  },
  onboarding: {
    wrapSplit:
      "mx-auto grid w-full max-w-[min(440px,100%)] grid-cols-1 gap-7 text-left sm:grid-cols-2 sm:gap-x-8 sm:gap-y-0",
    wrapStack: "flex w-full flex-col gap-5 text-left",
    wrapPair:
      "grid w-full grid-cols-2 items-start gap-0 text-left [&>*:first-child]:border-r [&>*:first-child]:border-white/12 [&>*:first-child]:pr-4 sm:[&>*:first-child]:pr-4 [&>*:last-child]:pl-4 sm:[&>*:last-child]:pl-4",
    wrapSingle: "w-full min-w-0 text-left",
    label:
      "font-sans text-[15px] font-semibold tracking-[-0.02em] text-white/78 sm:text-[17px]",
    labelPair:
      "font-sans text-[13px] font-semibold tracking-[-0.02em] text-white/76 sm:text-[15px]",
  },
} as const;

function segmentCopy(seg: DictationShortcutSegment): {
  title: string;
  tooltipText: string;
} {
  if (seg === "hold") {
    return {
      title: dictationShortcutSummaryHoldTitle,
      tooltipText: dictationShortcutSummaryHoldBody,
    };
  }
  return {
    title: dictationShortcutSummaryTapTitle,
    tooltipText: dictationShortcutSummaryTapBody,
  };
}

export function DictationShortcutBehaviorSummary({
  variant = "ready",
  className = "",
  behaviorLayout = "split",
  segments,
}: {
  variant?: keyof typeof styles;
  className?: string;
  /**
   * `split`: Hold | Tap from viewport `sm`.
   * `stack`: vertical stack.
   * `pair`: always Hold | Tap in one row (e.g. under main shortcut beside PTT).
   */
  behaviorLayout?: "split" | "stack" | "pair";
  /** Omit to show both. Use `['tap']` or `['hold']` for a single block. */
  segments?: DictationShortcutSegment[];
}) {
  const s = styles[variant];
  const segs: DictationShortcutSegment[] =
    segments ?? (["hold", "tap"] as const);

  const blocks = segs.map((seg) => ({
    key: seg,
    ...segmentCopy(seg),
  }));

  if (blocks.length === 0) return null;

  if (blocks.length === 1) {
    const b = blocks[0];
    return (
      <div className={`${s.wrapSingle} ${className}`}>
        <SummaryLabel
          title={b.title}
          tooltipText={b.tooltipText}
          labelClass={s.labelPair}
        />
      </div>
    );
  }

  const labelClass = behaviorLayout === "pair" ? s.labelPair : s.label;
  const wrap =
    behaviorLayout === "stack"
      ? s.wrapStack
      : behaviorLayout === "pair"
        ? s.wrapPair
        : s.wrapSplit;

  return (
    <div className={`${wrap} ${className}`}>
      {blocks.map((b) => (
        <SummaryLabel
          key={b.key}
          title={b.title}
          tooltipText={b.tooltipText}
          labelClass={labelClass}
        />
      ))}
    </div>
  );
}
