import { describe, expect, it } from "vitest";
import { InvalidRequestError } from "../errors";
import { MockModel } from "../mock/mock-model";
import { instruction } from "../system-prompt/instruction";
import { persona } from "../system-prompt/persona";
import { systemPrompt } from "../system-prompt/system-prompt";
import { prompts } from "./prompts-manager";

/** A unique name so default-manager-bound tests never collide across runs. */
function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

describe("ai.prompts.define — bulk version registration", () => {
  it("registers many string-template versions oldest-first", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "You are v1." },
      { version: "2", template: "You are v2." },
    ]);

    expect(registry.versions("agent")).toEqual(["1", "2"]);
    expect(registry.resolve("agent", "1")).toBe("You are v1.");
    expect(registry.resolve("agent")).toBe("You are v2.");
  });

  it("wraps a string template into one instruction block", () => {
    const registry = prompts();
    registry.define("agent", [{ version: "1", template: "Single block." }]);

    const blocks = registry.get("agent", "1").blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("instruction");
    expect(blocks[0].text).toBe("Single block.");
  });

  it("registers a block-array template verbatim, preserving order + types", () => {
    const registry = prompts();
    registry.define("agent", [
      {
        version: "1",
        template: [persona("You are Alex."), instruction("Be concise.")],
      },
    ]);

    const blocks = registry.get("agent", "1").blocks;
    expect(blocks.map(b => [b.type, b.text])).toEqual([
      ["persona", "You are Alex."],
      ["instruction", "Be concise."],
    ]);
  });

  it("does NOT leak into the process-wide default manager", async () => {
    const { ai } = await import("../ai");
    const name = uniqueName("local-define");
    const registry = prompts();

    registry.define(name, [{ version: "1", template: "Local only." }]);

    expect(registry.has(name)).toBe(true);
    expect(ai.prompts.has(name)).toBe(false);
  }, 30_000);

  it("enforces the duplicate rule across define() versions", () => {
    const registry = prompts();
    registry.define("agent", [{ version: "1", template: "first" }]);

    expect(() =>
      registry.define("agent", [{ version: "1", template: "different" }]),
    ).toThrow(InvalidRequestError);
  });
});

describe("ai.prompts.tag — pin + resolve by tag", () => {
  it("resolves a tagged version via get(name, tag)", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "old body." },
      { version: "2", template: "new body." },
    ]);

    registry.tag("agent", "production", "1");

    expect(registry.get("agent", "production").resolve()).toBe("old body.");
    expect(registry.resolve("agent", "production")).toBe("old body.");
  });

  it("resolves a tag via the inline name@tag form", () => {
    const registry = prompts();
    registry.define("agent", [{ version: "1", template: "tagged body." }]);
    registry.tag("agent", "stable", "1");

    expect(registry.get("agent@stable").resolve()).toBe("tagged body.");
    expect(registry.resolve("agent@stable")).toBe("tagged body.");
    expect(registry.has("agent@stable")).toBe(true);
  });

  it("resolves a version via the inline name@version form", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "one." },
      { version: "2", template: "two." },
    ]);

    expect(registry.resolve("agent@1")).toBe("one.");
    expect(registry.resolve("agent@2")).toBe("two.");
  });

  it("re-pinning a tag moves it to the new version", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "v1." },
      { version: "2", template: "v2." },
    ]);

    registry.tag("agent", "production", "1");
    registry.tag("agent", "production", "2");

    expect(registry.resolve("agent", "production")).toBe("v2.");
  });

  it("prefers an exact version label over a same-named tag", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "real v1." },
      { version: "2", template: "real v2." },
    ]);
    // Pin a tag literally named "1" onto version 2 — the version label wins.
    registry.tag("agent", "1", "2");

    expect(registry.resolve("agent", "1")).toBe("real v1.");
  });

  it("throws when tagging an unknown version", () => {
    const registry = prompts();
    registry.define("agent", [{ version: "1", template: "body." }]);

    expect(() => registry.tag("agent", "production", "99")).toThrow(
      InvalidRequestError,
    );
  });

  it("throws when resolving an unknown tag", () => {
    const registry = prompts();
    registry.define("agent", [{ version: "1", template: "body." }]);

    expect(() => registry.get("agent", "ghost")).toThrow(InvalidRequestError);
  });
});

