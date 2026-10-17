import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface MenuItem {
  label: ReactNode;
  hint?: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** A small button that opens a list of choices. Closes on a choice, outside click or Escape. */
export function Menu({
  label,
  icon,
  items,
  title,
  compact,
}: {
  label: string;
  icon?: ReactNode;
  items: MenuItem[];
  title?: string;
  /** Smaller, for use on a card */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-sm border border-line-strong bg-surface-2 font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink',
          compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs',
        )}
      >
        {icon}
        {label}
        <ChevronDown className="size-3 opacity-60" />
      </button>
      {open && (
        <ul
          role="menu"
          className="absolute top-full left-0 z-30 mt-1 min-w-48 rounded-md border border-line-strong bg-surface p-1 shadow-[0_16px_40px_-16px_rgb(0_0_0/0.8)]"
        >
          {items.map((item, i) => (
            <li key={i} role="none">
              <button
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className="flex w-full flex-col rounded-sm px-2.5 py-1.5 text-left text-xs text-ink hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {item.label}
                {item.hint && <span className="text-[10px] text-ink-3">{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
