import { Check, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Panel, SectionTitle } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  ACCENTS,
  DEFAULT_PREFERENCES,
  TEXT_SCALES,
  THEMES,
  type Preferences,
} from '@/lib/preferences';
import pkg from '../../../../package.json';

/** A settings block: a heading, a one-line explanation and the controls. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <p className="-mt-1.5 mb-3 text-xs leading-snug text-ink-3">{hint}</p>
      {children}
    </section>
  );
}

function ThemeCard({
  name,
  description,
  swatch,
  active,
  onPick,
}: {
  name: string;
  description: string;
  swatch: readonly string[];
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-brand/60 bg-brand/5'
          : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2',
      )}
    >
      <span className="flex h-12 w-full overflow-hidden rounded-md border border-line">
        {swatch.map((color) => (
          <span key={color} className="flex-1" style={{ background: color }} />
        ))}
      </span>
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink">{name}</span>
          <span className="block truncate text-xs text-ink-3">{description}</span>
        </span>
        {active && <Check className="mt-0.5 size-4 shrink-0 text-brand" />}
      </span>
    </button>
  );
}

/** A label and its control, on one line, with a hairline between rows. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint && <p className="mt-0.5 text-xs leading-snug text-ink-3">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
        on ? 'border-brand bg-brand' : 'border-line bg-surface-3',
      )}
    >
      <span
        className={cn(
          'inline-block size-4 rounded-full shadow transition-transform',
          on ? 'translate-x-4 bg-abyss' : 'translate-x-0.5 bg-ink-2',
        )}
      />
    </button>
  );
}

export function Settings({
  prefs,
  onChange,
  onReset,
}: {
  prefs: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
  onReset: () => void;
}) {
  const dirty =
    prefs.theme !== DEFAULT_PREFERENCES.theme ||
    prefs.accent !== DEFAULT_PREFERENCES.accent ||
    prefs.textScale !== DEFAULT_PREFERENCES.textScale ||
    prefs.reduceMotion !== DEFAULT_PREFERENCES.reduceMotion;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-7 overflow-y-auto p-6">
      <p className="text-sm text-ink-2">
        These belong to the app, not to a project. They are remembered on this machine.
      </p>

      <Section title="Theme" hint="How dark the canvas is, and its hue. Every theme stays dark for the graph.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((t) => (
            <ThemeCard
              key={t.id}
              name={t.name}
              description={t.description}
              swatch={t.swatch}
              active={prefs.theme === t.id}
              onPick={() => onChange({ theme: t.id })}
            />
          ))}
        </div>
      </Section>

      <Section title="Accent" hint="The one accent colour: live work, the run button and focus rings.">
        <div className="flex flex-wrap items-center gap-3">
          {ACCENTS.map((a) => {
            const active = prefs.accent === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onChange({ accent: a.id })}
                aria-pressed={active}
                aria-label={a.name}
                title={a.name}
                className={cn(
                  'size-8 rounded-full transition-transform hover:scale-105',
                  active && 'ring-2 ring-ink-2 ring-offset-2 ring-offset-surface',
                )}
                style={{ background: a.brand }}
              />
            );
          })}
          <span className="ml-1 text-xs text-ink-3">
            {ACCENTS.find((a) => a.id === prefs.accent)?.name}
          </span>
        </div>
      </Section>

      <Section title="Text size" hint="Scales the whole interface, the way browser zoom does.">
        <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
          {TEXT_SCALES.map((s) => {
            const active = prefs.textScale === s.value;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onChange({ textScale: s.value })}
                aria-pressed={active}
                className={cn(
                  'rounded px-3.5 py-1.5 text-xs font-medium transition-colors',
                  active ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:text-ink',
                )}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Motion" hint="Animations when panels open, notices appear and status dots pulse.">
        <Panel>
          <Row label="Reduce motion" hint="Turn animations off. Useful if movement is distracting.">
            <Switch
              on={prefs.reduceMotion}
              onChange={(next) => onChange({ reduceMotion: next })}
              label="Reduce motion"
            />
          </Row>
        </Panel>
      </Section>

      <div className="flex items-center justify-between gap-4 border-t border-line pt-5">
        <span className="font-mono text-xs text-ink-3">Puff v{pkg.version}</span>
        <button
          type="button"
          onClick={onReset}
          disabled={!dirty}
          className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-xs font-medium text-ink transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" />
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
