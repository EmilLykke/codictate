import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { PermissionState } from "../../app-events";
import type { SettingsPane } from "../../../shared/types";
import { PermissionRow } from "./PermissionRow";
import { WordmarkCodictate } from "../Brand/WordmarkCodictate";
import { triggerPermissionPrompt } from "../../rpc";

/** System prompts run in this order (Accessibility → Documents → Microphone → Input Monitoring). */
export const PERMISSION_ORDER: SettingsPane[] = [
  "accessibility",
  "documents",
  "microphone",
  "inputMonitoring",
];

const ROWS: {
  pane: SettingsPane;
  label: string;
  description: string;
}[] = [
  {
    pane: "accessibility",
    label: "Accessibility",
    description: "Simulate keystrokes to paste transcription into other apps",
  },
  {
    pane: "documents",
    label: "Files & Folders",
    description: "Save recordings and transcription history",
  },
  {
    pane: "microphone",
    label: "Microphone",
    description: "Record your voice to transcribe into text",
  },
  {
    pane: "inputMonitoring",
    label: "Input Monitoring",
    description: "Detect the shortcut while the app is in background",
  },
];

function firstMissingPane(p: PermissionState): SettingsPane | null {
  for (const pane of PERMISSION_ORDER) {
    if (!p[pane]) return pane;
  }
  return null;
}

export function PermissionScreen({
  permissions,
  onOpenSettings,
}: {
  permissions: PermissionState;
  onOpenSettings: (pane: SettingsPane) => void;
}) {
  const grantedCount = PERMISSION_ORDER.filter(
    (pane) => permissions[pane],
  ).length;
  const allGranted = grantedCount === 4;
  const activePane = firstMissingPane(permissions);

  useEffect(() => {
    if (allGranted || !activePane) return;
    // Input Monitoring is the last step. The user clicks "Allow →" to trigger
    // CGRequestListenEventAccess() via keyboard.requestInputMonitoringPrompt().
    // Never auto-trigger — the system dialog must only appear when the user asks.
    if (activePane === "inputMonitoring") return;
    // Native prompts are idempotent (macOS shows each dialog at most once), so
    // re-sending the command on every step transition is safe and ensures the
    // prompt fires even if KeyListener was still starting on the first attempt.
    triggerPermissionPrompt(activePane);
  }, [activePane, allGranted]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-codictate-page text-white select-none px-6 overflow-hidden">
      <div className="electrobun-webkit-app-region-drag absolute top-0 left-0 right-0 h-7 hover:bg-white/10 transition-colors duration-200" />
      <div className="w-full max-w-[410px]">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center mb-8"
        >
          <div className="relative w-12 h-12 mb-4 flex items-end justify-center gap-[3px]">
            {[0.4, 0.65, 1, 0.8, 0.55, 0.75, 0.45].map((h, i) => (
              <div
                key={i}
                className="w-[3px] rounded-full bg-white/20"
                style={{ height: `${h * 100}%` }}
              />
            ))}
          </div>
          <WordmarkCodictate
            as="h1"
            showMark
            className="text-[19px] font-semibold tracking-tight text-white/80"
          />
          <p className="text-[15px] text-white/25 mt-0.5">
            A few things before we start
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.4 }}
          className="mb-4"
        >
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[14px] text-white/25 font-medium uppercase tracking-wider">
              Permissions
            </span>
            <span className="text-[14px] text-white/25">
              {grantedCount} / 4
            </span>
          </div>
          <div className="h-[2px] bg-white/6 rounded-full overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${allGranted ? "bg-emerald-400" : "bg-white/30"}`}
              initial={{ width: 0 }}
              animate={{ width: `${(grantedCount / 4) * 100}%` }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </motion.div>

        <div className="flex flex-col gap-1.5">
          {ROWS.map((row, index) => {
            const granted = permissions[row.pane];
            const isActiveStep = !allGranted && activePane === row.pane;
            const isLockedFutureStep =
              !granted &&
              activePane !== null &&
              PERMISSION_ORDER.indexOf(row.pane) >
                PERMISSION_ORDER.indexOf(activePane);

            return (
              <PermissionRow
                key={row.pane}
                granted={granted}
                label={row.label}
                description={row.description}
                pane={row.pane}
                index={index}
                onOpen={(pane) => {
                  triggerPermissionPrompt(pane);
                  // Opening System Settings immediately can steal focus and prevent the
                  // Input Monitoring TCC sheet from appearing; defer that pane only.
                  if (pane === "inputMonitoring") {
                    window.setTimeout(() => onOpenSettings(pane), 800);
                  } else {
                    onOpenSettings(pane);
                  }
                }}
                isActiveStep={isActiveStep}
                isLockedFutureStep={isLockedFutureStep}
              />
            );
          })}
        </div>

        <AnimatePresence>
          {!allGranted && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ delay: 0.5, duration: 0.3 }}
              className="mt-5 text-[14px] text-white/15 text-center leading-relaxed"
            >
              One system prompt at a time — return here after each step.
            </motion.p>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {allGranted && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-5 flex flex-col items-center gap-1"
            >
              <div className="text-[15px] text-emerald-400/70 font-medium">
                All set — ready to dictate
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
