import { PuffMark } from '@/components/landing/puff-logo';
import { cn } from '@/lib/cn';

export type MascotState = 'idle' | 'working' | 'happy' | 'worried';

export const MASCOT_LINES: Record<MascotState, string> = {
  idle: 'Ready when you are. Give the team a goal.',
  working: 'Juggling agents. Memory is being written.',
  happy: 'Everything verified. Lessons saved.',
  worried: 'A test failed. Remembering it so nobody repeats it.',
};

/** The Puff mascot. The mark carries the personality: no glow, no bounce. */
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
      className={cn('inline-grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <PuffMark className="h-full w-full select-none" label={`Puff is ${state}`} />
    </span>
  );
}
