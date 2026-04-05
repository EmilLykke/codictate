import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import type { SettingsPane } from "../../../shared/types";

export function PermissionStep({
  label,
  description,
  note,
  granted,
  pane,
  onOpenSettings,
}: {
  label: string;
  description: string;
  note?: string;
  granted: boolean;
  pane: SettingsPane;
  onOpenSettings: (pane: SettingsPane) => void;
}) {
  const queryClient = useQueryClient();
  const [hasOpened, setHasOpened] = useState(false);

  const handleAllow = () => {
    onOpenSettings(pane);
    setHasOpened(true);
  };

  const handleCheckStatus = () => {
    void queryClient.invalidateQueries({ queryKey: ["permissions"] });
  };

  return (
    <div className="flex flex-col items-center text-center w-full max-w-[400px] mx-auto">
      {/* Icon area */}
      <div
        className={`w-16 h-16 rounded-2xl border flex items-center justify-center mb-7 transition-colors duration-500 ${
          granted
            ? "border-emerald-400/30 bg-emerald-400/10"
            : "border-white/10 bg-white/5"
        }`}
      >
        <AnimatePresence mode="wait">
          {granted ? (
            <motion.div
              key="check"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 22 }}
              className="w-7 h-7 rounded-full bg-emerald-400/20 border border-emerald-400/50 flex items-center justify-center"
            >
              <svg
                width="13"
                height="10"
                viewBox="0 0 13 10"
                fill="none"
                className="text-emerald-400"
              >
                <path
                  d="M1.5 5L5 8.5L11.5 1.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </motion.div>
          ) : (
            <motion.div key="icon" exit={{ opacity: 0, scale: 0.8 }}>
              <PermissionIcon pane={pane} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <h2 className="text-[30px] font-semibold text-white tracking-tight mb-3">
        {label}
      </h2>
      <p className="text-[21px] text-white/60 leading-relaxed mb-2">
        {description}
      </p>
      {note && (
        <p className="text-[19px] text-white/35 leading-relaxed mt-1">{note}</p>
      )}

      <div className="mt-10 flex flex-col items-center gap-3">
        <AnimatePresence mode="wait">
          {granted ? (
            <motion.div
              key="granted-label"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[21px] text-emerald-400/80 font-medium"
            >
              Permission granted
            </motion.div>
          ) : (
            <motion.div
              key="buttons"
              className="flex flex-col items-center gap-3"
            >
              <motion.button
                onClick={handleAllow}
                className={`text-[21px] border px-7 py-3 rounded-xl transition-colors duration-200 cursor-pointer font-medium ${
                  hasOpened
                    ? "text-white/25 border-white/6 bg-white/2"
                    : "text-white/80 hover:text-white border-white/15 hover:border-white/35 bg-white/5 hover:bg-white/10"
                }`}
              >
                Allow in System Preferences →
              </motion.button>

              <AnimatePresence>
                {hasOpened && !granted && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    className="flex flex-col items-center gap-2"
                  >
                    <motion.button
                      type="button"
                      onClick={handleCheckStatus}
                      className="text-[21px] text-white/80 hover:text-white border border-white/15 hover:border-white/35 bg-white/5 hover:bg-white/10 px-7 py-3 rounded-xl transition-colors duration-200 cursor-pointer font-medium"
                    >
                      Check status
                    </motion.button>
                    <p className="text-[17px] text-white/38 max-w-[280px] leading-snug">
                      We only continue after this permission is on. Return here
                      after allowing in System Settings — we also refresh every
                      few seconds.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function PermissionIcon({ pane }: { pane: SettingsPane }) {
  switch (pane) {
    case "inputMonitoring":
      return (
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          className="text-white/50"
        >
          <rect
            x="2"
            y="6"
            width="20"
            height="12"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M6 14h3M12 14h.01M15 14h.01M18 14h.01"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "microphone":
      return (
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          className="text-white/50"
        >
          <rect
            x="8"
            y="2"
            width="8"
            height="13"
            rx="4"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M5 10c0 3.866 3.134 7 7 7s7-3.134 7-7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M12 17v5M10 22h4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "accessibility":
      return (
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          className="text-white/50"
        >
          <circle
            cx="12"
            cy="5"
            r="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M3 9h18M12 9v13M7 14l5-2 5 2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "documents":
      return (
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          className="text-white/50"
        >
          <path
            d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M14 2v6h6M8 13h8M8 17h5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
