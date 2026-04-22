import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { ShortcutId } from "../../../shared/types";
import type { PlatformRuntime } from "../../../shared/platform";
import {
  shortcutOptionById,
  shortcutOptionsGroupedForPlatform,
} from "../../../shared/shortcut-options";
import { Kbd } from "../Common/Kbd";

function DropdownChevron({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-white/45 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ShortcutPicker({
  value,
  onChange,
  platform,
}: {
  value: ShortcutId;
  onChange: (id: ShortcutId) => void;
  platform: PlatformRuntime;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = shortcutOptionById(value, platform);
  const groups = shortcutOptionsGroupedForPlatform(platform);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pick = (id: ShortcutId) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <motion.button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-white/11 bg-white/4 px-4 py-3 text-left transition-colors duration-200 hover:border-white/16 hover:bg-white/6"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {selected.keys.map((key, i) => (
            <span
              key={`${selected.id}-t-${i}`}
              className="flex items-center gap-1.5"
            >
              {i > 0 && (
                <span className="text-[18px] font-light text-white/40">+</span>
              )}
              <Kbd>{key}</Kbd>
            </span>
          ))}
        </div>
        <span className="hidden min-w-0 max-w-[min(11rem,46%)] shrink-0 truncate text-right font-sans text-[17px] text-white/62 sm:block sm:text-[19px]">
          {selected.label}
        </span>
        <DropdownChevron open={open} />
      </motion.button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 right-0 top-[calc(100%+8px)] z-120 overflow-hidden rounded-xl border border-white/12 bg-[#141416]/98 shadow-[0_16px_48px_rgba(0,0,0,0.55)] ring-1 ring-white/8 backdrop-blur-md"
            role="listbox"
            aria-label="Choose shortcut"
          >
            <div
              className="max-h-[min(340px,52vh)] overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]"
              style={{ scrollbarWidth: "thin" }}
            >
              <div className="flex flex-col gap-4 p-1">
                {groups.map(({ family, title, options }) => (
                  <div key={family}>
                    <p className="px-3 pb-1.5 pt-2 text-[14px] font-medium uppercase tracking-wider text-white/36">
                      {title}
                    </p>
                    <div className="flex flex-col gap-1">
                      {options.map((opt) => {
                        const isActive = opt.id === value;
                        return (
                          <motion.button
                            key={opt.id}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            onClick={() => pick(opt.id)}
                            className={`relative flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors duration-200 ${
                              isActive
                                ? "border-white/26 bg-white/6"
                                : "border-white/11 bg-white/4 hover:border-white/16 hover:bg-white/6"
                            }`}
                          >
                            <div
                              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                              style={{
                                borderColor: isActive
                                  ? "rgba(255,255,255,0.38)"
                                  : "rgba(255,255,255,0.18)",
                              }}
                            >
                              {isActive ? (
                                <motion.div
                                  initial={{ scale: 0 }}
                                  animate={{ scale: 1 }}
                                  transition={{
                                    type: "spring",
                                    stiffness: 500,
                                    damping: 25,
                                  }}
                                  className="h-2 w-2 rounded-full bg-white/60"
                                />
                              ) : null}
                            </div>

                            <div className="flex min-w-0 flex-1 items-center gap-1.5">
                              {opt.keys.map((key, i) => (
                                <span
                                  key={`${opt.id}-key-${i}`}
                                  className="flex items-center gap-1.5"
                                >
                                  {i > 0 && (
                                    <span className="text-[18px] font-light text-white/40">
                                      +
                                    </span>
                                  )}
                                  <Kbd>{key}</Kbd>
                                </span>
                              ))}
                            </div>

                            <span
                              className={`max-w-[min(11rem,42%)] shrink-0 text-right font-sans text-[17px] leading-snug transition-colors duration-200 sm:text-[19px] ${
                                isActive ? "text-white/72" : "text-white/56"
                              }`}
                            >
                              {opt.label}
                            </span>
                          </motion.button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
