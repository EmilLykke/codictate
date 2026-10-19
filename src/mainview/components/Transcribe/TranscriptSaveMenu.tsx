import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion } from "motion/react";
import type {
  TranscriptExportFormat,
  TranscriptExportFacts,
} from "../../../shared/transcript-export";
import { transcriptExportOptions } from "../../../shared/transcript-export";
import type { TranscriptExportTarget } from "../../../shared/types";
import { transcriptExportSavedLine } from "../../../shared/file-transcription-copy";
import { appEvents } from "../../app-events";
import { exportTranscript, revealExportedTranscript } from "../../rpc";
import { DropdownChevron } from "../Common/DropdownChevron";
import { BUTTON, LINK } from "./transcribe-styles";

type Status =
  { kind: "saved"; path: string } | { kind: "failed"; message: string } | null;

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * "Save" and its menu: Text, Captions (.srt, .vtt) and JSON, for a window result or a History
 * entry. Picking one asks the main process to open the folder picker and save a new file,
 * named after the transcribed file, in the folder the user picks; how it went comes back as
 * `transcriptExportFinished` and is shown beside the button. Captions are greyed out, with the reason, when there are no timings.
 *
 * Renders the button and the status line as siblings, for the caller's flex row.
 */
export function TranscriptSaveMenu({
  target,
  facts,
  lastExport = null,
}: {
  target: TranscriptExportTarget;
  facts: TranscriptExportFacts;
  /** A save the main process already knows of, so a remount still says it. */
  lastExport?: { path: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>(
    lastExport ? { kind: "saved", path: lastExport.path } : null,
  );
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo(
    () =>
      transcriptExportOptions({
        speechModelId: facts.speechModelId,
        hasTimedTranscript: facts.hasTimedTranscript,
      }),
    [facts.speechModelId, facts.hasTimedTranscript],
  );

  const { kind, id } = target;
  useEffect(
    () =>
      appEvents.on("transcriptExportFinished", (result) => {
        if (result.target.kind !== kind || result.target.id !== id) return;
        if (result.status === "saved") {
          setStatus({ kind: "saved", path: result.path });
        } else if (result.status === "failed") {
          setStatus({ kind: "failed", message: result.message });
        }
        // Cancelled: whatever was said before still holds.
      }),
    [kind, id],
  );

  const pick = (format: TranscriptExportFormat) => {
    setOpen(false);
    setStatus((current) => (current?.kind === "failed" ? null : current));
    exportTranscript(target, format);
  };

  /** Arrow keys move between the choices that can be picked. */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role=menuitem]:not(:disabled)",
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`${BUTTON} inline-flex items-center gap-1.5`}
            aria-haspopup="menu"
          >
            Save
            <DropdownChevron open={open} />
          </button>
        </Popover.Trigger>
        <AnimatePresence>
          {open && (
            <Popover.Portal forceMount>
              <Popover.Content
                forceMount
                asChild
                align="start"
                side="bottom"
                sideOffset={6}
                collisionPadding={10}
              >
                <motion.div
                  ref={listRef}
                  role="menu"
                  aria-label="Save as"
                  onKeyDown={handleKeyDown}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: EASE_OUT }}
                  className="z-[10000] w-[280px] overflow-hidden rounded-xl border border-overlay/12 bg-surface-elevated/98 p-1 shadow-[var(--popover-shadow)] ring-1 ring-overlay/8 backdrop-blur-md"
                >
                  <div className="flex flex-col gap-0.5">
                    {options.map((option) => (
                      <button
                        key={option.format}
                        type="button"
                        role="menuitem"
                        disabled={!option.available}
                        onClick={() => pick(option.format)}
                        className={`rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-200 ${
                          option.available
                            ? "cursor-pointer border-transparent hover:border-overlay/12 hover:bg-surface-1 focus-visible:border-overlay/12 focus-visible:bg-surface-1"
                            : "cursor-not-allowed border-transparent"
                        }`}
                      >
                        <span
                          className={`block text-[14px] font-medium ${
                            option.available
                              ? "text-overlay/75"
                              : "text-overlay/30"
                          }`}
                        >
                          {option.label}
                        </span>
                        {option.unavailableReason && (
                          <span className="mt-0.5 block text-[12px] leading-snug text-overlay/35">
                            {option.unavailableReason}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </motion.div>
              </Popover.Content>
            </Popover.Portal>
          )}
        </AnimatePresence>
      </Popover.Root>

      <AnimatePresence mode="wait" initial={false}>
        {status !== null && (
          <motion.span
            key={status.kind === "saved" ? status.path : status.message}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className={`min-w-0 text-[13px] ${
              status.kind === "saved" ? "text-overlay/45" : "text-accent-red/80"
            }`}
            role="status"
          >
            {status.kind === "saved" ? (
              <>
                {transcriptExportSavedLine(status.path)}{" "}
                <button
                  type="button"
                  onClick={() => revealExportedTranscript(target)}
                  className={LINK}
                >
                  Show
                </button>
              </>
            ) : (
              status.message
            )}
          </motion.span>
        )}
      </AnimatePresence>
    </>
  );
}
