import { motion, AnimatePresence } from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import type { AppSettings, DevAppPreviewRoute } from "../../../shared/types";
import { SectionUi } from "./Sections/SectionUi";
import { SectionGeneral } from "./Sections/SectionGeneral";
import { SectionFun } from "./Sections/SectionFun";
import { useState, useRef, useEffect, useCallback } from "react";

const SECRET_UNLOCK_CLICK_COUNT = 3;
const SECRET_UNLOCK_WINDOW_MS = 900;

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  devPreviewRoute,
  onDevPreviewRouteChange,
}: {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  devPreviewRoute?: DevAppPreviewRoute | null;
  onDevPreviewRouteChange?: (route: DevAppPreviewRoute | null) => void;
}) {
  const [activeTab, setActiveTab] = useState<"ui" | "general" | "fun">("ui");
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
      setActiveTab("ui");
    }
  }, [isOpen]);

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
                className="fixed inset-0 z-50 m-auto flex h-fit max-h-[85vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1A1A1A] shadow-2xl"
              >
                <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
                  <Dialog.Title asChild>
                    <button
                      type="button"
                      onClick={handleTitleSecretTap}
                      className="text-[18px] font-medium text-white/90 outline-none focus-visible:ring-2 focus-visible:ring-white/20 rounded"
                    >
                      Settings
                    </button>
                  </Dialog.Title>
                  <Dialog.Description className="sr-only">
                    Application settings
                  </Dialog.Description>
                  <Dialog.Close asChild>
                    <button
                      className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white/90 transition-colors"
                      aria-label="Close settings"
                    >
                      <svg
                        width="20"
                        height="20"
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

                <div className="flex flex-1 overflow-hidden">
                  <div className="w-[180px] shrink-0 border-r border-white/10 bg-white/2 p-4">
                    <nav className="flex flex-col gap-1">
                      <button
                        onClick={() => setActiveTab("ui")}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] font-medium transition-colors duration-200 ${
                          activeTab === "ui"
                            ? "bg-white/10 text-white/90"
                            : "text-white/50 hover:bg-white/5 hover:text-white/70"
                        }`}
                      >
                        UI
                      </button>
                      <button
                        onClick={() => setActiveTab("general")}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] font-medium transition-colors duration-200 ${
                          activeTab === "general"
                            ? "bg-white/10 text-white/90"
                            : "text-white/50 hover:bg-white/5 hover:text-white/70"
                        }`}
                      >
                        General
                      </button>
                      {funModeUnlocked && (
                        <button
                          onClick={() => setActiveTab("fun")}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] font-medium transition-colors duration-200 ${
                            activeTab === "fun"
                              ? "bg-white/10 text-white/90"
                              : "text-white/50 hover:bg-white/5 hover:text-white/70"
                          }`}
                        >
                          Fun
                        </button>
                      )}
                    </nav>
                  </div>

                  <div className="flex-1 overflow-y-auto p-6">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={activeTab}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.15 }}
                      >
                        {activeTab === "ui" && (
                          <SectionUi settings={settings} />
                        )}
                        {activeTab === "general" && (
                          <SectionGeneral
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
