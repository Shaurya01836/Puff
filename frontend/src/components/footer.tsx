import { Code2, Rss } from "lucide-react";
import { PuffLogo } from "./puff-logo";
import { DOCS_URL, REPO_URL, RELEASES_FEED_URL, RELEASES_URL } from "@/lib/site";

/**
 * Every entry goes somewhere real: a section of this page, a rendered Markdown
 * document in the repository, an issue list, or the newest installer.
 */
const columns = [
  {
    title: "Product",
    links: [
      { label: "Platform", href: "#platform" },
      { label: "Features", href: "#features" },
      { label: "Playground", href: "#playground" },
      { label: "Integrations", href: "#integrations" },
      { label: "Download", href: "#download" },
    ],
  },
  {
    title: "Graph",
    links: [
      { label: "Symbols", href: `${DOCS_URL.graphSchema}#nodes` },
      { label: "Failures", href: `${DOCS_URL.graphSchema}#q12-record-a-failure-tied-to-code` },
      { label: "Decisions", href: `${DOCS_URL.graphSchema}#q14-record-or-supersede-a-decision` },
      { label: "Procedures", href: `${DOCS_URL.graphSchema}#q13-record-a-solution` },
      { label: "Handoffs", href: `${DOCS_URL.graphSchema}#q15-handoff-between-sessions` },
    ],
  },
  {
    title: "Agents",
    links: [
      { label: "Claude Code", href: "https://claude.com/claude-code" },
      { label: "Codex", href: "https://github.com/openai/codex" },
      { label: "OpenCode", href: "https://opencode.ai" },
      {
        label: "Routing rules",
        href: `${DOCS_URL.graphSchema}#q10-route-best-agent-for-this-task`,
      },
      { label: "Strengths", href: `${DOCS_URL.architecture}#agent-adapters` },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "Architecture", href: DOCS_URL.architecture },
      { label: "Graph schema", href: DOCS_URL.graphSchema },
      { label: "Quickstart", href: `${DOCS_URL.readme}#quick-start` },
      { label: "Install guide", href: DOCS_URL.install },
      { label: "MCP server", href: `${DOCS_URL.architecture}#puff-mcp-server` },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "Roadmap", href: `${DOCS_URL.readme}#roadmap` },
      { label: "Issues", href: `${REPO_URL}/issues` },
      { label: "Pull requests", href: `${REPO_URL}/pulls` },
      { label: "Releases", href: RELEASES_URL },
      { label: "Contributors", href: `${REPO_URL}/graphs/contributors` },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "llms.txt", href: "/llms.txt" },
      { label: "sitemap.xml", href: "/sitemap.xml" },
      { label: "Benchmark", href: DOCS_URL.benchmark },
      { label: "Configuration", href: `${DOCS_URL.architecture}#configuration` },
      { label: "Team", href: `${DOCS_URL.readme}#team` },
    ],
  },
];

const socials = [
  { icon: Code2, label: "GitHub", href: REPO_URL },
  { icon: Rss, label: "Releases feed", href: RELEASES_FEED_URL },
];

export function SiteFooter() {
  return (
    <footer className="relative border-[1.5px] border-dashed border-slate-500">
      <span className="absolute -left-2.5 -top-2.5 select-none font-mono text-xs text-slate-500">
        +
      </span>
      <span className="absolute -right-2.5 -top-2.5 select-none font-mono text-xs text-slate-500">
        +
      </span>
      <span className="absolute -bottom-2.5 -left-2.5 select-none font-mono text-xs text-slate-500">
        +
      </span>
      <span className="absolute -bottom-2.5 -right-2.5 select-none font-mono text-xs text-slate-500">
        +
      </span>

      <div className="flex flex-col gap-6 border-b-[1.5px] border-dashed border-slate-500 p-8 md:flex-row md:items-start md:justify-between">
        <div className="max-w-md">
          <PuffLogo className="h-9 w-auto" />
          <p className="mt-4 text-sm text-slate-400 text-pretty">
            Shared graph memory for a team of real coding agents. Every lesson is tied
            to the code it came from.
          </p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs font-mono uppercase tracking-widest text-slate-500 transition-colors duration-150 ease-out hover:text-slate-300"
          >
            Source on GitHub ↗
          </a>
        </div>

        <p className="flex items-center gap-2 text-sm text-slate-300">
          <span className="h-2 w-2 rounded-none bg-emerald-400" />
          All memory systems online
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6">
        {columns.map((column) => (
          <div
            key={column.title}
            className="border-b-[1.5px] border-dashed border-slate-500 p-6 last:border-b-0 md:border-b-0 md:border-r-[1.5px] md:last:border-r-0"
          >
            <p className="text-sm font-semibold text-white">{column.title}</p>
            <ul className="mt-4 space-y-2">
              {column.links.map((link) => {
                const isExternal = link.href.startsWith("http");
                return (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      target={isExternal ? "_blank" : undefined}
                      rel={isExternal ? "noreferrer" : undefined}
                      className="text-sm text-slate-400 transition-colors duration-150 ease-out hover:text-white"
                    >
                      {link.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex flex-col items-center justify-between gap-4 border-t-[1.5px] border-dashed border-slate-500 p-6 sm:flex-row">
        <div className="flex items-center gap-5 text-xs text-slate-400">
          <span className="font-mono uppercase tracking-widest text-slate-500">
            Follow us
          </span>
          {socials.map(({ icon: Icon, label, href }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              aria-label={label}
              className="flex items-center gap-1.5 transition-colors duration-150 ease-out hover:text-white"
            >
              <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              {label}
            </a>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          © 2026 Puff. All rights reserved.
        </p>
      </div>
    </footer>
  );
}