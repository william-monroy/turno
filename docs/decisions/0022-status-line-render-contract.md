# 0022. Status line: each part fails alone, unknown prices show "$?", tests run under a guard HOME

Date: 2026-11-16. Status: accepted.

## Context

`turno statusline` runs on every redraw of Claude Code. One `try` around the whole line meant
that an accessory datum (a cache file of the wrong shape, a `null` payload, a full disk) replaced
the line with an error until someone deleted the file. The cost worker silently counted 0 for
any model missing from the price table, so the line could show `$0.00` for a conversation that
cost dollars. The plan cache was written empty when the first `claude auth status` failed and
was never asked again. And the test suite let real agent binaries run with the real HOME.

## Decision

- **Every input is shape-checked** (`statusline/input.ts`): the stdin payload and every cache
  file keep only fields of the expected type. `session_id` must match `^[A-Za-z0-9-]+$` before
  it becomes part of a file name.
- **Each part is computed on its own** (limits, plan, folder rule, turns, exhausted marks,
  branch, cost, gateway). An error leaves that part empty. Writes never throw.
- **Background workers start after the line is written** (`collect()` queues them as jobs).
- **Prices are matched exactly** after normalizing Bedrock, Vertex and snapshot ids. A record
  with tokens and no price marks the conversation as partly unpriced; the line then shows
  Claude Code's `cost.total_cost_usd` or `$?`. A test fails if a model in the fixture
  transcript has no price. The cost state carries a version, so states counted with the old
  rules are recomputed.
- **The plan is retried**: an empty plan file is the time of the last attempt, retried after
  10 minutes. The worker never writes an empty plan.
- **The branch comes from `.git/HEAD`** (following `gitdir:`); git runs only for an unusual HEAD.
- **Cache keys are hashes** of the folder and the config mtime; the cost worker prunes cache
  files older than 7 days, at most once a day.
- **Gateway marker**: when `mcp sync` has written gateway entries, the line reads a health file
  that a detached worker refreshes at most once a minute (an HTTP request to the recorded port,
  1.5 s timeout). The render only reads a file, well under the 2 ms budget.
- **Tests** run under a global HOME guard (`test/helpers/global-setup.ts`) and build the env of
  real binaries from the sandbox. The Cursor e2e needs the network and runs only with
  `TURNO_E2E_NETWORK=1` (`pnpm test:e2e`).

## Consequences

The line can show less (an empty field, `$?`) but never an error caused by one datum. The price
table still needs an entry for each new model; until then the line shows Claude Code's figure.
Bedrock and Vertex regional prices can differ slightly from the first-party ones used here. The
gateway marker lags the real state by up to a minute.
