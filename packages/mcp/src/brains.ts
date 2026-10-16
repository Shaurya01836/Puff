// Which agent answers Ask Puff. Claude Code is handed Puff's tools directly; Codex and OpenCode answer through
// the action protocol (see action-brain.ts). A person (or team) picks one; with no choice, the first agent that
// is installed and not signed out is used, so a teammate with only Codex or OpenCode just works.
import { SIGN_IN_AGENTS, createAdapter, resolveExecutable, signInState } from '@puff/core';
import type { PuffConfig } from '@puff/core';
import type { AgentName, ChatChoice } from '@puff/shared';
import { ActionBrain, type AgentRun } from './action-brain';
import { ClaudeCodeBrain, type ChatBrain } from './chat';

export const BRAIN_LABEL: Record<AgentName, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** The order they are tried in when nobody chose */
export const BRAIN_ORDER: AgentName[] = ['claude-code', 'codex', 'opencode'];

const commandOf = (config: PuffConfig, id: AgentName): string | undefined =>
  config.harnesses[id]?.command;

const installed = (config: PuffConfig, id: AgentName): boolean => {
  const command = commandOf(config, id);
  return command !== undefined && resolveExecutable(command) !== undefined;
};

/** The agents a person can pick for Ask Puff, and which of them are installed. */
export function brainChoices(config: PuffConfig): ChatChoice[] {
  return BRAIN_ORDER.map((id) => ({
    id,
    label: BRAIN_LABEL[id],
    installed: installed(config, id),
  }));
}

/** The agent to use: the one asked for if it is installed, else the first installed one that is not signed out. */
export async function pickBrain(config: PuffConfig, preferred?: string): Promise<AgentName> {
  const asked = BRAIN_ORDER.find((id) => id === preferred);
  if (asked && installed(config, asked)) return asked;
  for (const id of BRAIN_ORDER) {
    if (!installed(config, id)) continue;
    // "unknown" (no cheap way to tell) counts as usable; only a known sign-out rules an agent out
    if ((await signInState(id, commandOf(config, id)!)) !== 'signed-out') return id;
  }
  // Nothing usable: the first installed one, or Claude Code, so the chat explains what is missing
  return BRAIN_ORDER.find((id) => installed(config, id)) ?? 'claude-code';
}

/** Whether signing in can be started from Puff for this agent (Claude Code and Codex) */
export const canSignIn = (id: AgentName): boolean => id in SIGN_IN_AGENTS;

export function createBrain(id: AgentName, config: PuffConfig): ChatBrain {
  const command = commandOf(config, id) ?? id;
  if (id === 'claude-code') return new ClaudeCodeBrain(command);

  const label = BRAIN_LABEL[id];
  const harness = config.harnesses[id];
  const adapter = harness ? createAdapter(id, harness) : undefined;
  // The planner role is read-only for every agent (Codex: read-only sandbox, OpenCode: its "plan" agent), so
  // the agent that is being the orchestrator cannot edit files or run commands.
  const run: AgentRun = async (prompt, o) => {
    if (!adapter)
      return {
        text: '',
        error: { kind: 'unavailable', message: `${label} is not set up for this project.` },
      };
    const r = await adapter.run({
      prompt,
      cwd: o.cwd,
      role: 'planner',
      timeoutMs: o.timeoutMs,
      model: o.model,
      signal: o.signal,
    });
    return {
      text: r.output,
      tokens: { in: r.tokensIn ?? 0, out: r.tokensOut ?? 0 },
      error: r.error,
    };
  };
  return new ActionBrain(label, run, async () =>
    resolveExecutable(command)
      ? { ok: true }
      : {
          ok: false,
          note: `${label} is not installed (the \`${command}\` command was not found). Slash commands still work.`,
        },
  );
}
