"use client";

import { useState } from "react";
import {
  Terminal,
  Cpu,
  Database,
  Copy,
  Check,
  Network,
} from "lucide-react";
import { TechnicalGridContainer } from "./technical-grid";

const TASKS = [
  {
    id: "rate-limit",
    title: "Add rate limiting to login endpoint",
    target: "src/auth/login.ts:12-48",
    callers: ["routes/auth.ts::postLogin", "session.ts::Session.start"],
    failure: '"test: password appears in audit log" → fixed by: redact credentials before audit()',
    decision: "Tokens are stored in httpOnly cookies, never localStorage",
    assignedAgent: "Claude Code",
    agentColor: "border-slate-600 bg-slate-900/40 text-slate-300",
  },
  {
    id: "list-products",
    title: "Add helper that returns all product names",
    target: "src/products/service.ts:80-105",
    callers: ["controllers/products.ts::getProducts"],
    failure: "None recorded for this symbol",
    decision: "Always paginate DB queries with limit <= 100",
    assignedAgent: "OpenCode",
    agentColor: "border-slate-600 bg-slate-900/40 text-slate-300",
  },
];

export function InteractivePlayground() {
  const [selectedTask, setSelectedTask] = useState(TASKS[0]);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const contextPrompt = `TASK: ${selectedTask.title}\nTARGET CODE: ${selectedTask.target}\nCALLERS: ${selectedTask.callers.join(", ")}\nPAST LESSON: ${selectedTask.failure}\nACTIVE DECISION: ${selectedTask.decision}`;
    try {
      await navigator.clipboard.writeText(contextPrompt);
    } catch {
      /* clipboard may be unavailable */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="w-full py-4">
      <TechnicalGridContainer className="shadow-sm">
        <div className="flex flex-col gap-6 border-b border-slate-200 dark:border-slate-600 pb-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <div className="relative flex h-16 w-16 shrink-0 items-center justify-center border border-slate-600 bg-slate-900/60">
              <Network
                className="h-7 w-7 text-slate-400"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span className="absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-[#08090c] bg-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="border border-slate-600 bg-slate-900 px-2 py-0.5 text-[10px] font-mono font-semibold uppercase text-slate-400">
                  Interactive Sandbox
                </span>
                <span className="font-mono text-xs text-slate-400">
                  falkordblite://puff_demo
                </span>
              </div>
              <h3 className="mt-1 font-display text-xl font-bold tracking-tight text-white">
                Play with Puff&apos;s Context Engine
              </h3>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {TASKS.map((task) => (
              <button
                key={task.id}
                onClick={() => setSelectedTask(task)}
                className={`rounded-none border px-3 py-1.5 text-xs font-mono transition-[background-color,border-color,color,box-shadow] duration-150 ease-out ${
                  selectedTask.id === task.id
                    ? "border-white bg-white text-slate-950"
                    : "border-slate-600 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                }`}
              >
                {task.id === "rate-limit" ? "Rate Limiter" : "Products Helper"}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left: Graph lookup */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-mono font-semibold uppercase tracking-wider text-slate-500">
                <Database className="h-3.5 w-3.5 text-slate-500" />
                FalkorDB Graph Query Result
              </span>
              <span className="border border-slate-600 px-2 py-0.5 text-[10px] font-mono text-slate-400">
                2 Hops Traversed
              </span>
            </div>

            <div className="space-y-3 rounded-none border border-slate-200 bg-slate-50 p-4 font-mono text-xs dark:border-slate-600 dark:bg-[#0b0d12]">
              <div>
                <span className="text-slate-400">Target Symbol:</span>
                <p className="font-semibold text-slate-100">
                  {selectedTask.target}
                </p>
              </div>
              <div>
                <span className="text-slate-400">Impact Graph (Callers):</span>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-slate-700 dark:text-slate-200">
                  {selectedTask.callers.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
              <div>
                <span className="text-slate-400">Historical Lessons &amp; Fixes:</span>
                <p className="mt-0.5 text-slate-700 dark:text-slate-200">
                  {selectedTask.failure}
                </p>
              </div>
            </div>

            <div
              className={`flex items-center justify-between rounded-none border p-3 ${selectedTask.agentColor}`}
            >
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4" />
                <span className="text-xs font-mono font-medium">Auto-Routed Agent:</span>
              </div>
              <span className="text-xs font-mono font-bold">
                {selectedTask.assignedAgent}
              </span>
            </div>
          </div>

          {/* Right: Compiled prompt */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-mono font-semibold uppercase tracking-wider text-slate-500">
                <Terminal className="h-3.5 w-3.5 text-slate-500" />
                Compiled ContextPack Prompt
              </span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-xs font-mono font-medium text-slate-400 transition-colors duration-150 ease-out hover:text-white"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied!" : "Copy Context"}
              </button>
            </div>

            <div className="h-[210px] overflow-y-auto rounded-none border border-slate-600 bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-100">
              <p className="mb-2 text-slate-500">{"// Auto-generated by Puff Context Compiler"}</p>
              <p className="text-slate-200">
                <span className="text-slate-500">TASK:</span> {selectedTask.title}
              </p>
              <p className="mt-2 text-slate-200">
                <span className="text-slate-500">TARGET CODE:</span> {selectedTask.target}
              </p>
              <p className="mt-2 text-slate-200">
                <span className="text-slate-500">PAST LESSON:</span> {selectedTask.failure}
              </p>
              <p className="mt-2 text-slate-200">
                <span className="text-slate-500">ACTIVE DECISION:</span> {selectedTask.decision}
              </p>
            </div>
          </div>
        </div>
      </TechnicalGridContainer>
    </section>
  );
}