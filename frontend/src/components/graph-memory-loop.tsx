import { Fragment } from 'react';
import { motion } from 'framer-motion';

const NODES = [
  { label: '[Code Node]', title: 'src/auth/login.ts', foot: 'symbol · login()' },
  { label: '[Task]', title: 'Add rate limiting', foot: 'status · planned' },
  { label: '[Lesson]', title: 'Redact credentials in audit log', foot: 'past fix · verified' },
];

const ACTIVE = { borderColor: 'rgba(52, 211, 153, 0.6)', backgroundColor: 'rgba(52, 211, 153, 0.06)' };
const IDLE = { borderColor: 'rgba(71, 85, 105, 1)', backgroundColor: 'rgba(15, 23, 42, 0.6)' };

export function GraphMemoryLoop({ live = false, tick = 0 }: { live?: boolean; tick?: number }) {
  const active = live ? tick % NODES.length : -1;

  return (
    <div className="space-y-3 text-xs font-mono">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        {NODES.map((node, i) => (
          <Fragment key={node.label}>
            {i > 0 && (
              <motion.div
                className="hidden items-center text-slate-400 sm:flex"
                aria-hidden="true"
                initial={false}
                animate={live ? { x: [0, 3, 0], opacity: [0.45, 1, 0.45] } : { x: 0, opacity: 1 }}
                transition={
                  live ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0 }
                }
              >
                →
              </motion.div>
            )}
            <motion.div
              className="flex-1 border p-3"
              initial={false}
              animate={i === active ? ACTIVE : IDLE}
              transition={{ duration: live ? 0.5 : 0, ease: 'easeOut' }}
            >
              <p className="flex items-center justify-between text-slate-500">
                {node.label}
                {i === active && (
                  <motion.span
                    className="h-1.5 w-1.5 bg-emerald-400"
                    initial={false}
                    animate={
                      live ? { scale: [1, 1.9, 1], opacity: [1, 0.35, 1] } : { scale: 1, opacity: 1 }
                    }
                    transition={
                      live
                        ? { duration: 1.4, repeat: Infinity, ease: 'easeOut' }
                        : { duration: 0 }
                    }
                  />
                )}
              </p>
              <p className="mt-1 text-slate-200">{node.title}</p>
              <p className="mt-2 text-[10px] uppercase tracking-widest text-slate-400">
                {node.foot}
              </p>
            </motion.div>
          </Fragment>
        ))}
      </div>
      <p className="text-center text-[10px] uppercase tracking-widest text-slate-400">
        Each edge carries a reason · graph traversed, not grepped
      </p>
    </div>
  );
}
