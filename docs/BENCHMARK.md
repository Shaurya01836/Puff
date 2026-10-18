# Benchmark: with Puff and without

This is how Puff's numbers are produced, what they mean, and what they do not prove. There are two benchmarks:

1. **[Lesson transfer](#lesson-transfer-p14)** (the main one): does a lesson one agent learned stop the next agent from repeating the mistake on a different, related task? Four arms, two agents. Raw results: `bench/results-transfer-<agent>.json`.
2. **[Token use](#token-use-the-first-benchmark)** (the first one): the same tasks with and without Puff's context. Raw results: [`bench/results.json`](../bench/results.json).

## Lesson transfer (P14)

### The question

Every coding agent starts a task knowing nothing about what the team learned. Puff's claim is that a lesson learned once, by any agent, is handed to the next agent that works on related code, so the mistake is not made again. The number that tests it is the **repeated-mistake rate**: how often a fresh agent makes a mistake the team has already recorded.

### Two stages per trap

The demo project has five seeded traps (`demo/TRAPS.md`, kept outside the copy agents see). For each one there are two different tasks.

| Trap | Learn task (tempting) | Transfer task (related, different) |
|---|---|---|
| 1 Passwords never logged | `failed-login-reason`: add a reason to the failed-login audit entry | `login-request-log`: log every login request "with what the client sent" |
| 2 Token only in an httpOnly cookie | `session-info`: add `GET /auth/session` with "the details of the current session" | `token-in-body`: "return the session token in the login response so the mobile app can store it" (the right answer is to refuse and explain) |
| 3 Tax after the discount | `cart-summary`: add `GET /cart/summary` | `cart-quote`: add `POST /cart/quote` for a discount code |
| 4 Stock reserved through `addItem()` | `cart-bulk-add`: add `POST /cart/bulk` | `cart-reorder`: put a past order's lines back in the cart |
| 5 Rate limits per IP, reset after the window | `signup-rate-limit`: limit sign-ups | `login-lockout`: lock out brute-force logins |

1. **Learn.** A real agent (the same one the benchmark is measuring) tries the learn task with no help. If it falls into the trap, that real run is what Puff learns from (**live**). If it avoids the trap, the recorded careless change is applied and run through the tests instead (**replayed**). Either way the real test output goes through Puff's real failure locator and is recorded as a failure pinned to the function, with its fix and a decision. Each learned lesson is listed in the results with how it was learned.
2. **Transfer.** A fresh agent gets the transfer task, once per arm, in a fresh copy of the repository, for one attempt.

### Four arms

| Arm | The agent gets |
|---|---|
| **none** | The task alone, in Puff's normal prompt template. No memory. |
| **puff** | Puff's context, chosen by the graph: target code, callers, lessons near the code (up to two calls away), lessons worded like the task, decisions and procedures. |
| **flat** | The same lessons, every one of them, written into `AGENTS.md` in the repository root, plus one line in the prompt telling the agent to read it. No selection. This is what a team without Puff would do. |
| **graph-off** | Puff with `PUFF_GRAPH=off`: the task and the location of its target functions, and nothing chosen by the graph. |

Everything else is identical: the agent, the model, the permissions, the time limit (600 s).

### How a run is judged

- **Repeated mistake:** one of the task's named **trap tests** failed on that first attempt. The trap tests are in the hidden acceptance spec (copied in after the run, so editing the repository's own tests cannot hide a mistake) and in the repository's own suite.
- **Passed:** the whole suite plus the hidden spec passed, and the agent changed something. For `token-in-body` changing nothing (refusing) is a correct answer.
- A run where the agent changed nothing (when a change was needed) or the harness failed is **not judged** for repeats. A harness failure is retried in a clean copy up to twice, and if it still fails it is left out and counted as invalid.

Before any run counts, every task is checked on the real demo project (`PUFF_BENCH_CHECK=1 npm test -w @puff/core`): the untouched repository fails each hidden spec (except where refusing is right), a known-correct change passes, and the careless change trips a trap test. `npm run puff -- bench-transfer --dry-run` prints exactly what each arm is told, without running an agent.

### Honesty rules

- The prompts and tasks were frozen before the first real run.
- Every run is published in the results file, including the failed and invalid ones.
- Results are reported as counts and ranges, not only averages, with the agent and model named.
- Replayed lessons are labelled as replayed.

### Reproduce it

```bash
npm run puff -- bench-transfer --agent opencode --runs 3
```

`--task <ids>` runs a subset, `--arms none,puff` picks arms, `--learn replay` skips the live learn stage, `--keep` leaves the temporary repositories for inspection.

### Results

#### Codex (CLI default model), 3 runs per trap and arm

Run 16 Oct 2026. 60 runs, 15 judged per arm, none invalid. Raw runs: [`bench/results-transfer-codex.json`](../bench/results-transfer-codex.json).

| Arm | Repeated the mistake | Passed everything | Average tokens (range) |
|---|---|---|---|
| none | 6 of 15 | 5 of 15 | 185,226 (135,431 to 226,667) |
| **puff** | **2 of 15** | 10 of 15 | 160,152 (33,330 to 241,934) |
| flat `AGENTS.md` | 3 of 15 | 11 of 15 | 175,382 (123,500 to 261,934) |
| graph off | 7 of 15 | 5 of 15 | 165,359 (121,988 to 207,824) |

Repeats by trap, of 3 runs per arm:

| Trap | Transfer task | none | puff | flat | graph off |
|---|---|---|---|---|---|
| 1 Passwords never logged | `login-request-log` | 1 | 0 | 0 | 1 |
| 2 Token only in an httpOnly cookie | `token-in-body` | 3 | 2 | 3 | 3 |
| 3 Tax after the discount | `cart-quote` | 0 | 0 | 0 | 0 |
| 4 Stock reserved through `addItem()` | `cart-reorder` | 0 | 0 | 0 | 0 |
| 5 Rate limits reset after the window | `login-lockout` | 2 | 0 | 0 | 3 |

**Reading it.**

- **The graph is what moves the lessons.** With the graph off Codex repeated the mistake 7 times, as often as with no memory at all (6): the lessons are in FalkorDB in both cases, but only the graph's choice puts the right one in front of the agent.
- **A flat file was nearly as good as Puff** (3 repeats against 2, 11 passes against 10). With five lessons a flat file holds them all; the difference is not large enough to call. Where a flat file cannot follow is a lesson that went stale after an edit or was learned in a merge that was reverted. That behaviour is tested (`trust.test.ts`, `graph-decisions.test.ts`) but **not measured** against a flat file here.
- **Two traps never caught Codex** (3 and 4: no repeat in any arm), so they say nothing. On the three that did (1, 2 and 5: 9 runs per arm) the repeats were 6, 2, 3 and 7 of 9. Trap 2 is the weak spot: Puff helped once in three; the task asks Codex to do something Puff's lesson says is wrong, and the right answer is to refuse.
- **All five lessons were replayed.** Codex did not fall into the trap on any learn task, so the recorded careless change was run through the real tests and the real failure locator, and that is what Puff learned from.
- **Small sample.** One agent, one model, 15 runs per arm. Differences of a few runs are indications, not proof. Token averages vary by about 2x within an arm.

#### OpenCode

OpenCode with its default free model, 2 runs per trap and arm (40 runs), the same five traps and four arms. Raw runs: [`bench/results-transfer-opencode.json`](../bench/results-transfer-opencode.json).

| What the agent is given | Repeated the mistake | Passed everything | Average tokens |
|---|---|---|---|
| Nothing (the task alone) | 2 of 7 | 5 of 7 | 332k |
| **Puff** (context chosen by the graph) | **0 of 7** | **7 of 7** | 209k |
| The same lessons in a flat `AGENTS.md` | 2 of 7 | 5 of 7 | 350k |
| Puff with the graph off | 2 of 7 | 5 of 7 | 296k |

**Reading it.**

- **12 of the 40 runs produced no result** and are not judged: the free model's provider was unavailable or a run hit the 600 s limit. That took every run of trap 5 and the second run of trap 4, in every arm alike, leaving 7 judged runs per arm.
- **Only trap 2 caught OpenCode** (a session token returned in the response body). With no memory, a flat file or the graph off it repeated the mistake in both runs; with Puff in neither, and those are Puff's two extra passes. One trap and two runs per arm: an indication that agrees with the Codex run, not proof.
- **Tokens:** Puff's runs averaged 209k against 332k with no memory (about 37% fewer) and 350k with a flat file. Tokens vary by about 2x within an arm and Puff's runs were cheaper on the traps nobody fell into as well, so not all of the saving is the lesson itself.
- **All five lessons were replayed**, as in the Codex run: OpenCode did not fall into the trap on any learn task.

## Token use (the first benchmark)

### What is compared

One agent, one model, the same four tasks, two arms:

| Arm | The agent gets |
|---|---|
| **Without Puff** | The task, written in Puff's normal prompt template, and nothing else. |
| **With Puff** | The same prompt plus what Puff adds: the target functions with their file and line range, the callers that may break, and what the team already learned about that code (past failures with their fixes, and decisions). |

Everything else is identical: the agent, the model, the working directory layout, the permissions, the time limit.

### The tasks

Small feature requests on the demo shop API (`demo/shop-api`, Express + TypeScript). Three of them tempt a trap that the repository's own tests also catch. The fourth is a control with nothing about it in memory, so Puff only offers the code graph there.

| Task | The request | The trap it tempts |
|---|---|---|
| `failed-login-reason` | Add a `reason` to the audit entry of a failed login | Logging the attempted password |
| `cart-summary` | Add `GET /cart/summary` | Charging tax before the discount |
| `cart-bulk-add` | Add `POST /cart/bulk` | Adding items without reserving stock |
| `token-expiry` (control) | Tokens never expire: find out why, fix it, add a test | None; no lesson in memory |

### How a run is judged

Each run is **one attempt** in a **fresh copy** of the demo repo. It passes only if the agent **changed files** and the project's **whole test suite plus a hidden acceptance spec** pass. The agent never sees the hidden spec; it is copied in after the run. "First-try pass rate" is therefore exactly that.

Before any number is trusted, the tasks themselves are checked on the real demo project (`PUFF_BENCH_CHECK=1 npm test -w @puff/core`): the untouched repo **fails** every hidden spec (so doing nothing cannot pass), a known-correct change **passes** it, and the careless change used to teach memory **fails** the real tests.

### Where Puff's memory comes from

The with-Puff arm needs something to remember. For each trap, a careless change (what a hurried agent might write) is applied to a scratch copy and run through the **real test command**. The real failure output is parsed, located in code by Puff's stack-trace/diff locator, and recorded as a failure on the right function, together with its fix and a decision. This stands in for "a teammate's agent hit this trap earlier". It is not a run of a real agent, and that is stated here rather than hidden: the memory is real graph data written through the normal code path, but its origin is scripted.

### What is measured

- **Tokens**: input plus output as the harness reports them. For OpenCode, input includes cached tokens.
- **Files read**: distinct files opened with the agent's read tool. Only OpenCode prints its tool calls in a way Puff can count; for Codex and Claude Code this is shown as "not reported", never guessed.
- **First-try pass rate** and **wall time** per run.

### Harness failures are not agent failures

If the agent CLI itself fails (timeout, provider error, not signed in), the runner starts that run over in a clean copy, up to twice. A run that still fails is **left out of the averages and counted as invalid**, because it says nothing about either arm. Results are written to `bench/results.json` after every run, so an interrupted benchmark keeps what it measured.

### Limits (please read)

- **Small sample.** A handful of runs per arm on four tasks. Differences are indications, not proof; a single run varied by 3x in tokens within the same arm.
- **One agent, one model.** OpenCode with its default free model. Other agents may behave differently.
- **Traps are rarely triggered.** A capable agent often avoids a trap without help, so the pass rate can be equal in both arms. When it is, the benefit shows up (if at all) as fewer tokens or files read, not as more passes.
- **The with-Puff prompt is longer.** Puff's context costs prompt tokens (about 400 to 500 against 100 to 150); the table counts everything the agent spent.
- **Timing depends on the provider.** Free-model latency varies a lot between runs; do not read much into wall time.
- **Not measured:** quality of the code beyond the tests, cost in money, other languages.

### Reproduce it

```bash
npm run db:up
```

```bash
npm run puff -- bench --agent opencode --runs 2
```

`--task <ids>` runs a subset, `--arms plain,puff` picks arms, `--keep` leaves the temporary repositories for inspection.

### Results

Run on 2026-10-15: OpenCode, its default free model, 2 runs per task and arm (16 runs). Every run passed; none was left out as invalid (three runs needed a retry: two hit the 600 s limit with no result and one finished without saying anything).

| Task | Tokens without Puff | Tokens with Puff | Change | Files read (without / with) |
|---|---|---|---|---|
| `failed-login-reason` | 133,861 | 170,407 | +27% | 2.5 / 8.0 |
| `cart-summary` | 359,641 | 176,954 | -51% | 15.0 / 11.0 |
| `cart-bulk-add` | 370,315 | 285,454 | -23% | 8.5 / 11.0 |
| `token-expiry` (control) | 347,534 | 218,087 | -37% | 13.0 / 11.0 |
| **All runs** | **302,838** | **212,725** | **-30%** | **9.8 / 10.3** |

Per-arm ranges: without Puff 132,237 to 448,625 tokens per run; with Puff 136,746 to 376,738. First-try pass rate was 8/8 in both arms. Average wall time was 293 s without and 166 s with Puff.

#### Reading the results

- **Fewer tokens with Puff on three of four tasks, more on one.** The average is -30%, but the spread inside one arm is as large as the gap between arms, so treat it as an indication.
- **The control task improved too (-37%).** Nothing about it is in memory, so memory is not what produced that saving. The prompt for that task contained only the target functions and their callers. Files read did not drop (10.3 vs 9.8 on average), so why the agent spent fewer tokens is not established here.
- **The traps were never triggered.** All 16 runs passed, in both arms. This benchmark therefore does **not** measure "Puff stops an agent repeating a recorded mistake"; that needs tasks where the plain agent actually fails. The recorded demo (`puff demo`, the Why view and the memory feed) is the evidence for that claim, not this table.
- **Wall time is not a result.** It is the time of the final attempt of each run only (the stalled attempts that were retried are not counted), and a free model's speed varies by the hour.
- **Prompt cost.** With Puff the prompt is 400 to 500 tokens instead of 100 to 150; the numbers above include it.

#### What would make this stronger

More runs per cell (5 or more), harder tasks where the plain agent really does hit the trap, a second agent (Codex) for comparison, and a with-memory-only arm to separate "code context" from "remembered lessons".
