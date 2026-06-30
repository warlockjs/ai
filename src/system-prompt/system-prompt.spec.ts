import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidRequestError } from "../errors";
import { Instruction, instruction } from "./instruction";
import { Persona, persona } from "./persona";
import { renderPlaceholders } from "./render-placeholders";
import { SystemPrompt, systemPrompt } from "./system-prompt";

describe("renderPlaceholders", () => {
  it("substitutes a simple key", () => {
    expect(renderPlaceholders("Hello {{name}}", { name: "Hasan" })).toBe(
      "Hello Hasan",
    );
  });

  it("ignores surrounding whitespace inside braces", () => {
    expect(renderPlaceholders("Hello {{  name  }}", { name: "Hasan" })).toBe(
      "Hello Hasan",
    );
  });

  it("resolves nested dot paths", () => {
    const rendered = renderPlaceholders("{{user.profile.role}}", {
      user: { profile: { role: "admin" } },
    });

    expect(rendered).toBe("admin");
  });

  it("uses fallback when key is missing", () => {
    expect(renderPlaceholders("{{language|English}}", {})).toBe("English");
  });

  it("uses fallback when value is empty string", () => {
    expect(renderPlaceholders("{{language|English}}", { language: "" })).toBe(
      "English",
    );
  });

  it("uses fallback when value is null", () => {
    expect(renderPlaceholders("{{language|English}}", { language: null })).toBe(
      "English",
    );
  });

  it("leaves placeholder untouched when no fallback and key is missing", () => {
    expect(renderPlaceholders("Hello {{name}}", {})).toBe("Hello {{name}}");
  });

  it("coerces non-string values to string", () => {
    expect(renderPlaceholders("Count: {{count}}", { count: 42 })).toBe(
      "Count: 42",
    );
  });

  it("returns undefined for blocked traversal (segment on non-object)", () => {
    const rendered = renderPlaceholders("{{user.name|anonymous}}", {
      user: "hasan",
    });

    expect(rendered).toBe("anonymous");
  });

  it("replaces multiple placeholders in one template", () => {
    const rendered = renderPlaceholders(
      "{{greeting}}, {{user.name}}! Lang: {{language|English}}",
      { greeting: "Hi", user: { name: "Hasan" } },
    );

    expect(rendered).toBe("Hi, Hasan! Lang: English");
  });
});

describe("persona", () => {
  it("is an instance of Persona", () => {
    expect(persona("You are Alex")).toBeInstanceOf(Persona);
  });

  it("exposes raw text", () => {
    expect(persona("You are Alex").text).toBe("You are Alex");
  });

  it("resolves placeholders", () => {
    expect(persona("You are {{name}}").resolve({ name: "Alex" })).toBe(
      "You are Alex",
    );
  });

  it("leaves unresolved placeholders literal when no fallback", () => {
    expect(persona("You are {{name}}").resolve()).toBe("You are {{name}}");
  });
});

describe("instruction", () => {
  it("is an instance of Instruction", () => {
    expect(instruction("Be concise")).toBeInstanceOf(Instruction);
  });

  it("exposes raw text", () => {
    expect(instruction("Be concise").text).toBe("Be concise");
  });

  it("resolves placeholders with fallback", () => {
    const rendered = instruction("Reply in {{language|English}}").resolve();

    expect(rendered).toBe("Reply in English");
  });
});

describe("systemPrompt", () => {
  it("returns an instance of SystemPrompt", () => {
    expect(systemPrompt()).toBeInstanceOf(SystemPrompt);
  });

  it("resolves to an empty string when no persona or instructions are set", () => {
    expect(systemPrompt().resolve()).toBe("");
  });

  it("seeds from an initial instruction string", () => {
    expect(systemPrompt("Be concise.").resolve()).toBe("Be concise.");
  });

  it("joins persona and instructions with blank-line separators", () => {
    const text = systemPrompt()
      .persona("You are Alex.")
      .instruction("Be concise.")
      .instruction("Cite sources.")
      .resolve();

    expect(text).toBe("You are Alex.\n\nBe concise.\n\nCite sources.");
  });

  it("accepts a pre-built Persona instance", () => {
    const alex = persona("You are {{name}}");
    const prompt = systemPrompt().persona(alex).instruction("Be concise.");

    expect(prompt.resolve({ name: "Alex" })).toBe(
      "You are Alex\n\nBe concise.",
    );
  });

  it("accepts a pre-built Instruction instance", () => {
    const replyIn = instruction("Reply in {{language|English}}");
    const prompt = systemPrompt().persona("You are Alex.").instruction(replyIn);

    expect(prompt.resolve({ language: "Arabic" })).toBe(
      "You are Alex.\n\nReply in Arabic",
    );
  });

  it("resolves placeholders across every block", () => {
    const prompt = systemPrompt()
      .persona("You are {{user.name}}")
      .instruction("Respond in {{language|English}}");

    expect(prompt.resolve({ user: { name: "Alex" }, language: "Arabic" })).toBe(
      "You are Alex\n\nRespond in Arabic",
    );
  });

  it("is immutable — parent is unaffected by forks", () => {
    const base = systemPrompt().persona("Base persona");
    const forked = base.instruction("Forked instruction");

    expect(base.resolve()).toBe("Base persona");
    expect(forked.resolve()).toBe("Base persona\n\nForked instruction");
  });

  it("overwrites persona when called twice", () => {
    const prompt = systemPrompt().persona("First").persona("Second");

    expect(prompt.resolve()).toBe("Second");
  });

  it("accumulates instructions when called multiple times", () => {
    const prompt = systemPrompt().instruction("One").instruction("Two");

    expect(prompt.resolve()).toBe("One\n\nTwo");
  });

  it("lets the same Instruction instance render differently in different prompts", () => {
    const replyIn = instruction("Reply in {{language|English}}");
    const english = systemPrompt()
      .instruction(replyIn)
      .resolve({ language: "English" });
    const arabic = systemPrompt()
      .instruction(replyIn)
      .resolve({ language: "Arabic" });

    expect(english).toBe("Reply in English");
    expect(arabic).toBe("Reply in Arabic");
  });
});

