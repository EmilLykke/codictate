import { motion, AnimatePresence } from "motion/react";
import type { SettingsPane } from "../../../shared/types";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.06, duration: 0.35, ease: EASE_OUT },
  }),
  exit: { opacity: 0, y: -6, transition: { duration: 0.2 } },
};

export function PermissionRow({
  granted,
  label,
  description,
  pane,
  index,
  onOpen,
  isActiveStep,
  isLockedFutureStep,
}: {
  granted: boolean;
  label: string;
  description: string;
  pane: SettingsPane;
  index: number;
  onOpen: (pane: SettingsPane) => void;
  isActiveStep: boolean;
  isLockedFutureStep: boolean;
}) {
  const showAllowButton = !granted && isActiveStep;

  return (
    <motion.div
      custom={index}
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      layout
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors duration-300 ${
        granted
          ? "border-overlay/6 bg-overlay/3"
          : isActiveStep
            ? "border-overlay/18 bg-overlay/4"
            : "border-overlay/10 bg-overlay/2"
      }`}
    >
      <div className="shrink-0 w-5 flex items-center justify-center">
        <AnimatePresence mode="wait">
          {granted ? (
            <motion.span
              key="check"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
              className="block w-[7px] h-[7px] rounded-full bg-accent-emerald"
            />
          ) : (
            <motion.span
              key="dot"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              className="block w-[7px] h-[7px] rounded-full bg-overlay/20"
            />
          )}
        </AnimatePresence>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span
            className={`text-[17px] font-medium leading-none transition-colors duration-300 ${granted ? "text-overlay/60" : "text-overlay/80"}`}
          >
            {label}
          </span>
          {granted && (
            <motion.span
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-[14px] text-accent-emerald/60 font-medium"
            >
              granted
            </motion.span>
          )}
        </div>
        <p className="text-[15px] text-overlay/25 mt-0.5 leading-snug">
          {description}
        </p>
        {isLockedFutureStep && (
          <p className="text-[16px] text-overlay/12 mt-1 leading-snug">
            Complete the step above first
          </p>
        )}
      </div>

      <AnimatePresence>
        {showAllowButton && (
          <motion.button
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 6 }}
            onClick={() => onOpen(pane)}
            className="shrink-0 text-[15px] text-overlay/35 hover:text-overlay/70 border border-overlay/8 hover:border-overlay/20 px-2.5 py-1 rounded-lg transition-colors duration-200 cursor-pointer"
          >
            Allow →
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
