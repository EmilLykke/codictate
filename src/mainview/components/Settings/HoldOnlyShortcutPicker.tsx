import { useState } from "react";
import * as Select from "@radix-ui/react-select";
import { motion } from "motion/react";
import type { ShortcutId } from "../../../shared/types";
import type { PlatformRuntime } from "../../../shared/platform";
import {
  shortcutOptionById,
  shortcutOptionsGroupedForPlatform,
} from "../../../shared/shortcut-options";
import { Kbd } from "../Common/Kbd";
import { DropdownChevron } from "../Common/DropdownChevron";

const NONE_VALUE = "__none__";

export function HoldOnlyShortcutPicker({
  value,
  mainShortcutId,
  onChange,
  platform,
  disabled = false,
}: {
  value: ShortcutId | null;
  mainShortcutId: ShortcutId;
  onChange: (id: ShortcutId | null) => void;
  platform: PlatformRuntime;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const groups = shortcutOptionsGroupedForPlatform(platform)
    .map(({ family, title, options }) => ({
      family,
      title,
      options: options.filter((o) => o.id !== mainShortcutId),
    }))
    .filter((g) => g.options.length > 0);

  const selected = value !== null ? shortcutOptionById(value, platform) : null;
  const isNone = value === null;

  return (
    <Select.Root
      value={value ?? NONE_VALUE}
      onValueChange={(v) =>
        onChange(v === NONE_VALUE ? null : (v as ShortcutId))
      }
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <Select.Trigger asChild>
        <motion.button
          type="button"
          className={`flex w-full items-center gap-3 rounded-xl border border-white/11 bg-white/4 px-4 py-3 text-left outline-none transition-colors duration-200 focus-visible:ring-1 focus-visible:ring-white/20 ${
            disabled
              ? "opacity-50 cursor-not-allowed"
              : "cursor-pointer hover:border-white/16 hover:bg-white/6"
          }`}
        >
          {selected ? (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {selected.keys.map((key, i) => (
                  <span
                    key={`${selected.id}-t-${i}`}
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
              <span className="hidden min-w-0 max-w-[min(11rem,46%)] shrink-0 truncate text-right font-sans text-[13px] text-white/62 sm:block sm:text-[15px]">
                {selected.label}
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1 font-sans text-[13px] text-white/56 sm:text-[15px]">
              None
            </span>
          )}
          <DropdownChevron open={open} />
        </motion.button>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          asChild
          position="popper"
          align="start"
          side="bottom"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: "var(--radix-select-trigger-width)" }}
        >
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="z-[10000] overflow-hidden rounded-xl border border-white/12 bg-[#141416]/98 shadow-[0_16px_48px_rgba(0,0,0,0.55)] ring-1 ring-white/8 backdrop-blur-md"
          >
            <Select.Viewport
              className="max-h-[min(340px,52vh)] overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]"
              style={{ scrollbarWidth: "thin" }}
            >
              <div className="flex flex-col gap-4 p-1">
                <div>
                  <Select.Item
                    value={NONE_VALUE}
                    textValue="None"
                    className={`relative flex w-full cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 outline-none transition-colors duration-200 ${
                      isNone
                        ? "border-white/26 bg-white/6 data-[highlighted]:bg-white/8"
                        : "border-white/11 bg-white/4 data-[highlighted]:border-white/16 data-[highlighted]:bg-white/6"
                    }`}
                  >
                    <div
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                      style={{
                        borderColor: isNone
                          ? "rgba(255,255,255,0.38)"
                          : "rgba(255,255,255,0.18)",
                      }}
                    >
                      {isNone ? (
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
                    <span className="font-sans text-[13px] text-white/72 sm:text-[15px]">
                      None
                    </span>
                  </Select.Item>
                </div>

                {groups.map(({ family, title, options }) => (
                  <Select.Group key={family}>
                    <Select.Label className="px-3 pb-1.5 pt-2 text-[14px] font-medium uppercase tracking-wider text-white/36">
                      {title}
                    </Select.Label>
                    <div className="flex flex-col gap-1">
                      {options.map((opt) => {
                        const isActive = opt.id === value;
                        return (
                          <Select.Item
                            key={opt.id}
                            value={opt.id}
                            textValue={opt.label}
                            className={`relative flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 outline-none transition-colors duration-200 ${
                              isActive
                                ? "border-white/26 bg-white/6 data-[highlighted]:bg-white/8"
                                : "border-white/11 bg-white/4 data-[highlighted]:border-white/16 data-[highlighted]:bg-white/6"
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
                              className={`max-w-[min(11rem,42%)] shrink-0 text-right font-sans text-[13px] leading-snug transition-colors duration-200 sm:text-[15px] ${
                                isActive ? "text-white/72" : "text-white/56"
                              }`}
                            >
                              {opt.label}
                            </span>
                          </Select.Item>
                        );
                      })}
                    </div>
                  </Select.Group>
                ))}
              </div>
            </Select.Viewport>
          </motion.div>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
