import { PuffMark } from '@/components/landing/puff-logo';
import { cn } from '@/lib/cn';

export type MascotState = 'idle' | 'working' | 'happy' | 'worried';

export const MASCOT_LINES: Record<MascotState, string> = {
  idle: 'Ready when you are. Give the team a goal.',
  working: 'Juggling agents. Memory is being written.',
  happy: 'Everything verified. Lessons saved.',
  worried: 'A test failed. Remembering it so nobody repeats it.',
};

const GLOW: Record<MascotState, string> = {
  idle: 'rgba(0, 212, 146, 0.28)',
  working: 'rgba(52, 211, 153, 0.45)',
  happy: 'rgba(52, 211, 153, 0.45)',
  worried: 'rgba(244, 63, 94, 0.5)',
};

/** Authentic Puff mascot from landing page. */
export function Mascot({
  state = 'idle',
  size = 56,
  className,
}: {
  state?: MascotState;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <span
        className="absolute inset-[10%] rounded-full blur-xl transition-colors duration-700"
        style={{ background: GLOW[state] }}
        aria-hidden
      />
      <span
        className={cn('relative flex items-center justify-center', state === 'working' && 'animate-bob')}
        style={{ width: size, height: size }}
      >
        <PuffMark className="h-full w-full select-none" label={`Puff is ${state}`} />
      </span>
    </span>
  );
}
