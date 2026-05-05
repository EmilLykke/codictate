import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { motion, AnimatePresence } from "motion/react";
import type { DropdownOption } from "./DropdownSelect";
import { DropdownChevron } from "./DropdownChevron";

function isSubsequence(needle: string, haystack: string): boolean {
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++;
  }
  return j === needle.length;
}

interface SearchableSelectProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  searchPlaceholder?: string;
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
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder ?? "";

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    const substring: DropdownOption[] = [];
    const fuzzy: DropdownOption[] = [];
    for (const o of options) {
      const label = o.label.toLowerCase();
      if (label.includes(q)) {
        substring.push(o);
      } else if (isSubsequence(q, label)) {
        fuzzy.push(o);
      }
    }
    return [...substring, ...fuzzy];
  }, [options, query]);

  const enabledIndices = useMemo(
    () => filtered.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [filtered],
  );

  useLayoutEffect(() => {
    if (!open) {
      setQuery("");
      setHighlightedIndex(-1);
      return;
    }
    const idx = filtered.findIndex((o) => o.value === value && !o.disabled);
    setHighlightedIndex(idx >= 0 ? idx : (enabledIndices[0] ?? -1));
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const idx = enabledIndices[0] ?? -1;
    setHighlightedIndex(idx);
  }, [query]);

  useLayoutEffect(() => {
    if (!open || highlightedIndex < 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector(
      `[data-index="${highlightedIndex}"]`,
    ) as HTMLElement | null;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [open, highlightedIndex]);

  const pick = useCallback(
    (v: string) => {
      onChange(v);
      setOpen(false);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (enabledIndices.length === 0) return;
      const pos = enabledIndices.indexOf(highlightedIndex);

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next =
            pos < enabledIndices.length - 1
              ? enabledIndices[pos + 1]
              : enabledIndices[0];
          setHighlightedIndex(next);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev =
            pos > 0
              ? enabledIndices[pos - 1]
              : enabledIndices[enabledIndices.length - 1];
          setHighlightedIndex(prev);
          break;
        }
        case "Home": {
          e.preventDefault();
          setHighlightedIndex(enabledIndices[0]);
          break;
        }
        case "End": {
          e.preventDefault();
          setHighlightedIndex(enabledIndices[enabledIndices.length - 1]);
          break;
        }
        case "Enter": {
          e.preventDefault();
          const opt = filtered[highlightedIndex];
          if (opt && !opt.disabled) pick(opt.value);
          break;
        }
      }
    },
    [enabledIndices, highlightedIndex, filtered, pick],
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          className={`flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left outline-none transition-colors duration-200 focus-visible:ring-1 focus-visible:ring-white/20 ${
            disabled
              ? "opacity-50 cursor-not-allowed"
              : "cursor-pointer hover:border-white/20 hover:bg-white/7"
          }`}
        >
          <span
            className={`min-w-0 flex-1 truncate text-[15px] font-medium ${
              selectedOption ? "text-white/90" : "text-white/45"
            }`}
          >
            {displayLabel}
          </span>
          <DropdownChevron open={open} />
        </button>
      </Popover.Trigger>
      <AnimatePresence>
        {open && (
          <Popover.Portal forceMount>
            <Popover.Content
              forceMount
              align="start"
              sideOffset={6}
              collisionPadding={10}
              asChild
              onOpenAutoFocus={(e) => e.preventDefault()}
              style={{ width: "var(--radix-popover-trigger-width)" }}
            >
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                role="listbox"
                aria-label={ariaLabel}
                aria-activedescendant={
                  highlightedIndex >= 0
                    ? `ss-opt-${highlightedIndex}`
                    : undefined
                }
                className="z-[10000] overflow-hidden rounded-xl border border-white/12 bg-[#141416]/98 shadow-[0_16px_48px_rgba(0,0,0,0.55)] ring-1 ring-white/8 backdrop-blur-md"
              >
                <div className="border-b border-white/10 px-3 py-2">
                  <input
                    type="text"
                    role="combobox"
                    aria-expanded={open}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      highlightedIndex >= 0
                        ? `ss-opt-${highlightedIndex}`
                        : undefined
                    }
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={searchPlaceholder}
                    autoFocus
                    className="w-full bg-transparent text-[14px] font-medium text-white/90 placeholder-white/30 outline-none"
                  />
                </div>
                <div
                  ref={scrollRef}
                  className="max-h-[min(290px,46vh)] overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]"
                  style={{ scrollbarWidth: "thin" }}
                >
                  {filtered.length === 0 ? (
                    <div className="px-4 py-4 text-center text-[13px] text-white/34">
                      No matches
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5 p-1">
                      {filtered.map((opt, index) => {
                        const isActive = opt.value === value;
                        const isHighlighted = index === highlightedIndex;
                        return (
                          <button
                            key={opt.value}
                            id={`ss-opt-${index}`}
                            data-index={index}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            tabIndex={-1}
                            disabled={opt.disabled}
                            onClick={() => !opt.disabled && pick(opt.value)}
                            onPointerEnter={() =>
                              !opt.disabled && setHighlightedIndex(index)
                            }
                            className={`relative flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-200 whitespace-nowrap ${
                              opt.disabled
                                ? "border-transparent text-white/30 cursor-not-allowed"
                                : isActive && isHighlighted
                                  ? "border-white/26 bg-white/8 cursor-pointer"
                                  : isActive
                                    ? "border-white/26 bg-white/6 cursor-pointer"
                                    : isHighlighted
                                      ? "border-white/12 bg-white/5 cursor-pointer"
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
                              className={`text-[14px] font-medium transition-colors duration-200 ${
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
            </Popover.Content>
          </Popover.Portal>
        )}
      </AnimatePresence>
    </Popover.Root>
  );
}
