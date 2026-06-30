import { describe, expect, it } from "vitest";
import { Instruction } from "../system-prompt/instruction";
import { SystemPrompt } from "../system-prompt/system-prompt";
import { PromptNotFoundError, PromptValidationError } from "./errors";
import { prompt } from "./prompt";

describe("prompt() registry — registration", () => {
  it("seeds entries from constructor options", () => {
    const registry = prompt({
      prompts: [
        { name: "a", versions: [{ version: "1", template: "You are A." }] },
        { name: "b", versions: [{ version: "1", template: "You are B." }] },
      ],
    });

    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(true);
    expect(registry.list()).toEqual(["a", "b"]);
  });

  it("register() adds a new entry and is chainable", () => {
    const registry = prompt();
    const returned = registry.register({
      name: "x",
      versions: [{ version: "1", template: "You are X." }],
    });

    expect(returned).toBe(registry);
    expect(registry.has("x")).toBe(true);
  });

  it("add() appends a version to an existing name, latest last", () => {
    const registry = prompt({
      prompts: [{ name: "a", versions: [{ version: "1", template: "You are A1." }] }],
    });

    registry.add("a", { version: "2", template: "You are A2." });

    const versions = registry.versions("a");
    expect(versions.map(v => v.version)).toEqual(["1", "2"]);
  });

  it("add() creates the name when it does not yet exist", () => {
    const registry = prompt();
    registry.add("fresh", { version: "1", template: "You are fresh." });

    expect(registry.has("fresh")).toBe(true);
    expect(registry.versions("fresh")).toHaveLength(1);
  });

  it("add() with a duplicate version label throws PromptValidationError", () => {
    const registry = prompt({
      prompts: [{ name: "a", versions: [{ version: "1", template: "You are A." }] }],
    });

    expect(() => registry.add("a", { version: "1", template: "dup" })).toThrow(
      PromptValidationError,
    );
  });

  it("has() is false for unknown names", () => {
    expect(prompt().has("nope")).toBe(false);
  });
});

describe("prompt() registry — versions()", () => {
  it("returns a copy (mutating it does not affect the registry)", () => {
    const registry = prompt({
      prompts: [{ name: "a", versions: [{ version: "1", template: "You are A." }] }],
    });

    const versions = registry.versions("a");
    versions.push({ version: "2", template: "injected" });

    expect(registry.versions("a")).toHaveLength(1);
  });

  it("throws PromptNotFoundError for an unknown name", () => {
    expect(() => prompt().versions("ghost")).toThrow(PromptNotFoundError);
  });
});

describe("prompt() registry — resolve()", () => {
  const registry = prompt({
    prompts: [
      {
        name: "support",
        versions: [
          { version: "1", template: "You are support for {{product}}. Reply in {{language|English}}." },
          { version: "2", template: "You are senior support for {{product}}.", required: ["product"] },
        ],
      },
    ],
  });

  it("defaults to the latest version", () => {
    const resolved = registry.resolve("support", { placeholders: { product: "Warlock" } });
    expect(resolved.version).toBe("2");
    expect(resolved.text).toBe("You are senior support for Warlock.");
  });

  it("picks an explicit version", () => {
    const resolved = registry.resolve("support", {
      version: "1",
      placeholders: { product: "Warlock", language: "Arabic" },
    });

    expect(resolved.version).toBe("1");
    expect(resolved.text).toBe("You are support for Warlock. Reply in Arabic.");
  });

  it("delegates rendering to renderPlaceholders (default value)", () => {
    const resolved = registry.resolve("support", {
      version: "1",
      placeholders: { product: "Warlock" },
    });

    expect(resolved.text).toBe("You are support for Warlock. Reply in English.");
  });

  it("supports dot-path placeholders via the shared renderer", () => {
    const registry = prompt({
      prompts: [{ name: "x", versions: [{ version: "1", template: "Hi {{user.name}}." }] }],
    });

    const resolved = registry.resolve("x", { placeholders: { user: { name: "Hasan" } } });
    expect(resolved.text).toBe("Hi Hasan.");
  });

  it("throws PromptNotFoundError on an unknown name", () => {
    expect(() => registry.resolve("ghost")).toThrow(PromptNotFoundError);
  });

  it("carries the missing name in the error context", () => {
    try {
      registry.resolve("ghost");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PromptNotFoundError);
      expect((error as PromptNotFoundError).context?.name).toBe("ghost");
    }
  });

  it("throws PromptNotFoundError when an explicit version is unknown", () => {
    expect(() => registry.resolve("support", { version: "99" })).toThrow(
      PromptNotFoundError,
    );
  });

  it("throws PromptValidationError listing missing required keys", () => {
    try {
      registry.resolve("support", { placeholders: {} });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PromptValidationError);
      expect((error as PromptValidationError).context?.missing).toEqual(["product"]);
    }
  });

  it("treats an empty-string required value as missing", () => {
    expect(() => registry.resolve("support", { placeholders: { product: "" } })).toThrow(
      PromptValidationError,
    );
  });

  it("passes required validation when the key is supplied", () => {
    expect(() =>
      registry.resolve("support", { placeholders: { product: "Warlock" } }),
    ).not.toThrow();
  });
});

describe("prompt() registry — toSystemPrompt()", () => {
  it("returns the same seed shape as systemPrompt(string)", () => {
    const registry = prompt({
      prompts: [{ name: "a", versions: [{ version: "1", template: "You are {{role}}." }] }],
    });

    const resolved = registry.resolve("a", { placeholders: { role: "Alex" } });
    const sp = resolved.toSystemPrompt();

    expect(sp).toBeInstanceOf(SystemPrompt);
    expect(sp.blocks).toHaveLength(1);
    expect(sp.blocks[0]).toBeInstanceOf(Instruction);
    expect(sp.resolve()).toBe("You are Alex.");
  });

  it("seeds with the already-rendered text (placeholders baked in)", () => {
    const registry = prompt({
      prompts: [{ name: "a", versions: [{ version: "1", template: "Hi {{name|friend}}." }] }],
    });

    const sp = registry.resolve("a").toSystemPrompt();
    expect(sp.resolve()).toBe("Hi friend.");
  });
});

describe("prompt() registry — unified backing (P3 facade)", () => {
  it("resolves through the unified contract while preserving raw-template rendering", () => {
    const registry = prompt({
      prompts: [
        {
          name: "support",
          versions: [
            { version: "1", template: "You are support for {{product}}. Reply in {{language|English}}." },
          ],
        },
      ],
    });

    // The explicit value must win over the inline default — proving the facade
    // renders the RAW stored template (not an already-resolved contract body).
    const resolved = registry.resolve("support", {
      version: "1",
      placeholders: { product: "Warlock", language: "Arabic" },
    });

    expect(resolved.text).toBe("You are support for Warlock. Reply in Arabic.");
  });
});

describe("prompt() registry — register() merge semantics", () => {
  it("merges new versions onto an existing name", () => {
    const registry = prompt({
      prompts: [{ name: "a", versions: [{ version: "1", template: "v1" }] }],
    });

    registry.register({ name: "a", versions: [{ version: "2", template: "v2" }] });

    expect(registry.versions("a").map(v => v.version)).toEqual(["1", "2"]);
  });

  it("throws when a merged entry repeats an existing version label", () => {
    const registry = prompt({
      prompts: [{ name: "a", versions: [{ version: "1", template: "v1" }] }],
    });

    expect(() =>
      registry.register({ name: "a", versions: [{ version: "1", template: "dup" }] }),
    ).toThrow(PromptValidationError);
  });
});
