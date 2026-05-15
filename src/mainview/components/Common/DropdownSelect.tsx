import { useState } from "react";
import * as Select from "@radix-ui/react-select";
import { motion } from "motion/react";
import { DropdownChevron } from "./DropdownChevron";

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface DropdownSelectProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  align?: "start" | "center" | "end";
}

export function DropdownSelect({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder,
  align = "end",
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder ?? "";

  return (
    <Select.Root
      value={value}
      onValueChange={onChange}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <Select.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={`flex w-full items-center gap-2 rounded-lg border border-overlay/10 bg-surface-1 px-3 py-2 text-left outline-none transition-colors duration-200 focus-visible:ring-1 focus-visible:ring-overlay/20 ${
            disabled
              ? "opacity-50 cursor-not-allowed"
              : "cursor-pointer hover:border-overlay/20 hover:bg-surface-2"
          }`}
        >
          <span
            className={`min-w-0 flex-1 truncate text-[15px] font-medium ${
              selectedOption ? "text-overlay/90" : "text-overlay/45"
            }`}
          >
            {displayLabel}
          </span>
          <DropdownChevron open={open} />
        </button>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          asChild
          position="popper"
          align={align}
          sideOffset={6}
          collisionPadding={10}
          style={{
            width: "max-content",
            minWidth: "var(--radix-select-trigger-width)",
            maxWidth: 380,
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="z-[10000] overflow-hidden rounded-xl border border-overlay/12 bg-surface-elevated/98 shadow-[var(--popover-shadow)] ring-1 ring-overlay/8 backdrop-blur-md"
          >
            <Select.Viewport
              className="max-h-[min(340px,52vh)] overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]"
              style={{ scrollbarWidth: "thin" }}
            >
              <div className="flex flex-col gap-0.5 p-1">
                {options.map((opt) => {
                  const isActive = opt.value === value;
                  return (
                    <Select.Item
                      key={opt.value}
                      value={opt.value}
                      textValue={opt.label}
                      disabled={opt.disabled}
                      className={`relative flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-200 whitespace-nowrap ${
                        opt.disabled
                          ? "border-transparent text-overlay/30 cursor-not-allowed"
                          : isActive
                            ? "border-overlay/26 bg-surface-2 cursor-pointer data-[highlighted]:bg-surface-3"
                            : "border-transparent cursor-pointer data-[highlighted]:border-overlay/12 data-[highlighted]:bg-surface-1"
                      }`}
                    >
                      <div
                        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                        style={{
                          borderColor: isActive
                            ? "var(--overlay-38)"
                            : "var(--overlay-18)",
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
                            className="h-1.5 w-1.5 rounded-full bg-overlay/60"
                          />
                        )}
                      </div>
                      <span
                        className={`text-[14px] font-medium transition-colors duration-200 ${
                          opt.disabled
                            ? "text-overlay/30"
                            : isActive
                              ? "text-overlay/85"
                              : "text-overlay/65"
                        }`}
                      >
                        {opt.label}
                      </span>
                    </Select.Item>
                  );
                })}
              </div>
            </Select.Viewport>
          </motion.div>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
