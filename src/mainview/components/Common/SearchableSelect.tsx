import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import type { DropdownOption } from "./DropdownSelect";

interface SearchableSelectProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  searchPlaceholder?: string;
}

const ANCHOR_GAP = 6;
const VIEW_MARGIN = 10;

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

export function SearchableSelect({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder,
  searchPlaceholder = "Search…",
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder ?? "";

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const r = trigger.getBoundingClientRect();
    const left = r.left;
    const width = r.width;

    const panelHeight = panel.offsetHeight;
    const below = r.bottom + ANCHOR_GAP;
    const above = r.top - ANCHOR_GAP - panelHeight;
    const fitsBelow = below + panelHeight <= window.innerHeight - VIEW_MARGIN;
    const top = fitsBelow ? below : Math.max(VIEW_MARGIN, above);

    setPos({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      setQuery("");
      return;
    }
    reposition();
  }, [open, reposition]);

  useLayoutEffect(() => {
    if (open && pos) {
      searchRef.current?.focus();
    }
  }, [open, pos]);

  useLayoutEffect(() => {
    if (!open || !pos || query) return;
    const container = scrollRef.current;
    if (!container) return;
    const active = container.querySelector("[aria-selected='true']");
    if (active) {
      active.scrollIntoView({ block: "center" });
    }
  }, [open, pos, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      )
        return;
      setOpen(false);
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

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const panel = open
    ? createPortal(
        <AnimatePresence>
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            role="listbox"
            aria-label={ariaLabel}
            className="overflow-hidden rounded-xl border border-white/12 bg-[#141416]/98 shadow-[0_16px_48px_rgba(0,0,0,0.55)] ring-1 ring-white/8 backdrop-blur-md"
            style={{
              position: "fixed",
              zIndex: 10000,
              top: pos?.top ?? -9999,
              left: pos?.left ?? 0,
              width: pos?.width ?? "auto",
              opacity: pos ? undefined : 0,
            }}
          >
            <div className="border-b border-white/10 px-3 py-2">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent text-[18px] font-medium text-white/90 placeholder-white/30 outline-none"
              />
            </div>
            <div
              ref={scrollRef}
              className="max-h-[min(290px,46vh)] overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]"
              style={{ scrollbarWidth: "thin" }}
            >
              {filtered.length === 0 ? (
                <div className="px-4 py-4 text-center text-[17px] text-white/34">
                  No matches
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 p-1">
                  {filtered.map((opt) => {
                    const isActive = opt.value === value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        disabled={opt.disabled}
                        onClick={() => !opt.disabled && pick(opt.value)}
                        className={`relative flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors duration-200 ${
                          opt.disabled
                            ? "border-transparent text-white/30 cursor-not-allowed"
                            : isActive
                              ? "border-white/26 bg-white/6 cursor-pointer"
                              : "border-transparent hover:border-white/12 hover:bg-white/5 cursor-pointer"
                        }`}
                      >
                        <div
                          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                          style={{
                            borderColor: isActive
                              ? "rgba(255,255,255,0.38)"
                              : "rgba(255,255,255,0.18)",
                          }}
                        >
                          {isActive && (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{
                                type: "spring",
                                stiffness: 500,
                                damping: 25,
                              }}
                              className="h-1.5 w-1.5 rounded-full bg-white/60"
                            />
                          )}
                        </div>
                        <span
                          className={`text-[18px] font-medium transition-colors duration-200 ${
                            opt.disabled
                              ? "text-white/30"
                              : isActive
                                ? "text-white/85"
                                : "text-white/65"
                          }`}
                        >
                          {opt.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        </AnimatePresence>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={`flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left transition-colors duration-200 ${
          disabled
            ? "opacity-50 cursor-not-allowed"
            : "cursor-pointer hover:border-white/20 hover:bg-white/7"
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate text-[19px] font-medium ${
            selectedOption ? "text-white/90" : "text-white/45"
          }`}
        >
          {displayLabel}
        </span>
        <DropdownChevron open={open} />
      </button>
      {panel}
    </>
  );
}
