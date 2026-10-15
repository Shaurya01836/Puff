import { agentLogos } from "./agent-logos";

const labels: Record<string, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  opencode: "OpenCode",
  falkordb: "FalkorDB Graph",
  cypher: "Cypher Query",
};

export function AgentBadge({ kind }: { kind: string }) {
  const Logo = agentLogos[kind as keyof typeof agentLogos];

  return (
    <span className="inline-flex items-center gap-2 border border-slate-600 bg-slate-900/60 px-2.5 py-1 text-xs font-mono text-slate-400">
      {Logo ? (
        <Logo className="h-3.5 w-3.5 text-slate-300" />
      ) : (
        <span className="h-1.5 w-1.5 bg-slate-500" />
      )}
      {labels[kind] ?? kind}
    </span>
  );
}