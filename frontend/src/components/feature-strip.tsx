"use client";

import { useState } from "react";
import {
  Network,
  Package,
  Route,
  GitBranch,
  Lightbulb,
  Database,
  Check,
  ArrowUpRight,
} from "lucide-react";
import { PromptPreview } from "./prompt-preview";
import { GraphMemoryLoop } from "./graph-memory-loop";
import { AgentBadge } from "./agent-badge";
import { InteractivePuff } from "./interactive-puff";

const FEATURES = [
  {
    id: "memory",
    icon: Network,
    label: "Graph Memory",
    hint: "Code-anchored",
    tag: "Memory",
    heading: "Memory tied to the exact symbol",
    body: "Every failure and decision points at a real function or class, so memory can be found, checked, and invalidated when that code changes.",
    checklist: [
      "Files, functions and calls parsed with tree-sitter",
      "Failures linked to the symbol they happened in",
      "Stale lessons get flagged when code changes",
    ],
    cta: "Explore the graph",
    narration: "I pin every lesson to the exact symbol it came from.",
  },
  {
    id: "context",
    icon: Package,
    label: "ContextPack",
    hint: "Targeted context",
    tag: "Context",
    heading: "A compiled pack, not a repo scan",
    body: "Before a task runs, Puff compiles the target ranges, the callers that may break, past failures and active decisions into one prompt.",
    checklist: [
      "Target code with line ranges",
      "Impacted callers, one hop out",
      "Past lessons and active rules attached",
    ],
    cta: "See a ContextPack",
    narration: "I compile a pack for the task — not another repo scan.",
  },
  {
    id: "routing",
    icon: Route,
    label: "Routing",
    hint: "By strength",
    tag: "Routing",
    heading: "Work routed by measured strength",
    body: "Planning and verification go to reasoning agents, implementation to fast coders, docs chores to cheap ones — adjusted by past success.",
    checklist: [
      "Declared strengths per agent",
      "Adjusted by successes and failures",
      "Every routing choice is explainable",
    ],
    cta: "Inspect a decision",
    narration: "I hand each task to the agent that's best at it.",
  },
  {
    id: "parallel",
    icon: GitBranch,
    label: "Parallelism",
    hint: "Safe overlap",
    tag: "Parallelism",
    heading: "Independent tasks run at once",
    body: "Tasks whose code overlaps directly or through CALLS wait for each other. Everything independent runs in its own git worktree.",
    checklist: [
      "Overlap detected through the call graph",
      "One worktree per running task",
      "No two agents edit the same symbol",
    ],
    cta: "See the scheduler",
    narration: "Independent tasks run side by side — no collisions.",
  },
  {
    id: "why",
    icon: Lightbulb,
    label: "Explainability",
    hint: "Why this?",
    tag: "Explainability",
    heading: "Every item carries a reason",
    body: "Each prompt the agent receives is stored with the graph path behind it, so you can ask why a lesson, decision or agent was chosen.",
    checklist: [
      "Reasons stored next to the context",
      "Graph path shown for each choice",
      "Auditable after the task finishes",
    ],
    cta: "Trace a reason",
    narration: "Every choice I make keeps the reason behind it.",
  },
  {
    id: "falkordb",
    icon: Database,
    label: "FalkorDB",
    hint: "Cypher-native",
    tag: "Storage",
    heading: "Built on FalkorDB graphs",
    body: "The whole team shares one graph of symbols, tasks, failures and decisions, queried with Cypher instead of flat markdown files.",
    checklist: [
      "One shared graph across vendors",
      "Cypher queries for context lookup",
      "Symbols and lessons stay connected",
    ],
    cta: "Read the schema",
    narration: "One shared graph, queried with Cypher.",
  },
] as const;

