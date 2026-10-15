export function GraphMemoryLoop() {
  return (
    <div className="space-y-3 text-xs font-mono">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="flex-1 rounded-none border border-slate-300 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/60">
          <p className="text-slate-500">[Code Node]</p>
          <p className="mt-1 text-slate-700 dark:text-slate-200">src/auth/login.ts</p>
          <p className="mt-2 text-[10px] uppercase tracking-widest text-slate-400">symbol · login()</p>
        </div>
        <div className="hidden items-center text-slate-400 sm:flex">→</div>
        <div className="flex-1 rounded-none border border-slate-300 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/60">
          <p className="text-slate-500">[Task]</p>
          <p className="mt-1 text-slate-700 dark:text-slate-200">Add rate limiting</p>
          <p className="mt-2 text-[10px] uppercase tracking-widest text-slate-400">status · planned</p>
        </div>
        <div className="hidden items-center text-slate-400 sm:flex">→</div>
        <div className="flex-1 rounded-none border border-slate-300 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/60">
          <p className="text-slate-500">[Lesson]</p>
          <p className="mt-1 text-slate-700 dark:text-slate-200">Redact credentials in audit log</p>
          <p className="mt-2 text-[10px] uppercase tracking-widest text-slate-400">past fix · verified</p>
        </div>
      </div>
      <p className="text-center text-[10px] uppercase tracking-widest text-slate-400">
        Each edge carries a reason · graph traversed, not grepped
      </p>
    </div>
  );
}