describe("block discriminators", () => {
  it("tags personas with type: 'persona'", () => {
    expect(persona("x").type).toBe("persona");
  });

  it("tags instructions with type: 'instruction'", () => {
    expect(instruction("x").type).toBe("instruction");
  });
});

describe("systemPrompt (array form)", () => {
  it("accepts an array of blocks", () => {
    const prompt = systemPrompt([
      persona("You are Alex."),
      instruction("Be concise."),
    ]);

    expect(prompt.resolve()).toBe("You are Alex.\n\nBe concise.");
  });

  it("preserves insertion order exactly (instruction before persona)", () => {
    const prompt = systemPrompt([
      instruction("Be concise."),
      persona("You are Alex."),
    ]);

    expect(prompt.resolve()).toBe("Be concise.\n\nYou are Alex.");
  });

  it("exposes blocks as a readonly ordered snapshot", () => {
    const alex = persona("You are Alex.");
    const beConcise = instruction("Be concise.");
    const prompt = systemPrompt([alex, beConcise]);

    expect(prompt.blocks).toEqual([alex, beConcise]);
  });

  it("resolves placeholders across array blocks", () => {
    const prompt = systemPrompt([
      persona("You are {{name}}."),
      instruction("Reply in {{language|English}}."),
    ]);

    expect(prompt.resolve({ name: "Alex" })).toBe(
      "You are Alex.\n\nReply in English.",
    );
  });

  it("is empty when given an empty array", () => {
    expect(systemPrompt([]).resolve()).toBe("");
  });
});

describe("systemPrompt.fromFile / SystemPrompt.fromFile", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "warlock-ai-system-prompt-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns a SystemPrompt seeded from the file contents", async () => {
    const filePath = join(tempDir, "plain.md");
    await writeFile(filePath, "You are a helpful assistant.", "utf8");

    const prompt = SystemPrompt.fromFile(filePath);

    expect(prompt).toBeInstanceOf(SystemPrompt);
    expect(prompt.resolve()).toBe("You are a helpful assistant.");
  });

  it("seeds the file contents as a single instruction block", async () => {
    const filePath = join(tempDir, "single-block.md");
    await writeFile(filePath, "Be concise.", "utf8");

    const prompt = SystemPrompt.fromFile(filePath);

    expect(prompt.blocks).toHaveLength(1);
    expect(prompt.blocks[0]).toBeInstanceOf(Instruction);
    expect(prompt.blocks[0].type).toBe("instruction");
  });

  it("resolves placeholders embedded in the file at resolve time", async () => {
    const filePath = join(tempDir, "with-placeholders.md");
    await writeFile(filePath, "Respond in {{language|English}}.", "utf8");

    const prompt = SystemPrompt.fromFile(filePath);

    expect(prompt.resolve()).toBe("Respond in English.");
    expect(prompt.resolve({ language: "Arabic" })).toBe("Respond in Arabic.");
  });

  it("produces a forkable builder that accepts further persona/instruction calls", async () => {
    const filePath = join(tempDir, "forkable.md");
    await writeFile(filePath, "Base instruction.", "utf8");

    const prompt = SystemPrompt.fromFile(filePath)
      .persona("You are Alex.")
      .instruction("Cite sources.");

    expect(prompt.resolve()).toBe(
      "You are Alex.\n\nBase instruction.\n\nCite sources.",
    );
  });

  it("reads the file once at construction, not on each resolve", async () => {
    const filePath = join(tempDir, "one-shot.md");
    await writeFile(filePath, "First contents.", "utf8");

    const prompt = SystemPrompt.fromFile(filePath);

    await writeFile(filePath, "Changed on disk.", "utf8");

    expect(prompt.resolve()).toBe("First contents.");
    expect(prompt.resolve()).toBe("First contents.");
  });

  it("throws InvalidRequestError when the file does not exist", () => {
    const missingPath = join(tempDir, "does-not-exist.md");

    expect(() => SystemPrompt.fromFile(missingPath)).toThrow(
      InvalidRequestError,
    );
    expect(() => SystemPrompt.fromFile(missingPath)).toThrow(
      /Failed to read system prompt file/,
    );
  });

  it("preserves the path in the error context and the original cause", async () => {
    const missingPath = join(tempDir, "also-missing.md");

    try {
      SystemPrompt.fromFile(missingPath);
      expect.unreachable("fromFile should throw for a missing file");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as InvalidRequestError).context).toEqual({
        path: missingPath,
      });
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
    }
  });

  it("is exposed as a property on the systemPrompt factory and matches the static", async () => {
    const filePath = join(tempDir, "factory-property.md");
    await writeFile(filePath, "Via the factory property.", "utf8");

    expect(systemPrompt.fromFile).toBe(SystemPrompt.fromFile);

    const prompt = systemPrompt.fromFile(filePath);

    expect(prompt).toBeInstanceOf(SystemPrompt);
    expect(prompt.resolve()).toBe("Via the factory property.");
  });
});

