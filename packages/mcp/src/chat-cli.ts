// `npm run chat`: the same conversation as the app's Ask Puff panel, in the terminal.
//
//   npm run chat                 the active project (see `puff project use`)
//   npm run chat -- my-app       a project by id, name or folder
//
// Slash commands answer at once and cost nothing. Anything else goes to Claude Code, which can only
// use Puff's tools. Running the team asks you first (y/n), because it spends tokens.
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  activeProject,
  connect,
  findConfigFile,
  findProject,
  loadConfig,
  loadDotEnv,
  loadRegistry,
  openProject,
  ProjectController,
  SignInManager,
  slugify,
  type ProjectEntry,
} from '@puff/core';
import type { ChatMessage, PuffEvent } from '@puff/shared';
import { ChatSession } from './chat';
import { brainChoices, createBrain, pickBrain } from './brains';

loadDotEnv();

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

/** The project to talk about: the one named, else the active one, else $PUFF_REPO, else this folder. */
async function chooseProject(ref?: string): Promise<ProjectEntry> {
  const reg = await loadRegistry();
  const given = ref ?? (activeProject(reg) ? undefined : (process.env.PUFF_REPO ?? '.'));
  if (given === undefined) return activeProject(reg)!;
  const found = findProject(reg, given);
  if (found) return found;
  const repoPath = resolve(given);
  return {
    slug: slugify(basename(repoPath)),
    name: basename(repoPath),
    repoPath,
    addedAt: Date.now(),
  };
}

function show(m: ChatMessage): void {
  switch (m.role) {
    case 'user':
      return; // the person just typed it
    case 'action':
      return void console.log(`  ${m.ok === false ? '✖' : '✔'} ${m.text}`);
    case 'approval':
      return; // asked below, after the turn
    case 'system':
      return void console.log(m.ok === false ? `! ${m.text}` : m.text);
    case 'assistant': {
      const tokens = m.tokens ? dim(`  (${m.tokens.in + m.tokens.out} tokens)`) : '';
      return void console.log(`${bold('puff ›')} ${m.text}${tokens}`);
    }
  }
}

async function main(): Promise<void> {
  const entry = await chooseProject(process.argv[2]);
  const configFile = findConfigFile([process.cwd()]);
  if (!configFile) throw new Error('No Puff configuration found. Run: npm run puff -- config init');
  const userConfig = await loadConfig(configFile);
  const db = await connect();

  const shown = new Set<string>();
  const emit = (e: PuffEvent) => {
    if (e.type === 'chat' && !shown.has(e.message.id)) {
      shown.add(e.message.id);
      show(e.message);
    } else if (e.type === 'run' && !e.running && e.message) console.log(dim(`▶ ${e.message}`));
  };

  const opened = await openProject(db, entry, userConfig);
  const controller = await ProjectController.create({
    graph: opened.graph,
    project: opened.project,
    config: opened.config,
    emit,
    log: (line) => console.log(dim(`  ${line}`)),
  });
  // The agent that answers: PUFF_CHAT_AGENT, else the first installed one that is not signed out
  const brainId = await pickBrain(opened.config, process.env.PUFF_CHAT_AGENT);
  const session = new ChatSession({
    controller,
    brain: createBrain(brainId, opened.config),
    brainId,
    choices: () => brainChoices(opened.config),
    model: opened.config.harnesses[brainId]?.model,
    signIn: new SignInManager((agent) => opened.config.harnesses[agent]?.command, emit),
    autoApprove: process.env.PUFF_CHAT_AUTO_APPROVE === '1',
    emit,
  });

  const info = await session.info();
  console.log(`${bold('Puff')} · ${entry.name} · orchestrator: ${info.brain}`);
  if (!info.ready && info.note) console.log(`! ${info.note}`);
  console.log(dim('Say what you want, or type /help. /exit leaves.\n'));

  // Lines are read through an iterator (not rl.question), so piped input works as well as typing.
  const rl = createInterface({ input: process.stdin });
  rl.on('SIGINT', () => rl.close());
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | undefined> => {
    process.stdout.write(prompt);
    const next = await lines.next();
    return next.done ? undefined : next.value;
  };
  try {
    for (;;) {
      const line = await ask(bold('you › '));
      if (line === undefined) break;
      const said = line.trim();
      if (!said) continue;
      if (said === '/exit' || said === '/quit') break;
      try {
        await session.send(said);
      } catch (err) {
        console.log(`! ${(err as Error).message}`);
        continue;
      }
      // The orchestrator may have asked to run the team: only the person can say yes.
      for (const m of session.history) {
        if (m.approval?.state !== 'pending') continue;
        const answer = await ask(`${bold('?')} ${m.approval.summary} Run now? [y/N] `);
        await session
          .approve(m.approval.id, /^y(es)?$/i.test((answer ?? '').trim()))
          .catch((err: Error) => console.log(`! ${err.message}`));
      }
    }
  } finally {
    rl.close();
    await controller.stop();
    await session.close();
    await db.close();
  }
}

main().catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
