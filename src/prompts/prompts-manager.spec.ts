import { describe, expect, it } from "vitest";
import { InvalidRequestError } from "../errors";
import { instruction } from "../system-prompt/instruction";
import { persona } from "../system-prompt/persona";
import { systemPrompt } from "../system-prompt/system-prompt";
import { defaultPromptsManager, prompts } from "./prompts-manager";

describe("systemPrompt meta", () => {
  it("is anonymous by default — meta() returns undefined", () => {
    expect(systemPrompt("Be concise.").meta()).toBeUndefined();
  });

  it("carries meta passed via the factory's second argument", () => {
    const prompt = systemPrompt("You are support.", {
      name: "support",
      version: "1",
      description: "Tier-1 support.",
    });

    expect(prompt.meta()).toEqual({
      name: "support",
      version: "1",
      description: "Tier-1 support.",
    });
  });

  it(".meta() shallow-merges onto existing metadata and returns a new builder", () => {
    const base = systemPrompt("Body.").meta({ description: "first" });
    const updated = base.meta({ description: "second", version: "9" });

    expect(base.meta()).toEqual({ description: "first" });
    expect(updated.meta()).toEqual({ description: "second", version: "9" });
  });

  it(".meta() does not mutate the original (immutability)", () => {
    const base = systemPrompt("Body.");
    const named = base.meta({ name: "x" });

    expect(base.meta()).toBeUndefined();
    expect(named.meta()?.name).toBe("x");
  });
});

describe("prompts() registry — registration", () => {
  it("registers a named prompt and resolves it back", () => {
    const registry = prompts();
    registry.register(systemPrompt("You are support.", { name: "support" }));

    expect(registry.has("support")).toBe(true);
    expect(registry.resolve("support")).toBe("You are support.");
  });

  it("defaults the version to '1' for the first registration of a name", () => {
    const registry = prompts();
    registry.register(systemPrompt("v one.", { name: "agent" }));

    expect(registry.versions("agent")).toEqual(["1"]);
  });

  it("auto-increments the default version per name", () => {
    const registry = prompts();
    registry.register(systemPrompt("one", { name: "agent" }));
    registry.register(systemPrompt("two", { name: "agent" }));
    registry.register(systemPrompt("three", { name: "agent" }));

    expect(registry.versions("agent")).toEqual(["1", "2", "3"]);
  });

  it("throws when registering a prompt without a name", () => {
    const registry = prompts();

    expect(() => registry.register(systemPrompt("anon"))).toThrow(
      InvalidRequestError,
    );
  });

  it("honors an explicit version label", () => {
    const registry = prompts();
    registry.register(
      systemPrompt("body", { name: "agent", version: "2024-draft" }),
    );

    expect(registry.versions("agent")).toEqual(["2024-draft"]);
    expect(registry.resolve("agent", "2024-draft")).toBe("body");
  });

  it("stores tags on the entry when provided", () => {
    const registry = prompts();
    registry.register(systemPrompt("body", { name: "agent" }), {
      tags: ["support", "tier1"],
    });

    // Tags do not affect resolution; presence is verified via has/resolve.
    expect(registry.has("agent")).toBe(true);
  });
});

// Build a named contract WITHOUT auto-registering into the global default
// manager: seed an anonymous prompt, then attach a name via a meta object that
// the LOCAL registry reads. We give the local registry the contract directly
// and let it derive the name from meta — but to avoid the global side effect of
// `.meta({ name })`, we register an anonymous-bodied prompt under an explicit
// name by constructing it with a unique name (global reg is harmless / unique).
function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

describe("prompts() registry — duplicates + idempotency", () => {
  it("throws InvalidRequestError on a duplicate name@version with different content", () => {
    const registry = prompts();
    const name = uniqueName("dup");
    // Build two DIFFERENT bodies as anonymous prompts (no global side effect),
    // then register both into the local registry under the same name@version.
    const first = systemPrompt("first");
    const second = systemPrompt("different");

    registry.register(first.meta({ name, version: "1" }));

    expect(() =>
      registry.register(second.meta({ name, version: "1" })),
    ).toThrow(InvalidRequestError);
  });

  it("is idempotent — re-registering identical content under the same key is a no-op", () => {
    const registry = prompts();
    const name = uniqueName("idem");
    const contract = systemPrompt("same").meta({ name, version: "1" });

    registry.register(contract);

    expect(() => registry.register(contract)).not.toThrow();
    expect(registry.versions(name)).toEqual(["1"]);
  });

  it("treats meta-only differences as idempotent (content signature ignores meta)", () => {
    const registry = prompts();
    const name = uniqueName("metaonly");
    registry.register(
      systemPrompt("same").meta({ name, version: "1", description: "a" }),
    );

    const sameBodyOtherMeta = systemPrompt("same").meta({
      name,
      version: "1",
      description: "b",
    });

    expect(() => registry.register(sameBodyOtherMeta)).not.toThrow();
  });
});