function FeatureVisual({ id }: { id: string }) {
  if (id === "memory" || id === "parallel") {
    return <GraphMemoryLoop />;
  }

  if (id === "context" || id === "falkordb") {
    return <PromptPreview />;
  }

  if (id === "routing") {
    return (
      <div className="space-y-3 font-mono text-xs">
        <div className="flex flex-wrap gap-2">
          <AgentBadge kind="claude" />
          <AgentBadge kind="codex" />
          <AgentBadge kind="opencode" />
        </div>
        <div className="space-y-2 text-slate-400">
          <p>plan + verify → Claude Code</p>
          <p>implement → Codex</p>
          <p>docs + boilerplate → OpenCode</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 font-mono text-xs text-slate-400">
      <p className="text-slate-500">{"// why this context?"}</p>
      <p className="text-slate-200">
        login() → WAS_FIXED_BY → &quot;redact credentials&quot;
      </p>
      <p className="text-slate-200">
        task → TARGETS → src/auth/login.ts:12-48
      </p>
      <p className="text-slate-200">decision → APPLIES_TO → auth/*</p>
    </div>
  );
}

export function FeatureStrip() {
  const [active, setActive] = useState(0);
  const feature = FEATURES[active];
  const Icon = feature.icon;

  return (
    <section id="platform" className="scroll-mt-24">
      <div className="text-center">
        <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
          What you can do in Puff
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-slate-400 text-pretty">
          Main tools are on top. Click one to see what it does. More tools are listed
          below.
        </p>
      </div>

      <div className="relative mt-12 border-[1.5px] border-dashed border-slate-500">
        <span className="absolute -left-2.5 -top-2.5 select-none font-mono text-xs text-slate-500">
          +
        </span>
        <span className="absolute -right-2.5 -top-2.5 select-none font-mono text-xs text-slate-500">
          +
        </span>

        <div className="grid grid-cols-2 border-b-[1.5px] border-dashed border-slate-500 sm:grid-cols-3 md:grid-cols-6">
          {FEATURES.map((item, index) => {
            const ItemIcon = item.icon;
            const isActive = index === active;
            return (
              <button
                key={item.id}
                onClick={() => setActive(index)}
                aria-pressed={isActive}
                className={`group relative flex flex-col items-center gap-2 border-b-[1.5px] border-r-[1.5px] border-dashed border-slate-500 px-3 py-6 transition-colors duration-150 ease-out last:border-r-0 md:border-b-0 ${
                  isActive
                    ? "text-emerald-400"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <ItemIcon
                  className="h-5 w-5"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span className="text-xs font-semibold text-white">{item.label}</span>
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                  {item.hint}
                </span>
                {isActive && (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-emerald-400" />
                )}
              </button>
            );
          })}
        </div>

        <div className="grid md:grid-cols-2">
          <div className="border-b-[1.5px] border-dashed border-slate-500 p-8 md:border-b-0 md:border-r-[1.5px]">
            <span className="inline-flex items-center gap-2 border-[1.5px] border-dashed border-slate-500 px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-emerald-400">
              <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              {feature.tag}
            </span>
            <h3 className="mt-6 font-display text-3xl font-bold tracking-tight text-white">
              {feature.heading}
            </h3>
            <p className="mt-5 max-w-md text-slate-400 text-pretty">{feature.body}</p>

            <ul className="mt-8 space-y-3">
              {feature.checklist.map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm text-slate-300">
                  <span className="flex h-5 w-5 flex-none items-center justify-center border border-slate-700 text-emerald-400">
                    <Check className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                  </span>
                  {item}
                </li>
              ))}
            </ul>

            <a
              href="#playground"
              className="mt-10 inline-flex h-11 items-center gap-2 rounded-none border border-slate-700 bg-white px-5 text-sm font-semibold text-slate-950 transition-[transform,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.97]"
            >
              {feature.cta}
              <ArrowUpRight className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            </a>
          </div>

          <div className="flex items-center justify-center border-dashed border-slate-500 p-8 md:border-l-[1.5px]">
            <div className="w-full rounded-none border border-slate-600 bg-[#0b0d12] p-5 shadow-2xl shadow-black/40">
              <div className="mb-5 border-b border-slate-600 pb-5">
                <InteractivePuff message={feature.narration} reactionKey={feature.id} />
              </div>
              <FeatureVisual id={feature.id} />
            </div>
          </div>
        </div>

        <span className="absolute -bottom-2.5 -left-2.5 select-none font-mono text-xs text-slate-500">
          +
        </span>
        <span className="absolute -bottom-2.5 -right-2.5 select-none font-mono text-xs text-slate-500">
          +
        </span>
      </div>
    </section>
  );
}