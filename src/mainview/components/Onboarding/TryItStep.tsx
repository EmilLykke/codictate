import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { ShortcutId } from "../../../shared/types";
import { Kbd } from "../Common/Kbd";

const SHORTCUT_KEYS: Record<ShortcutId, string[]> = {
  "option-space": ["⌥", "Space"],
  "right-option": ["Right ⌥"],
  "option-f1": ["⌥", "F1"],
  "option-f2": ["⌥", "F2"],
  "option-enter": ["⌥", "Enter"],
};

export function TryItStep({
  shortcutId,
  onDone,
}: {
  shortcutId: ShortcutId;
  onDone: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [hasTried, setHasTried] = useState(false);

  useEffect(() => {
    // Focus the textarea so native paste lands here
    const frame = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const keys = SHORTCUT_KEYS[shortcutId];

  return (
    <div className="flex flex-col items-center w-full max-w-[420px] mx-auto">
      <h2 className="text-[30px] font-semibold text-white tracking-tight mb-3 text-center">
        Give it a try
      </h2>
      <p className="text-[21px] text-white/60 mb-6 text-center leading-relaxed">
        Click the box below and hold your shortcut to start dictating. Release
        to transcribe.
      </p>

      {/* Shortcut hint */}
      <div className="flex items-center gap-1.5 mb-6">
        {keys.map((key, i) => (
          <span key={key} className="flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-white/40 text-[19px] font-light">+</span>
            )}
            <Kbd>{key}</Kbd>
          </span>
        ))}
        <span className="text-[19px] text-white/40 ml-2">to dictate</span>
      </div>

      {/* Text area */}
      <textarea
        ref={textareaRef}
        onInput={() => {
          if (textareaRef.current && textareaRef.current.value.length > 0) {
            setHasTried(true);
          }
        }}
        className="w-full h-[120px] bg-white/4 border border-white/10 rounded-xl px-4 py-3 text-[21px] text-white/80 placeholder-white/25 resize-none outline-none focus:border-white/20 transition-colors duration-200"
        placeholder="Your transcription will appear here..."
      />

      <AnimatePresence>
        {hasTried && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            onClick={onDone}
            className="mt-6 text-[21px] text-white/80 hover:text-white border border-white/20 hover:border-white/40 bg-white/6 hover:bg-white/10 px-8 py-3 rounded-xl transition-colors duration-200 cursor-pointer font-medium"
          >
            I'm ready →
          </motion.button>
        )}
      </AnimatePresence>

      {!hasTried && (
        <p className="mt-5 text-[18px] text-white/25 text-center">
          The "I'm ready" button will appear after your first dictation.
        </p>
      )}
    </div>
  );
}
