export function PromptPreview() {
  return (
    <div className="rounded-none border border-slate-200 dark:border-slate-600 bg-slate-900 text-slate-100 font-mono text-xs p-4 overflow-x-auto">
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-600 text-slate-400">
        <span>PUFF_COMPILED_CONTEXT.txt</span>
        <span className="text-emerald-400">● Graph Verified (Q3 Context)</span>
      </div>
      <pre className="space-y-1 whitespace-pre-wrap">
        <span className="text-slate-400">TASK:</span> <span className="text-slate-100">Add rate limiting to login</span>{"\n"}
        <span className="text-slate-400">TARGET CODE:</span> <span className="text-slate-100">src/auth/login.ts:12-48 login</span>{"\n"}
        <span className="text-slate-400">PAST LESSON:</span> <span className="text-slate-100">&quot;test: password appears in audit log&quot; → redact credentials</span>{"\n"}
        <span className="text-slate-400">ACTIVE DECISION:</span> <span className="text-slate-100">Tokens stored in httpOnly cookies, never localStorage</span>
      </pre>
    </div>
  );
}