describe("systemPrompt.persona() — replace-in-place behavior", () => {
  it("replaces existing persona in place, preserving its position", () => {
    const prompt = systemPrompt([
      instruction("First."),
      persona("Old persona."),
      instruction("Last."),
    ]).persona("New persona.");

    expect(prompt.resolve()).toBe("First.\n\nNew persona.\n\nLast.");
  });

  it("prepends a new persona when none exists", () => {
    const prompt = systemPrompt([instruction("Be concise.")]).persona(
      "You are Alex.",
    );

    expect(prompt.resolve()).toBe("You are Alex.\n\nBe concise.");
  });
});

describe("systemPrompt.merge()", () => {
  it("merges N predefined blocks in one call", () => {
    const prompt = systemPrompt().merge(
      persona("You are Alex."),
      instruction("Be concise."),
      instruction("Cite sources."),
    );

    expect(prompt.resolve()).toBe(
      "You are Alex.\n\nBe concise.\n\nCite sources.",
    );
  });

  it("is equivalent to chaining persona()/instruction()", () => {
    const reviewer = persona("You review code.");
    const style = instruction("Be terse.");
    const lang = instruction("Reply in {{language|English}}.");

    const merged = systemPrompt().merge(reviewer, style, lang);
    const chained = systemPrompt()
      .persona(reviewer)
      .instruction(style)
      .instruction(lang);

    expect(merged.resolve({ language: "Arabic" })).toBe(
      chained.resolve({ language: "Arabic" }),
    );
  });

  it("folds a persona to the front even when passed after instructions", () => {
    const prompt = systemPrompt().merge(
      instruction("Be concise."),
      persona("You are Alex."),
    );

    expect(prompt.resolve()).toBe("You are Alex.\n\nBe concise.");
  });

  it("appends every non-persona block in order", () => {
    const prompt = systemPrompt().merge(
      instruction("One."),
      instruction("Two."),
      instruction("Three."),
    );

    expect(prompt.resolve()).toBe("One.\n\nTwo.\n\nThree.");
  });

  it("merges onto an existing builder, replacing its persona in place", () => {
    const base = systemPrompt().persona("Old.").instruction("Keep me.");
    const merged = base.merge(persona("New."), instruction("Added."));

    expect(merged.resolve()).toBe("New.\n\nKeep me.\n\nAdded.");
  });

  it("keeps only the last persona when several are merged", () => {
    const prompt = systemPrompt().merge(persona("First."), persona("Second."));

    expect(prompt.resolve()).toBe("Second.");
  });

  it("resolves placeholders across merged blocks", () => {
    const prompt = systemPrompt().merge(
      persona("You are {{name}}."),
      instruction("Reply in {{language|English}}."),
    );

    expect(prompt.resolve({ name: "Alex", language: "Arabic" })).toBe(
      "You are Alex.\n\nReply in Arabic.",
    );
  });

  it("returns an equivalent builder when given no blocks", () => {
    const base = systemPrompt()
      .persona("You are Alex.")
      .instruction("Be concise.");

    expect(base.merge().resolve()).toBe(base.resolve());
  });

  it("is immutable — the original builder is untouched", () => {
    const base = systemPrompt().persona("Base.");
    const merged = base.merge(instruction("Extra."));

    expect(base.resolve()).toBe("Base.");
    expect(merged.resolve()).toBe("Base.\n\nExtra.");
  });

  it("reuses the same pre-built blocks across prompts", () => {
    const lang = instruction("Reply in {{language|English}}.");
    const a = systemPrompt().merge(persona("A."), lang);
    const b = systemPrompt().merge(persona("B."), lang);

    expect(a.resolve({ language: "English" })).toBe("A.\n\nReply in English.");
    expect(b.resolve({ language: "Arabic" })).toBe("B.\n\nReply in Arabic.");
  });
});
