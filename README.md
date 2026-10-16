<div align="center">

<img src="assets/puff-mascot.svg" alt="Puff the octopus" width="220" />

# Puff

### One brain. Many agents. Shared memory.

**Shared graph memory for a team of real coding agents. Every lesson is tied to the code it came from.**

[![Graph Hacks 2026](https://img.shields.io/badge/Graph%20Hacks-2026-7c5ce6)](https://www.wemakedevs.org/hackathons/falkordb)
[![Track 02](https://img.shields.io/badge/Track%2002-Agent%20Memory%20%26%20Coordination-ff9a3c)](#hackathon)
[![FalkorDB](https://img.shields.io/badge/graph-FalkorDB-e3204d)](https://www.falkordb.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Node%2022-3178c6)](#tech-stack)
[![Status](https://img.shields.io/badge/status-building-yellow)](#roadmap)

[Problem](#the-problem) · [Solution](#the-solution) · [How it uses FalkorDB](#how-puff-uses-falkordb) · [How agents use Puff](#how-agents-use-puff) · [Install](#install-the-windows-app) · [Quick start](#quick-start) · [Docs](#documentation)

### ⬇ [Download Puff for Windows](https://github.com/Shaurya01836/Puff/releases/latest/download/Puff-Setup.exe)

Windows 10/11 · about 115 MB · [all releases](https://github.com/Shaurya01836/Puff/releases/latest) · [install guide](docs/INSTALL.md)

</div>

---

## Install the Windows app

1. **Download** [`Puff-Setup.exe`](https://github.com/Shaurya01836/Puff/releases/latest/download/Puff-Setup.exe) and run it. Windows may warn about an unknown publisher (the installer is not code-signed yet): choose **More info**, then **Run anyway**.
2. **Have Docker Desktop running.** On first start Puff shows a setup screen; press **Start the database** and it starts FalkorDB for you.
3. **Have at least one agent CLI installed:** Claude Code, Codex or OpenCode. The same screen lists which are installed and signed in, and has a **Sign in** button for Claude Code and Codex. One is enough: Ask Puff, the chat that plans and runs the team, works with whichever you have (pick it in the panel header).
4. **Press Add a project…**, choose a git repository (TypeScript or JavaScript), give the team a goal, and press **Run team**.

Already installed? Run the new installer: it updates in place and keeps your projects and memory. Details, where files are kept, and building the installer yourself are in [docs/INSTALL.md](docs/INSTALL.md). macOS and Linux: run from source ([Quick start](#quick-start)).


---

## TL;DR

Puff runs a **team of different coding agents** (Claude Code, Codex and OpenCode) on one repository. All of them share **one graph memory in [FalkorDB](https://www.falkordb.com/)**.

The graph holds two things, linked together:

1. **The code**: files, functions, classes, calls and imports, parsed with tree-sitter.
2. **What the team has learned**: tasks, sessions, failures, fixes, decisions, procedures and handoffs.

Puff uses that graph to decide **which agent gets which task**, **what context each agent receives**, **what can safely run in parallel**, and **why it made each choice**. A failure is linked to the exact function it happened in. The next agent that touches that function, from any vendor, starts with the lesson instead of repeating the mistake.

---

## The problem

AI coding agents start almost every session with **amnesia**.

| Pain | What actually happens |
|---|---|
| 🔍 **They rediscover the codebase every time** | grep, read files, grep again. Tokens are spent re-learning code that hasn't changed. |
| 🔁 **They repeat past mistakes** | Last week's failing test and its fix are gone. The same trap catches the next agent. |
| 🤷 **They lose the "why"** | Decisions and constraints sit in chat logs nobody reads again. |
| 🧱 **Agents can't share knowledge** | A lesson Claude Code learned is invisible to Codex, and the reverse. |
| 🎯 **Nobody routes work by strength** | Teams mix reasoning-heavy, fast and cheap agents by hand. |

Today's workaround is hand-written `CLAUDE.md` / `AGENTS.md` files. They are flat text, go stale quickly, aren't connected to the code, and every vendor reads a different one.

---

## The solution

<table>
<tr>
<td width="50%" valign="top">

### 🧠 Memory tied to code
Every `Failure` and `Decision` points at a real `Symbol` (a function, class or method). Memory lives where the code lives, so it can be found and checked, and it goes stale when that code changes.

### 🤝 Shared across vendors
Claude Code, Codex and OpenCode all read and write the **same graph**. A lesson from one agent is context for the next.

### 🧭 Routed by strength
Planning and verification go to a reasoning agent, implementation to a fast coder, docs chores to a cheap agent. The choice comes from the graph: declared strengths, adjusted by each agent's past successes and failures.

</td>
<td width="50%" valign="top">

### 📦 Minimal, targeted context
Before a task, Puff compiles a **ContextPack**: the target functions with line ranges, the callers that may break, past failures and fixes on that code, active decisions and procedures. The agent stops scanning the whole repo.

### 🚦 Safe parallelism
Tasks whose code overlaps (directly or through `CALLS`) wait for each other. Independent tasks run at the same time, each in its own git worktree.

### 💡 Explainable
Every item an agent receives is stored with a **reason**. Click **Why?** to see the graph path behind each choice.

</td>
</tr>
</table>

### The memory loop in one picture

```mermaid
flowchart LR
    A["📝 Task: add rate limiting to login()"] --> B{"🧭 Route<br/>graph query"}
    B -->|implement| C["🤖 Codex<br/>session 1"]
    C --> D["❌ Test fails<br/>password logged"]
    D --> E["🐙 Puff records Failure<br/>linked to auth.ts::login"]
    E --> F[("FalkorDB<br/>shared memory")]
    G["📝 New task touching login()"] --> H["📦 Context compiler"]
    F --> H
    H -->|"includes past failure + fix"| I["🤖 Fresh agent<br/>session 2"]
    I --> J["✅ Passes first try"]
```

---

## How Puff uses FalkorDB

FalkorDB is **not a log sink**. It is where Puff thinks. Take it away and Puff can't pick an agent, build context, schedule work or explain itself.

| Puff decision | What the graph does | Query |
|---|---|---|
| **What context does this agent need?** | `Task → TARGETS → Symbol`, then up to 2 hops of callers, failures `IN` that symbol with their fixes, active decisions `ABOUT` it, and procedures for its technologies | [Q3](docs/GRAPH_SCHEMA.md#q3-build-context-for-a-task-core-query) |
| **Which agent should take this task?** | `Task → REQUIRES → Capability ← HAS_STRENGTH ← Agent`, scored by that agent's past `Session` outcomes on the same capability | [Q10](docs/GRAPH_SCHEMA.md#q10-route-best-agent-for-this-task) |
| **Can these tasks run in parallel?** | Do two tasks target the same symbols, or symbols one `CALLS` hop apart? | [Q8](docs/GRAPH_SCHEMA.md#q8-overlap-check-safe-to-run-in-parallel) |
| **What breaks if I change this?** | Reverse `CALLS*1..3` up to the files that define the callers | [Q6](docs/GRAPH_SCHEMA.md#q6-impact-what-breaks-if-i-change-this) |
| **Which memories are now outdated?** | File hash changed → every Failure/Decision linked to its symbols is marked `stale` | [Q2](docs/GRAPH_SCHEMA.md#q2-mark-memory-stale-when-a-file-changes) |
| **Why did the agent get this?** | `Session → RECEIVED → ContextPack → INCLUDED {reason} → memory` | [Q5](docs/GRAPH_SCHEMA.md#q5-why-did-this-session-get-this-context) |
| **Is this code load-bearing?** | `algo.pageRank` and `algo.betweenness` over `CALLS`, plus open failures, stored as a percentile on every function. A task in the top 10% goes to an agent that declares reasoning and gets 1.5× the context budget | [Q20](docs/GRAPH_SCHEMA.md#q20-risk-from-pagerank-and-betweenness) |
| **Which lessons are two calls away?** | `target → CALLS → m → CALLS → n`: a mistake in `log()` reaches a task on `login()` through `audit()` | [Q21](docs/GRAPH_SCHEMA.md#q21-lessons-two-calls-away) |
| **Which past failures sound like this task?** | Full-text search over `Failure.message` (`db.idx.fulltext.queryNodes`), for lessons the call graph does not reach | [Q22](docs/GRAPH_SCHEMA.md#q22-failures-worded-like-the-task) |
| **How many agents can this plan use, and why does a task wait?** | The plan's tasks are tied where they share code or depend on each other, on a `GRAPH.COPY`; `algo.WCC` gives the independent lanes. A waiting task says which two functions meet ("login() calls audit(), which task_03 changes"), and a free one how far the nearest running work is, by `algo.SPpaths` | [Q30](docs/GRAPH_SCHEMA.md#q30-lanes), [Q31](docs/GRAPH_SCHEMA.md#q31-wait-reasons-and-nearby-work) |
| **Which past failures mean the same as this task?** | A vector index on `Failure.embedding` (a 30 MB static model that runs in TypeScript, no server): "Stop leaking user credentials when recording events" finds "password appears in audit log" with no shared word. Full-text search stays as the fallback | [Q32](docs/GRAPH_SCHEMA.md#q32-similar-failures-by-meaning) |
| **Who is best at this part of the code?** | Functions are grouped into modules (folders), `CALLS` across folders become `DEPENDS_ON`, and every finished session updates `(Agent)-[:KNOWS {runs, wins}]->(Module)`. An agent with a real record in the task's module can take the lead over the declared best ("opencode has won 5 of 6 runs in the cart module"). Tasks in the same module as a choke point (top betweenness) do not run side by side | [Q27](docs/GRAPH_SCHEMA.md#q27-modules), [Q28](docs/GRAPH_SCHEMA.md#q28-expertise), [Q29](docs/GRAPH_SCHEMA.md#q29-choke-points) |
| **What will this merge change?** | Before a task is merged, `GRAPH.COPY` makes a copy of the graph, the branch is indexed into it, and the two are compared: functions added, changed, removed, calls added, lessons that would become outdated, new callers of load-bearing code. For a plan, a dry run of the scheduler on a copy shows which tasks start together and which wait | [Q25](docs/GRAPH_SCHEMA.md#q25-merge-preview), [Q26](docs/GRAPH_SCHEMA.md#q26-plan-preview) |
| **Can this lesson still be trusted?** | Each lesson links to the session and commit it came from. A revert of that merge (by Puff's re-test or by you in git) marks its fix reverted and follows `DERIVED_FROM` up to 3 steps to downgrade what was built on it. Trust (confirmations, sessions it helped, repeats despite it, staleness, reverts, the learning agent's record) sinks or drops a lesson from context | [Q23](docs/GRAPH_SCHEMA.md#q23-repair-on-revert), [Q24](docs/GRAPH_SCHEMA.md#q24-trust) |
| **Separate memory per project** | One graph per project: `puff_<project>` | [Tenancy](docs/GRAPH_SCHEMA.md#database) |

**See the Cypher behind every decision.** Each decision (which agent, what context, when it may start, what went out of date, where a failure belongs) records the queries it ran, with milliseconds and row counts, as a `Trace` in the graph ([Q19](docs/GRAPH_SCHEMA.md#q19-trace-the-queries-behind-a-decision)). Open a task and choose **Graph trace**.

**Turn the graph off to see what it is worth.** `PUFF_GRAPH=off` (or `graph.enabled: false`) runs the same team with routing by escalation order, context of the task and its target files only, overlap by file name, and no stale marking. The Why view and every trace say "graph off". This is arm D of the [transfer benchmark](#benchmark).

These are **multi-hop questions**: function → callers → failed here → fixed by → which agent. A vector store can find one similar item. The graph follows the whole chain in a single query.

### The graph, simplified

```mermaid
graph LR
    File -- DEFINES --> Symbol
    Symbol -- CALLS --> Symbol
    File -- IMPORTS --> File
    Task -- TARGETS --> Symbol
    Task -- REQUIRES --> Capability
    Agent -- HAS_STRENGTH --> Capability
    Agent -- RAN --> Session
    Session -- WORKED_ON --> Task
    Session -- HIT --> Failure
    Failure -- IN --> Symbol
    Failure -- FIXED_BY --> Solution
    Decision -- ABOUT --> Symbol
    Decision -- SUPERSEDES --> Decision
    Session -- RECEIVED --> ContextPack
    ContextPack -- INCLUDED --> Failure
```

The full schema, indexes and every Cypher query are in **[docs/GRAPH_SCHEMA.md](docs/GRAPH_SCHEMA.md)**.

---

## How agents use Puff

Puff doesn't rely on agents to remember anything. **Puff writes the facts itself** (diffs, test results, outcomes, tokens). Agents add their reasoning (decisions and notes) through whichever channel their CLI supports.

| Agent | Role it's good at | Gets context through | Writes memory back through |
|---|---|---|---|
| 🟠 **Claude Code** | planning, reasoning, verification, review | Compiled prompt + **Puff MCP server** (`get_context`, `impact_of`, `why`) | MCP `record_decision` / `handoff` + `<puff-report>` block |
| 🟢 **Codex** | implementation, refactors | Compiled prompt (MCP calls are cancelled in `codex exec`, see [openai/codex#24135](https://github.com/openai/codex/issues/24135)) | `<puff-report>` block, parsed by Puff |
| 🔵 **OpenCode** | simple edits, docs, boilerplate | Compiled prompt + **Puff MCP server** | MCP + `<puff-report>` block |

### What happens to one task

```mermaid
sequenceDiagram
    autonumber
    participant O as Puff orchestrator
    participant G as FalkorDB
    participant W as git worktree
    participant A as Agent CLI
    O->>G: Ready tasks + overlap check (Q7, Q8)
    O->>G: Claim task atomically (Q9)
    O->>G: Pick best agent (Q10)
    O->>G: Compile context, store ContextPack (Q3, Q4)
    O->>W: Create worktree for the task
    O->>A: Run headless with the compiled prompt
    A-->>O: Output + tokens + <puff-report>
    O->>G: Record Session, changed files, decisions (Q11)
    O->>W: Run tests (verify)
    alt tests pass
        O->>W: Merge branch
        O->>G: Re-index changed files, mark old memory stale (Q1, Q2)
    else tests fail
        O->>G: Record Failure linked to the failing function (Q12)
        O->>O: Retry once, then escalate to the next agent
    end
```

Every agent receives the same prompt shape:

```text
You are the coder on a team of coding agents working in this repository.

TASK: Add rate limiting to login
TARGET CODE (read these first, do not scan the whole repo):
- src/auth/login.ts:12-48  login
CALLERS THAT MAY BREAK: routes/auth.ts::postLogin, session.ts::Session.start

PROJECT MEMORY
Past failures here and their fixes:
- "test: password appears in audit log" → fixed by: redact credentials before audit()
Active decisions you must respect:
- Tokens are stored in httpOnly cookies, never localStorage
Procedures:
- Run tests with `npm test -- auth`

WHEN DONE: final block <puff-report>{"decisions":[...],"notes":"..."}</puff-report>
```

---

## Features

| | Feature | Status |
|---|---|---|
| 🌳 | Code indexer (tree-sitter → files, symbols, calls, imports; re-index by content hash) | 🔨 |
| 🧠 | Memory layer: sessions, failures, solutions, decisions, procedures, handoffs, all linked to code | 🔨 |
| 📦 | Context compiler + stored ContextPacks with reasons | 🔨 |
| 🤖 | Harness adapters: Claude Code, Codex, OpenCode (headless, one worktree each) | 🔨 |
| 🔁 | Core loop: plan → implement → verify → record → retry → escalate | 🔨 |
| 🧭 | Routing by strength + learned success rate | 🔨 |
| 🚦 | Graph-based parallel scheduling (overlap-aware) | 🔨 |
| 💡 | **Why?** view: graph path for every choice | ✅ |
| ♻️ | Memory correctness: stale-on-change, `SUPERSEDES` for decisions | ✅ |
| 🔌 | Puff MCP server | ✅ |
| 📊 | Benchmark: tokens, files read, first-try pass rate, with vs without Puff | ✅ |
| 🎯 | Risk from PageRank + betweenness drives routing and the context budget; lessons two calls away; failures found by wording | ✅ |
| 🔎 | **Graph trace**: the Cypher, timing and rows behind every decision; `PUFF_GRAPH=off` ablation switch | ✅ |
| 🧩 | **Team intelligence**: modules, what each agent knows per module (routing uses it), choke points that do not run in parallel | ✅ |
| 🔮 | **Previews on a `GRAPH.COPY`**: what a merge will change in the graph before it happens; a dry run of the plan | ✅ |
| 🛡️ | **Trustworthy memory**: provenance for every lesson, repair on revert, a trust score that decides what the next agent is told | ✅ |
| ✨ | Stretch: vector search over failures, generic CLI adapter | 🔭 |

## Roadmap

Puff is built in **phases**. Each phase ends with a checkpoint: a working build that's committed before the next phase starts.

| Phase | Builds | Checkpoint |
|---|---|---|
| **P0 Foundation** ✅ | Monorepo, shared types/API/mocks, FalkorDB + indexes | UI renders mocks; project graph is created on start |
| **P1 Code graph** ✅ | Indexer, impact query, demo repo, live graph view | Demo repo visible as a graph |
| **P2 Memory + context** ✅ | Memory writes, stack trace → symbol mapping, context compiler, ContextPack | A recorded failure lands on the right function |
| **P3 Three agents, one loop** ✅ | Claude Code + Codex + OpenCode adapters, worktrees, verify, retry | Session 2 avoids session 1's mistake |
| **P4 Team coordination** ✅ | Goal-to-tasks planner, overlap-aware parallel runs, Team timeline, New task dialog | 3 agents in parallel, one waits on overlap |
| **P5 Correctness + Why** ✅ | Stale flags per function, supersede, confirm, Why view, MCP server | Editing code marks memory stale |
| **P6 Benchmark** ✅ | Benchmark runner, savings screen | Real numbers on screen |
| **P7 Land it** ✅ | Real benchmark numbers, every new screen checked, committed | Savings screen shows measured results |
| **P8 Projects** ✅ | Add any repo from the app or CLI, switch between projects, per-project settings, import checks | Add a second repo, index it, switch back |
| **P9 Command center** ✅ | Ask Puff chat with slash commands and a Claude Code orchestrator, task actions (retry, edit, remove, see changes) | "Add a /health endpoint and run it" typed in chat |
| **P10 Installer** ✅ | Windows installer, first-run setup (database, agent CLIs) | Install, add a project, run a task without the source folder |
| **P11 Watch agents** ✅ | Live view of what each agent does (Activity tab), re-test of the combined result after every merge | You see files read, edits and commands as they happen |
| **P13 Foundations** ✅ | `PUFF_GRAPH=off` ablation switch, a trace of the queries behind every decision | The same task routes and gets context differently with the graph on and off |
| **P14 Proof** | Lesson-transfer benchmark: four arms (no memory, Puff, a flat AGENTS.md, Puff with the graph off), two agents | Repeated-mistake rate per arm, with limits |
| **P15 The graph decides** ✅ | Risk from PageRank and betweenness in routing and the budget, lessons two calls away, failures found by wording, Graph trace tab, risk badge | Each decision shows its query in the app |
| **P16 Trustworthy memory** ✅ | Provenance edges, repair on revert (Puff's or a person's), trust in context ranking and the Context tab | A revert downgrades the right lessons, end to end |
| **P17 Team intelligence** ✅ | Modules from folders and `CALLS`, per-agent expertise in routing, choke points in scheduling, "Knows" on agent cards | The agent with the record in a module gets its tasks |
| **P18 Previews** ✅ | Merge preview and plan dry run on a `GRAPH.COPY` | A branch's effect on the graph is known before it is merged |
| **P12 Ship** | One-command demo story, clean-clone test, screenshots | Fresh clone to running demo in minutes |
| **Stretch** | PageRank (hotspots, done), similar failures (done), vector search, Python support | Each one ships independently |

Details: [docs/ARCHITECTURE.md → Build phases](docs/ARCHITECTURE.md#build-phases).

---

## Quick start

> 🚧 Puff is being built during Graph Hacks (15–18 Oct 2026). **Phases P0 to P11 are in:** the code graph, shared memory (failures tied to the function they happened in, fixes, decisions, procedures, handoffs), the context compiler with its "why" trail, real agents, **and team coordination**. Claude Code, Codex and OpenCode run tasks in isolated git worktrees, Puff verifies with the project's own tests, records what went wrong, retries with the lesson and escalates. Give it a goal and a planner agent splits it into tasks; independent tasks run in parallel and a task that touches the same code as one already running waits. Tasks that were really run by agents were verified on the demo repo (OpenCode and Codex, both merged with tests passing; a real OpenCode planner turned a goal into three linked tasks). Memory stays correct: editing a function marks what was learned about *that function* "possibly outdated" (not the whole file), a replaced decision is kept but superseded, and a Puff MCP server lets Claude Code and OpenCode read and write memory mid-task. You can add any TypeScript or JavaScript repository as a project and switch between projects in the app or the CLI, and you can talk to Puff: slash commands answer at once, and plain sentences go to a Claude Code orchestrator that can only use Puff's tools (it adds tasks and goals, retries failures, reads the project memory, and asks you before it runs anything). A first benchmark has run (see [Benchmark](#benchmark)); the sample data in the quick start below is seeded, not real.

**Just want to use it?** [Download the Windows app](#install-the-windows-app) (no source code, Node or npm needed). The rest of this section is for running from a checkout.

**Prerequisites:** Node 22.12+, Docker (or [falkordblite](docs/ARCHITECTURE.md#option-b-no-docker-falkordblite)), git. Agent CLIs (`claude`, `codex`, `opencode`) are needed from phase P3.

```bash
git clone https://github.com/Shaurya01836/Puff.git
```

```bash
cd Puff && npm install
```

Start FalkorDB (database on `6379`, browser UI on <http://localhost:3000>):

```bash
npm run db:up
```

> If port 6379 is already used by another Redis, copy `.env.example` to `.env` and set `FALKORDB_PORT=6380` and `FALKORDB_URL=falkor://localhost:6380`. Puff detects a plain Redis and tells you.

Index the demo repo into its graph: creates `puff_shop_api`, the indexes and the agent pool, then parses every file (safe to re-run; only changed files are rewritten):

```bash
npm run puff -- index demo/shop-api
```

Try the impact query:

```bash
npm run puff -- impact login
```

Write sample tasks, sessions and memory for the demo repo (flagged `seeded`, so the UI says it is sample data):

```bash
npm run puff -- seed --force
```

See what a fresh agent would be handed for the running task, and why each item is in it:

```bash
npm run puff -- task list
```

```bash
npm run puff -- context <taskId>
```

### Your own projects

Puff finds the app inside your repository by itself. If the code is in a folder (a Next.js app in `my-app/`, a package in `packages/web`) and there is no package.json at the top, it picks the folder with the most source code and a real test script or TypeScript setup, runs the project's check from the top of the repository, and links that folder's `node_modules` into each agent's worktree. A project with no tests is type-checked (`tsc --noEmit`) instead; Puff says so, because a pass then means "it compiles", not "it works". Anything you set in the project's settings wins.

The app and the CLI share one list of projects (`~/.puff/projects.json`). Each project is a folder, its own graph (`puff_<name>`), and its own test command. Add one:

```bash
npm run puff -- project add C:\work\my-app
```

Puff looks at the folder first and tells you what will work: whether it is a git repository (agents need one, because they work in separate git worktrees), how many TypeScript/JavaScript files it can read, which test command it found in `package.json`, and what it cannot read (Python, Go and other languages are not understood yet). If the folder is not a git repository, `--init-git` runs `git init` and makes a first commit, only when you ask. Then:

```bash
npm run puff -- project list
```

```bash
npm run puff -- project use my-app
```

From then on every command works on the active project; `--repo <folder|name>` picks another for one command. `project set` changes a project's test command or linked folders, and `project remove` forgets a project (its folder is never touched; `--delete-memory` also deletes its graph). In the desktop app the project card at the top of the sidebar does the same: switch, **Add a project…** (with a folder picker and the same checks), settings and remove. Your agents and limits stay shared: `npm run puff -- config init` copies the defaults to `~/.puff/config.yaml` for you to edit.

### Take control of the team

- **See who did what.** Each card on the Board keeps a trail of every agent that worked on the task and how each attempt ended ("OpenCode stalled, Codex failed, Claude Code working"), how long the current attempt has been running, and a warning when the agent has printed nothing for three minutes. The Activity tab has a **Console** view that reads like a terminal log.
- **Act on a card.** **Stop** kills one task's agent and leaves the rest running. **Retry**, **Switch agent** (gives the task to another agent and model), **Done** (you did it yourself; what waits for it can start) and **Take over** are on every card. You can also drag a card: a running card onto *Needs attention* stops it, a failed card onto *Planned* retries it, any card onto *Done* marks it done. There is a search box and an agent filter, and **Pause after current** lets the running tasks finish and starts nothing new (**Stop now** is the hard stop).
- **Leave a note** on a task: the next attempt is told to follow it.
- **Take over in a real terminal.** The agents run without a screen of their own while Puff drives them (that is how Puff reads their steps and token use), so a run in progress cannot show Claude Code's, Codex's or OpenCode's own screen. Take over does: the agent is stopped and a real terminal opens inside the app in the task's own working folder, running the program you pick (or a plain shell). The folder starts from the agent's last attempt, so you carry on from there. There are two ways in. **Start Claude Code / Codex / OpenCode on this task** opens the program and gives it the task straight away, so you watch it work in its own screen (this uses tokens). **Open … and wait** opens it idle: **Paste task brief** types what the task is and what was tried into its input, and nothing is sent until you press Enter. Either way you finish with **Verify and merge my changes**. If you took a task over while an agent was still running it in the background, Puff says so on the task (what you see under Activity is that background run, not your terminal) and **Stop** ends it. When you are done, **Verify and merge my changes** checks your work with the project's tests, merges it, re-tests the combined result and records it as work done by *you* (if it fixes what an agent got wrong, that failure gets its fix).
- **Stuck agents.** An agent silent for `limits.stallWarnMs` (default 3 minutes) is marked stalled on its card. Set `limits.stallKillMs` to stop it automatically and move the task on to the next agent; it is off by default.

### Protecting your tokens

- **The check is tested before any agent starts.** When a run is about to start an agent that writes code, Puff first runs the project's own check once on the untouched code. If that command cannot run at all (no package.json where it runs, a missing tool), the run stops with the reason, nothing is spent, and the tasks stay ready. A project that already fails its tests still runs, since the task may be the fix.
- **An agent that hit its usage limit is skipped** for the rest of the run, instead of being asked again by every task.
- **A task left "running" by a closed app** goes back to the queue the next time the project is opened (anything silent for more than two agent timeouts cannot still be running).

### Watch the agents work

Open a task and its **Activity** tab shows each step as it happens: the files an agent reads, what it edits, the commands it runs, what it says, and Puff's own steps in between (running the tests, merging, re-testing). A running task opens on it, with a pulse on the tab. The steps are kept with the session, so you can read what an earlier attempt did. In the terminal, `npm run puff -- run` prints the same steps.

Puff also **re-runs the project's tests on the combined result after every merge**. A task that passed in its own worktree can still break the code merged before it. If the combined tests fail twice (the second run rules out a flaky test), Puff undoes the merge with a revert commit, records the failure against the code it broke, and the next attempt starts with that lesson. Set `verify.retestAfterMerge: false` in the config to turn it off.

### Talk to Puff

Open **Ask Puff** in the app (or press Ctrl+K). The side panel has two tabs: **Ask Puff** (the conversation) and **Team** (who did what and who handed what to whom, with a pulse while agents are working), so you can talk to Puff and watch the team in one place. Or use the terminal:

```bash
npm run chat
```

Type `/` for **instant commands that cost nothing**: `/status`, `/tasks`, `/goal <what you want>`, `/task <title>`, `/run`, `/stop`, `/retry <task>`, `/why <task>`, `/diff <task>`, `/index`, `/projects`, `/project <name>`. Tasks are named by the last six characters of their id, or a word from their title.

Anything else is a plain sentence ("plan a health check endpoint and document it"). Those go to the agent you pick in the panel header (**Claude Code, Codex or OpenCode**, whichever you have installed and signed in; your choice is remembered). Claude Code is started with `--tools ""`, a strict MCP config and only Puff's tools; Codex and OpenCode run read-only and ask for Puff's tools in plain text, which Puff runs for them through the same guarded tool server. Either way the agent: it can look at the board, add goals and tasks, edit and retry tasks, and read the project's memory and code graph. It **cannot** edit files, run commands, delete anything, or write memory. It can only *ask* to run the team; that shows up as a card with **Run now / Not now**, because running spends your tokens (set `PUFF_CHAT_AUTO_APPROVE=1` to skip the question). Each message gets at most 20 tool calls. The agent you picked must be installed and signed in. If it is not, the chat says so and offers a **Sign in** button (or type `/login`): Puff starts that agent's own sign-in, which opens your browser on Anthropic's page. If the page ends by showing a one-time code, paste it as `/code <the code>`; it is handed to the waiting sign-in and not kept in the conversation. Puff never sees your password or token. Until you are signed in, slash commands keep working.

On a task's detail panel you can also **Retry** a failed task, **Edit** one that has not started (its title, targets, agent and model), **Remove** one that never ran, and read what it changed in the **Changes** tab (the commit that merged it, or the newest attempt that was kept).

### Run real agents

Agents work in git worktrees, so the project must be the root of its own git repository. `demo/shop-api` lives inside Puff's repo, so this makes a separate copy under `~/.puff/demo` (outside the Puff checkout, so agents cannot see `demo/TRAPS.md`) and points `PUFF_REPO` at it:

```bash
npm run puff -- demo setup
```

Check which agent CLIs are installed and runnable (this does not call any model):

```bash
npm run puff -- agents
```

Create a small task and run it. Puff picks the agent from declared strengths and past results; `--agent` forces one (`opencode` has a free model):

```bash
npm run puff -- task add "Add a helper that returns all product names, with a test" -t listProducts
```

```bash
npm run puff -- run <taskId>
```

Or give the team a **goal** and let a planner agent split it into tasks (with dependencies and the functions each one touches), then run the whole queue. Tasks that do not overlap run at the same time:

```bash
npm run puff -- goal "Add a GET /products/count endpoint and document it"
```

```bash
npm run puff -- run --agent opencode
```

```bash
npm run puff -- team
```

`team` prints the timeline: who worked on what, who handed what to whom, who asked for which follow-up task, and every escalation and retry. The same story is on the **Team** screen of the app. In the app, **New task** lets you choose the work, the functions it touches, the agent and the model (or leave it on Auto).

Prerequisites: `codex` (`npm install -g @openai/codex`, then `codex login`), `opencode` (`npm install -g opencode-ai`), and `claude` signed in (`claude` then `/login`). Each run spends real tokens: even a tiny task used about 100k input tokens on Codex and OpenCode, because every tool call re-sends the conversation.

Open the desktop app:

```bash
npm run dev
```

### Working on the code

| Command | What it does |
|---|---|
| `npm run dev` | Electron app with hot reload |
| `npm run dev:web` | Same UI in a normal browser at <http://localhost:5173>, backed by mocks (fastest for UI work) |
| `npm run puff -- project add <folder>` · `list` · `use <name>` · `info` · `set` · `remove` | Manage the projects Puff knows about (see [Your own projects](#your-own-projects)) |
| `npm run puff -- config init` · `config path` | Copy the default configuration to `~/.puff/config.yaml` · show which file is used |
| `npm run puff -- index` | Parse the repo with tree-sitter and write it to the graph (incremental; `--force` rewrites all) |
| `npm run puff -- impact login` | What may break if a symbol changes (callers up to 3 hops) |
| `npm run puff -- symbols cart` | Find symbols by name |
| `npm run puff -- task add "…" -t login` / `task list` | Create and list tasks (targets are symbols) |
| `npm run puff -- context <taskId> [--agent codex]` | The context an agent would receive, with a reason per item. With `--agent` it starts a session and records the pack |
| `npm run puff -- failure add --session <id> --test-output <file> [--diff <file>]` | Record failures from real test output; each is located in code (stack, diff, targets) |
| `npm run puff -- fix add` · `decision add` · `procedure add` · `handoff` | Record fixes, decisions (with `--supersedes`), procedures and handoff notes |
| `npm run puff -- why <taskId>` · `memory` | Why a task went to its agent and why each context item was included · the memory feed |
| `npm run puff -- demo setup` · `agents` | Make the demo its own git repo for agent runs · check the agent CLIs |
| `npm run puff -- run [taskId] [--agent x]` | Run one task, or every ready task in dependency order, in parallel when the code does not overlap. `--agent` applies to the whole queue. Ctrl+C stops it cleanly |
| `npm run puff -- goal "…"` · `team` | Add a planning task for a goal · print the team timeline |
| `npm run puff -- seed [--force]` · `reset-memory` | Sample data for the demo · clear tasks and memory (keeps the code graph) |
| `npm run puff -- <init|status|graphs>` | Graph setup and inspection |
| `npm run puff -- confirm <id>` | Clear "possibly outdated" on a failure or decision you checked still holds |
| `npm run chat [project]` | The Ask Puff conversation in the terminal (slash commands, any installed agent as orchestrator via `PUFF_CHAT_AGENT`, y/n before a run) |
| `npm run mcp` | Puff MCP server over stdio (needs `PUFF_PROJECT`; optional `PUFF_SESSION`). Tools: `get_context`, `impact_of`, `find_symbols`, `record_decision` / `record_failure` / `record_solution`, `confirm_memory`, `handoff`, `why` |
| `npm run puff -- mcp-config` | Print the MCP config to point Claude Code or OpenCode at this project |
| `npm run typecheck` · `npm test` · `npm run format` | Checks (also run in CI) |
| `npm run build:desktop` | Build the Windows installer (`apps/desktop/release/Puff-Setup.exe`) |

**UI work:** screens live in `apps/desktop/src/renderer/src/screens`. They only talk to `puff` (`lib/api.ts`), which is the `PuffApi` from `packages/shared`. Inside Electron they are served live from FalkorDB (the badge in the top bar says what is still sample data). In the browser-only mode (`npm run dev:web`) every call returns mock data from `packages/shared/src/mocks`. **Run team** runs the ready tasks through the same orchestrator as `puff run`, and the task list, agent pool and memory update live.

Setup, configuration and deployment details: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#deployment)**.

---

## Benchmark

Same agent and model, the same four tasks, a fresh copy of the demo repo for every run, one attempt each. **Without Puff** the agent gets the task alone; **with Puff** it also gets the target code, its callers, and what the team learned about that code. A run passes only if the agent changed files and the whole test suite plus a hidden acceptance spec pass. 16 real runs on OpenCode (its default free model), 2 per task and arm.

| Metric (average per run) | Without Puff | With Puff | Change |
|---|---|---|---|
| Tokens (input + output) | 302,838 | 212,725 | **-30%** |
| Files read | 9.8 | 10.3 | +5% (no reduction) |
| First-try pass rate | 8/8 | 8/8 | no difference |
| Wall time (final attempt) | 293 s | 166 s | -43% (noisy, see below) |

| Task | Without Puff | With Puff | Change |
|---|---|---|---|
| `cart-summary` | 359,641 | 176,954 | -51% |
| `token-expiry` (control, no lesson in memory) | 347,534 | 218,087 | -37% |
| `cart-bulk-add` | 370,315 | 285,454 | -23% |
| `failed-login-reason` | 133,861 | 170,407 | **+27%** |

**What this does and does not show.** Puff used about 30% fewer tokens on average, but it is a small sample: the same arm varied by up to 2x between runs, and in two of the four tasks the ranges of the two arms overlap. The saving also appeared on the control task, where nothing was remembered, so it cannot be credited to memory; it more likely comes from the target code and callers in the prompt, but files read did not go down, so we cannot say why. **No agent fell into any trap in either arm**, so every run passed and this benchmark does **not** show Puff preventing repeated mistakes. That claim rests on the recorded demo, not on these numbers. Wall time covers only the final attempt of each run, on a free model whose speed varies by the hour, so it should not be read closely.

Method, limits and how to reproduce: **[docs/BENCHMARK.md](docs/BENCHMARK.md)**. Raw results: [`bench/results.json`](bench/results.json).


---

## Tech stack

| Layer | Choice |
|---|---|
| Graph database | **FalkorDB** (Docker `falkordb/falkordb`), official `falkordb` npm client |
| Core | Node 22 + TypeScript |
| Parsing | `web-tree-sitter@0.22.6` + `tree-sitter-wasms` (WASM, no native rebuilds) |
| Agents | Claude Code, Codex, OpenCode (headless CLIs) |
| Git | `simple-git` + `git worktree` |
| Agent protocol | `@modelcontextprotocol/sdk` (Puff MCP server) |
| UI | React + TypeScript + Tailwind + shadcn/ui, `react-force-graph`, Electron shell |

## Repository layout

```text
puff/
  apps/desktop        Electron + React UI (Tasks with the task panel, Memory, Agents)
  packages/core       indexer, graph queries, context compiler, router, scheduler, adapters
  packages/mcp        Puff MCP server (stdio)
  packages/shared     types, API contract, mock fixtures
  demo/shop-api       our own synthetic demo repo + benchmark tasks
  scripts/            seed, reset-graph, run-benchmark
  docs/               architecture, graph schema, queries
  docker-compose.yml  FalkorDB
```

## Documentation

| Doc | What's inside |
|---|---|
| 📐 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Platform, components, agent adapters, orchestrator, config, UI, deployment, build phases, risks |
| 💿 [docs/INSTALL.md](docs/INSTALL.md) | Install on Windows, first-run setup, where files live, building the installer |
| 🕸️ [docs/GRAPH_SCHEMA.md](docs/GRAPH_SCHEMA.md) | Database setup, full graph data model, indexes, every Cypher query with explanations |

---

## How Puff compares

| | Agent orchestrators | Code-search indexers | **Puff** |
|---|---|---|---|
| Runs & supervises agents | ✅ many harnesses | ❌ | ✅ 3 harnesses, minimal loop |
| Finds relevant code | via the agent | ✅ text / vector | ✅ **structural graph** (calls, imports) |
| Remembers across sessions | chat history | notes | ✅ **failures, fixes, decisions linked to functions** |
| Shared across vendors | partly | ❌ | ✅ **one graph for every agent** |
| Routes by agent strength | user picks | ❌ | ✅ **graph query over history** |
| Explains its choices | ❌ | ❌ | ✅ **stored ContextPack + graph path** |

We don't compete on orchestration breadth. Puff is the **memory and reasoning layer** that orchestrators are missing.

---

## Hackathon

- **Event:** Graph Hacks: Context for AI Agents (WeMakeDevs × FalkorDB), 15–18 Oct 2026
- **Track:** **Track 02: Agent Memory and Coordination** (also relevant to Track 01)
- **Data:** the demo repository is our own synthetic project. No private or third-party data is used.

## AI assistance

We used Claude Code and Codex to help with boilerplate, scaffolding and documentation drafts. The graph schema, Cypher queries and architecture were designed and checked by the team, and we can walk through every query.

## Credits

Ideas (not code) were drawn from [Orchestrator.inc](https://github.com/OrchestratorInc/agent-orchestrator) (running agents in parallel) and [XERJ](https://github.com/xerj-org/xerj) (indexed code retrieval for agents). Both are Apache-2.0. Thanks to [FalkorDB](https://www.falkordb.com/) and [WeMakeDevs](https://www.wemakedevs.org/).

## Team

| | |
|---|---|
| **Dhruv Pancholi** | Backend, graph, agents |
| _Teammate_ | Design, UI, mascot, story |

<div align="center">
<br/>
<img src="assets/puff-mascot.svg" alt="" width="64" />
<br/>
<sub>Puff is a placeholder mascot until the 3D render arrives. Any harness plugs in; they all share one brain.</sub>
</div>
