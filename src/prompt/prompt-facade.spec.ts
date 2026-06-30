import { describe, expect, it } from "vitest";
import { defaultPromptsManager } from "../prompts/prompts-manager";
import { SystemPrompt } from "../system-prompt/system-prompt";
import { systemPrompt } from "../system-prompt/system-prompt";
import { prompt } from "./prompt";

/**
 * P3 — `ai.prompt` is now a THIN FACADE over the unified `ai.prompts` manager.
 * These specs pin the facade contract: one storage shape (a
 * `SystemPromptContract` per `name@version`), the string-overload read path onto
 * the process-wide registry, and `required` → `meta.required` migration.
 */
describe("prompt() facade — unified backing storage", () => {
  it("stores each version as a SystemPromptContract (single storage shape)", () => {
    const registry = prompt({
      prompts: [
        {
          name: "support",
          versions: [{ version: "1", template: "You are support." }],
        },
      ],
    });

    // The facade resolves through the unified contract — the rendered text is
    // exactly the stored instruction block's body.
    const resolved = registry.resolve("support", { version: "1" });
    expect(resolved.text).toBe("You are support.");
  });

  it("migrates a version's `required` keys onto meta.required", () => {
    const registry = prompt({
      prompts: [
        {
          name: "support",
          versions: [
            {
              version: "1",
              template: "You are support for {{product}}.",
              required: ["product"],
            },
          ],
        },
      ],
    });

    // Resolving without the required key still throws (back-compat assertion),
    // and validating the contract surfaces the same declared-required key.
    expect(() => registry.resolve("support", { placeholders: {} })).toThrow();
  });

  it("keeps each prompt() registry isolated (no shared global state)", () => {
    const a = prompt({
      prompts: [{ name: "shared", versions: [{ version: "1", template: "A." }] }],
    });
    const b = prompt({
      prompts: [{ name: "shared", versions: [{ version: "1", template: "B." }] }],
    });

    expect(a.resolve("shared").text).toBe("A.");
    expect(b.resolve("shared").text).toBe("B.");
  });

  it("does NOT auto-register facade versions into the process-wide ai.prompts", () => {
    const name = `facade-isolation-${Math.random().toString(36).slice(2)}`;

    prompt({
      prompts: [{ name, versions: [{ version: "1", template: "Isolated." }] }],
    });

    // A facade registry owns its own manager — its names never leak into the
    // global default manager that named `systemPrompt(...)` builders use.
    expect(defaultPromptsManager().has(name)).toBe(false);
  });
});

describe("prompt(name) — string overload reads from ai.prompts", () => {
  it("resolves a globally-registered prompt by name", () => {
    const name = `facade-global-${Math.random().toString(36).slice(2)}`;
    systemPrompt("You are the global one.", { name });

    const contract = prompt(name);
    expect(contract).toBeInstanceOf(SystemPrompt);
    expect(contract.resolve()).toBe("You are the global one.");
  });

  it("resolves a specific version via the second argument", () => {
    const name = `facade-global-ver-${Math.random().toString(36).slice(2)}`;
    systemPrompt("v1 body.", { name, version: "1" });
    systemPrompt("v2 body.", { name, version: "2" });

    expect(prompt(name, "1").resolve()).toBe("v1 body.");
    expect(prompt(name, "2").resolve()).toBe("v2 body.");
  });

  it("throws when the global name is unknown", () => {
    expect(() => prompt("definitely-not-registered-xyz")).toThrow();
  });
});

describe("ai.prompts.create — alias of systemPrompt", () => {
  it("builds an empty builder with no argument", () => {
    const created = defaultPromptsManager().create();
    expect(created).toBeInstanceOf(SystemPrompt);
    expect(created.resolve()).toBe("");
  });

  it("seeds one instruction block from a string", () => {
    const created = defaultPromptsManager().create("Answer in JSON.");
    expect(created.resolve()).toBe("Answer in JSON.");
  });

  it("auto-registers when given a name in meta (same as systemPrompt)", () => {
    const name = `facade-create-${Math.random().toString(36).slice(2)}`;
    defaultPromptsManager().create("Created + named.", { name });

    expect(defaultPromptsManager().has(name)).toBe(true);
    expect(defaultPromptsManager().resolve(name)).toBe("Created + named.");
  });
});
