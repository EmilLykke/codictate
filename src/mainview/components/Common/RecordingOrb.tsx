import { motion, AnimatePresence } from "motion/react";
import type { AppStatus } from "../../../shared/types";
import { VoiceActivityCore } from "../Common/VoiceActivityCore";

export function RecordingOrb({ status }: { status: AppStatus }) {
  const isRecording = status === "recording";
  const isTranscribing = status === "transcribing";
  const isStreaming = status === "streaming";

  return (
    <div className="relative flex h-20 w-20 shrink-0 items-center justify-center">
      <AnimatePresence>
        {isRecording && (
          <motion.span
            key="pulse-ring"
            className="absolute inset-0 rounded-full border border-accent-red/30"
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1.35, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isRecording && (
          <motion.span
            key="mid-ring"
            className="absolute inset-0 rounded-full border border-accent-red/20"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1.18, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: 1.4,
              repeat: Infinity,
              ease: "easeOut",
              delay: 0.35,
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isStreaming && (
          <motion.span
            key="stream-pulse-ring"
            className="absolute inset-0 rounded-full border border-accent-blue/30"
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1.35, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isStreaming && (
          <motion.span
            key="stream-mid-ring"
            className="absolute inset-0 rounded-full border border-accent-blue/20"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1.18, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: 1.8,
              repeat: Infinity,
              ease: "easeOut",
              delay: 0.45,
            }}
          />
        )}
      </AnimatePresence>

      <motion.div
        className={`relative z-10 flex h-14 w-14 shrink-0 items-center justify-center rounded-full border transition-colors duration-500 ${
          isRecording
            ? "border-accent-red/25 bg-accent-red/8"
            : isTranscribing
              ? "border-accent-amber/20 bg-accent-amber/5"
              : isStreaming
                ? "border-accent-blue/25 bg-accent-blue/8"
                : "border-overlay/8 bg-surface-1"
        }`}
        style={{ transformOrigin: "center center" }}
        animate={{
          scale: isRecording || isStreaming ? [1, 1.04, 1] : 1,
        }}
        transition={
          isRecording || isStreaming
            ? { duration: 1.8, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.3 }
        }
      >
        <VoiceActivityCore status={status} variant="ready" />
      </motion.div>
    </div>
  );
}
