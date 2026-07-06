import { describe, expect, it } from "vitest";
import { MockModel } from "../mock/mock-model";
import { prompts } from "./prompts-manager";
import { formatCriteria } from "./prompts-validate";

describe("formatCriteria", () => {
  it("returns undefined for absent / empty input (falls back to the default rubric)", () => {
    expect(formatCriteria(undefined)).toBeUndefined();
    expect(formatCriteria("")).toBeUndefined();
    expect(formatCriteria("   ")).toBeUndefined();
    expect(formatCriteria([])).toBeUndefined();
    expect(formatCriteria(["", "  "])).toBeUndefined();
  });

  it("uses a single string verbatim", () => {
    expect(formatCriteria("Must stay under 200 words.")).toBe("Must stay under 200 words.");
  });

  it("joins a list into a numbered rule set and drops blanks", () => {
    const out = formatCriteria(["Addresses the user by name", "", "  ", "Never gives medical advice"]);
    expect(out).toContain("ALL of the following criteria");
    expect(out).toContain("1. Addresses the user by name");
    expect(out).toContain("2. Never gives medical advice");
    expect(out).not.toContain("3.");
  });
});

describe("ai.prompts.validate — custom criteria", () => {
  const verdict = JSON.stringify({ score: 0.9, passed: true, reason: "meets the rules" });

  it("passes the caller's criteria to the judge instead of the default rubric", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [{ content: verdict }]);

    const result = await registry.validate("You are support for {{product}} helping {{name}}.", {
      judge,
      criteria: ["Addresses the user by their {{name}}", "Never gives medical advice"],
      declare: ["product", "name"],
    });

    // The judge ran against our rules (score surfaced, ok unaffected).
    expect(result.ok).toBe(true);
    expect(result.score).toBe(0.9);

    // Our criteria text actually reached the judge model.
    const sent = judge.callHistory
      .flatMap(call => call.messages)
      .map(message => JSON.stringify(message.content))
      .join("\n");
    expect(sent).toContain("Never gives medical advice");
    expect(sent).toContain("Addresses the user by their");
  });

  it("still runs the deterministic placeholder check alongside criteria", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [{ content: verdict }]);

    const result = await registry.validate("You are support for {{product}}.", {
      judge,
      criteria: "Be concise.",
      // `product` NOT declared/supplied → missing, ok=false, regardless of the judge.
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["product"]);
  });

  it("a criteria judge never flips ok for a placeholder-clean prompt", async () => {
    const registry = prompts();
    const judge = new MockModel("judge", [{ content: JSON.stringify({ score: 0.1, passed: false, reason: "violates rule 2" }) }]);

    const result = await registry.validate("A clean, placeholder-free prompt.", {
      judge,
      criteria: ["Must mention the company name"],
    });

    expect(result.ok).toBe(true); // deterministic verdict stands
    expect(result.score).toBe(0.1);
    expect(result.issues).toContain("violates rule 2");
  });
});
