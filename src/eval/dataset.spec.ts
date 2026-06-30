import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataset } from "./dataset";
import { InvalidRequestError } from "../errors";

describe("dataset", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "warlock-dataset-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeJsonl(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents, "utf8");

    return path;
  }

  it("should build from inline cases", () => {
    const ds = dataset({
      name: "inline",
      cases: [
        { name: "a", input: "1" },
        { name: "b", input: "2" },
      ],
    });

    expect(ds.name).toBe("inline");
    expect(ds.cases).toHaveLength(2);
    expect(ds.cases.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("should default to an empty case list", () => {
    const ds = dataset({ name: "empty" });

    expect(ds.cases).toEqual([]);
  });

  it("should load entries from a JSONL file, skipping blank lines", () => {
    const path = writeJsonl(
      "support.jsonl",
      '{"name":"a","input":"hello","expected":"hi"}\n\n  \n{"name":"b","input":"bye","tags":["smoke"]}\n',
    );

    const ds = dataset({ name: "support", fromFile: path });

    expect(ds.cases).toHaveLength(2);
    expect(ds.cases[0]).toMatchObject({ name: "a", input: "hello", expected: "hi" });
    expect(ds.cases[1].tags).toEqual(["smoke"]);
  });

  it("should append file entries after inline cases", () => {
    const path = writeJsonl("more.jsonl", '{"name":"file","input":"x"}\n');

    const ds = dataset({
      name: "combined",
      cases: [{ name: "inline", input: "y" }],
      fromFile: path,
    });

    expect(ds.cases.map((entry) => entry.name)).toEqual(["inline", "file"]);
  });

  it("should throw naming the line number on a malformed JSON line", () => {
    const path = writeJsonl(
      "bad.jsonl",
      '{"name":"a","input":"1"}\n{"name":"b" "input":"2"}\n',
    );

    expect(() => dataset({ name: "bad", fromFile: path })).toThrow(InvalidRequestError);
    expect(() => dataset({ name: "bad", fromFile: path })).toThrow(/line 2/);
  });

  it("should throw when a line is valid JSON but not an object", () => {
    const path = writeJsonl("notobj.jsonl", '{"name":"a","input":"1"}\n["nope"]\n');

    expect(() => dataset({ name: "notobj", fromFile: path })).toThrow(/line 2/);
  });

  it("should throw a read error when the file does not exist", () => {
    expect(() =>
      dataset({ name: "missing", fromFile: join(dir, "does-not-exist.jsonl") }),
    ).toThrow(InvalidRequestError);
  });

  it("should filter to a new dataset without mutating the original", () => {
    const ds = dataset({
      name: "tagged",
      cases: [
        { name: "a", input: "1", tags: ["smoke"] },
        { name: "b", input: "2", tags: ["slow"] },
        { name: "c", input: "3", tags: ["smoke"] },
      ],
    });

    const smoke = ds.filter((entry) => entry.tags?.includes("smoke") ?? false);

    expect(smoke.cases.map((entry) => entry.name)).toEqual(["a", "c"]);
    expect(smoke.name).toBe("tagged");
    expect(ds.cases).toHaveLength(3);
  });

  it("should shard deterministically with no gaps or overlaps", () => {
    const cases = Array.from({ length: 10 }, (_, index) => ({
      name: `case-${index}`,
      input: String(index),
    }));
    const ds = dataset({ name: "big", cases });

    const total = 3;
    const shards = [0, 1, 2].map((index) => ds.shard(index, total));

    expect(shards[0].cases.map((entry) => entry.name)).toEqual([
      "case-0",
      "case-3",
      "case-6",
      "case-9",
    ]);
    expect(shards[1].cases.map((entry) => entry.name)).toEqual([
      "case-1",
      "case-4",
      "case-7",
    ]);
    expect(shards[2].cases.map((entry) => entry.name)).toEqual([
      "case-2",
      "case-5",
      "case-8",
    ]);

    const reunited = shards.flatMap((shard) => shard.cases.map((entry) => entry.name)).sort();
    expect(reunited).toHaveLength(10);
    expect(new Set(reunited).size).toBe(10);
  });

  it("should reject invalid shard arguments", () => {
    const ds = dataset({ name: "s", cases: [{ name: "a", input: "1" }] });

    expect(() => ds.shard(0, 0)).toThrow(InvalidRequestError);
    expect(() => ds.shard(2, 2)).toThrow(InvalidRequestError);
    expect(() => ds.shard(-1, 3)).toThrow(InvalidRequestError);
  });
});