describe("ai.prompts.validate — deterministic placeholder check", () => {
  it("ok=true with no missing keys for a fully-defaulted prompt", async () => {
    const registry = prompts();
    const result = await registry.validate("Reply in {{language|English}}.");

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.score).toBeUndefined();
  });

  it("reports a bare placeholder with no default as missing", async () => {
    const registry = prompts();
    const result = await registry.validate("You are support for {{product}}.");

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["product"]);
  });

  it("treats a supplied placeholder as satisfied", async () => {
    const registry = prompts();
    const result = await registry.validate("You are support for {{product}}.", {
      placeholders: { product: "Warlock" },
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("treats a declared key as satisfied", async () => {
    const registry = prompts();
    const result = await registry.validate("You are support for {{product}}.", {
      declare: ["product"],
    });

    expect(result.ok).toBe(true);
  });

  it("honors a prompt's meta.required as declared", async () => {
    const registry = prompts();
    // meta.required lists `product`, so it is declared (not missing) even
    // though no value is supplied — required ⇒ caller-must-supply-at-runtime.
    const contract = systemPrompt("You are support for {{product}}.").meta({
      required: ["product"],
    });

    const result = await registry.validate(contract);
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("flags a required key that is never referenced in the body", async () => {
    const registry = prompts();
    const contract = systemPrompt("You are a fixed support agent.").meta({
      required: ["product"],
    });

    const result = await registry.validate(contract);
    expect(result.ok).toBe(true);
    expect(result.issues?.some(i => i.includes("product"))).toBe(true);
  });

  it("validates a registered name (latest) by string target", async () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "You are support for {{product}}." },
    ]);

    const result = await registry.validate("agent");
    expect(result.missing).toEqual(["product"]);
  });

  it("validates a tagged registered version via name@tag target", async () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "All good, no slots." },
      { version: "2", template: "Needs {{slot}}." },
    ]);
    registry.tag("agent", "production", "1");

    const result = await registry.validate("agent@production");
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("validates a single block target", async () => {
    const registry = prompts();
    const result = await registry.validate(instruction("Needs {{x}}."));

    expect(result.missing).toEqual(["x"]);
  });
});

