import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import type {
  AppSettings,
  DevAppPreviewRoute,
  UpdateCheckState,
} from "../../../../shared/types";
import {
  copyDebugLog,
  fetchSettings,
  setDebugMode,
  setUserDisplayName,
  triggerApplyUpdate,
  triggerUpdateCheck,
} from "../../../rpc";
import { appEvents } from "../../../app-events";
import { devPreviewSelectClass, settingsHelperClass } from "../settings-shared";

type Props = {
  settings: AppSettings;
  devPreviewRoute?: DevAppPreviewRoute | null;
  onDevPreviewRouteChange?: (route: DevAppPreviewRoute | null) => void;
};

export function SectionGeneral({
  settings,
  devPreviewRoute = null,
  onDevPreviewRouteChange,
}: Props) {
  const queryClient = useQueryClient();
  const [updateState, setUpdateState] = useState<UpdateCheckState>("idle");
  const [updateMessage, setUpdateMessage] = useState<string | undefined>();
  const [isCopied, setIsCopied] = useState(false);
  const [userDisplayNameDraft, setUserDisplayNameDraft] = useState("");

  useEffect(() => {
    return appEvents.on("updateCheckStatus", ({ state, message }) => {
      setUpdateState(state);
      setUpdateMessage(message);
      if (state === "up-to-date") {
        setTimeout(() => setUpdateState("idle"), 4000);
      }
    });
  }, []);

  useEffect(() => {
    setUserDisplayNameDraft(settings.userDisplayName);
  }, [settings.userDisplayName]);

  const handleUserDisplayNameCommit = useCallback(async () => {
    const normalized = userDisplayNameDraft.trim();
    if (normalized === settings.userDisplayName) return;
    queryClient.setQueryData(["settings"], (old: AppSettings | undefined) =>
      old ? { ...old, userDisplayName: normalized } : old,
    );
    const ok = await setUserDisplayName(normalized);
    if (!ok) {
      queryClient.setQueryData(["settings"], await fetchSettings());
    }
  }, [queryClient, settings.userDisplayName, userDisplayNameDraft]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void handleUserDisplayNameCommit();
    }, 600);
    return () => clearTimeout(timer);
  }, [userDisplayNameDraft, handleUserDisplayNameCommit]);

  const handleCheckForUpdates = useCallback(() => {
    setUpdateState("checking");
    triggerUpdateCheck();
  }, []);

  const handleApplyUpdate = useCallback(() => {
    triggerApplyUpdate();
  }, []);

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
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Profile
        </h2>
        <label className="block">
          <span className="mb-2 block text-[13px] text-white/44 font-sans">
            Your name
          </span>
          <input
            type="text"
            value={userDisplayNameDraft}
            onChange={(event) => setUserDisplayNameDraft(event.target.value)}
            onBlur={() => void handleUserDisplayNameCommit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            placeholder="Your name"
            className="w-full rounded-lg border border-white/12 bg-white/5 px-4 py-3.5 text-[17px] font-medium text-white/78 outline-none transition-[border-color,background-color,box-shadow] duration-200 placeholder:text-white/24 hover:border-white/18 hover:bg-white/7 focus-visible:border-white/26 focus-visible:ring-2 focus-visible:ring-white/12 focus-visible:ring-offset-0"
          />
        </label>
        <p className={settingsHelperClass}>
          Stored as a general profile value. Formatting can use it for email
          sign-offs, and future features can reuse it elsewhere.
        </p>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Updates
        </h2>
        <div className="rounded-xl border border-white/11 bg-white/4 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div className="shrink-0 w-4 h-4 flex items-center justify-center">
              <UpdateIcon state={updateState} />
            </div>
            <div className="flex-1 min-w-0">
              <AnimatePresence mode="wait">
                <motion.span
                  key={updateState}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                  className={`block text-[17px] font-medium ${updateStateTextClass(updateState)}`}
                >
                  {updateStateLabel(updateState, updateMessage)}
                </motion.span>
              </AnimatePresence>
            </div>
            <UpdateAction
              state={updateState}
              onCheck={handleCheckForUpdates}
              onRestart={handleApplyUpdate}
            />
          </div>

          <AnimatePresence>
            {updateState === "error" && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="border-t border-white/10 px-4 py-2.5"
              >
                <p className="text-[14px] text-orange-300/85 leading-relaxed font-sans font-normal">
                  {updateMessage ??
                    "Something went wrong. Check your internet connection and try again."}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="mb-8">
        <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
          Diagnostics
        </h2>
        <div className="rounded-xl border border-white/11 bg-white/4 overflow-hidden">
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
                  settings.debugMode ? "text-amber-400/70" : "text-white/38"
                }
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <span
                className={`block text-[17px] font-medium ${settings.debugMode ? "text-amber-400/80" : "text-white/58"}`}
              >
                {settings.debugMode ? "Debug logging active" : "Debug logging"}
              </span>
            </div>
            <button
              onClick={handleDebugToggle}
              className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border ${
                settings.debugMode
                  ? "bg-amber-500/30 border-amber-400/30"
                  : "bg-white/7 border-white/14"
              }`}
              aria-label="Toggle debug logging"
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full transition-all duration-200 ${
                  settings.debugMode
                    ? "left-4 bg-amber-400/90"
                    : "left-0.5 bg-white/40"
                }`}
              />
            </button>
          </div>

          <AnimatePresence>
            {settings.debugMode && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="border-t border-white/10 px-4 py-3"
              >
                <button
                  onClick={handleCopyLog}
                  className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[15px] font-medium border transition-colors duration-200 cursor-pointer ${
                    isCopied
                      ? "bg-emerald-500/15 border-emerald-400/25 text-emerald-400/80"
                      : "border-white/12 hover:border-white/20 bg-white/4 hover:bg-white/7 text-white/52 hover:text-white/72"
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
          <h2 className="text-[14px] text-white/48 font-medium uppercase tracking-wider mb-3">
            Development
          </h2>
          <div className="relative group">
            <select
              value={devPreviewRoute ?? ""}
              onChange={handleDevPreviewRouteSelect}
              className={devPreviewSelectClass}
              aria-label="Preview root screen"
            >
              <option value="" className="bg-zinc-900 text-white/78">
                Default (normal routing)
              </option>
              <option value="permissions" className="bg-zinc-900 text-white">
                Permissions
              </option>
              <option value="onboarding" className="bg-zinc-900 text-white">
                Product onboarding
              </option>
              <option value="ready" className="bg-zinc-900 text-white">
                Ready (main)
              </option>
            </select>
            <span
              className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-white/38 transition-colors duration-200 group-hover:text-white/50 right-3.5"
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

function updateStateLabel(state: UpdateCheckState, message?: string): string {
  switch (state) {
    case "idle":
      return "Check for updates";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return "Downloading update…";
    case "up-to-date":
      return message ?? "You're up to date";
    case "ready":
      return "Update ready — restart to apply";
    case "error":
      return "Update check failed";
  }
}

function updateStateTextClass(state: UpdateCheckState): string {
  switch (state) {
    case "up-to-date":
      return "text-emerald-400/70";
    case "ready":
      return "text-blue-400/80";
    case "error":
      return "text-orange-400/70";
    default:
      return "text-white/55";
  }
}

function UpdateIcon({ state }: { state: UpdateCheckState }) {
  if (state === "checking" || state === "downloading") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-white/45 animate-spin"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    );
  }
  if (state === "up-to-date") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-emerald-400/70"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (state === "ready") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-blue-400/80"
      >
        <path d="M12 2v10m0 0 3-3m-3 3-3-3" />
        <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      </svg>
    );
  }
  if (state === "error") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-orange-400/70"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-white/38"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function UpdateAction({
  state,
  onCheck,
  onRestart,
}: {
  state: UpdateCheckState;
  onCheck: () => void;
  onRestart: () => void;
}) {
  if (state === "checking" || state === "downloading") {
    return null;
  }
  if (state === "ready") {
    return (
      <button
        onClick={onRestart}
        className="shrink-0 px-3 py-1.5 rounded-lg text-[15px] font-semibold bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/20 hover:border-blue-400/35 text-blue-300/90 transition-colors duration-200 cursor-pointer"
      >
        Restart
      </button>
    );
  }
  if (state === "error") {
    return (
      <button
        onClick={onCheck}
        className="shrink-0 px-3 py-1.5 rounded-lg text-[15px] font-medium border border-white/12 hover:border-white/20 bg-white/4 hover:bg-white/7 text-white/48 hover:text-white/68 transition-colors duration-200 cursor-pointer"
      >
        Retry
      </button>
    );
  }
  if (state === "up-to-date") {
    return null;
  }
  return (
    <button
      onClick={onCheck}
      className="shrink-0 px-3 py-1.5 rounded-lg text-[15px] font-medium border border-white/12 hover:border-white/20 bg-white/4 hover:bg-white/7 text-white/48 hover:text-white/68 transition-colors duration-200 cursor-pointer"
    >
      Check
    </button>
  );
}
