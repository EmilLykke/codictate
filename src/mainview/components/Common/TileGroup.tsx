export type TileOption<T extends string> = {
  value: T;
  label: string;
  sublabel?: string;
  preview?: string;
  /** Chat-shaped bubble for messaging modes, plain panel for prose. */
  previewVariant?: "bubble" | "panel";
  /** Lets a label demo its own tone (e.g. serif "Formal."). */
  labelFont?: "serif";
};

// Column counts are fixed per option count; only the 4-up group wraps to 2x2
// when the container gets narrow. Breakpoints are container widths, not
// viewport widths -- the settings pane is capped well below any viewport
// breakpoint that would otherwise make sense.
const GRID_COLS: Record<2 | 3 | 4, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 @min-[480px]:grid-cols-4",
};

export function TileGroup<T extends string>({
  value,
  onChange,
  options,
  maxColumns,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: TileOption<T>[];
  maxColumns: 2 | 3 | 4;
  ariaLabel?: string;
}) {
  return (
    <div className="@container">
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className={`grid ${GRID_COLS[maxColumns]} gap-3 @min-[480px]:gap-4`}
      >
        {options.map((opt) => {
          const selected = opt.value === value;
          const bubble = opt.previewVariant === "bubble";
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={`flex h-full w-full flex-col overflow-hidden rounded-[20px] border p-3 text-left cursor-pointer transition-[scale,border-color,background-color] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 ${
                selected
                  ? "border-accent-blue/60 bg-surface-3 ring-1 ring-accent-blue/40"
                  : "border-overlay/8 bg-surface-1 hover:border-overlay/16 hover:bg-surface-2"
              }`}
            >
              <div className="px-1.5 pt-1">
                <span
                  className={`block leading-tight tracking-tight text-[15px] @min-[480px]:text-[18px] @min-[560px]:text-[20px] ${
                    opt.labelFont === "serif" ? "font-serif" : "font-sans"
                  } ${selected ? "text-white" : "text-overlay/70"}`}
                >
                  {opt.label}
                </span>
                {opt.sublabel && (
                  <span
                    className={`mt-1 block font-medium leading-snug text-[11px] @min-[480px]:text-[12px] ${
                      selected ? "text-overlay/60" : "text-overlay/45"
                    }`}
                  >
                    {opt.sublabel}
                  </span>
                )}
              </div>

              {opt.preview && (
                <div className="hidden @min-[480px]:block mt-auto pt-4">
                  <div
                    className={`rounded-lg p-3 leading-relaxed whitespace-pre-wrap text-[12px] @min-[560px]:text-[13px] ${
                      bubble ? "rounded-br-sm" : ""
                    } ${
                      selected
                        ? "bg-accent-blue/20 text-overlay/90"
                        : "bg-surface-2 text-overlay/55"
                    }`}
                  >
                    {opt.preview}
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