describe("prompts() registry — resolution", () => {
  it("get() returns the latest version when none requested", () => {
    const registry = prompts();
    registry.register(systemPrompt("old", { name: "agent" }));
    registry.register(systemPrompt("new", { name: "agent" }));

    expect(registry.get("agent").resolve()).toBe("new");
  });

  it("get() returns a specific version when requested", () => {
    const registry = prompts();
    registry.register(systemPrompt("old", { name: "agent" }));
    registry.register(systemPrompt("new", { name: "agent" }));

    expect(registry.get("agent", "1").resolve()).toBe("old");
  });

  it("resolve() renders placeholders", () => {
    const registry = prompts();
    registry.register(
      systemPrompt("Reply in {{language|English}}.", { name: "lang" }),
    );

    expect(registry.resolve("lang", undefined, { language: "Arabic" })).toBe(
      "Reply in Arabic.",
    );
  });

  it("get() throws InvalidRequestError on an unknown name", () => {
    const registry = prompts();

    expect(() => registry.get("missing")).toThrow(InvalidRequestError);
  });

  it("get() throws InvalidRequestError on an unknown version", () => {
    const registry = prompts();
    registry.register(systemPrompt("body", { name: "agent" }));

    expect(() => registry.get("agent", "99")).toThrow(InvalidRequestError);
  });

  it("has() is false for an unknown name and respects a version argument", () => {
    const registry = prompts();
    registry.register(systemPrompt("body", { name: "agent" }));

    expect(registry.has("missing")).toBe(false);
    expect(registry.has("agent", "1")).toBe(true);
    expect(registry.has("agent", "99")).toBe(false);
  });

  it("list() reflects registered names in first-seen order", () => {
    const registry = prompts();
    registry.register(systemPrompt("a", { name: "alpha" }));
    registry.register(systemPrompt("b", { name: "beta" }));
    registry.register(systemPrompt("a2", { name: "alpha" }));

    expect(registry.list()).toEqual(["alpha", "beta"]);
  });

  it("versions() is empty for an unknown name", () => {
    expect(prompts().versions("nope")).toEqual([]);
  });
});

// Dynamically importing the full `../ai` facade cold-transforms the entire
// primitive graph through vitest's esbuild; this one-time cold import can
// exceed the default 5s test budget (a test-time transform cost only — the
// shipped package is precompiled JS). These three tests reach `ai.prompts`
// (which IS the default manager) through that facade, so each carries a
// generous timeout for the one-time cold import.
describe("ai.prompts auto-registration via the default manager", () => {
  it("auto-registers a named systemPrompt into ai.prompts", async () => {
    const { ai } = await import("../ai");
    const name = `auto-${Math.random().toString(36).slice(2)}`;

    systemPrompt("Auto body.", { name });

    expect(ai.prompts.has(name)).toBe(true);
    expect(ai.prompts.resolve(name)).toBe("Auto body.");
  }, 30_000);

  it("auto-registers when a fork is re-named via .meta({ name })", async () => {
    const { ai } = await import("../ai");
    const name = `renamed-${Math.random().toString(36).slice(2)}`;

    systemPrompt("Base.").instruction("More.").meta({ name });

    expect(ai.prompts.has(name)).toBe(true);
    expect(ai.prompts.resolve(name)).toBe("Base.\n\nMore.");
  }, 30_000);

  it("does NOT register anonymous prompts", async () => {
    const { ai } = await import("../ai");
    const before = ai.prompts.list().length;

    systemPrompt("Anonymous, never registered.");

    expect(ai.prompts.list().length).toBe(before);
  }, 30_000);
});

