"use client";

import { useState } from "react";
import { Download, Terminal, Check, Copy, Laptop, Monitor, ShieldCheck } from "lucide-react";
import { TechnicalGridContainer } from "./technical-grid";
import { INSTALLER_URL, LATEST_RELEASE_URL } from "@/lib/site";

export function DownloadSection() {
  const [copiedCmd, setCopiedCmd] = useState(false);

  const copyInstall = async () => {
    try {
      await navigator.clipboard.writeText(
        "git clone https://github.com/Shaurya01836/Puff.git && cd Puff && npm install"
      );
    } catch {
      /* clipboard may be unavailable */
    }
    setCopiedCmd(true);
    window.setTimeout(() => setCopiedCmd(false), 2000);
  };

  return (
    <section className="w-full py-4">
      <TechnicalGridContainer className="overflow-hidden">
        <div className="relative z-10 mx-auto max-w-3xl space-y-8 text-center">
          <div className="inline-flex items-center gap-2 border border-slate-600 bg-slate-900/60 px-3 py-1 text-xs font-mono font-medium text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Graph Hacks 2026 Build • Open Source
          </div>

          <h2 className="font-display text-3xl font-bold tracking-tight text-white md:text-5xl">
            Get Puff for your team
          </h2>

          <p className="mx-auto max-w-2xl text-base text-slate-400 md:text-lg">
            Run Claude Code, Codex and OpenCode on a single repository with shared
            graph memory.
          </p>

          <div className="flex flex-col items-center justify-center gap-4 pt-4 sm:flex-row">
            <a
              href={INSTALLER_URL}
              rel="noopener"
              className="inline-flex w-full items-center justify-center gap-2.5 whitespace-nowrap bg-white px-6 py-3.5 text-sm font-semibold text-slate-950 transition-[transform,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.97] sm:w-auto"
            >
              <Download className="h-4 w-4" />
              Download for Windows (.exe)
            </a>
            <button
              onClick={copyInstall}
              className="inline-flex w-full items-center justify-center gap-2.5 whitespace-nowrap border border-slate-700 bg-slate-900 px-6 py-3.5 font-mono text-xs text-slate-100 transition-[transform,background-color,border-color] duration-150 ease-out hover:bg-slate-800 active:scale-[0.97] sm:w-auto"
            >
              <Terminal className="h-4 w-4 text-slate-400" />
              {copiedCmd ? "Command Copied!" : "git clone … && npm install"}
              {copiedCmd ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-slate-400" />
              )}
            </button>
          </div>

          <p className="mx-auto max-w-xl text-xs leading-relaxed text-slate-500">
            New in this release: a live Tasks view with the graph&apos;s reason for each task and
            one-click &ldquo;Open in&rdquo; your agent&apos;s terminal, a Memory screen with every
            lesson&apos;s trust, and fixes for projects whose checks already fail. Windows 10 or
            11, 64-bit, about 115 MB. Already installed? Run the new installer and it
            updates in place, keeping your projects and memory. The installer is not code-signed
            yet, so Windows may warn about an unknown publisher: choose{" "}
            <span className="text-slate-300">More info</span>, then{" "}
            <span className="text-slate-300">Run anyway</span>. macOS and Linux: run from source with
            the command above.{" "}
            <a
              href={LATEST_RELEASE_URL}
              rel="noopener"
              className="text-slate-300 underline underline-offset-2 hover:text-white"
            >
              Release notes
            </a>
          </p>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 pt-2 text-xs font-mono text-slate-500">
            <span className="flex items-center gap-1.5">
              <Laptop className="h-3.5 w-3.5" /> Windows 10 / 11
            </span>
            <span className="flex items-center gap-1.5">
              <Monitor className="h-3.5 w-3.5" /> Docker Desktop or FalkorDB Cloud
            </span>
            <span>Git</span>
            <span>Any one of Claude Code, Codex or OpenCode</span>
          </div>
        </div>
      </TechnicalGridContainer>
    </section>
  );
}