export function SectionDivider({
  label,
  className = "",
}: {
  label: string;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 sm:gap-4 ${className}`}>
      <span className="h-px flex-1 bg-slate-600" aria-hidden="true" />
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full border border-slate-600"
        aria-hidden="true"
      />
      <span className="shrink-0 border border-slate-600 bg-[#0e1116] px-4 py-1.5 font-mono text-[11px] font-medium uppercase tracking-widest text-slate-300">
        {label}
      </span>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full border border-slate-600"
        aria-hidden="true"
      />
      <span className="h-px flex-1 bg-slate-600" aria-hidden="true" />
    </div>
  );
}
