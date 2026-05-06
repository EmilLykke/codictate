export function Kbd({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap min-w-[38px] h-9 px-2.5 text-[15px] font-mono text-overlay/55 border border-overlay/18 rounded-md bg-surface-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] leading-none ${className}`}
    >
      {children}
    </kbd>
  );
}
