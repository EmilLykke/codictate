import * as SwitchPrimitive from "@radix-ui/react-switch";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer border outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-40 ${
        checked
          ? "bg-blue-500/30 border-blue-400/30"
          : "bg-white/7 border-white/14"
      }`}
    >
      <SwitchPrimitive.Thumb
        className={`block w-4 h-4 rounded-full transition-transform duration-200 will-change-transform ${
          checked
            ? "translate-x-4 bg-blue-400/90"
            : "translate-x-0.5 bg-white/40"
        }`}
      />
    </SwitchPrimitive.Root>
  );
}
