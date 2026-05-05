import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function InstantTooltip({
  text,
  children,
  className,
  tooltipClassName,
  side = "top",
}: {
  text: ReactNode;
  children: ReactNode;
  className?: string;
  tooltipClassName?: string;
  side?: "top" | "bottom";
  /** @deprecated Radix always portals — this prop is accepted for backward compatibility but ignored. */
  floatInViewport?: boolean;
  /** @deprecated Radix Tooltip keeps open while hovering content. Accepted for backward compatibility. */
  interactive?: boolean;
}) {
  return (
    <Tooltip.Root>
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
          className={`pointer-events-auto rounded-lg border border-white/14 bg-[#1c1c1f]/98 px-3 py-2 text-left text-[13px] leading-snug text-white/90 shadow-lg whitespace-normal z-[10000] ${tooltipClassName ?? ""}`}
        >
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
