import puffSvg from '@/assets/puff.svg';
import { cn } from '@/lib/cn';

export type MascotState = 'idle' | 'working' | 'happy' | 'worried';

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
    <img
      src={puffSvg}
      alt={`Puff (${state})`}
      width={size}
      height={size}
      className={cn(
        'select-none',
        state === 'working' && 'animate-bob',
        state === 'worried' && 'drop-shadow-[0_0_10px_#ff5c7a]',
        state === 'happy' && 'drop-shadow-[0_0_10px_#3ddc84]',
        className,
      )}
      draggable={false}
    />
  );
}
