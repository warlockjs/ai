import { describe, expect, it } from "vitest";
import type { RefinedPromptStoreLike } from "../contracts/system-prompt.contract";
import { PromptRefinementError } from "../errors";
import { agent } from "../agent/agent";
import { MockModel } from "../mock/mock-model";
import type { MockModelResponse } from "../mock/mock-config.type";
import { defaultPromptsManager } from "../prompts/prompts-manager";
import { systemPrompt } from "./system-prompt";

/** A parity-clean rewrite of {@link sourceWithPlaceholders}'s template. */
const REFINED_WITH_PLACEHOLDERS =
  "REFINED: assist {{name|friend}} with {{product}} precisely.";

function sourceWithPlaceholders() {
  return systemPrompt("You are support for {{product}} helping {{name|friend}}.");
}

function refinerModel(responses: MockModelResponse[]): MockModel {
  return new MockModel("refiner", responses);
}

/** In-memory `RefinedPromptStoreLike` fake with call counters (judgeCache-fake pattern). */
function makeStore() {
  const entries = new Map<string, unknown>();
  let getCalls = 0;
  let setCalls = 0;

  const store: RefinedPromptStoreLike & {
    entries: Map<string, unknown>;
    readonly getCalls: number;
    readonly setCalls: number;
  } = {
    entries,
    get getCalls() {
      return getCalls;
    },
    get setCalls() {
      return setCalls;
    },
    async get<T>(key: string): Promise<T | null> {
      getCalls += 1;

      return (entries.get(key) as T | undefined) ?? null;
    },
    async set(key: string, value: unknown): Promise<unknown> {
      setCalls += 1;
      entries.set(key, value);

      return value;
    },
  };

  return store;
}

