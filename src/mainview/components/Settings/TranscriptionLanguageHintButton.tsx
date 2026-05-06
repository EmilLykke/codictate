import { InstantTooltip } from "../Common/InstantTooltip";
import { TRANSCRIPTION_LANGUAGE_HINT } from "../../../shared/transcription-languages";

export function TranscriptionLanguageHintButton({
  className = "",
  tooltipSide = "top",
}: {
  className?: string;
  tooltipSide?: "top" | "bottom";
}) {
  return (
    <InstantTooltip
      text={TRANSCRIPTION_LANGUAGE_HINT}
      side={tooltipSide}
      floatInViewport
    >
      <button
        type="button"
        className={`inline-flex aspect-square w-10 shrink-0 self-stretch items-center justify-center rounded-lg border border-overlay/12 bg-surface-1 shadow-[inset_0_1px_0_var(--overlay-06)] text-overlay/42 hover:text-overlay/58 hover:border-overlay/18 hover:bg-surface-2 focus-visible:border-overlay/26 focus-visible:ring-2 focus-visible:ring-overlay/12 focus-visible:ring-offset-0 transition-[border-color,background-color,box-shadow] duration-200 cursor-pointer ${className}`}
        aria-label={TRANSCRIPTION_LANGUAGE_HINT}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
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
  );
}
