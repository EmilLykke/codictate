import { motion } from "motion/react";
import type { AppStatus } from "../../../shared/types";

const READY_BASES = [0.45, 0.75, 1, 0.7, 0.5] as const;
/** Center bar brightest; outer bars slightly muted (reference island look). */
const READY_IDLE_OPACITY = ["55%", "62%", "78%", "62%", "55%"] as const;
const READY_REC_OPACITY = ["68%", "76%", "92%", "76%", "68%"] as const;
/** Indicator HUD: all white; idle height ladder. */
const INDICATOR_IDLE_OPACITY = ["42%", "52%", "72%", "52%", "42%"] as const;
const INDICATOR_REC_OPACITY = ["58%", "68%", "92%", "68%", "58%"] as const;

type Variant = "ready" | "compact" | "indicator";

const variantClass: Record<
  Variant,
  { row: string; bar: string; transcribeBar: string }
> = {
  ready: {
    row: "flex items-end gap-[2px] h-4",
    bar: "block w-[3px] rounded-full",
    transcribeBar: "block w-[3px] rounded-full bg-accent-amber/60",
  },
  compact: {
    row: "flex items-end gap-[1.5px] h-3",
    bar: "block w-[2.5px] rounded-full",
    transcribeBar: "block w-[2.5px] rounded-full bg-accent-amber/65",
  },
  /** Desktop HUD — black circle; white bars only; motion encodes state. */
  indicator: {
    row: "flex items-end justify-center gap-[2.5px] h-4",
    bar: "block w-[3px] rounded-full",
    transcribeBar: "block w-[3px] rounded-full",
  },
};

export function VoiceActivityCore({
  status,
  variant,
  theme,
}: {
  status: AppStatus;
  variant: Variant;
  theme?: "light" | "dark";
}) {
  const isRecording = status === "recording";
  const isTranscribing = status === "transcribing";
  const isStreaming = status === "streaming";
  const isActive = isRecording || isStreaming;
  const vc = variantClass[variant];
  const indicatorRgb = theme === "light" ? "0 0 0" : "255 255 255";

  if (isTranscribing) {
    if (variant === "indicator") {
      return (
        <motion.div className={vc.row} initial="hidden" animate="visible">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className={vc.transcribeBar}
              animate={{ scaleY: [0.22, 1, 0.22] }}
              transition={{
                duration: 0.72,
                repeat: Infinity,
                delay: i * 0.18,
                ease: [0.45, 0, 0.55, 1],
              }}
              style={{
                height: "100%",
                transformOrigin: "bottom",
                backgroundColor: `rgb(${indicatorRgb} / 0.88)`,
              }}
            />
          ))}
        </motion.div>
      );
    }
    return (
      <motion.div className={vc.row} initial="hidden" animate="visible">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className={vc.transcribeBar}
            animate={{ scaleY: [0.28, 1, 0.28] }}
            transition={{
              duration: 0.85,
              repeat: Infinity,
              delay: i * 0.14,
              ease: [0.45, 0, 0.55, 1],
            }}
            style={{ height: "100%", transformOrigin: "bottom" }}
          />
        ))}
      </motion.div>
    );
  }

  if (variant === "indicator") {
    return (
      <motion.div className={vc.row} animate={isActive ? "active" : "idle"}>
        {READY_BASES.map((base, i) => (
          <motion.span
            key={i}
            className={vc.bar}
            style={{
              height: "100%",
              transformOrigin: "bottom",
              backgroundColor: isActive
                ? `rgb(${indicatorRgb} / ${INDICATOR_REC_OPACITY[i]})`
                : `rgb(${indicatorRgb} / ${INDICATOR_IDLE_OPACITY[i]})`,
            }}
            animate={
              isActive
                ? {
                    scaleY: [base, base * 0.32 + 0.1, base + 0.2, base],
                  }
                : { scaleY: base }
            }
            transition={
              isActive
                ? {
                    duration: 0.52 + i * 0.055,
                    repeat: Infinity,
                    delay: i * 0.085,
                    ease: [0.45, 0, 0.55, 1],
                  }
                : { duration: 0.45, ease: [0.22, 1, 0.36, 1] }
            }
          />
        ))}
      </motion.div>
    );
  }

  const barColor = isStreaming
    ? (opacity: string) => `rgb(var(--accent-blue-rgb) / ${opacity})`
    : isRecording
      ? (opacity: string) => `rgb(var(--accent-red-rgb) / ${opacity})`
      : (opacity: string) => `rgb(var(--overlay-rgb) / ${opacity})`;

  return (
    <motion.div className={vc.row} animate={isActive ? "active" : "idle"}>
      {READY_BASES.map((base, i) => (
        <motion.span
          key={i}
          className={vc.bar}
          style={{
            height: "100%",
            transformOrigin: "bottom",
            backgroundColor: isActive
              ? barColor(READY_REC_OPACITY[i])
              : barColor(READY_IDLE_OPACITY[i]),
          }}
          animate={
            isActive
              ? {
                  scaleY: [base, base * 0.35 + 0.12, base + 0.18, base],
                }
              : { scaleY: base }
          }
          transition={
            isActive
              ? {
                  duration: 0.58 + i * 0.06,
                  repeat: Infinity,
                  delay: i * 0.09,
                  ease: [0.45, 0, 0.55, 1],
                }
              : { duration: 0.5, ease: [0.22, 1, 0.36, 1] }
          }
        />
      ))}
    </motion.div>
  );
}
