import { motion } from "motion/react";
import type { ShortcutId } from "../../../shared/types";
import { ShortcutPicker } from "../Settings/ShortcutPicker";

export function ShortcutStep({
  value,
  onChange,
  onContinue,
}: {
  value: ShortcutId;
  onChange: (id: ShortcutId) => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col items-center w-full max-w-[420px] mx-auto">
      <h2 className="text-[30px] font-semibold text-white tracking-tight mb-3 text-center">
        Choose your shortcut
      </h2>
      <p className="text-[21px] text-white/60 mb-8 text-center">
        This is the key you'll hold to start dictating.
      </p>

      <div className="w-full">
        <ShortcutPicker value={value} onChange={onChange} />
      </div>

      <motion.button
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.3 }}
        onClick={onContinue}
        className="mt-8 text-[21px] text-white/80 hover:text-white border border-white/15 hover:border-white/35 bg-white/5 hover:bg-white/10 px-8 py-3 rounded-xl transition-colors duration-200 cursor-pointer font-medium"
      >
        Continue →
      </motion.button>
    </div>
  );
}
