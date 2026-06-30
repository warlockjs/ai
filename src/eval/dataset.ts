import { readFileSync } from "node:fs";
import type { DatasetContract, DatasetEntry, DatasetOptions } from "./dataset.type";
import { InvalidRequestError } from "../errors";

/**
 * Parse a JSONL file's contents into {@link DatasetEntry} rows. Blank
 * lines (and trailing whitespace-only lines) are skipped; every other
 * line must be a JSON object. A malformed line throws an
 * `InvalidRequestError` naming the 1-based line number — failing loud at
 * construction, like `SystemPrompt.fromFile`.
 */
function parseJsonl<TOutput>(path: string, contents: string): DatasetEntry<TOutput>[] {
  const entries: DatasetEntry<TOutput>[] = [];
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();

    if (line === "") {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new InvalidRequestError(
        `Failed to parse dataset file "${path}" — line ${index + 1} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { context: { path, line: index + 1 }, cause: error },
      );
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidRequestError(
        `Failed to parse dataset file "${path}" — line ${index + 1} is not a JSON object`,
        { context: { path, line: index + 1 } },
      );
    }

    entries.push(parsed as DatasetEntry<TOutput>);
  }

  return entries;
}

/**
 * Read a JSONL dataset file once, synchronously, at construction.
 * Mirrors `SystemPrompt.fromFile`: a read failure (missing path,
 * permission denied) throws an `InvalidRequestError` surfacing the
 * underlying cause.
 */
function readDatasetFile<TOutput>(path: string): DatasetEntry<TOutput>[] {
  let contents: string;

  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new InvalidRequestError(
      `Failed to read dataset file "${path}" — ${
        error instanceof Error ? error.message : String(error)
      }`,
      { context: { path }, cause: error },
    );
  }

  return parseJsonl<TOutput>(path, contents);
}

/**
 * Build an immutable {@link DatasetContract} over the given entries.
 * Shared by the {@link dataset} factory and by `filter` / `shard`, which
 * each return a fresh dataset built from a derived case list.
 */
function makeDataset<TOutput>(
  name: string,
  cases: DatasetEntry<TOutput>[],
): DatasetContract<TOutput> {
  return {
    name,
    cases,
    filter(predicate) {
      return makeDataset(name, cases.filter(predicate));
    },
    shard(index, total) {
      if (!Number.isInteger(total) || total <= 0) {
        throw new InvalidRequestError(
          `dataset.shard: "total" must be a positive integer, received ${total}`,
          { context: { name, total } },
        );
      }

      if (!Number.isInteger(index) || index < 0 || index >= total) {
        throw new InvalidRequestError(
          `dataset.shard: "index" must be an integer in [0, ${total}), received ${index}`,
          { context: { name, index, total } },
        );
      }

      return makeDataset(
        name,
        cases.filter((_, position) => position % total === index),
      );
    },
  };
}

/**
 * Create an immutable evaluation dataset that feeds `agent.eval({ cases })`
 * directly.
 *
 * **Role.** A taggable, filterable, shardable wrapper around a list of
 * {@link DatasetEntry} rows. `agent.eval` accepts a `DatasetContract` in
 * place of a raw `EvalCase[]`, reading `.cases` off it.
 *
 * Sources (combinable — file entries append after inline `cases`):
 * - `cases` → inline entries.
 * - `fromFile` → a JSONL file read once, synchronously, at construction
 *   (one JSON object per line). A malformed line throws an
 *   `InvalidRequestError` naming the 1-based line number.
 *
 * @example
 * const ds = dataset({ name: "support", fromFile: "./eval/support.jsonl" });
 * const smoke = ds.filter((entry) => entry.tags?.includes("smoke"));
 * const shard = ds.shard(0, 4); // first of four parallel CI shards
 *
 * const report = await agent.eval({ cases: ds, scorers: [contains()] });
 */
export function dataset<TOutput = unknown>(
  options: DatasetOptions<TOutput>,
): DatasetContract<TOutput> {
  const cases: DatasetEntry<TOutput>[] = [...(options.cases ?? [])];

  if (options.fromFile !== undefined) {
    cases.push(...readDatasetFile<TOutput>(options.fromFile));
  }

  return makeDataset(options.name, cases);
}