describe("systemPrompt.refined — laziness and the agent path", () => {
  it("does not call the refiner at construction; resolve() serves the original until compiled", () => {
    const refiner = refinerModel([{ content: REFINED_WITH_PLACEHOLDERS }]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    expect(refiner.callCount).toBe(0);
    expect(refined.resolve({ product: "Warlock" })).toBe(
      "You are support for Warlock helping friend.",
    );
  });

  it("compiles on first agent use, serves the refined text, and pins for later runs", async () => {
    const refiner = refinerModel([{ content: "REFINED SUPPORT PROMPT." }]);
    const chat = new MockModel("chat", [{ content: "ok", finishReason: "stop" }]);
    const refined = systemPrompt("You are a support agent.").refined({
      model: refiner,
    });

    const support = agent({ model: chat, systemPrompt: refined });

    await support.execute("Hi");

    expect(refiner.callCount).toBe(1);
    expect(chat.callHistory[0].messages[0]).toEqual({
      role: "system",
      content: "REFINED SUPPORT PROMPT.",
    });

    await support.execute("Hi again");

    // Pinned — the second run reads the compiled text without a refiner call.
    expect(refiner.callCount).toBe(1);
    expect(chat.callHistory[1].messages[0].content).toBe(
      "REFINED SUPPORT PROMPT.",
    );
  });

  it("falls back to the original prompt when the refiner fails — the agent path never throws", async () => {
    const refiner = refinerModel([
      { content: "", error: new Error("refiner down") },
    ]);
    const chat = new MockModel("chat", [{ content: "ok", finishReason: "stop" }]);
    const refined = systemPrompt("You are a support agent.").refined({
      model: refiner,
    });

    const result = await agent({ model: chat, systemPrompt: refined }).execute(
      "Hi",
    );

    expect(result.error).toBeUndefined();
    expect(chat.callHistory[0].messages[0]).toEqual({
      role: "system",
      content: "You are a support agent.",
    });
  });

  it("stamps the SOURCE prompt's name@version on the agent report", async () => {
    const refiner = refinerModel([{ content: "REFINED." }]);
    const chat = new MockModel("chat", [{ content: "ok", finishReason: "stop" }]);
    const refined = systemPrompt("You are support.", {
      name: "refined-spec-report-linkage",
      version: "3",
    }).refined({ model: refiner });

    const result = await agent({ model: chat, systemPrompt: refined }).execute(
      "Hi",
    );

    expect(result.report.promptName).toBe("refined-spec-report-linkage");
    expect(result.report.promptVersion).toBe("3");
  });
});

describe("refine() — the explicit compilation surface", () => {
  it("returns the refined template string with the placeholder set intact", async () => {
    const refiner = refinerModel([{ content: REFINED_WITH_PLACEHOLDERS }]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    const text = await refined.refine();

    expect(text).toBe(REFINED_WITH_PLACEHOLDERS);
    // Still a template — the caller resolves placeholders per use.
    expect(refined.resolve({ product: "Warlock", name: "Hasan" })).toBe(
      "REFINED: assist Hasan with Warlock precisely.",
    );
  });

  it("is store-first: a second instance with the same inputs reads the pin, no model call", async () => {
    const refiner = refinerModel([{ content: REFINED_WITH_PLACEHOLDERS }]);
    const store = makeStore();

    await sourceWithPlaceholders().refined({ model: refiner, store }).refine();

    expect(refiner.callCount).toBe(1);
    expect(store.setCalls).toBe(1);

    const second = await sourceWithPlaceholders()
      .refined({ model: refiner, store })
      .refine();

    expect(second).toBe(REFINED_WITH_PLACEHOLDERS);
    expect(refiner.callCount).toBe(1);
    expect(store.getCalls).toBeGreaterThanOrEqual(2);
  });

  it("{ fresh: true } bypasses the pin, re-runs the refiner, and re-pins", async () => {
    const refiner = refinerModel([
      { content: "REFINED take one {{product}} {{name|friend}}." },
      { content: "REFINED take two {{product}} {{name|friend}}." },
    ]);
    const store = makeStore();
    const refined = sourceWithPlaceholders().refined({ model: refiner, store });

    const first = await refined.refine();
    const second = await refined.refine({ fresh: true });

    expect(first).toContain("take one");
    expect(second).toContain("take two");
    expect(refiner.callCount).toBe(2);
    expect(store.setCalls).toBe(2);
    // The fresh take replaced the pin the instance serves.
    expect(refined.resolve({ product: "X", name: "Y" })).toContain("take two");
  });

  it("throws PromptRefinementError (reason 'model') when the refiner model fails", async () => {
    const refiner = refinerModel([
      { content: "", error: new Error("provider down") },
    ]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    await expect(refined.refine()).rejects.toMatchObject({
      name: "PromptRefinementError",
      reason: "model",
    });
  });

  it("rejects a rewrite that breaks placeholder parity — after one repair attempt", async () => {
    const refiner = refinerModel([
      { content: "REWRITE that lost every placeholder." },
      { content: "REWRITE still missing {{product}} only... actually has none." },
    ]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    await expect(refined.refine()).rejects.toBeInstanceOf(
      PromptRefinementError,
    );
    // First attempt + one bounded repair re-ask, then reject.
    expect(refiner.callCount).toBe(2);
  });

  it("accepts when the repair attempt restores parity", async () => {
    const refiner = refinerModel([
      { content: "REWRITE that lost every placeholder." },
      { content: REFINED_WITH_PLACEHOLDERS },
    ]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    await expect(refined.refine()).resolves.toBe(REFINED_WITH_PLACEHOLDERS);
    expect(refiner.callCount).toBe(2);

    // The repair prompt named the exact parity breaks.
    const sent = refiner.callHistory
      .flatMap(call => call.messages)
      .map(message => JSON.stringify(message.content))
      .join("\n");

    expect(sent).toContain("placeholder parity");
    expect(sent).toContain("{{product}}");
  });

  it("unwraps a code-fenced rewrite", async () => {
    const refiner = refinerModel([
      { content: "```\nREFINED {{product}} {{name|friend}}\n```" },
    ]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    await expect(refined.refine()).resolves.toBe(
      "REFINED {{product}} {{name|friend}}",
    );
  });

  it("throws PromptRefinementError (reason 'empty') on blank refiner output", async () => {
    const refiner = refinerModel([{ content: "   " }]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    await expect(refined.refine()).rejects.toMatchObject({ reason: "empty" });
  });

  it("threads criteria into the refiner call", async () => {
    const refiner = refinerModel([{ content: REFINED_WITH_PLACEHOLDERS }]);
    const refined = sourceWithPlaceholders().refined({
      model: refiner,
      criteria: ["Stay under 50 words", "Keep the supportive tone"],
    });

    await refined.refine();

    const sent = refiner.callHistory
      .flatMap(call => call.messages)
      .map(message => JSON.stringify(message.content))
      .join("\n");

    expect(sent).toContain("MUST also satisfy ALL of the following criteria");
    expect(sent).toContain("1. Stay under 50 words");
    expect(sent).toContain("2. Keep the supportive tone");
  });

  it("compiles an empty source to an empty string without a model call", async () => {
    const refiner = refinerModel([{ content: "SHOULD NEVER BE USED" }]);
    const refined = systemPrompt().refined({ model: refiner });

    await expect(refined.refine()).resolves.toBe("");
    expect(refiner.callCount).toBe(0);
  });
});

describe("refinePrompt() — the composable compiled prompt", () => {
  it("returns a plain prompt carrying the refined template, provenance, and the source's required keys", async () => {
    const refiner = refinerModel([{ content: REFINED_WITH_PLACEHOLDERS }]);
    const source = systemPrompt(
      "You are support for {{product}} helping {{name|friend}}.",
      {
        name: "refined-spec-provenance",
        version: "2",
        required: ["product"],
      },
    );

    const compiled = await source.refined({ model: refiner }).refinePrompt();

    expect(compiled.blocks).toHaveLength(1);
    expect(compiled.blocks[0].type).toBe("instruction");
    expect(compiled.blocks[0].text).toBe(REFINED_WITH_PLACEHOLDERS);
    expect(compiled.meta()?.refinedFrom).toBe("refined-spec-provenance@2");
    expect(compiled.meta()?.refinerModel).toBe("mock:refiner");
    expect(compiled.meta()?.required).toEqual(["product"]);
    expect(compiled.meta()?.name).toBeUndefined();
    expect(compiled.resolve({ product: "Warlock", name: "Hasan" })).toBe(
      "REFINED: assist Hasan with Warlock precisely.",
    );
  });

  it("never auto-registers the compiled prompt", async () => {
    const refiner = refinerModel([{ content: "REFINED." }]);
    const source = systemPrompt("You are support.", {
      name: "refined-spec-no-register",
    });
    const before = defaultPromptsManager().list().length;

    await source.refined({ model: refiner }).refinePrompt();

    expect(defaultPromptsManager().list().length).toBe(before);
  });

  it("labels an anonymous source as refinedFrom 'anonymous'", async () => {
    const refiner = refinerModel([{ content: "REFINED." }]);

    const compiled = await systemPrompt("You are support.")
      .refined({ model: refiner })
      .refinePrompt();

    expect(compiled.meta()?.refinedFrom).toBe("anonymous");
  });
});

describe("pin invalidation — the lockfile rule", () => {
  it("different criteria compile under a different pin key", async () => {
    const refiner = refinerModel([{ content: REFINED_WITH_PLACEHOLDERS }]);
    const store = makeStore();

    await sourceWithPlaceholders().refined({ model: refiner, store }).refine();
    await sourceWithPlaceholders()
      .refined({ model: refiner, store, criteria: "Be terse." })
      .refine();

    expect(refiner.callCount).toBe(2);
    expect(store.entries.size).toBe(2);
  });

  it("editing the source re-wraps refined and compiles under a new key", async () => {
    const refiner = refinerModel([{ content: REFINED_WITH_PLACEHOLDERS }]);
    const store = makeStore();
    const refined = sourceWithPlaceholders().refined({ model: refiner, store });

    await refined.refine();

    // Chaining preserves the compiled wrapper — no cast needed.
    const edited = refined.instruction("Always close with a summary.");

    expect(typeof edited.refine).toBe("function");

    await edited.refine();

    // …and the edited source is a different input ⇒ a fresh compilation.
    expect(refiner.callCount).toBe(2);
    expect(store.entries.size).toBe(2);
  });

  it("treats a parity-broken store pin as a miss and re-compiles", async () => {
    const refiner = refinerModel([{ content: REFINED_WITH_PLACEHOLDERS }]);
    const store = makeStore();

    await sourceWithPlaceholders().refined({ model: refiner, store }).refine();

    const [key] = [...store.entries.keys()];

    store.entries.set(key, "tampered pin with no placeholders");

    const text = await sourceWithPlaceholders()
      .refined({ model: refiner, store })
      .refine();

    expect(text).toBe(REFINED_WITH_PLACEHOLDERS);
    expect(refiner.callCount).toBe(2);
  });
});

describe("single-flight and supersession", () => {
  it("concurrent refine() calls share one compilation", async () => {
    const refiner = refinerModel([
      { content: REFINED_WITH_PLACEHOLDERS, delay: 15 },
    ]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    const [first, second] = await Promise.all([
      refined.refine(),
      refined.refine(),
    ]);

    expect(first).toBe(REFINED_WITH_PLACEHOLDERS);
    expect(second).toBe(REFINED_WITH_PLACEHOLDERS);
    expect(refiner.callCount).toBe(1);
  });

  it("a slow superseded lazy compile can never overwrite an explicit fresh pin", async () => {
    const refiner = refinerModel([
      { content: "SLOW LAZY take {{product}} {{name|friend}}.", delay: 30 },
      { content: "FRESH take {{product}} {{name|friend}}." },
    ]);
    const store = makeStore();
    const refined = sourceWithPlaceholders().refined({ model: refiner, store });

    // Start the lazy compile and let it grab the slow scripted response…
    const lazy = refined.materialize();

    await new Promise(resolve => setTimeout(resolve, 0));

    // …then compile fresh (settles first) — this is now the approved pin.
    const fresh = await refined.refine({ fresh: true });

    await lazy;

    expect(fresh).toContain("FRESH take");
    // The stale lazy result must not have re-pinned the instance…
    expect(refined.resolve({ product: "X", name: "Y" })).toContain(
      "FRESH take",
    );
    // …nor the shared store.
    expect([...store.entries.values()]).toEqual([
      "FRESH take {{product}} {{name|friend}}.",
    ]);
  });
});

describe("lazy failure cap", () => {
  it("stops retrying a persistently-failing refiner on the agent path after 3 attempts", async () => {
    const refiner = refinerModel([
      { content: "", error: new Error("key revoked") },
    ]);
    const chat = new MockModel("chat", [{ content: "ok", finishReason: "stop" }]);
    const refined = systemPrompt("You are a support agent.").refined({
      model: refiner,
    });
    const support = agent({ model: chat, systemPrompt: refined });

    for (let run = 0; run < 5; run++) {
      const result = await support.execute("Hi");

      expect(result.error).toBeUndefined();
    }

    // Attempts 1-3 hit the refiner; runs 4-5 serve the original immediately.
    expect(refiner.callCount).toBe(3);
    expect(chat.callHistory[4].messages[0].content).toBe(
      "You are a support agent.",
    );
  });

  it("explicit refine() stays live past the lazy cap", async () => {
    const refiner = refinerModel([
      { content: "", error: new Error("down") },
      { content: "", error: new Error("down") },
      { content: "", error: new Error("down") },
      { content: "RECOVERED REFINED PROMPT." },
    ]);
    const chat = new MockModel("chat", [{ content: "ok", finishReason: "stop" }]);
    const refined = systemPrompt("You are a support agent.").refined({
      model: refiner,
    });
    const support = agent({ model: chat, systemPrompt: refined });

    for (let run = 0; run < 4; run++) {
      await support.execute("Hi");
    }

    expect(refiner.callCount).toBe(3); // capped

    // The explicit surface still compiles — and re-arms the pin for everyone.
    await expect(refined.refine()).resolves.toBe("RECOVERED REFINED PROMPT.");

    await support.execute("Hi");

    const lastCall = chat.callHistory[chat.callHistory.length - 1];

    expect(lastCall.messages[0].content).toBe("RECOVERED REFINED PROMPT.");
  });
});

describe("code-fence handling", () => {
  it("leaves multi-fence output untouched instead of splicing fence markers into the body", async () => {
    const multiFence = [
      "```",
      "REFINED {{product}} {{name|friend}}",
      "```",
      "Between the fences.",
      "```",
      "Another block.",
      "```",
    ].join("\n");
    const refiner = refinerModel([{ content: multiFence }]);
    const refined = sourceWithPlaceholders().refined({ model: refiner });

    await expect(refined.refine()).resolves.toBe(multiFence);
  });
});
