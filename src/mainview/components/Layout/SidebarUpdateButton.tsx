import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { UpdateCheckState } from "../../../shared/types";
import { triggerApplyUpdate, triggerUpdateCheck } from "../../rpc";
import { appEvents } from "../../app-events";
import { InstantTooltip } from "../Common/InstantTooltip";

/** How long "You're up to date" stays before the row settles back to idle. */
const UP_TO_DATE_LINGER_MS = 4000;

const ICON_TRANSITION = { type: "spring", duration: 0.3, bounce: 0 } as const;
const LABEL_TRANSITION = {
  duration: 0.18,
  ease: [0.23, 1, 0.32, 1],
} as const;

/**
 * Update control in the sidebar footer, one row below Help.
 *
 * One row carries every update state: idle offers the check, checking and
 * downloading spin, up-to-date confirms in green and fades back, and a ready
 * update turns the row blue and restarts the app on click.
 */
export function SidebarUpdateButton() {
  const [state, setState] = useState<UpdateCheckState>("idle");
  const [message, setMessage] = useState<string | undefined>();
  const reduceMotion = useReducedMotion();
  const lingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearLinger = () => {
      if (lingerTimerRef.current != null) {
        clearTimeout(lingerTimerRef.current);
        lingerTimerRef.current = null;
      }
    };

    const off = appEvents.on("updateCheckStatus", ({ state, message }) => {
      clearLinger();
      setState(state);
      setMessage(message);
      if (state === "up-to-date") {
        lingerTimerRef.current = setTimeout(() => {
          setState("idle");
          setMessage(undefined);
        }, UP_TO_DATE_LINGER_MS);
      }
    });

    return () => {
      clearLinger();
      off();
    };
  }, []);

  const isBusy = state === "checking" || state === "downloading";

  const handleClick = useCallback(() => {
    if (isBusy) return;
    if (state === "ready") {
      triggerApplyUpdate();
      return;
    }
    setState("checking");
    setMessage(undefined);
    triggerUpdateCheck();
  }, [isBusy, state]);

  const row = (
    <button
      type="button"
      onClick={handleClick}
      disabled={isBusy}
      aria-label={actionLabel(state)}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-medium transition-[background-color,color,scale] duration-200 ease-out ${toneClass(state)} ${
        isBusy ? "cursor-default" : "cursor-pointer active:scale-[0.96]"
      }`}
    >
      <span className="relative flex size-[18px] shrink-0 items-center justify-center">
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            key={iconKey(state)}
            initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
            transition={ICON_TRANSITION}
            className="absolute inset-0 flex items-center justify-center"
          >
            <UpdateStateIcon state={state} reduceMotion={reduceMotion} />
          </motion.span>
        </AnimatePresence>
      </span>

      <span className="min-w-0 flex-1 text-left">
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            key={state}
            initial={{ opacity: 0, transform: "translateY(4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transform: "translateY(-4px)" }}
            transition={LABEL_TRANSITION}
            aria-live="polite"
            className="block truncate"
          >
            {stateLabel(state, message)}
          </motion.span>
        </AnimatePresence>
      </span>
    </button>
  );

  if (state === "error") {
    return (
      <InstantTooltip
        side="top"
        className="w-full"
        text={
          message ??
          "Something went wrong. Check your internet connection and try again."
        }
      >
        {row}
      </InstantTooltip>
    );
  }

  return row;
}

function stateLabel(state: UpdateCheckState, message?: string): string {
  switch (state) {
    case "idle":
      return "Check for updates";
    case "checking":
      return "Checking...";
    case "downloading":
      return "Downloading update...";
    case "up-to-date":
      return message ?? "You're up to date";
    case "ready":
      return "Restart to update";
    case "error":
      return "Update check failed";
  }
}

/** What a click does right now — the label alone reads as a status, not an action. */
function actionLabel(state: UpdateCheckState): string {
  switch (state) {
    case "checking":
      return "Checking for updates";
    case "downloading":
      return "Downloading update";
    case "ready":
      return "Restart to apply the update";
    case "error":
      return "Retry update check";
    default:
      return "Check for updates";
  }
}

function toneClass(state: UpdateCheckState): string {
  switch (state) {
    case "ready":
      return "bg-accent-blue/12 text-accent-blue/90 hover:bg-accent-blue/18";
    case "up-to-date":
      return "text-accent-emerald/75";
    case "error":
      return "text-orange-400/80 hover:bg-surface-1";
    default:
      return "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70";
  }
}

/** Icons are keyed by look, so checking and downloading don't re-run the swap. */
function iconKey(state: UpdateCheckState): string {
  return state === "downloading" ? "checking" : state;
}

function UpdateStateIcon({
  state,
  reduceMotion,
}: {
  state: UpdateCheckState;
  reduceMotion: boolean | null;
}) {
  const iconProps = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;

  if (state === "checking" || state === "downloading") {
    return (
      <svg
        {...iconProps}
        className={`opacity-80 ${reduceMotion ? "animate-pulse" : "animate-spin"}`}
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    );
  }

  if (state === "up-to-date") {
    return (
      <svg {...iconProps}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }

  if (state === "ready") {
    return (
      <svg {...iconProps}>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v5h-5" />
      </svg>
    );
  }

  if (state === "error") {
    return (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  }

  return (
    <svg {...iconProps} className="opacity-80">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}
