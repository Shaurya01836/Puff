"use client";

import { useState } from "react";
import { TechnicalGridContainer } from "./technical-grid";

const rows = [
  {
    pain: "Rediscover the codebase every time",
    puffWay: "Targeted ContextPack compiled from the tree-sitter AST graph",
    metric: "85% token reduction",
  },
  {
    pain: "Repeat past test failures",
    puffWay: "Failures linked to the exact Symbol (function / class) in FalkorDB",
    metric: "0 repeated traps",
  },
  {
    pain: "Vendor lock-in & amnesia",
    puffWay: "Claude Code, Codex and OpenCode read and write to one graph",
    metric: "100% shared memory",
  },
  {
    pain: "Nobody routes work by strength",
    puffWay: "Routing by declared strengths, adjusted by past successes",
    metric: "Explainable picks",
  },
];

type View = "split" | "pain" | "puff";

export function ProblemSolutionMatrix() {
  const [view, setView] = useState<View>("split");

  return (
    <TechnicalGridContainer className="overflow-hidden">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-emerald-400 font-medium">
            {"// problem → puff matrix"}
          </p>
          <h3 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight mt-2">
            Amnesia vs. shared graph memory
          </h3>
        </div>
        <div className="inline-flex rounded-none border border-slate-200 dark:border-slate-600 bg-slate-100/50 dark:bg-slate-900/50 p-1">
          {(["split", "pain", "puff"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded-none text-xs font-mono uppercase tracking-widest transition-colors ${
                view === v
                  ? "bg-white text-slate-950"
                  : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              }`}
            >
              {v === "split" ? "Both" : v === "pain" ? "Pain" : "Puff"}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 hidden md:grid md:grid-cols-[1fr_auto_1fr] gap-4 items-start">
        {(view === "split" || view === "pain") && (
          <div className="space-y-3">
            <p className="font-mono text-xs uppercase tracking-widest text-slate-500 mb-2">
              Today (amnesia)
            </p>
            {rows.map((r, i) => (
              <div
                key={`pain-${i}`}
                className="rounded-none border border-slate-200 dark:border-slate-600 bg-white/40 dark:bg-slate-900/40 px-4 py-3 text-sm text-slate-700 dark:text-slate-200"
              >
                {r.pain}
              </div>
            ))}
          </div>
        )}
        {view === "split" && (
          <div className="flex flex-col items-center justify-center gap-2 pt-8 text-slate-400">
            <span className="font-mono text-xs">→</span>
          </div>
        )}
        {(view === "split" || view === "puff") && (
          <div className="space-y-3">
            <p className="font-mono text-xs uppercase tracking-widest text-emerald-400 mb-2">
              With Puff
            </p>
            {rows.map((r, i) => (
              <div
                key={`puff-${i}`}
                className="rounded-none border border-slate-600 bg-slate-900/40 px-4 py-3 text-sm text-slate-200"
              >
                <div>{r.puffWay}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  {r.metric}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* mobile stack */}
      <div className="mt-6 space-y-3 md:hidden">
        {rows.map((r, i) => (
          <div
            key={`m-${i}`}
            className="rounded-none border border-slate-200 dark:border-slate-600 p-4"
          >
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {r.pain}
            </p>
            <p className="mt-2 text-sm text-slate-300">
              {r.puffWay}
            </p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {r.metric}
            </p>
          </div>
        ))}
      </div>
    </TechnicalGridContainer>
  );
}