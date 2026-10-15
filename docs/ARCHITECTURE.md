# 📐 Puff architecture, platform and deployment

How Puff is put together, how it runs agents, and how to set it up.

- [System overview](#system-overview)
- [Platform and tech stack](#platform-and-tech-stack)
- [Monorepo layout](#monorepo-layout)
- [Components](#components)
- [Task lifecycle](#task-lifecycle)
- [Agent adapters](#agent-adapters)
- [Context compiler](#context-compiler)
- [Puff MCP server](#puff-mcp-server)
- [Configuration](#configuration)
- [Shared types and API contract](#shared-types-and-api-contract)
- [UI](#ui)
- [Deployment](#deployment)
- [Demo repo and benchmark](#demo-repo-and-benchmark)
- [Build phases](#build-phases)
- [Security](#security)
- [Risks and mitigations](#risks-and-mitigations)

The graph data model and every Cypher query are in **[GRAPH_SCHEMA.md](GRAPH_SCHEMA.md)**.

---

## System overview

```mermaid
flowchart TB
    subgraph UI["apps/desktop: Electron + React"]
        B[Board] --- TD[Task detail] --- MG[Memory graph] --- AG[Agents + Savings]
    end

    subgraph CORE["packages/core: Node + TypeScript"]
        IDX[Indexer<br/>tree-sitter]
        GQ[Graph layer<br/>all Cypher]
        CC[Context compiler]
        RT[Router]
        SC[Scheduler]
        OR[Orchestrator loop]
        AD[Harness adapters]
        WT[Worktree manager]
        BUS[Event bus]
        BEN[Benchmark runner]
    end

    MCP["packages/mcp<br/>Puff MCP server"]
    DB[("FalkorDB<br/>puff_&lt;project&gt;")]
    GIT[("git worktrees<br/>one per task")]
    CLI["Agent CLIs<br/>claude · codex · opencode"]

    UI <-->|"typed IPC (PuffApi)"| CORE
    IDX --> GQ
    CC --> GQ
    RT --> GQ
    SC --> GQ
    OR --> SC & RT & CC & AD & WT
    GQ <--> DB
    WT --> GIT
    AD -->|spawn, no shell| CLI
    CLI -.->|"MCP (Claude Code, OpenCode)"| MCP
    MCP --> GQ
    OR --> BUS --> UI
```

**Key principle:** all logic lives in `packages/core`, which runs **without Electron**. The desktop app is only a window onto it. If packaging breaks, the same demo runs from the CLI with a web renderer.

---

## Platform and tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 22**, TypeScript (strict) | Spawning CLIs, git and the FalkorDB client are all native to Node |
| Graph DB | **FalkorDB** (`falkordb/falkordb:latest`) | Fast multi-hop Cypher, one graph per project, built-in vector + graph algorithms |
| DB client | **`falkordb`** npm (official, MIT) | `connect`, `selectGraph`, parameterised `query`, `roQuery`, `list` |
| Parsing | **`web-tree-sitter@0.22.6`** + `tree-sitter-wasms` | WASM means no native rebuild inside Electron. **Pinned**: newer versions changed the API. |
| Git | `simple-git` + `git worktree` | Each task gets its own isolated checkout |
| Agent protocol | `@modelcontextprotocol/sdk` | Standard tool interface for Claude Code and OpenCode |
| Desktop | Electron + **electron-vite** | Same Node backend; the UI is a Vite React app first |
| UI | React, Tailwind, shadcn/ui | |
| Graph viz | `react-force-graph` | Force layout, handles a few thousand nodes |
| Tests | Vitest (Puff and the demo repo) | |

### Supported operating systems

| OS | Status | Notes |
|---|---|---|
| Windows 11 | Primary dev machine | See the [Windows notes](#windows-notes) for spawning |
| macOS / Linux | Supported | Nothing platform-specific beyond spawning |

---

## Monorepo layout

npm workspaces.

```text
puff/
├─ apps/
│  └─ desktop/                 Electron main + preload + React renderer
│     ├─ src/main/             IPC handlers → core
│     ├─ src/preload/          exposes window.puff (PuffApi)
│     └─ src/renderer/         screens, graph view, mascot states
├─ packages/
│  ├─ shared/                  types.ts, api.ts, mocks/ (frozen contract)
│  ├─ core/
│  │  ├─ src/db/               connection, graph init, indexes
│  │  ├─ src/queries/          code (impact, symbol lookup), graph export for the UI, explain (Why, feed, agent stats)
│  │  ├─ src/indexer/          walk → hash → parse → resolve → write
│  │  ├─ src/memory/           tasks, sessions, memory writes, locate (failure → code), failures, puff-report
│  │  ├─ src/context/          prompt.ts (pure rendering) + compiler.ts (graph → ranked, budgeted ContextPack)
│  │  ├─ src/seed/             demo memory seed (flagged seeded)
│  │  ├─ src/agents/           adapters, router, pool
│  │  ├─ src/orchestrator/     loop, scheduler, state machine, verify
│  │  ├─ src/git/              worktree manager, diff, merge
│  │  ├─ src/bench/            benchmark runner
│  │  └─ src/cli.ts            `puff` CLI entry
│  └─ mcp/                     stdio MCP server, imports core
├─ demo/
│  ├─ shop-api/                synthetic Express + TS repo with seeded traps
│  └─ tasks/                   benchmark task definitions
├─ scripts/                    seed.ts, reset-graph.ts, run-benchmark.ts
├─ bench/                      results.json (generated)
├─ docs/
├─ assets/                     mascot, screenshots
├─ puff.config.yaml
└─ docker-compose.yml
```

---

## Components

| Component | Responsibility | Graph queries |
|---|---|---|
| **Indexer** | Walk the repo (respecting `.gitignore`), hash files, parse with tree-sitter, resolve calls and imports, write in batches | Q1, Q2 |
| **Graph layer** | The only module that talks to FalkorDB. Typed functions wrapping each query. | all |
| **Memory** | Record sessions, failures, solutions, decisions, handoffs. Parse `<puff-report>`. | Q11–Q15 |
| **Context compiler** | Build a per-task, per-role prompt within a token budget and store it as a ContextPack | Q3, Q4, Q6 |
| **Router** | Pick the agent type for a task from strengths and history, respecting free instances | Q10 |
| **Scheduler** | Promote ready tasks, check overlap, claim atomically, respect `maxParallel` | Q7, Q8, Q9 |
| **Orchestrator** | Runs the loop and state machine: retry, escalate, merge, re-index | all above |
| **Harness adapters** | Run each agent CLI headless and normalise its output into `HarnessResult` | — |
| **Worktree manager** | `git worktree add` per task, collect diffs, merge one at a time, clean up | — |
| **Event bus** | Push `task:update`, `session:update` and `memory` events to the UI | — |
| **MCP server** | Expose memory tools to agents that support MCP | Q3, Q5, Q6, Q12–Q15 |
| **Benchmark runner** | Run tasks with and without Puff, aggregate into `bench/results.json` | reads Session |

### Indexer pipeline

```mermaid
flowchart LR
    W["Walk repo<br/>.ts .tsx .js .jsx<br/>skip node_modules, dist"] --> H{"Hash<br/>changed?"}
    H -- no --> SKIP[skip]
    H -- yes --> P["Parse<br/>tree-sitter query"]
    P --> D["Defs<br/>path::name<br/>path::Class.method"]
    P --> C["Calls<br/>attributed to<br/>enclosing def"]
    P --> I["Imports<br/>relative paths"]
    C --> R["Resolve by name:<br/>same file → imported files<br/>drop unresolved"]
    D & R & I --> Q1["Batch write<br/>UNWIND (Q1)"]
    Q1 --> Q2["Mark linked memory<br/>stale (Q2)"]
```

Tree-sitter query (tested on TypeScript):

```scheme
(function_declaration name:(identifier) @def.fn)
(variable_declarator name:(identifier) @def.fn value:(arrow_function))
(method_definition name:(property_identifier) @def.method)
(class_declaration name:(type_identifier) @def.class)
(call_expression function:[(identifier) @call
                           (member_expression property:(property_identifier) @call)])
(import_statement source:(string) @import)
```

Technologies come from `package.json` dependencies plus file extensions.

---

## Task lifecycle

### State machine

```mermaid
stateDiagram-v2
    [*] --> planned
    planned --> ready: all dependencies done (Q7)
    ready --> running: claimed (Q9) + no overlap (Q8)
    running --> verifying: agent finished
    verifying --> done: tests + verifier pass
    running --> failed: error / timeout
    verifying --> failed: tests fail
    failed --> retrying: retries left
    retrying --> running
    failed --> escalated: retries exhausted
    escalated --> running: next agent in chain
    done --> [*]
```

### Running a task (implemented in `orchestrator/run.ts`)

```mermaid
flowchart TD
    A["Pick agent<br/>declared strengths + past results (Q10),<br/>then up the escalation chain"] --> B["New worktree + branch<br/>node_modules linked in"]
    B --> C["Start session, compile context<br/>(ContextPack with reasons)"]
    C --> D["Run the agent headless<br/>prompt on stdin"]
    D -->|"could not run<br/>(auth, timeout, crash)"| E["Session = error<br/>no failure memory<br/>escalate"]
    D --> F{"Writer role?"}
    F -->|"no (planner)"| G["Session = success<br/>nothing to merge"]
    F -->|yes| H{"Any files changed?"}
    H -->|no| I["Failure: changed nothing<br/>no lesson, escalate"]
    H -->|yes| J["Run the project's tests<br/>in the worktree"]
    J -->|pass| K["Commit, merge (one at a time),<br/>re-index, record decisions,<br/>record the fix for earlier failures"]
    J -->|fail| L["Locate failures in code,<br/>record Failure memory,<br/>keep the branch"]
    L --> M{"Retries left<br/>on this agent?"}
    M -->|yes| B
    M -->|no| N["Escalate to the next agent"] --> B
```

What it guarantees:

- **Puff observes, the agent does not self-report.** Success means the project's own test command exited 0 in the worktree. The agent's claim is never trusted, and a writer that changed nothing cannot "pass" on the old tests.
- **Retry with the lesson.** The retry gets a new worktree and a freshly compiled context that now contains the failure Puff just recorded.
- **The fix is learned.** When a later attempt passes, Puff records that as the **Solution** for the earlier failures of the same task (`FIXED_BY`, with the merge commit), so the next task that touches that code gets *what failed and what fixed it*.
- **Bounded cost.** At most `limits.maxAttempts` agent runs per task. An agent found unusable (not signed in, not installed) is skipped for the rest of the run.
- **Clean up.** A passing branch is deleted after the merge, a failed attempt keeps its branch (`puff/<task>-a<n>`) so it can be inspected, and worktrees are always removed. Removing one never touches the real `node_modules` it links to (tested).
- **Stop and crash recovery.** Stopping kills the running agent and returns its task to the queue; tasks left half-run by a crash are reset on the next start and their orphaned sessions closed as errors.

The team loop (`orchestrator/orchestrator.ts`) promotes planned tasks whose dependencies are done (Q7) and runs ready tasks one at a time, oldest first. Overlap-aware parallel runs and the goal-to-tasks planner arrive in P4.

### Planning: from a goal to tasks (`memory/plan.ts`, `memory/report.ts`)

A goal becomes a task of type `plan`. When the team runs, the planner agent (read-only) is given:

- the goal, the project's technologies, procedures and recent failures,
- a **code map**: every source file and the functions in it (read from the graph), so it can name real targets instead of guessing,
- the **tasks already on the board**, so it does not repeat them,
- the exact output format and the rules for a safe plan.

It answers with one JSON block, the same `<puff-report>` every agent uses, so it works for Codex too (which cannot call MCP tools headlessly):

```json
{"tasks":[
  {"title":"Add a /products/count route","type":"implement","complexity":"low","targets":["productsRouter"],"dependsOn":[]},
  {"title":"Document the route in docs/API.md","type":"chore","dependsOn":[0]}
]}
```

Any agent can also include `tasks` in its report to **ask for follow-up work** (for example a coder noticing the docs need updating), and `handoffs` to leave a note for whoever works next. Because agents can create work, Puff keeps it under control:

| Safeguard | Rule |
|---|---|
| Size | A plan creates at most `limits.maxTasksPerPlan` tasks (8) |
| Depth | Agent-created work may nest at most `limits.maxSpawnDepth` levels (2): a planner's task may ask for follow-ups, but those cannot ask for more forever |
| Cycles | `dependsOn` may only point at **earlier** tasks in the same list, so a plan can never contain a cycle |
| Duplicates | A task with the same title as one already on the board is skipped |
| Unknown code | A name that is not in the graph (new code) is kept as a **hint** shown to the agent, never guessed into a symbol |
| Empty plans | A plan that creates no tasks counts as a **failure**, not a success |
| Attribution | Each created task is linked to the session that asked for it (`(Session)-[:SPAWNED]->(Task)`) |

Models are loose about JSON, so the report parser is forgiving where it can be (a single string where a list belongs, numbers as strings, an unknown `type` falls back to `implement`) and strict where it matters (a task without a title invalidates the report, and the reason is returned).

### Scheduling: what runs at the same time (`orchestrator/schedule.ts`, `orchestrator.ts`)

The team loop keeps up to `limits.maxParallel` tasks running, and for every ready task, oldest first:

1. **Overlap (Q8).** If its code overlaps a task already in flight, it waits and `blockedBy` says for what.
2. **Claim (Q9).** Otherwise it is claimed atomically and started in its own worktree.
3. **Slots.** The agent chosen for it may only have as many simultaneous runs as its configured `instances`; extra runs wait for a free slot.
4. **Merge, one at a time.** Merging and the re-index that follows it run under one repository lock, so parallel tasks never read the main checkout halfway through each other's merge.

When any task finishes, the loop promotes tasks whose dependencies are now done (Q7) and looks again. This is tested with fake agents: independent tasks overlap in time, a task overlapping a running one starts only after it ends, and an agent with 2 slots never runs 3 tasks at once.

Not done: if two tasks edit different functions of the same file, git merges them, but a real textual conflict aborts the merge and fails that task cleanly. After a merge, the combined result is not re-tested.

### The Team timeline (`getTeamTimeline`)

The **Team** screen tells the story in order: which agent worked on which task and how it ended, which note was handed to whom, which agent asked for which task, and when a task moved up to another agent (**escalated**) or got a second try (**retried**). It is derived entirely from sessions, handoffs and `SPAWNED` edges already in the graph, so there is nothing extra to keep in sync. `npm run puff -- team` prints the same.

### Delegating a task by hand

The desktop app's **New task** dialog (and `puff task add`) lets a person choose what to do, which functions it touches (searched from the graph), the type and complexity, and **which agent and model** (Auto lets Puff route it). The choice is stored on the task (`preferredAgent`, `model`) and honoured by the run loop; escalation still applies if that agent fails.

### The demo needs its own git repository

Agents work in git worktrees, so a project must be the root of its own repository. `demo/shop-api` lives inside Puff's repository, so `npm run puff -- demo setup` copies it to `~/.puff/demo/shop-api` (a fresh repository with one commit, `node_modules` linked), and writes `PUFF_REPO` to your local `.env`. It is deliberately **outside the Puff checkout**: an agent working there cannot wander up into Puff's own files, such as `demo/TRAPS.md`, which lists the seeded traps. `--force` recreates it from scratch.

### Who writes what

| Written by | What |
|---|---|
| **Puff (always)** | Session, outcome, tokens, duration, changed files, test results, Failure (from test output), ContextPack, status changes, re-index |
| **Agents via MCP** (Claude Code, OpenCode) | Decisions, notes, handoffs |
| **Agents via `<puff-report>`** (all agents, including Codex) | Decisions, notes |

Puff never trusts an agent's claim of success. The outcome comes from the exit code **and** the test run.

---

## Agent adapters

Every agent is run headless, in the task's own git worktree, with the prompt on **stdin**. The commands below are what Puff actually sends (verified against Claude Code 2.1.232, Codex 0.162.1 and OpenCode 1.19.0); the base arguments come from `puff.config.yaml`, and Puff adds the role's permissions, the working directory and the model.

| Harness | Base command | Added per role | Strengths |
|---|---|---|---|
| 🟠 **Claude Code** | `claude -p --output-format json --no-session-persistence` | `--permission-mode acceptEdits` and `--allowedTools Read,Glob,Grep,Edit,Write,MultiEdit,Bash(npm test:*)…` for writers; `--permission-mode default` and read-only tools for planners and verifiers | reasoning, planning, verification, review |
| 🟢 **Codex** | `codex exec --json --skip-git-repo-check --ephemeral` | `-s workspace-write` for writers, `-s read-only` otherwise, `-C <worktree>`, then `-` (read the prompt from stdin) | implementation, refactor |
| 🔵 **OpenCode** | `opencode run --format json` | `--dir <worktree>`, `--agent build` for writers and `--agent plan` (cannot edit) otherwise | simple-edit, docs, formatting, boilerplate |
| ⚫ Antigravity | — | — | **Not supported.** In headless mode it ignores `permissions.allow` and reports denied runs as successful, which would corrupt failure memory. Listed as future work. |

`--full-auto`, which the original plan used for Codex, no longer exists in Codex 0.162; the sandbox is chosen with `-s`. Puff's MCP server is not passed to the agents yet (phase P5), so all three get their context in the prompt.

### Adapter interface

```ts
export interface HarnessAdapter {
  readonly name: AgentName;
  available(): Promise<{ ok: boolean; detail: string }>;   // installed and runnable? no model call
  run(opts: { prompt; cwd; role; timeoutMs; model?; signal? }): Promise<HarnessResult>;
}

export interface HarnessResult {
  exitCode: number | null;
  output: string;            // the agent's final text
  report?: PuffReport;       // parsed <puff-report>
  tokensIn?: number;         // total input, including cached
  cachedIn?: number;         // the cached part of tokensIn
  tokensOut?: number;
  costUsd?: number;
  durationMs: number;
  error?: { kind: 'auth' | 'unavailable' | 'timeout' | 'aborted' | 'api' | 'crash'; message: string };
  raw: string;               // trimmed stdout, for debugging
}
```

**Errors are about the harness, never the code.** A run that ends in `error` is recorded as a session with outcome `error` and **writes no failure memory**. Otherwise a login problem would teach the next agent a "lesson" about the wrong function. We saw this for real: the standalone `claude` CLI prints a normal-looking JSON result with `is_error: true` and the text *"OAuth session expired and could not be refreshed"*, with exit code 1.

### Running programs safely (Windows)

- **No shell, ever, for agents.** The prompt is data. It travels on stdin, and arguments are passed as an array, so a prompt containing `& echo pwned | $(whoami)` arrives as plain text (tested).
- npm installs CLIs as **`.cmd` shims** on Windows, which Node refuses to spawn without a shell. Puff reads the shim and launches what it wraps: `opencode.cmd` wraps a real `opencode.exe`, and `codex.cmd` wraps `node …/codex.js`. The real target is the **last** quoted path in the shim, because shims first mention `%dp0%\node.exe` in a "use the bundled node" check (this broke Codex detection until `puff agents` caught it).
- Inside Electron, `process.execPath` is the Electron binary, so JavaScript shims are run with the `node` found on `PATH` (or `ELECTRON_RUN_AS_NODE`).
- Every run has a **timeout and an abort signal**. Both kill the whole process tree (`taskkill /T` on Windows), because agents start their own children.
- The test command is the one exception to "no shell": it comes from the project's own config, not from model output, and `npm` needs the shell on every OS.

### Token reporting (measured)

The three CLIs report usage differently, so Puff normalises everything to *total input (including cache)*, *the cached part*, and *output*.

| Harness | Where the tokens are | How they are normalised |
|---|---|---|
| Claude Code | `usage` in the result object | `input_tokens` **excludes** cache; total input = input + cache creation + cache reads |
| Codex | `turn.completed.usage` event | `input_tokens` **includes** `cached_input_tokens`; used as is |
| OpenCode | `step_finish.part.tokens` per step | `input` **excludes** cache; total input = input + cache read + cache write; reasoning tokens are added to output |

Even a one-word reply costs about **15,000 input tokens on Codex** (about 10,000 cached) and about **11,000 on OpenCode**, because each CLI sends its own system prompt. The benchmark therefore reports cached and uncached input separately and applies the same accounting to both arms.

---

## Context compiler

Input: `taskId`, `role`. Output: a prompt string and a stored `ContextPack`.

| Role | Includes |
|---|---|
| **planner** | goal, project technologies, a **code map** (files and their functions), the tasks already on the board, procedures, active decisions, recent project-wide failures, the plan format and rules |
| **coder** | task, target symbols with file + line ranges, callers (impact), failures + fixes on those symbols, active decisions, procedures, pending handoffs |
| **verifier** | task, diff, tests to run, decisions the change must respect, previous failures on these symbols, pending handoffs |
| **chore** | task, target files, active decisions, procedures, pending handoffs |

**Rules:**
- Budget of about **2k tokens**. Items are ranked: unresolved failures → fixed failures → decisions → callers → procedures.
- `stale` items are dropped unless nothing else exists. In that case they are labelled *"possibly outdated"*.
- Every included item gets a **reason**, stored on the `INCLUDED` edge.

Prompt template:

```text
You are the {role} on a team of coding agents working in this repository.

TASK: {title}
TARGET CODE (read these first, do not scan the whole repo):
- {file}:{startLine}-{endLine}  {symbol}
CALLERS THAT MAY BREAK: {callers}

PROJECT MEMORY
Past failures here and their fixes:
- {failure} → fixed by: {fix}
Active decisions you must respect:
- {decision}
Procedures:
- {procedure}

WHEN DONE: state files changed, tests run, and any decision you made and why,
in a final block:
<puff-report>{"decisions":[{"symbol":"...","text":"..."}],"notes":"..."}</puff-report>
```

---

## Puff MCP server

A stdio server (`packages/mcp`) built with `@modelcontextprotocol/sdk`. Environment: `FALKORDB_URL`, `PUFF_PROJECT`.

| Tool | Input | Does |
|---|---|---|
| `get_context` | `{ taskId, role }` | Runs the context compiler and returns the text |
| `impact_of` | `{ symbolId }` | Q6 |
| `record_decision` | `{ symbolId, text, supersedes? }` | Q14 |
| `record_failure` | `{ symbolId, message, kind }` | Q12 |
| `record_solution` | `{ failureId, summary }` | Q13 |
| `handoff` | `{ toRole, payload }` | Q15 |
| `why` | `{ sessionId }` | Q5 |

Claude Code config (`puff-mcp.json`, generated by Puff with absolute paths):

```json
{
  "mcpServers": {
    "puff": {
      "command": "node",
      "args": ["<abs-path>/packages/mcp/dist/index.js"],
      "env": { "FALKORDB_URL": "falkor://localhost:6379", "PUFF_PROJECT": "shop_api" }
    }
  }
}
```

---

## Configuration

`puff.config.yaml` at the repo root (the file in the repo is the source of truth; this is its shape):

```yaml
harnesses:
  claude-code:
    command: claude
    args: ["-p", "--output-format", "json", "--no-session-persistence"]
    promptVia: stdin
    instances: 2
    strengths: [reasoning, planning, verification, review]
    # model: optional provider model override; omit to use the CLI's own configuration
  codex:
    command: codex
    args: ["exec", "--json", "--skip-git-repo-check", "--ephemeral"]
    promptVia: stdin
    instances: 2
    strengths: [implementation, refactor]
  opencode:
    command: opencode
    args: ["run", "--format", "json"]
    promptVia: stdin
    instances: 1
    strengths: [simple-edit, docs, formatting, boilerplate]

routing:            # task type → required capabilities
  plan: [planning, reasoning]
  implement: [implementation]
  verify: [verification]
  chore: [simple-edit, docs]

limits:
  maxParallel: 3
  timeoutMs: 600000
  retriesBeforeEscalate: 1
  maxAttempts: 3          # hard cap on agent runs per task, across retries and escalation
  contextTokenBudget: 2000

escalation: [opencode, codex, claude-code]   # weakest to strongest

verify:
  testCommand: "npm test"
  verifierAgent: claude-code

worktrees:
  linkDirs: [node_modules]   # linked into every task worktree from the main checkout
```

Agents, capabilities and `HAS_STRENGTH` edges are written to the graph from this file on startup, so routing (Q10) is a pure graph query.

---

## Shared types and API contract

`packages/shared` is the **frozen contract** between backend and UI. The UI is built against mocks; the backend implements the same interface.

```ts
export type AgentName = 'claude-code' | 'codex' | 'opencode';
export type Role = 'planner' | 'coder' | 'verifier' | 'chore';
export type TaskType = 'plan' | 'implement' | 'verify' | 'chore';
export type TaskStatus =
  | 'planned' | 'ready' | 'running' | 'verifying'
  | 'failed' | 'retrying' | 'escalated' | 'done';

export interface PuffApi {
  openProject(repoPath: string): Promise<{ projectId: string }>;
  indexProject(projectId: string): Promise<{ files: number; symbols: number; calls: number }>;
  listTasks(projectId: string): Promise<Task[]>;
  createGoal(projectId: string, goal: string): Promise<Task[]>;
  createTask(projectId: string, t: Partial<Task>): Promise<Task>;
  getTask(taskId: string): Promise<{ task: Task; sessions: SessionInfo[] }>;
  getContextPack(sessionId: string): Promise<ContextPack>;
  getWhy(taskId: string): Promise<WhyPath>;
  getGraph(projectId: string, focusId?: string, depth?: number): Promise<GraphData>;
  getMemoryFeed(projectId: string, limit?: number): Promise<MemoryEvent[]>;
  listAgents(projectId: string): Promise<AgentProfile[]>;
  getSavings(projectId: string): Promise<Savings>;
  start(projectId: string): Promise<void>;
  stop(projectId: string): Promise<void>;
  onEvent(cb: (e: PuffEvent) => void): () => void;
}
```

The full type definitions (`Task`, `SessionInfo`, `ContextPack`, `WhyPath`, `GraphData`, `MemoryEvent`, `AgentProfile`, `Savings`, `PuffEvent`) live in `packages/shared/src/types.ts`. Mock fixtures cover every return type: 8–12 tasks across all statuses, a 60–100 node graph, 20 memory events and 3 agents.

---

## UI

| Screen | Contents |
|---|---|
| **Memory graph** (the demo opens here) | Force graph of the project. Nodes coloured by kind; the current task's neighbourhood highlighted; click a node → side panel; live **memory feed** column. |
| **Board** | Columns: Planned · Running · Verifying · Failed/Retrying · Done. Cards show title, agent, role, worktree, tests passed, tokens, and **"waiting on …"** when blocked by overlap. "+ New goal" with agent: Auto / specific. |
| **Task detail** | Agent output, changed files, **Context received** (items + reasons), **Why?** mini-graph, session history |
| **Agents** | Pool cards (strengths, busy/free, success rate, average tokens) and the **savings meter** |

Mascot states: **idle** (empty states) · **working** (agents running) · **happy** (verified) · **worried** (failure recorded).

Visual direction: dark and calm, "mission control". The graph and the mascot are the identity.

---

## Deployment

Puff is a **local-first developer tool**. Agents run on your machine against your repo, and FalkorDB runs next to them. Nothing leaves your machine except the agent CLIs' own model calls.

```mermaid
flowchart LR
    subgraph Machine["Your machine"]
        APP["Puff app / CLI<br/>Node 22"]
        AG["claude · codex · opencode"]
        REPO[("your repo<br/>+ .puff/worktrees")]
        subgraph Docker
            FDB[("FalkorDB<br/>:6379 db · :3000 browser")]
        end
    end
    CLOUD[("FalkorDB Cloud<br/>optional")]
    APP <--> FDB
    APP -.->|FALKORDB_URL| CLOUD
    APP --> AG --> REPO
```

### Option A: Docker (recommended)

```yaml
# docker-compose.yml
services:
  falkordb:
    image: falkordb/falkordb:latest
    ports: ["6379:6379", "3000:3000"]
    volumes: ["falkordb-data:/data"]
volumes:
  falkordb-data: {}
```

```bash
docker compose up -d
```

### Option B: no Docker (falkordblite)

`falkordblite` ships a real FalkorDB server binary through pip, which is useful when Docker Desktop isn't available.

```bash
pip install falkordblite
```

Start it on port 6379 and point `FALKORDB_URL` at it.

### Option C: FalkorDB Cloud

Create a free instance and set `FALKORDB_URL` to its connection string. Puff only stores references (no code bodies), so the free tier is plenty.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FALKORDB_URL` | `falkor://localhost:6379` | Database connection |
| `PUFF_PROJECT` | from the opened repo | Graph name suffix (`puff_<project>`) |
| `PUFF_CONFIG` | `./puff.config.yaml` | Harness and routing config |
| `PUFF_WORKTREES` | `<repo>/.puff/worktrees` | Where task worktrees are created |
| `CODEX_HOME` | `~/.codex` | Codex config dir (used for MCP config if enabled) |
| `OPENCODE_CONFIG` | — | OpenCode config override |

### Run

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run puff -- index demo/shop-api
```

```bash
npm run puff -- seed --force
```

```bash
npm run puff -- context <taskId>
```

### Scripts

| Script | Does |
|---|---|
| `npm run dev` | Electron app with hot reload |
| `npm run puff -- <cmd>` | Headless CLI: `init`, `index`, `symbols`, `impact`, `task`, `context`, `session`, `failure`, `fix`, `decision`, `procedure`, `handoff`, `memory`, `why`, `seed`, `reset-memory` (`goal` and `run` arrive with the orchestrator) |
| `npm run puff -- seed --force` | Load sample tasks, sessions and memory for the demo repo (flagged `seeded`) |
| `npm run puff -- reset-memory` | Development only: delete tasks, sessions and memory, keeping the code graph |
| `npm run bench` | Run the benchmark → `bench/results.json` |
| `npm run build:desktop` | Package the Electron app (electron-builder) |

### Data lifecycle

- **Graph:** persisted in the `falkordb-data` volume. `reset-memory` clears memory but keeps the code graph.
- **Worktrees:** created under `.puff/worktrees/<taskId>`, removed after merge or after a failed task is escalated.
- **Inspecting:** the FalkorDB browser at <http://localhost:3000> runs any query from [GRAPH_SCHEMA.md](GRAPH_SCHEMA.md).

---

## Demo repo and benchmark

**`demo/shop-api`** is our own synthetic Express + TypeScript project: auth (login, session, tokens), users, products, cart, orders, middleware and a Vitest + Supertest suite (38 files, 25 tests). It has **seeded traps** (full list in `demo/TRAPS.md`, kept outside the repo copy agents see):

- `login` must never log passwords
- tokens must never go to `localStorage`
- the rate limiter must reset per IP

**Benchmark tasks:**

1. Add rate limiting to `login` (touches auth + middleware)
2. Add an endpoint that reuses cart logic (needs callers/impact)
3. Fix a seeded failing test
4. **Repeated-failure pair:** task A fails on a trap in session 1; task B in session 2 touches the same function and must avoid the trap on the first try
5. Docs chore (OpenCode)
6. Refactor a function with many callers (impact query)

**Arms:** (a) plain harness, (b) harness + Puff context. Same model and prompt wording otherwise, a fresh worktree per run, 2–3 runs per arm.

**Metrics:** tokens in/out, files read (where the stream exposes Read calls), first-try pass rate, **repeated-mistake rate**, wall time.

---

## Build phases

Every phase ends with a **checkpoint**: a working build, committed. The next phase starts only after the checkpoint passes, so a submittable project exists at every point.

| Phase | When | Backend | UI | Checkpoint |
|---|---|---|---|---|
| **P0 Foundation** | Thu afternoon | Monorepo, `packages/shared` contract + mocks, docker-compose, graph init + indexes | electron-vite shell, design tokens, mascot, Board on mocks | UI renders mocks; `puff init` creates the graph |
| **P1 Code graph** ✅ | Thu night | Indexer (Q1), impact (Q6), technologies, demo repo skeleton | Memory graph screen on real data | Demo repo visible as a graph; impact query returns files |
| **P2 Memory + context** ✅ | Fri morning | Memory writes (Q11–Q15), stack trace → symbol, context compiler + ContextPack (Q3–Q5), `<puff-report>` parsing | Task detail on mocks | A recorded failure lands on the right function |
| **P3 Three agents, one loop** ✅ | Fri afternoon | Claude Code + Codex + OpenCode adapters, worktrees, verify, retry once | Task detail on real data | **Session 2 avoids session 1's mistake** |
| **P4 Team coordination** ✅ | Fri night | Planner goal split, routing (Q10), scheduling (Q7–Q9), escalation, event bus | Board live, mascot states wired | A goal runs across 3 agents; one task waits on overlap |
| **P5 Correctness + Why** | Sat morning | Stale on hash change, supersede, MCP server | Why view, memory feed | Editing code marks memory stale; Why shows the path |
| **P6 Benchmark** | Sat afternoon | Benchmark runner (sessions recorded since P3), `results.json` | Savings meter | Real numbers on screen |
| **P7 Stretch** | Sat evening, until the 22:00 freeze | PageRank routing (Q18), vector failures (Q17), generic CLI adapter | Electron packaging, polish | Each item ships independently |
| **Ship** | Sun | README numbers, setup from a clean clone | Demo video, blog | Submit by 20:00 |

---

## Security

- Agent CLIs are spawned **without a shell**. Prompts are passed as data (stdin or a single argv entry) and never interpolated into a command line.
- Each task runs in its **own git worktree**; the main checkout is only touched by Puff's merge step.
- All Cypher is **parameterised**.
- The graph stores **no source code bodies and no secrets**: only paths, line ranges, signatures, hashes and short messages.
- The demo uses only **our own synthetic repository**.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Harness stalls on a permission prompt | Role-based permissions (`acceptEdits` + an allow-list for Claude Code, `-s workspace-write` for Codex); timeout + process-tree kill; recorded as `error` |
| Codex can't call MCP in `exec` | Context in the prompt + `<puff-report>` + facts written by Puff |
| Token fields missing for a harness | Benchmark on the harnesses that report them; say so |
| Imperfect call resolution | Resolve by name, drop unresolved calls; good enough for impact and context |
| Stack trace doesn't map to a symbol | Fallbacks: changed target symbols → verifier names it |
| API quota / cost | `maxParallel: 3`, small demo repo, cached benchmark results |
| Merge conflicts | Overlap check (Q8), merge one at a time, re-run tests after merge |
| Electron packaging breaks | Core runs as a CLI; the UI runs as a web app |
| Live demo is flaky | Record from a known-good run; `npm run seed` resets to a known state |
