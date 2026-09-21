import { useCallback, useState, type ChangeEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Switch } from "../../Common/Switch";
import type { AppSettings, DevAppPreviewRoute } from "../../../../shared/types";
import { copyDebugLog, setDebugMode } from "../../../rpc";
import { devPreviewSelectClass, settingsHelperClass } from "../settings-shared";

type Props = {
  settings: AppSettings;
  devPreviewRoute?: DevAppPreviewRoute | null;
  onDevPreviewRouteChange?: (route: DevAppPreviewRoute | null) => void;
};

export function SectionDebug({
  settings,
  devPreviewRoute = null,
  onDevPreviewRouteChange,
}: Props) {
  const [isCopied, setIsCopied] = useState(false);

  const handleDebugToggle = useCallback(async () => {
    await setDebugMode(!settings.debugMode);
  }, [settings.debugMode]);

  const handleCopyLog = useCallback(() => {
    copyDebugLog();
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }, []);

  const handleDevPreviewRouteSelect = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const v = e.target.value;
      onDevPreviewRouteChange?.(v === "" ? null : (v as DevAppPreviewRoute));
    },
    [onDevPreviewRouteChange],
  );

  const showDevTools = import.meta.env.DEV && onDevPreviewRouteChange != null;

  return (
    <>
      <div className="mb-8">
        <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
          Diagnostics
        </h2>
        <div className="rounded-xl border border-overlay/11 bg-surface-1 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div className="shrink-0 w-4 h-4 flex items-center justify-center">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={
                  settings.debugMode
                    ? "text-accent-amber/70"
                    : "text-overlay/38"
                }
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <span
                className={`block text-[17px] font-medium ${settings.debugMode ? "text-accent-amber/80" : "text-overlay/58"}`}
              >
                {settings.debugMode ? "Debug logging active" : "Debug logging"}
              </span>
            </div>
            <Switch
              checked={settings.debugMode}
              onCheckedChange={() => void handleDebugToggle()}
              aria-label="Toggle debug logging"
            />
          </div>

          <AnimatePresence>
            {settings.debugMode && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="border-t border-overlay/10 px-4 py-3"
              >
                <button
                  onClick={handleCopyLog}
                  className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[15px] font-medium border transition-colors duration-200 cursor-pointer ${
                    isCopied
                      ? "bg-accent-emerald/15 border-accent-emerald/25 text-accent-emerald/80"
                      : "border-overlay/12 hover:border-overlay/20 bg-surface-1 hover:bg-surface-2 text-overlay/52 hover:text-overlay/72"
                  }`}
                >
                  {isCopied ? (
                    <>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Copied to clipboard
                    </>
                  ) : (
                    <>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect
                          x="9"
                          y="9"
                          width="13"
                          height="13"
                          rx="2"
                          ry="2"
                        />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      Copy log to clipboard
                    </>
                  )}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <p className={settingsHelperClass}>
          Records session activity. Stops automatically after 5 minutes. Share
          with support for diagnostics.
        </p>
      </div>

      {showDevTools && (
        <div className="mb-8">
          <h2 className="text-[14px] text-overlay/48 font-medium uppercase tracking-wider mb-3">
            Development
          </h2>
          <div className="relative group">
            <select
              value={devPreviewRoute ?? ""}
              onChange={handleDevPreviewRouteSelect}
              className={devPreviewSelectClass}
              aria-label="Preview root screen"
            >
              <option value="" className="bg-surface-elevated text-overlay/78">
                Default (normal routing)
              </option>
              <option
                value="permissions"
                className="bg-surface-elevated text-codictate-foreground"
              >
                Permissions
              </option>
              <option
                value="onboarding"
                className="bg-surface-elevated text-codictate-foreground"
              >
                Product onboarding
              </option>
              <option
                value="ready"
                className="bg-surface-elevated text-codictate-foreground"
              >
                Ready (main)
              </option>
            </select>
            <span
              className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-overlay/38 transition-colors duration-200 group-hover:text-overlay/50 right-3.5"
              aria-hidden
            >
              <svg
                className="size-[18px]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </div>
          <p className={settingsHelperClass}>
            Vite dev only: jump to a root screen to iterate on UI. Closes
            Settings. Open Settings from the menu to clear.
          </p>
        </div>
      )}
    </>
  );
}
