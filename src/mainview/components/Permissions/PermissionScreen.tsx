import { useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { PermissionState } from "../../app-events";
import type { SettingsPane } from "../../../shared/types";
import { requestDocumentsAccess } from "../../rpc";
import { PermissionRow } from "./PermissionRow";
import { WordmarkCodictate } from "../Brand/WordmarkCodictate";

export function PermissionScreen({
  permissions,
  onOpenSettings,
}: {
  permissions: PermissionState;
  onOpenSettings: (pane: SettingsPane) => void;
}) {
  // For Documents: trigger the native macOS dialog first; fall back to System
  // Preferences only if the app was previously denied (dialog won't re-appear).
  const handleAllow = useCallback(
    async (pane: SettingsPane) => {
      if (pane === "documents") {
        const granted = await requestDocumentsAccess();
        if (!granted) {
          onOpenSettings(pane);
        }
      } else {
        onOpenSettings(pane);
      }
    },
    [onOpenSettings],
  );

  const grantedCount = [
    permissions.inputMonitoring,
    permissions.microphone,
    permissions.accessibility,
    permissions.documents,
  ].filter(Boolean).length;

  const allGranted = grantedCount === 4;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-codictate-page text-white select-none px-6">
      <div className="electrobun-webkit-app-region-drag absolute top-0 left-0 right-0 h-7 hover:bg-white/3 transition-colors duration-200" />
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
            className="text-[23px] font-semibold tracking-tight text-white/80"
          />
          <p className="text-[19px] text-white/25 mt-0.5">
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
            <span className="text-[18px] text-white/25 font-medium uppercase tracking-wider">
              Permissions
            </span>
            <span className="text-[18px] text-white/25">
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
          <PermissionRow
            granted={permissions.inputMonitoring}
            label="Input Monitoring"
            description="Detect the shortcut while the app is in background"
            pane="inputMonitoring"
            index={0}
            onOpen={handleAllow}
          />
          <PermissionRow
            granted={permissions.microphone}
            label="Microphone"
            description="Record your voice to transcribe into text"
            pane="microphone"
            index={1}
            onOpen={handleAllow}
          />
          <PermissionRow
            granted={permissions.accessibility}
            label="Accessibility"
            description="Simulate keystrokes to paste transcription into other apps"
            pane="accessibility"
            index={2}
            onOpen={handleAllow}
          />
          <PermissionRow
            granted={permissions.documents}
            label="Files & Folders"
            description="Save recordings and transcription history"
            pane="documents"
            index={3}
            onOpen={handleAllow}
          />
        </div>

        <AnimatePresence>
          {!allGranted && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ delay: 0.5, duration: 0.3 }}
              className="mt-5 text-[18px] text-white/15 text-center leading-relaxed"
            >
              “Allow” opens System Settings → Privacy & Security. Use the list
              on the right to enable Input Monitoring, Microphone,
              Accessibility, and Files & Folders for Codictate.
              <br />
              Updates live when you return here. Input Monitoring needs an app
              restart after you allow it.
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
              <div className="text-[19px] text-emerald-400/70 font-medium">
                All set — ready to dictate
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
