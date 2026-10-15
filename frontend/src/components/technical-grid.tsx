import type { ReactNode } from "react";

export function TechnicalGridContainer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative border-[1.5px] border-dashed border-slate-500 bg-transparent p-8 md:p-10 ${className}`}
    >
      <span className="absolute -top-2.5 -left-2.5 select-none font-mono text-xs text-slate-500">
        +
      </span>
      <span className="absolute -top-2.5 -right-2.5 select-none font-mono text-xs text-slate-500">
        +
      </span>
      <span className="absolute -bottom-2.5 -left-2.5 select-none font-mono text-xs text-slate-500">
        +
      </span>
      <span className="absolute -bottom-2.5 -right-2.5 select-none font-mono text-xs text-slate-500">
        +
      </span>
      {children}
    </div>
  );
}