'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from 'framer-motion';

const GREEN = '#00d492';
const INK = '#0c121f';

// How far the eye glints may travel, in viewBox units. The eyes are 6.5 x 8.5
// and the glints have r=2.6, so anything past ~3 would poke outside the eye.
const MAX_GLINT_TRAVEL = 3;

/**
 * The puff mascot, alive: its eyes follow the cursor, it bobs and blinks, and it
 * hops whenever `reactionKey` changes. `message` is what it says.
 */
export function InteractivePuff({
  message,
  reactionKey,
}: {
  message: string;
  /** Changing this makes the puff react (a hop). */
  reactionKey: string | number;
}) {
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const hop = useAnimationControls();
  const [blink, setBlink] = useState(false);
  const [hovered, setHovered] = useState(false);

  const targetX = useMotionValue(0);
  const targetY = useMotionValue(0);
  const glintX = useSpring(targetX, { stiffness: 240, damping: 18, mass: 0.4 });
  const glintY = useSpring(targetY, { stiffness: 240, damping: 18, mass: 0.4 });

  // Glints track the pointer.
  useEffect(() => {
    if (reduced) return;

    const onMove = (event: PointerEvent) => {
      const el = svgRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;

      // The eyes sit on the line y=51 inside a 100 x 120 box, centred on x=60.
      const eyeX = box.left + box.width * 0.5;
      const eyeY = box.top + box.height * (51 / 120);

      const dx = (event.clientX - eyeX) * (100 / box.width);
      const dy = (event.clientY - eyeY) * (120 / box.height);
      const dist = Math.hypot(dx, dy) || 1;
      const travel = MAX_GLINT_TRAVEL * Math.min(1, dist / 80);

      targetX.set((dx / dist) * travel);
      targetY.set((dy / dist) * travel);
    };

    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [reduced, targetX, targetY]);

  // Blink on a slow, even cadence.
  useEffect(() => {
    if (reduced) return;
    let closeId: number | undefined;
    const openId = window.setInterval(() => {
      setBlink(true);
      closeId = window.setTimeout(() => setBlink(false), 140);
    }, 3600);
    return () => {
      window.clearInterval(openId);
      if (closeId) window.clearTimeout(closeId);
    };
  }, [reduced]);

  // Greet on mount, then hop whenever the highlighted feature changes.
  useEffect(() => {
    if (reduced) return;
    hop.start({ y: [0, -16, 0], transition: { duration: 0.55, ease: 'easeOut' } });
  }, [hop, reactionKey, reduced]);

  return (
    <div className="flex w-full flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-4">
      <motion.div
        className="shrink-0"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        animate={{ scale: hovered && !reduced ? 1.07 : 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 20 }}
      >
        <motion.div animate={hop}>
          <motion.div
            animate={reduced ? { y: 0 } : { y: [0, -3.5, 0] }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }
            }
          >
            <motion.svg
              ref={svgRef}
              viewBox="10 0 100 120"
              aria-hidden="true"
              focusable="false"
              className="h-16 w-auto"
            >
              <g fill="none" stroke={GREEN} strokeWidth={13} strokeLinecap="round">
                <path d="M38 78 C 26 92 28 106 42 108" />
                <path d="M60 84 L60 108" />
                <path d="M82 78 C 94 92 92 106 78 108" />
              </g>
              <path
                d="M60 12 C 86 12 102 30 102 54 C 102 74 86 86 60 86 C 34 86 18 74 18 54 C 18 30 34 12 60 12 Z"
                fill={GREEN}
              />
              <motion.ellipse
                cx="49"
                cy="51"
                rx="6.5"
                ry="8.5"
                fill={INK}
                initial={false}
                animate={{ ry: blink ? 1.4 : 8.5 }}
                transition={{ duration: 0.09 }}
              />
              <motion.ellipse
                cx="71"
                cy="51"
                rx="6.5"
                ry="8.5"
                fill={INK}
                initial={false}
                animate={{ ry: blink ? 1.4 : 8.5 }}
                transition={{ duration: 0.09 }}
              />
              <motion.g style={{ x: glintX, y: glintY }} fill="#fff">
                <motion.circle
                  cx="51.5"
                  cy="47.5"
                  r="2.6"
                  initial={false}
                  animate={{ opacity: blink ? 0 : 1 }}
                  transition={{ duration: 0.09 }}
                />
                <motion.circle
                  cx="73.5"
                  cy="47.5"
                  r="2.6"
                  initial={false}
                  animate={{ opacity: blink ? 0 : 1 }}
                  transition={{ duration: 0.09 }}
                />
              </motion.g>
              <path
                d="M53 65 Q60 72 67 65"
                fill="none"
                stroke={INK}
                strokeWidth={4}
                strokeLinecap="round"
              />
            </motion.svg>
          </motion.div>
        </motion.div>
      </motion.div>

      <div className="relative min-h-[4.5rem] w-full min-w-0 border border-slate-600 bg-[#0b0d12] sm:w-auto sm:flex-1">
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-l border-t border-slate-600 bg-[#0b0d12] sm:hidden"
        />
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 hidden h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-l border-slate-600 bg-[#0b0d12] sm:block"
        />
        {/* Crossfade: the outgoing line stays put while the new one fades in. */}
        <AnimatePresence initial={false}>
          <motion.p
            key={message}
            className="absolute inset-0 flex items-center justify-center px-4 py-3 text-center text-sm text-slate-300"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }}
          >
            {message}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}
