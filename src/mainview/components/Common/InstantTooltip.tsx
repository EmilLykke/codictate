import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function InstantTooltip({
  text,
  children,
  className,
  tooltipClassName,
  side = "top",
  disableHoverableContent = false,
}: {
  text: ReactNode;
  children: ReactNode;
  className?: string;
  tooltipClassName?: string;
  side?: "top" | "bottom";
  disableHoverableContent?: boolean;
  /** @deprecated Radix always portals — this prop is accepted for backward compatibility but ignored. */
  floatInViewport?: boolean;
  /** @deprecated Radix Tooltip keeps open while hovering content. Accepted for backward compatibility. */
  interactive?: boolean;
}) {
  return (
    <Tooltip.Root disableHoverableContent={disableHoverableContent}>
      <Tooltip.Trigger asChild>
        <span className={`inline-flex max-w-full ${className ?? ""}`}>
          {children}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className={`pointer-events-auto max-w-[260px] rounded-lg border border-overlay/14 bg-surface-elevated/98 px-3 py-2 text-left text-[13px] leading-snug text-overlay/90 shadow-lg whitespace-normal z-[10000] ${tooltipClassName ?? ""}`}
        >
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
