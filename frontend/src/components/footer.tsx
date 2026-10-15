import { Code2, AtSign, Rss } from "lucide-react";
import { PuffLogo } from "./puff-logo";

const columns = [
  {
    title: "Product",
    links: ["Platform", "Playground", "ContextPack", "Routing", "Parallelism"],
  },
  {
    title: "Graph",
    links: ["Symbols", "Failures", "Decisions", "Procedures", "Handoffs"],
  },
  {
    title: "Agents",
    links: ["Claude Code", "Codex", "OpenCode", "Routing rules", "Strengths"],
  },
  {
    title: "Docs",
    links: ["Architecture", "Graph schema", "Quickstart", "CLI", "MCP server"],
  },
  {
    title: "Community",
    links: ["Contributors", "Discussions", "Roadmap", "Changelog", "Brand"],
  },
  {
    title: "Developers",
    links: ["llms.txt", "llms-full.txt", "sitemap.xml", "OpenAPI", "MCP"],
  },
];

const socials = [
  { icon: AtSign, label: "Twitter", href: "https://twitter.com" },
  { icon: Code2, label: "GitHub", href: "https://github.com/Shaurya01836/Puff" },
  { icon: Rss, label: "Blog", href: "#" },
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
            href="https://github.com/Shaurya01836/Puff"
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
              {column.links.map((link) => (
                <li key={link}>
                  <a
                    href="#"
                    className="text-sm text-slate-400 transition-colors duration-150 ease-out hover:text-white"
                  >
                    {link}
                  </a>
                </li>
              ))}
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