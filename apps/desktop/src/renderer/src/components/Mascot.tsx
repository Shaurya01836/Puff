import puffSvg from '@/assets/puff.svg';
import { cn } from '@/lib/cn';

export type MascotState = 'idle' | 'working' | 'happy' | 'worried';

export const MASCOT_LINES: Record<MascotState, string> = {
  idle: 'Ready when you are. Give the team a goal.',
  working: 'Juggling agents. Memory is being written.',
  happy: 'Everything verified. Lessons saved.',
  worried: 'A test failed. Remembering it so nobody repeats it.',
};

const GLOW: Record<MascotState, string> = {
  idle: 'rgb(139 124 246 / 0.35)',
  working: 'rgb(45 212 224 / 0.45)',
  happy: 'rgb(74 222 128 / 0.45)',
  worried: 'rgb(244 93 109 / 0.5)',
};

/** Placeholder SVG mascot; swap for the 3D renders (one PNG per state) when they arrive. */
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
    <span className={cn('relative inline-grid shrink-0 place-items-center', className)}>
      <span
        className="absolute inset-[12%] rounded-full blur-xl transition-colors duration-700"
        style={{ background: GLOW[state] }}
        aria-hidden
      />
      <img
        src={puffSvg}
        alt={`Puff is ${state}`}
        width={size}
        height={size}
        className={cn('relative select-none', state === 'working' && 'animate-bob')}
        draggable={false}
      />
    </span>
  );
}
