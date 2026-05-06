import { motion, AnimatePresence } from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import type {
  AppSettings,
  AppStatus,
  DevAppPreviewRoute,
} from "../../../shared/types";
import { SectionUi } from "./Sections/SectionUi";
import { SectionGeneral } from "./Sections/SectionGeneral";
import { SectionDebug } from "./Sections/SectionDebug";
import { SectionShortcuts } from "./Sections/SectionShortcuts";
import { SectionAudio } from "./Sections/SectionAudio";
import { SectionFun } from "./Sections/SectionFun";
import { SectionHistory } from "./Sections/SectionHistory";
import { useState, useRef, useEffect, useCallback } from "react";

const SECRET_UNLOCK_CLICK_COUNT = 3;
const SECRET_UNLOCK_WINDOW_MS = 900;

type SettingsTab =
  | "general"
  | "audio"
  | "shortcuts"
  | "ui"
  | "history"
  | "debug"
  | "fun";

const TAB_BUTTON =
  "flex items-center gap-3 px-3 py-2 rounded-lg text-[15px] font-medium transition-colors duration-200 cursor-pointer w-full text-left";

export type { SettingsTab };

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  status,
  initialTab,
  devPreviewRoute,
  onDevPreviewRouteChange,
}: {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  status: AppStatus;
  initialTab?: SettingsTab;
  devPreviewRoute?: DevAppPreviewRoute | null;
  onDevPreviewRouteChange?: (route: DevAppPreviewRoute | null) => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [funModeUnlocked, setFunModeUnlocked] = useState(false);
  const titleClickCountRef = useRef(0);
  const titleClickResetTimerRef = useRef<number | null>(null);

  const handleTitleSecretTap = useCallback(() => {
    if (titleClickResetTimerRef.current !== null) {
      window.clearTimeout(titleClickResetTimerRef.current);
    }
    titleClickCountRef.current += 1;
    if (titleClickCountRef.current >= SECRET_UNLOCK_CLICK_COUNT) {
      titleClickCountRef.current = 0;
      titleClickResetTimerRef.current = null;
      setFunModeUnlocked(true);
      setActiveTab("fun");
      return;
    }
    titleClickResetTimerRef.current = window.setTimeout(() => {
      titleClickCountRef.current = 0;
      titleClickResetTimerRef.current = null;
    }, SECRET_UNLOCK_WINDOW_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (titleClickResetTimerRef.current !== null) {
        window.clearTimeout(titleClickResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab ?? "general");
    }
  }, [isOpen, initialTab]);

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay forceMount asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
              />
            </Dialog.Overlay>
            <Dialog.Content
              forceMount
              asChild
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="fixed inset-0 z-50 m-auto flex max-h-[85vh] w-full max-w-[820px] flex-col overflow-hidden rounded-2xl border border-overlay/10 bg-surface-elevated shadow-2xl"
              >
                <Dialog.Title className="sr-only">Settings</Dialog.Title>
                <Dialog.Description className="sr-only">
                  Application settings
                </Dialog.Description>

                <div className="flex flex-1 overflow-hidden">
                  <div className="w-[200px] shrink-0 border-r border-overlay/8 p-5 pt-7">
                    <button
                      type="button"
                      onClick={handleTitleSecretTap}
                      className="mb-5 px-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-overlay/40 outline-none focus-visible:ring-2 focus-visible:ring-overlay/20 rounded cursor-default"
                    >
                      Settings
                    </button>

                    <nav className="flex flex-col gap-0.5">
                      <button
                        onClick={() => setActiveTab("general")}
                        className={`${TAB_BUTTON} ${
                          activeTab === "general"
                            ? "bg-surface-3 text-overlay/90"
                            : "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70"
                        }`}
                      >
                        General
                      </button>
                      <button
                        onClick={() => setActiveTab("audio")}
                        className={`${TAB_BUTTON} ${
                          activeTab === "audio"
                            ? "bg-surface-3 text-overlay/90"
                            : "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70"
                        }`}
                      >
                        Audio
                      </button>
                      <button
                        onClick={() => setActiveTab("ui")}
                        className={`${TAB_BUTTON} ${
                          activeTab === "ui"
                            ? "bg-surface-3 text-overlay/90"
                            : "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70"
                        }`}
                      >
                        Indicator
                      </button>
                      <button
                        onClick={() => setActiveTab("shortcuts")}
                        className={`${TAB_BUTTON} ${
                          activeTab === "shortcuts"
                            ? "bg-surface-3 text-overlay/90"
                            : "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70"
                        }`}
                      >
                        Shortcuts
                      </button>
                      <button
                        onClick={() => setActiveTab("history")}
                        className={`${TAB_BUTTON} ${
                          activeTab === "history"
                            ? "bg-surface-3 text-overlay/90"
                            : "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70"
                        }`}
                      >
                        History
                      </button>
                      <button
                        onClick={() => setActiveTab("debug")}
                        className={`${TAB_BUTTON} ${
                          activeTab === "debug"
                            ? "bg-surface-3 text-overlay/90"
                            : "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70"
                        }`}
                      >
                        Debug
                      </button>
                      {funModeUnlocked && (
                        <button
                          onClick={() => setActiveTab("fun")}
                          className={`${TAB_BUTTON} ${
                            activeTab === "fun"
                              ? "bg-surface-3 text-overlay/90"
                              : "text-overlay/50 hover:bg-surface-1 hover:text-overlay/70"
                          }`}
                        >
                          Fun
                        </button>
                      )}
                    </nav>
                  </div>

                  <div className="flex-1 overflow-y-auto p-8 pt-7">
                    <div className="flex items-center justify-between mb-6">
                      <h2 className="text-[22px] font-semibold text-overlay/90">
                        {activeTab === "general"
                          ? "General"
                          : activeTab === "audio"
                            ? "Audio"
                            : activeTab === "ui"
                              ? "Indicator"
                              : activeTab === "shortcuts"
                                ? "Shortcuts"
                                : activeTab === "history"
                                  ? "History"
                                  : activeTab === "debug"
                                    ? "Debug"
                                    : "Fun"}
                      </h2>
                      <Dialog.Close asChild>
                        <button
                          className="rounded-lg p-1.5 text-overlay/40 hover:bg-surface-3 hover:text-overlay/80 transition-colors cursor-pointer"
                          aria-label="Close settings"
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </Dialog.Close>
                    </div>

                    <AnimatePresence mode="wait">
                      <motion.div
                        key={activeTab}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.15 }}
                      >
                        {activeTab === "general" && (
                          <SectionGeneral settings={settings} />
                        )}
                        {activeTab === "audio" && (
                          <SectionAudio settings={settings} />
                        )}
                        {activeTab === "shortcuts" && (
                          <SectionShortcuts
                            settings={settings}
                            status={status}
                          />
                        )}
                        {activeTab === "ui" && (
                          <SectionUi settings={settings} />
                        )}
                        {activeTab === "history" && (
                          <SectionHistory settings={settings} />
                        )}
                        {activeTab === "debug" && (
                          <SectionDebug
                            settings={settings}
                            devPreviewRoute={devPreviewRoute}
                            onDevPreviewRouteChange={onDevPreviewRouteChange}
                          />
                        )}
                        {activeTab === "fun" && funModeUnlocked && (
                          <SectionFun
                            settings={settings}
                            onBackToSettings={() => setActiveTab("general")}
                          />
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
