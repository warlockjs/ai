---
name: eval-datasets-and-ci
description: 'Datasets + regression-gated eval CI with ai.dataset({...}) feeding agent.eval({cases,baseline,tolerance}). Covers the immutable filterable/shardable dataset (cases / fromFile JSONL), DatasetEntry tags, EvalReport.regression (regressed/added/removed/passed) against a baseline, and the ai.eval reporters toJUnit / toJSON / fromJSON for CI artifacts + committed baselines. Triggers: `ai.dataset`, `DatasetContract`, `DatasetEntry`, `DatasetOptions`, `dataset.filter`, `dataset.shard`, `fromFile`, `agent.eval`, `EvalOptions`, `EvalReport`, `EvalCaseResult`, `EvalRegression`, `baseline`, `tolerance`, `ai.eval.toJUnit`, `ai.eval.toJSON`, `ai.eval.fromJSON`, `diff`, JSONL; ''eval dataset from a JSONL file'', ''shard an eval suite across CI jobs'', ''fail CI on an eval regression'', ''emit a JUnit report'', ''snapshot an eval baseline''; typical import `import { ai } from "@warlock.js/ai"`. Skip: the scorers + LLM-as-judge + Vitest matchers themselves — `@warlock.js/ai/ai-dx-helpers/SKILL.md` (registerAiMatchers / ai.eval.exact|contains|predicate|judge); record/replay of model calls for deterministic tests — `@warlock.js/ai/record-replay-llm/SKILL.md`; competing libs `promptfoo`, `braintrust`.'
---

# `ai.dataset()` + `agent.eval()` regression CI

Turn a corpus of cases into a regression-gated CI signal. `ai.dataset(...)` wraps cases into an immutable, filterable, shardable collection; `agent.eval({ cases, baseline, tolerance })` runs them, scores them, and diffs against a prior report; the `ai.eval.*` reporters serialize the result for CI ingestion and tomorrow's baseline.

> This skill is the **dataset + CI** layer. The scorers, LLM-as-judge config, and Vitest matchers live in [`@warlock.js/ai/ai-dx-helpers/SKILL.md`](@warlock.js/ai/ai-dx-helpers/SKILL.md); `agent.eval`'s core scoring loop is in [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md).

## `ai.dataset()` — immutable, filterable, shardable

```ts
import { ai } from "@warlock.js/ai";

const ds = ai.dataset({
  name: "support",
  cases: [{ name: "greeting", input: "hi", expected: "Hello" }], // inline entries
  fromFile: "./eval/support.jsonl",  // JSONL read ONCE, synchronously, at construction
});

ds.name;   // "support"
ds.cases;  // DatasetEntry[] (inline first, then file entries appended)
```

- A `DatasetEntry` is an `EvalCase` plus optional `tags?: string[]` for filtering / sharding.
- **`fromFile`** reads a JSONL file (one JSON object per line; blank lines skipped) synchronously at construction — mirroring `SystemPrompt.fromFile`. A malformed line throws an **`InvalidRequestError` naming the 1-based line number**; a missing/unreadable path throws too. `cases` and `fromFile` combine (file entries append after inline).

### `filter` / `shard` — derive new datasets

```ts
const smoke = ds.filter((entry) => entry.tags?.includes("smoke"));
const shard = ds.shard(0, 4); // first of four parallel CI shards
```

Both return a **fresh dataset sharing nothing mutable**. `shard(index, total)` is deterministic round-robin by position: every entry lands in exactly one shard, so the union of all `total` shards reproduces the full list with no gaps or overlaps. `shard` validates its args (positive integer `total`, `index` in `[0, total)`) and throws `InvalidRequestError` otherwise.

## `agent.eval({ cases })` — accepts a dataset directly

```ts
const report = await myAgent.eval({
  cases: ds,                       // a DatasetContract OR a raw EvalCase[]
  scorers: [ai.eval.contains()],
});

expect(report.passed).toBe(true); // true only when EVERY case passed
```

The runner reads `.cases` off a dataset. Full `EvalReport`: `{ agentName, total, passedCount, failedCount, passRate, meanScore, passed, cases, duration, regression? }`. Each `EvalCaseResult` carries the case, the full `AgentResult`, every scorer's `scores`, the mean `score`, `passed`, and `duration`.

## Regression gating — `baseline` + `tolerance`

```ts
import { readFile, writeFile } from "node:fs/promises";

const baseline = ai.eval.fromJSON(await readFile("./eval/baseline.json", "utf8"));

const report = await myAgent.eval({
  cases: ds,
  scorers: [ai.eval.exact()],
  baseline,         // a prior EvalReport to diff against
  tolerance: 0.05,  // max allowed per-case score DROP before it regresses. default 0 (any drop)
});

if (report.regression && !report.regression.passed) {
  console.error("Regressed:", report.regression.regressed); // [{ name, before, after }]
  process.exit(1);
}
```

When `baseline` is set the report carries a `regression` block (`EvalRegression`), joining cases by `name`:

- **`regressed`** — `[{ name, before, after }]` for cases whose new score fell more than `tolerance` below baseline.
- **`added`** / **`removed`** — case names present in only one report. Adding or dropping a case **never fails the gate by itself**.
- **`passed`** — `true` when `regressed` is empty.

The pure `diff(report, baseline, tolerance)` function (exported as `diff`) is the same logic, decoupled from the runner — depends only on the two reports and the tolerance, mutates neither.

## CI reporters — `ai.eval.toJUnit` / `toJSON` / `fromJSON`

Pure functions over a finished `EvalReport`:

```ts
// JUnit-XML artifact for CI ingestion — one <testsuite> (the agent), one <testcase> per case,
// a <failure> on each non-passing case (joined scorer reasons), times in SECONDS.
await writeFile("./report.junit.xml", ai.eval.toJUnit(report));

// Round-trippable snapshot — today's report becomes tomorrow's baseline.
await writeFile("./eval/baseline.json", ai.eval.toJSON(report));
const restored = ai.eval.fromJSON(await readFile("./eval/baseline.json", "utf8"));
```

`toJSON`/`fromJSON` preserve `result` payloads, per-case `scores`, timings, and any attached `regression` block, so a parsed report drives regression diffing exactly as the in-memory one. `toJUnit` hand-emits XML (no `xml` dependency) and entity-escapes every dynamic value.

## Typical CI shard job

```ts
const shard = ai.dataset({ name: "support", fromFile: "./eval/support.jsonl" })
  .shard(Number(process.env.SHARD_INDEX), Number(process.env.SHARD_TOTAL));

const report = await agent.eval({
  cases: shard,
  scorers: [ai.eval.contains()],
  baseline: ai.eval.fromJSON(await readFile("./eval/baseline.json", "utf8")),
  tolerance: 0.05,
});

await writeFile(`./out/report-${process.env.SHARD_INDEX}.junit.xml`, ai.eval.toJUnit(report));
if (report.regression && !report.regression.passed) process.exit(1);
```

## See also

- [`@warlock.js/ai/ai-dx-helpers/SKILL.md`](@warlock.js/ai/ai-dx-helpers/SKILL.md) — `ai.eval.{exact,contains,predicate,judge}` scorers + Vitest matchers
- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — `agent.eval` scoring loop, `EvalCase` / `EvalJudge`
- [`@warlock.js/ai/record-replay-llm/SKILL.md`](@warlock.js/ai/record-replay-llm/SKILL.md) — `ai.vcr` for deterministic, offline eval runs
