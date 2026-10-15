# Benchmark: with Puff and without

This is how Puff's numbers are produced, what they mean, and what they do not prove. The runner is `puff bench` (`packages/core/src/bench`), the raw results are in [`bench/results.json`](../bench/results.json), and the Savings view in the app reads that file.

## What is compared

One agent, one model, the same four tasks, two arms:

| Arm | The agent gets |
|---|---|
| **Without Puff** | The task, written in Puff's normal prompt template, and nothing else. |
| **With Puff** | The same prompt plus what Puff adds: the target functions with their file and line range, the callers that may break, and what the team already learned about that code (past failures with their fixes, and decisions). |

Everything else is identical: the agent, the model, the working directory layout, the permissions, the time limit.

## The tasks

Small feature requests on the demo shop API (`demo/shop-api`, Express + TypeScript). Three of them tempt a trap that the repository's own tests also catch. The fourth is a control with nothing about it in memory, so Puff only offers the code graph there.

| Task | The request | The trap it tempts |
|---|---|---|
| `failed-login-reason` | Add a `reason` to the audit entry of a failed login | Logging the attempted password |
| `cart-summary` | Add `GET /cart/summary` | Charging tax before the discount |
| `cart-bulk-add` | Add `POST /cart/bulk` | Adding items without reserving stock |
| `token-expiry` (control) | Tokens never expire: find out why, fix it, add a test | None; no lesson in memory |

## How a run is judged

Each run is **one attempt** in a **fresh copy** of the demo repo. It passes only if the agent **changed files** and the project's **whole test suite plus a hidden acceptance spec** pass. The agent never sees the hidden spec; it is copied in after the run. "First-try pass rate" is therefore exactly that.

Before any number is trusted, the tasks themselves are checked on the real demo project (`PUFF_BENCH_CHECK=1 npm test -w @puff/core`): the untouched repo **fails** every hidden spec (so doing nothing cannot pass), a known-correct change **passes** it, and the careless change used to teach memory **fails** the real tests.

## Where Puff's memory comes from

The with-Puff arm needs something to remember. For each trap, a careless change (what a hurried agent might write) is applied to a scratch copy and run through the **real test command**. The real failure output is parsed, located in code by Puff's stack-trace/diff locator, and recorded as a failure on the right function, together with its fix and a decision. This stands in for "a teammate's agent hit this trap earlier". It is not a run of a real agent, and that is stated here rather than hidden: the memory is real graph data written through the normal code path, but its origin is scripted.

## What is measured

- **Tokens**: input plus output as the harness reports them. For OpenCode, input includes cached tokens.
- **Files read**: distinct files opened with the agent's read tool. Only OpenCode prints its tool calls in a way Puff can count; for Codex and Claude Code this is shown as "not reported", never guessed.
- **First-try pass rate** and **wall time** per run.

## Harness failures are not agent failures

If the agent CLI itself fails (timeout, provider error, not signed in), the runner starts that run over in a clean copy, up to twice. A run that still fails is **left out of the averages and counted as invalid**, because it says nothing about either arm. Results are written to `bench/results.json` after every run, so an interrupted benchmark keeps what it measured.

## Limits (please read)

- **Small sample.** A handful of runs per arm on four tasks. Differences are indications, not proof; a single run varied by 3x in tokens within the same arm.
- **One agent, one model.** OpenCode with its default free model. Other agents may behave differently.
- **Traps are rarely triggered.** A capable agent often avoids a trap without help, so the pass rate can be equal in both arms. When it is, the benefit shows up (if at all) as fewer tokens or files read, not as more passes.
- **The with-Puff prompt is longer.** Puff's context costs prompt tokens (about 400 to 500 against 100 to 150); the table counts everything the agent spent.
- **Timing depends on the provider.** Free-model latency varies a lot between runs; do not read much into wall time.
- **Not measured:** quality of the code beyond the tests, cost in money, other languages.

## Reproduce it

```bash
npm run db:up
```

```bash
npm run puff -- bench --agent opencode --runs 2
```

`--task <ids>` runs a subset, `--arms plain,puff` picks arms, `--keep` leaves the temporary repositories for inspection.

## Results

Run on 2026-10-15: OpenCode, its default free model, 2 runs per task and arm (16 runs). Every run passed; none was left out as invalid (three runs needed a retry: two hit the 600 s limit with no result and one finished without saying anything).

| Task | Tokens without Puff | Tokens with Puff | Change | Files read (without / with) |
|---|---|---|---|---|
| `failed-login-reason` | 133,861 | 170,407 | +27% | 2.5 / 8.0 |
| `cart-summary` | 359,641 | 176,954 | -51% | 15.0 / 11.0 |
| `cart-bulk-add` | 370,315 | 285,454 | -23% | 8.5 / 11.0 |
| `token-expiry` (control) | 347,534 | 218,087 | -37% | 13.0 / 11.0 |
| **All runs** | **302,838** | **212,725** | **-30%** | **9.8 / 10.3** |

Per-arm ranges: without Puff 132,237 to 448,625 tokens per run; with Puff 136,746 to 376,738. First-try pass rate was 8/8 in both arms. Average wall time was 293 s without and 166 s with Puff.

### Reading the results

- **Fewer tokens with Puff on three of four tasks, more on one.** The average is -30%, but the spread inside one arm is as large as the gap between arms, so treat it as an indication.
- **The control task improved too (-37%).** Nothing about it is in memory, so memory is not what produced that saving. The prompt for that task contained only the target functions and their callers. Files read did not drop (10.3 vs 9.8 on average), so why the agent spent fewer tokens is not established here.
- **The traps were never triggered.** All 16 runs passed, in both arms. This benchmark therefore does **not** measure "Puff stops an agent repeating a recorded mistake"; that needs tasks where the plain agent actually fails. The recorded demo (`puff demo`, the Why view and the memory feed) is the evidence for that claim, not this table.
- **Wall time is not a result.** It is the time of the final attempt of each run only (the stalled attempts that were retried are not counted), and a free model's speed varies by the hour.
- **Prompt cost.** With Puff the prompt is 400 to 500 tokens instead of 100 to 150; the numbers above include it.

### What would make this stronger

More runs per cell (5 or more), harder tasks where the plain agent really does hit the trap, a second agent (Codex) for comparison, and a with-memory-only arm to separate "code context" from "remembered lessons".