describe("ai.prompts.validate — optional LLM judge (Nova-safe)", () => {
  const judgeJson = JSON.stringify({
    score: 0.9,
    passed: true,
    reason: "clear and well scoped",
  });

  it("adds a score + issues when a judge model is supplied", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [{ content: judgeJson }]);

    const result = await registry.validate(
      "You are a senior support engineer. Answer concisely.",
      { judge },
    );

    expect(result.score).toBe(0.9);
    expect(result.issues).toContain("clear and well scoped");
    expect(result.ok).toBe(true);
  });

  it("never throws + degrades to score=undefined when the judge errors", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [
      { content: "", error: new Error("nova exploded"), finishReason: "stop" },
    ]);

    const result = await registry.validate("You are a clear support agent.", {
      judge,
    });

    expect(result.score).toBeUndefined();
    expect(result.issues?.some(i => i.includes("unavailable"))).toBe(true);
    // The deterministic verdict still stands.
    expect(result.ok).toBe(true);
  });

  it("degrades to score=undefined on unparseable judge output", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [
      { content: "not json at all", finishReason: "stop" },
    ]);

    const result = await registry.validate("You are a clear support agent.", {
      judge,
    });

    expect(result.score).toBeUndefined();
    expect(result.issues?.length).toBeGreaterThan(0);
  });

  it("a failing judge never flips ok for a placeholder-clean prompt", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [
      { content: "", error: new Error("down"), finishReason: "stop" },
    ]);

    const result = await registry.validate("Reply in {{language|English}}.", {
      judge,
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

/**
 * Minimal in-memory `PromptJudgeCacheLike` fake — a plain Map plus call
 * counters, so the validate-cache tests assert hit/miss behavior without
 * depending on the `@warlock.js/cache` package being resolvable.
 */
function makeJudgeCache() {
  const store = new Map<string, unknown>();

  return {
    store,
    getCalls: 0,
    setCalls: 0,
    async get<T = unknown>(key: string): Promise<T | null> {
      this.getCalls++;
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown): Promise<unknown> {
      this.setCalls++;
      store.set(key, value);
      return value;
    },
  };
}

describe("ai.prompts.validate — judge-verdict cache (item 2)", () => {
  const judgeJson = JSON.stringify({ score: 0.7, passed: true, reason: "fine" });

  it("memoizes a usable verdict so a second identical validate skips the model", async () => {
    const cache = makeJudgeCache();
    const registry = prompts({ judgeCache: cache });
    const judge = new MockModel("judge", [{ content: judgeJson }]);

    const body = "You are a careful, concise support engineer.";

    const first = await registry.validate(body, { judge });
    const second = await registry.validate(body, { judge });

    expect(first.score).toBe(0.7);
    expect(second.score).toBe(0.7);
    // One real model call only — the second came from the cache.
    expect(judge.callCount).toBe(1);
    expect(cache.setCalls).toBe(1);
    expect(cache.getCalls).toBe(2);
  });

  it("keys by judge model id — a different judge misses the cache", async () => {
    const cache = makeJudgeCache();
    const registry = prompts({ judgeCache: cache });
    const judgeA = new MockModel("judge-a", [{ content: judgeJson }]);
    const judgeB = new MockModel("judge-b", [{ content: judgeJson }]);

    const body = "You are a careful, concise support engineer.";

    await registry.validate(body, { judge: judgeA });
    await registry.validate(body, { judge: judgeB });

    expect(judgeA.callCount).toBe(1);
    expect(judgeB.callCount).toBe(1);
    expect(cache.store.size).toBe(2);
  });

  it("keys by prompt content — a different body misses the cache", async () => {
    const cache = makeJudgeCache();
    const registry = prompts({ judgeCache: cache });
    const judge = new MockModel("judge", [{ content: judgeJson }]);

    await registry.validate("You are a concise senior engineer.", { judge });
    await registry.validate("You are a verbose junior engineer.", { judge });

    expect(judge.callCount).toBe(2);
    expect(cache.store.size).toBe(2);
  });

  it("does NOT cache a degraded (scoreless) verdict", async () => {
    const cache = makeJudgeCache();
    const registry = prompts({ judgeCache: cache });
    const judge = new MockModel("judge", [
      { content: "", error: new Error("down"), finishReason: "stop" },
    ]);

    const result = await registry.validate("You are a clear support agent.", {
      judge,
    });

    expect(result.score).toBeUndefined();
    expect(cache.setCalls).toBe(0);
    expect(cache.store.size).toBe(0);
  });

  it("is a no-op when no cache is injected", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [
      { content: judgeJson },
      { content: judgeJson },
    ]);

    const body = "You are a careful, concise support engineer.";
    await registry.validate(body, { judge });
    await registry.validate(body, { judge });

    // No cache ⇒ both validations call the model.
    expect(judge.callCount).toBe(2);
  });

  it("a per-call judgeCache overrides the manager-level cache", async () => {
    const managerCache = makeJudgeCache();
    const callCache = makeJudgeCache();
    const registry = prompts({ judgeCache: managerCache });
    const judge = new MockModel("judge", [{ content: judgeJson }]);

    await registry.validate("You are a concise senior engineer.", {
      judge,
      judgeCache: callCache,
    });

    expect(callCache.store.size).toBe(1);
    expect(managerCache.store.size).toBe(0);
  });

  it("tolerates a throwing cache without failing validation", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [{ content: judgeJson }]);
    const brokenCache = {
      async get(): Promise<null> {
        throw new Error("cache get exploded");
      },
      async set(): Promise<unknown> {
        throw new Error("cache set exploded");
      },
    };

    const result = await registry.validate("You are a clear support agent.", {
      judge,
      judgeCache: brokenCache,
    });

    // The judge still ran and produced a usable score despite cache faults.
    expect(result.score).toBe(0.7);
    expect(result.ok).toBe(true);
  });
});

describe("systemPrompt().validate — sugar over ai.prompts.validate", () => {
  it("delegates a deterministic check through the default manager", async () => {
    const result = await systemPrompt("You are support for {{product}}.").validate();

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["product"]);
  });

  it("passes placeholders + judge through to the manager", async () => {
    const judge = new MockModel("judge", [
      { content: JSON.stringify({ score: 0.8, passed: true, reason: "ok" }) },
    ]);

    const result = await systemPrompt("You are support for {{product}}.").validate({
      placeholders: { product: "Warlock" },
      judge,
    });

    expect(result.ok).toBe(true);
    expect(result.score).toBe(0.8);
  });
});