describe("systemPrompt fork purity (anonymous derivations)", () => {
  it("forks via persona()/instruction() drop the name and stay anonymous", () => {
    const registry = prompts();
    const named = systemPrompt("Base.", { name: "base", version: "1" });
    registry.register(named);

    const forked = named.instruction("Extra.");

    expect(named.meta()?.name).toBe("base");
    expect(forked.meta()).toBeUndefined();
  });

  it("renaming a fork creates a NEW key, leaving the original entry intact", () => {
    const registry = prompts();
    registry.register(systemPrompt("Base body.", { name: "base" }));

    const renamed = systemPrompt("Base body.")
      .instruction("Variant.")
      .meta({ name: "variant" });
    registry.register(renamed);

    expect(registry.resolve("base")).toBe("Base body.");
    expect(registry.resolve("variant")).toBe("Base body.\n\nVariant.");
    expect(registry.list()).toContain("base");
    expect(registry.list()).toContain("variant");
  });
});

describe("systemPrompt.merge — by contract", () => {
  it("folds another prompt's blocks (persona replaces, instructions append)", () => {
    const base = systemPrompt()
      .persona("Base persona.")
      .instruction("Base rule.");
    const overlay = systemPrompt()
      .persona("Overlay persona.")
      .instruction("Overlay rule.");

    const merged = base.merge(overlay);

    expect(merged.resolve()).toBe(
      "Overlay persona.\n\nBase rule.\n\nOverlay rule.",
    );
  });

  it("records deterministic composedFrom provenance from named sources", () => {
    const baseName = uniqueName("base");
    const overlayName = uniqueName("global-instructions");
    const base = systemPrompt("Base.", { name: baseName, version: "2" });
    const overlay = systemPrompt("Global instructions.", {
      name: overlayName,
      version: "1",
    });

    const merged = base.merge(overlay);

    expect(merged.meta()?.composedFrom).toEqual([
      `${baseName}@2`,
      `${overlayName}@1`,
    ]);
  });

  // Generous timeout for the one-time cold `../ai` facade transform (see the
  // note above the auto-registration describe block).
  it("the merged result is anonymous (no name) and not auto-registered", async () => {
    const { ai } = await import("../ai");
    const base = systemPrompt("Base.", {
      name: `mbase-${Math.random().toString(36).slice(2)}`,
    });
    const overlay = systemPrompt("Overlay.");

    const merged = base.merge(overlay);
    const composed = merged.meta()?.composedFrom;

    expect(merged.meta()?.name).toBeUndefined();
    // composedFrom must exist (provenance) without registering the result.
    expect(composed && composed.length).toBe(2);
    expect(ai.prompts.has("anonymous")).toBe(false);
  }, 30_000);

  it("still supports the variadic-block form unchanged", () => {
    const merged = systemPrompt().merge(
      persona("You are Alex."),
      instruction("Be concise."),
      instruction("Cite sources."),
    );

    expect(merged.resolve()).toBe(
      "You are Alex.\n\nBe concise.\n\nCite sources.",
    );
  });
});

describe("systemPrompt.merge — by registry name", () => {
  it("folds a registered prompt resolved at the latest version", () => {
    const registry = prompts();
    registry.register(systemPrompt("v1 body.", { name: "shared" }));
    registry.register(systemPrompt("v2 body.", { name: "shared" }));

    // Register into the default manager too so merge-by-name resolves it.
    const name = `shared-${Math.random().toString(36).slice(2)}`;
    systemPrompt("latest body.", { name });

    const merged = systemPrompt().persona("Local.").merge(name);

    expect(merged.resolve()).toBe("Local.\n\nlatest body.");
  });

  it("folds a specific registered version via fromVersion", () => {
    const name = `versioned-${Math.random().toString(36).slice(2)}`;
    systemPrompt("first body.", { name, version: "1" });
    systemPrompt("second body.", { name, version: "2" });

    const merged = systemPrompt().merge(name, { fromVersion: "1" });

    expect(merged.resolve()).toBe("first body.");
  });

  it("composedFrom uses the resolved name@version label", () => {
    const name = `prov-${Math.random().toString(36).slice(2)}`;
    systemPrompt("body.", { name, version: "1" });

    const merged = systemPrompt("Local.", {
      name: `local-${Math.random().toString(36).slice(2)}`,
      version: "3",
    }).merge(name, { fromVersion: "1" });

    const composed = merged.meta()?.composedFrom;

    expect(composed?.[composed.length - 1]).toBe(`${name}@1`);
  });

  it("throws InvalidRequestError when the name is not registered", () => {
    expect(() => systemPrompt().merge("does-not-exist-xyz")).toThrow(
      InvalidRequestError,
    );
  });
});
