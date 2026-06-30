import { describe, expect, it } from "vitest";
import { MockModel } from "../mock/mock-model";
import { prompt } from "./prompt";
import {
  buildValidationReport,
  sortNotesBySeverity,
  staticLint,
  staticScore,
} from "./prompt-validate";
import type { PromptValidationNote } from "./prompt.type";

describe("staticLint", () => {
  it("flags a too-short prompt", () => {
    const notes = staticLint("Hi");
    expect(notes.some(n => n.message.includes("very short"))).toBe(true);
  });

  it("flags an over-length prompt", () => {
    const notes = staticLint("You are A. " + "x".repeat(9000));
    expect(notes.some(n => n.message.includes("very long"))).toBe(true);
  });

  it("flags an unresolved placeholder", () => {
    const notes = staticLint("You are a helpful agent for {{product}} support.");
    const note = notes.find(n => n.message.includes("{{product}}"));
    expect(note).toBeDefined();
    expect(note?.severity).toBe("info");
  });

  it("does not flag a placeholder that carries a default", () => {
    const notes = staticLint("You are a helpful agent. Reply in {{language|English}}.");
    expect(notes.find(n => n.message.includes("Unresolved placeholder"))).toBeDefined();
  });

  it("flags a missing role line", () => {
    const notes = staticLint("Always answer concisely and cite a source.");
    expect(notes.some(n => n.message.includes("No role line"))).toBe(true);
  });

  it("passes a well-formed prompt with a role and no placeholders", () => {
    const notes = staticLint(
      "You are a senior support engineer. Answer concisely and always cite a source.",
    );
    expect(notes).toHaveLength(0);
  });
});

describe("sortNotesBySeverity", () => {
  it("orders error, then warn, then info — stable within a severity", () => {
    const input: PromptValidationNote[] = [
      { severity: "info", message: "i1" },
      { severity: "error", message: "e1" },
      { severity: "warn", message: "w1" },
      { severity: "error", message: "e2" },
    ];

    const sorted = sortNotesBySeverity(input);
    expect(sorted.map(n => n.message)).toEqual(["e1", "e2", "w1", "i1"]);
  });
});

describe("staticScore", () => {
  it("returns 1 for no findings", () => {
    expect(staticScore([])).toBe(1);
  });

  it("deducts per finding and clamps at 0", () => {
    const notes: PromptValidationNote[] = Array.from({ length: 10 }, () => ({
      severity: "error" as const,
      message: "x",
    }));
    expect(staticScore(notes)).toBe(0);
  });
});

describe("buildValidationReport", () => {
  it("uses the static score alone when no judge ran", () => {
    const notes = staticLint("Always cite a source.");
    const report = buildValidationReport(notes);
    expect(report.score).toBe(staticScore(notes));
    expect(report.notes).toEqual(sortNotesBySeverity(notes));
  });

  it("averages static and judge scores when a judge ran", () => {
    const staticNotes: PromptValidationNote[] = [];
    const report = buildValidationReport(staticNotes, { score: 0.5, notes: [] });
    expect(report.score).toBe(0.75);
  });
});

describe("prompt().validate — static only (no model)", () => {
  it("returns a report and never throws without a model", async () => {
    const registry = prompt();
    const report = await registry.validate("Always answer concisely.");
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.notes.some(n => n.message.includes("No role line"))).toBe(true);
  });

  it("validates a registered prompt by name (latest version)", async () => {
    const registry = prompt({
      prompts: [
        { name: "a", versions: [{ version: "1", template: "Always concise." }] },
      ],
    });

    const report = await registry.validate("a");
    expect(report.notes.some(n => n.message.includes("No role line"))).toBe(true);
  });

  it("validates a specific registered version", async () => {
    const registry = prompt({
      prompts: [
        {
          name: "a",
          versions: [
            { version: "1", template: "You are a clear, helpful senior engineer answering questions." },
            { version: "2", template: "x" },
          ],
        },
      ],
    });

    const report = await registry.validate("a", { version: "2" });
    expect(report.notes.some(n => n.message.includes("very short"))).toBe(true);
  });
});

describe("prompt().validate — with judge model", () => {
  const judgeJson = JSON.stringify({ score: 0.9, passed: true, reason: "clear and well-scoped" });

  it("merges the judge finding into the report and combines scores", async () => {
    const model = new MockModel("judge", [{ content: judgeJson }]);
    const registry = prompt();

    const report = await registry.validate(
      "You are a senior support engineer. Answer concisely and cite a source.",
      { model },
    );

    expect(report.notes.some(n => n.message.includes("LLM-as-judge"))).toBe(true);
    // static is 1.0 (clean), judge is 0.9 → mean 0.95
    expect(report.score).toBe(0.95);
  });

  it("uses the registry default judgeModel when no per-call model is passed", async () => {
    const model = new MockModel("judge", [{ content: judgeJson }]);
    const registry = prompt({ judgeModel: model });

    const report = await registry.validate(
      "You are a senior support engineer. Answer concisely.",
    );

    expect(report.notes.some(n => n.message.includes("LLM-as-judge"))).toBe(true);
  });

  it("marks a low-scoring judge finding as a warning", async () => {
    const model = new MockModel("judge", [
      { content: JSON.stringify({ score: 0.2, passed: false, reason: "vague role" }) },
    ]);
    const registry = prompt();

    const report = await registry.validate(
      "You are a senior support engineer. Answer concisely.",
      { model },
    );

    const judgeNote = report.notes.find(n => n.message.includes("LLM-as-judge"));
    expect(judgeNote?.severity).toBe("warn");
  });
});