describe("ai.prompts.diff — block-level diff", () => {
  it("reports identical for byte-equal versions", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "Same body." },
      { version: "2", template: "Same body." },
    ]);

    const diff = registry.diff("agent", "1", "2");
    expect(diff.identical).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("reports a changed block at the same position", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: "First text." },
      { version: "2", template: "Second text." },
    ]);

    const diff = registry.diff("agent", "1", "2");
    expect(diff.identical).toBe(false);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].from.text).toBe("First text.");
    expect(diff.changed[0].to.text).toBe("Second text.");
  });

  it("reports added + removed when block counts differ", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: [instruction("Only one.")] },
      {
        version: "2",
        template: [instruction("Only one."), instruction("Plus two.")],
      },
    ]);

    const diff = registry.diff("agent", "1", "2");
    expect(diff.added.map(b => b.text)).toEqual(["Plus two."]);
    expect(diff.removed).toEqual([]);

    const reverse = registry.diff("agent", "2", "1");
    expect(reverse.removed.map(b => b.text)).toEqual(["Plus two."]);
    expect(reverse.added).toEqual([]);
  });

  it("throws on an unknown version", () => {
    const registry = prompts();
    registry.define("agent", [{ version: "1", template: "body." }]);

    expect(() => registry.diff("agent", "1", "99")).toThrow(InvalidRequestError);
  });
});

describe("ai.prompts.export / import — round-trip", () => {
  it("exports the whole registry as portable JSON", () => {
    const registry = prompts();
    registry.define("agent", [
      { version: "1", template: [persona("You are Alex."), instruction("Be terse.")] },
      { version: "2", template: "Plain v2." },
    ]);
    registry.tag("agent", "production", "1");

    const snapshot = registry.export();
    expect(snapshot.prompts).toHaveLength(1);

    const exported = snapshot.prompts[0];
    expect(exported.name).toBe("agent");
    expect(exported.versions.map(v => v.version)).toEqual(["1", "2"]);
    expect(exported.versions[0].blocks).toEqual([
      { type: "persona", text: "You are Alex." },
      { type: "instruction", text: "Be terse." },
    ]);
    expect(exported.versions[0].tags).toEqual(["production"]);
  });

  it("import rehydrates blocks, versions, and pinned tags", () => {
    const source = prompts();
    source.define("agent", [
      { version: "1", template: [persona("Persona."), instruction("Rule.")] },
      { version: "2", template: "Body v2." },
    ]);
    source.tag("agent", "production", "2");

    const snapshot = source.export();

    const target = prompts();
    target.import(snapshot);

    expect(target.list()).toEqual(["agent"]);
    expect(target.versions("agent")).toEqual(["1", "2"]);
    expect(target.resolve("agent", "1")).toBe("Persona.\n\nRule.");
    expect(target.resolve("agent", "production")).toBe("Body v2.");
  });

  it("round-trips export → import → export to an identical snapshot", () => {
    const source = prompts();
    source.define("a", [{ version: "1", template: "Alpha {{x|y}}." }]);
    source.define("b", [
      { version: "1", template: "Beta one." },
      { version: "2", template: "Beta two." },
    ]);
    source.tag("b", "stable", "1");

    const first = source.export();

    const target = prompts();
    target.import(first);
    const second = target.export();

    expect(second).toEqual(first);
  });

  it("carries meta.description + meta.required through export/import", () => {
    const source = prompts();
    const contract = systemPrompt("You are support for {{product}}.", {
      name: uniqueName("desc"),
      version: "1",
      description: "Tier-1 support.",
      required: ["product"],
    });
    source.register(contract);

    const exported = source.export().prompts[0].versions[0];
    expect(exported.description).toBe("Tier-1 support.");
    expect(exported.required).toEqual(["product"]);
  });

  it("import does NOT leak into the default manager", async () => {
    const { ai } = await import("../ai");
    const name = uniqueName("imp");
    const snapshot = {
      prompts: [
        {
          name,
          versions: [{ version: "1", blocks: [{ type: "instruction", text: "x" }] }],
        },
      ],
    };

    const target = prompts();
    target.import(snapshot);

    expect(target.has(name)).toBe(true);
    expect(ai.prompts.has(name)).toBe(false);
  }, 30_000);
});
