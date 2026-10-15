import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/footer";
import { FeatureStrip } from "@/components/feature-strip";
import { ProblemSolutionMatrix } from "@/components/problem-solution";
import { InteractivePlayground } from "@/components/interactive-playground";
import { DownloadSection } from "@/components/download-section";
import { AppDashboard } from "@/components/app-dashboard";
import { SectionDivider } from "@/components/section-divider";
import { AgentBadge } from "@/components/agent-badge";
import { ClaudeMark, OpenAIMark, OpenCodeMark } from "@/components/agent-logos";

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 sm:px-6">
        {/* Hero */}
        <section className="pt-16 text-center sm:pt-24">
          <h1 className="hero-in hero-in-2 mx-auto max-w-4xl font-display text-4xl font-bold tracking-tight text-white sm:text-6xl md:text-7xl text-balance">
            One brain. Many agents.{" "}
            <span className="text-emerald-400">Shared memory.</span>
          </h1>

          <p className="hero-in hero-in-3 mx-auto mt-6 max-w-2xl text-base leading-7 text-slate-400 sm:text-lg sm:leading-8 text-pretty">
            Puff gives a team of real coding agents one shared graph memory. Every
            lesson is tied to the code it came from, so the next agent starts with the
            answer instead of repeating the mistake.
          </p>

          <div className="hero-in hero-in-4 mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#playground"
              className="group inline-flex h-12 items-center gap-3 rounded-none bg-white pl-6 pr-1.5 text-sm font-semibold text-slate-950 transition-[transform,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.97]"
            >
              Start Graph Session
              <span className="flex h-9 w-9 items-center justify-center rounded-none bg-slate-950 text-white">
                ↗
              </span>
            </a>
            <a
              href="#platform"
              className="inline-flex h-12 items-center justify-center rounded-none border border-slate-700 bg-slate-900/60 px-6 text-sm font-semibold text-slate-200 transition-[transform,border-color] duration-150 ease-out hover:border-slate-500 active:scale-[0.97]"
            >
              Explore FalkorDB Cypher
            </a>
          </div>

          <div className="hero-in hero-in-5 mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <div className="flex -space-x-2.5">
              <span
                title="Claude Code"
                className="flex h-9 w-9 items-center justify-center border-2 border-[#08090c] bg-[#0e1116] text-slate-300"
              >
                <ClaudeMark className="h-4 w-4" />
              </span>
              <span
                title="OpenAI Codex"
                className="flex h-9 w-9 items-center justify-center border-2 border-[#08090c] bg-[#0e1116] text-slate-300"
              >
                <OpenAIMark className="h-4 w-4" />
              </span>
              <span
                title="OpenCode"
                className="flex h-9 w-9 items-center justify-center border-2 border-[#08090c] bg-[#0e1116] text-slate-300"
              >
                <OpenCodeMark className="h-4 w-4" />
              </span>
            </div>
            <p className="text-sm text-slate-400">
              <span className="font-semibold text-white">Claude Code</span>,{" "}
              <span className="font-semibold text-white">Codex</span> and{" "}
              <span className="font-semibold text-white">OpenCode</span> read and write
              one shared graph memory.
            </p>
          </div>
        </section>

        {/* Desktop app demo */}
        <div className="mt-20">
          <SectionDivider label="Product demo" />
          <section className="relative mt-8 border-[1.5px] border-dashed border-slate-500 p-3 sm:p-4">
            <span className="absolute -left-2.5 -top-2.5 select-none font-mono text-xs text-slate-500">
              +
            </span>
            <span className="absolute -right-2.5 -top-2.5 select-none font-mono text-xs text-slate-500">
              +
            </span>
            <span className="absolute -bottom-2.5 -left-2.5 select-none font-mono text-xs text-slate-500">
              +
            </span>
            <span className="absolute -right-2.5 -bottom-2.5 select-none font-mono text-xs text-slate-500">
              +
            </span>

            <AppDashboard />
          </section>
        </div>

        <div className="mt-20">
          <SectionDivider label="Features" />
          <div className="mt-8">
            <FeatureStrip />
          </div>
        </div>

        <div className="mt-20">
          <SectionDivider label="Why Puff" />
          <div className="mt-8">
            <ProblemSolutionMatrix />
          </div>
        </div>

        <div id="playground" className="mt-20 scroll-mt-24">
          <SectionDivider label="Playground" />
          <div className="mt-8 space-y-6">
            <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Play with Puff&apos;s Context Engine
            </h2>
            <InteractivePlayground />
          </div>
        </div>

        <div id="download" className="mt-20 scroll-mt-24">
          <SectionDivider label="Download" />
          <div className="mt-8 space-y-6">
            <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Get Puff for your team
            </h2>
            <DownloadSection />
          </div>
        </div>

        <div id="architecture" className="mt-20 scroll-mt-24">
          <SectionDivider label="Integrations" />
          <div className="mt-8 flex flex-wrap items-center gap-3 border-[1.5px] border-dashed border-slate-500 p-6">
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              works with
            </span>
            <AgentBadge kind="claude" />
            <AgentBadge kind="codex" />
            <AgentBadge kind="opencode" />
            <AgentBadge kind="falkordb" />
          </div>
        </div>
      </main>

      <div className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
        <SiteFooter />
      </div>
    </>
  );
}