export function Kbd({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap min-w-[38px] h-9 px-2.5 text-[15px] font-mono text-white/35 border border-white/10 rounded-md bg-white/4 leading-none ${className}`}
    >
      {children}
    </kbd>
  );
}
