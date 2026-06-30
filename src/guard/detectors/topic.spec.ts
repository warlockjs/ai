import { describe, expect, it } from "vitest";
import type { GuardrailDetectorContext } from "../contracts";
import { topic } from "./topic";

/** The topic filter ignores its context argument; a minimal stub suffices. */
const ctx = { phase: "input" } as unknown as GuardrailDetectorContext;

describe("topic detector", () => {
  describe("deny list", () => {
    it("blocks on a substring deny hit (case-insensitive)", () => {
      const verdict = topic({ deny: ["medical advice"] }).check(
        "Can you give me MEDICAL ADVICE about this rash?",
        ctx,
      );

      expect(verdict.type).toBe("block");

      if (verdict.type === "block") {
        expect(verdict.matches?.[0].rule).toBe("topic.deny.medical advice");
        expect(verdict.reason).toContain("medical advice");
      }
    });

    it("allows text with no deny hit", () => {
      const verdict = topic({ deny: ["weapons", "explosives"] }).check(
        "Tell me about the history of jazz.",
        ctx,
      );

      expect(verdict.type).toBe("allow");
    });

    it("matches a RegExp deny term and reports its span", () => {
      const text = "the diagnosis is unclear";
      const verdict = topic({ deny: [/diagnos\w+/i] }).check(text, ctx);

      expect(verdict.type).toBe("block");

      if (verdict.type === "block") {
        const match = verdict.matches?.[0];
        expect(match?.rule).toBe("topic.deny.diagnos\\w+");
        const [start, end] = match?.span ?? [0, 0];
        expect(text.slice(start, end + 1)).toBe("diagnosis");
      }
    });

    it("flags instead of blocking when onMatch is flag", () => {
      const verdict = topic({ deny: ["politics"], onMatch: "flag" }).check(
        "Let us discuss politics.",
        ctx,
      );

      expect(verdict.type).toBe("flag");

      if (verdict.type === "flag") {
        expect(verdict.matches[0].label).toBe("politics");
      }
    });

    it("uses a custom reason when provided", () => {
      const verdict = topic({
        deny: ["secret"],
        reason: "Off-policy content.",
      }).check("this is secret", ctx);

      expect(verdict.type).toBe("block");

      if (verdict.type === "block") {
        expect(verdict.reason).toBe("Off-policy content.");
      }
    });
  });

  describe("allow list", () => {
    it("triggers onMatch when the text matches NONE of the allow terms", () => {
      const verdict = topic({ allow: ["billing", "invoice", "refund"] }).check(
        "What is the weather like today?",
        ctx,
      );

      expect(verdict.type).toBe("block");

      if (verdict.type === "block") {
        expect(verdict.matches?.[0].rule).toBe("topic.allow.miss");
        expect(verdict.matches?.[0].label).toBe("allow-miss");
      }
    });

    it("allows text matching at least one allow term", () => {
      const verdict = topic({ allow: ["billing", "invoice"] }).check(
        "I have a question about my invoice.",
        ctx,
      );

      expect(verdict.type).toBe("allow");
    });

    it("matches an allow term given as a RegExp", () => {
      const verdict = topic({ allow: [/refund(s)?/i] }).check(
        "How do I request a Refund?",
        ctx,
      );

      expect(verdict.type).toBe("allow");
    });

    it("flags an allow-list miss when onMatch is flag", () => {
      const verdict = topic({ allow: ["billing"], onMatch: "flag" }).check(
        "tell me a joke",
        ctx,
      );

      expect(verdict.type).toBe("flag");

      if (verdict.type === "flag") {
        expect(verdict.matches[0].rule).toBe("topic.allow.miss");
      }
    });
  });

  describe("deny takes precedence over allow", () => {
    it("blocks on a deny hit even when an allow term is also present", () => {
      const verdict = topic({
        deny: ["weapon"],
        allow: ["billing"],
      }).check("billing question about a weapon purchase", ctx);

      expect(verdict.type).toBe("block");

      if (verdict.type === "block") {
        expect(verdict.matches?.[0].rule).toBe("topic.deny.weapon");
      }
    });
  });

  describe("no-op", () => {
    it("allows everything when neither list is supplied", () => {
      const verdict = topic({}).check("anything at all goes here", ctx);

      expect(verdict.type).toBe("allow");
    });
  });
});
