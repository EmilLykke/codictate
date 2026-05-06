import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useCallback, useEffect, useState } from "react";
import type { PlatformRuntime } from "../../../shared/platform";
import type { WindowResizeEdge } from "../../../shared/types";
import {
  windowClose,
  windowMinimize,
  windowResizeEnd,
  windowResizeMove,
  windowResizeStart,
  windowToggleMaximize,
} from "../../rpc";

type WebkitDragStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };

const dragStyle: WebkitDragStyle = { WebkitAppRegion: "drag" };
const noDragStyle: WebkitDragStyle = { WebkitAppRegion: "no-drag" };

const RESIZE_HANDLES: {
  edge: WindowResizeEdge;
  className: string;
  cursor: string;
}[] = [
  { edge: "top", className: "top-0 left-2 right-2 h-1.5", cursor: "ns-resize" },
  {
    edge: "right",
    className: "top-2 right-0 bottom-2 w-1.5",
    cursor: "ew-resize",
  },
  {
    edge: "bottom",
    className: "bottom-0 left-2 right-2 h-1.5",
    cursor: "ns-resize",
  },
  {
    edge: "left",
    className: "top-2 left-0 bottom-2 w-1.5",
    cursor: "ew-resize",
  },
  {
    edge: "top-left",
    className: "top-0 left-0 h-3 w-3",
    cursor: "nwse-resize",
  },
  {
    edge: "top-right",
    className: "top-0 right-0 h-3 w-3",
    cursor: "nesw-resize",
  },
  {
    edge: "bottom-right",
    className: "bottom-0 right-0 h-3 w-3",
    cursor: "nwse-resize",
  },
  {
    edge: "bottom-left",
    className: "bottom-0 left-0 h-3 w-3",
    cursor: "nesw-resize",
  },
];

function ControlButton({
  label,
  children,
  onClick,
  danger = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={noDragStyle}
      className={`flex h-8 w-11 items-center justify-center text-[15px] leading-none transition-colors duration-150 ${
        danger
          ? "text-overlay/58 hover:bg-accent-red/85 hover:text-white"
          : "text-overlay/48 hover:bg-overlay/10 hover:text-overlay/78"
      }`}
    >
      {children}
    </button>
  );
}

export function WindowTitleBar({
  platform,
}: {
  platform: PlatformRuntime | undefined;
}) {
  const [resizeEdge, setResizeEdge] = useState<WindowResizeEdge | null>(null);

  const startResize = useCallback(
    (edge: WindowResizeEdge, e: ReactPointerEvent<HTMLDivElement>) => {
      if (platform !== "windows") return;
      e.preventDefault();
      e.stopPropagation();
      setResizeEdge(edge);
      windowResizeStart({ edge, screenX: e.screenX, screenY: e.screenY });
    },
    [platform],
  );

  useEffect(() => {
    if (!resizeEdge) return;
    const handleMove = (e: globalThis.PointerEvent) => {
      windowResizeMove({ screenX: e.screenX, screenY: e.screenY });
    };
    const handleEnd = () => {
      setResizeEdge(null);
      windowResizeEnd();
    };
    window.addEventListener(
      "pointermove",
      handleMove as unknown as EventListener,
    );
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
    return () => {
      window.removeEventListener(
        "pointermove",
        handleMove as unknown as EventListener,
      );
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      windowResizeEnd();
    };
  }, [resizeEdge]);

  if (platform !== "windows") {
    return (
      <div className="electrobun-webkit-app-region-drag absolute top-0 left-0 right-0 z-50 h-7 hover:bg-overlay/10 transition-colors duration-200" />
    );
  }

  return (
    <>
      <div
        style={dragStyle}
        className="absolute top-0 left-0 right-0 z-50 flex h-8 items-center justify-between border-b border-overlay/8 bg-codictate-page/82 backdrop-blur-xl"
      >
        <div className="flex min-w-0 items-center gap-2 px-3 text-[12px] font-medium tracking-wide text-overlay/38">
          <span className="h-2 w-2 rounded-full bg-cyan-300/75 shadow-[0_0_12px_rgba(103,232,249,0.45)]" />
          <span>Codictate</span>
        </div>
        <div className="flex h-full items-center" style={noDragStyle}>
          <ControlButton label="Minimize" onClick={windowMinimize}>
            <span className="translate-y-[-2px]">-</span>
          </ControlButton>
          <ControlButton label="Maximize" onClick={windowToggleMaximize}>
            <span className="text-[13px]">□</span>
          </ControlButton>
          <ControlButton label="Close" onClick={windowClose} danger>
            <span className="text-[18px]">×</span>
          </ControlButton>
        </div>
      </div>
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.edge}
          style={{ ...noDragStyle, cursor: handle.cursor }}
          onPointerDown={(e) => startResize(handle.edge, e)}
          className={`absolute z-[60] ${handle.className}`}
        />
      ))}
    </>
  );
}
