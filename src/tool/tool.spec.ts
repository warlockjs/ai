import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { ai } from "../ai";
import { SchemaValidationError, ToolExecutionError } from "../errors";
import { tool } from "./tool";

// ---------------------------------------------------------------------------
// Minimal hand-rolled Standard Schema implementations used across tests
// ---------------------------------------------------------------------------

/** A schema that accepts strings and rejects everything else. */
const stringSchema: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value =>
      typeof value === "string"
        ? { value }
        : { issues: [{ message: "expected string" }] },
  },
};

/** A schema whose validate() always throws — tests execute-throw path indirectly. */
const throwingSchema: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => {
      throw new Error("schema exploded");
    },
  },
};

// ---------------------------------------------------------------------------
// Shared contract fixtures
// ---------------------------------------------------------------------------

const echoContract = {
  name: "echo",
  description: "Echoes the input string back",
  meta: { category: "test" },
  input: stringSchema,
  execute: async (input: string) => `echo: ${input}`,
};

const failingContract = {
  name: "failing",
  description: "Always throws during execution",
  input: stringSchema,
  execute: async (_input: string): Promise<string> => {
    throw new Error("execution error");
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool()", () => {
  describe("invoke() with valid input", () => {
    it("returns output and duration with no error", async () => {
      const wrapped = tool(echoContract);

      let result!: Awaited<ReturnType<typeof wrapped.invoke>>;
      try {
        result = await wrapped.invoke("hello");
      } catch {
        expect.fail("invoke() must never throw");
      }

      expect(result.data).toBe("echo: hello");
      expect(result.error).toBeUndefined();
      expect(typeof result.report.duration).toBe("number");
      expect(result.report.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("invoke() with invalid input", () => {
    it("returns error and duration with no output when schema rejects input", async () => {
      const wrapped = tool(echoContract);

      let result!: Awaited<ReturnType<typeof wrapped.invoke>>;
      try {
        result = await wrapped.invoke(42); // number, not string
      } catch {
        expect.fail("invoke() must never throw");
      }

      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(SchemaValidationError);
      expect(result.error?.code).toBe("SCHEMA_VALIDATION_FAILED");
      expect(result.error?.message).toContain("expected string");
      expect(typeof result.report.duration).toBe("number");
      expect(result.report.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("invoke() when execute() throws", () => {
    it("returns error and duration with no output", async () => {
      const wrapped = tool(failingContract);

      let result!: Awaited<ReturnType<typeof wrapped.invoke>>;
      try {
        result = await wrapped.invoke("trigger");
      } catch {
        expect.fail("invoke() must never throw");
      }

      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(ToolExecutionError);
      expect(result.error?.code).toBe("TOOL_EXEC_FAILED");
      expect((result.error as ToolExecutionError).toolName).toBe("failing");
      expect(result.error?.message).toBe("execution error");
      expect(typeof result.report.duration).toBe("number");
      expect(result.report.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("invoke() never throws", () => {
    it("does not throw even when the schema itself throws", async () => {
      const schemaThrowingContract = {
        name: "schemaThrow",
        description: "Has a schema that throws during validate()",
        input: throwingSchema,
        execute: async (v: string) => v,
      };
      const wrapped = tool(schemaThrowingContract);

      let threw = false;
      try {
        await wrapped.invoke("anything");
      } catch {
        threw = true;
      }

      // The schema throws, so invoke must surface that as an error field, not propagate it.
      // If the implementation lets it escape, this test catches it and marks threw=true.
      // We accept either "did not throw" OR "error is captured" — the non-throw contract is
      // what the spec mandates; capturing schema throws is a bonus.
      expect(threw).toBe(false);
    });

    it("does not throw for invalid input", async () => {
      const wrapped = tool(echoContract);
      let threw = false;
      try {
        await wrapped.invoke(null);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });

    it("does not throw when execute() throws", async () => {
      const wrapped = tool(failingContract);
      let threw = false;
      try {
        await wrapped.invoke("x");
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  });

  describe("timestamps", () => {
    it("populates ISO startedAt/endedAt on success", async () => {
      const wrapped = tool(echoContract);
      const result = await wrapped.invoke("hi");

      expect(typeof result.report.startedAt).toBe("string");
      expect(typeof result.report.endedAt).toBe("string");
      expect(Number.isNaN(Date.parse(result.report.startedAt))).toBe(false);
      expect(Date.parse(result.report.endedAt)).toBeGreaterThanOrEqual(
        Date.parse(result.report.startedAt),
      );
    });

    it("populates timestamps on validation failure", async () => {
      const wrapped = tool(echoContract);
      const result = await wrapped.invoke(42);

      expect(typeof result.report.startedAt).toBe("string");
      expect(typeof result.report.endedAt).toBe("string");
      expect(Date.parse(result.report.endedAt)).toBeGreaterThanOrEqual(
        Date.parse(result.report.startedAt),
      );
    });

    it("populates timestamps when execute throws", async () => {
      const wrapped = tool(failingContract);
      const result = await wrapped.invoke("x");

      expect(typeof result.report.startedAt).toBe("string");
      expect(typeof result.report.endedAt).toBe("string");
      expect(Date.parse(result.report.endedAt)).toBeGreaterThanOrEqual(
        Date.parse(result.report.startedAt),
      );
    });
  });

  describe("duration", () => {
    it("is a number >= 0 for successful invocations", async () => {
      const wrapped = tool(echoContract);
      const result = await wrapped.invoke("test");
      expect(typeof result.report.duration).toBe("number");
      expect(result.report.duration).toBeGreaterThanOrEqual(0);
    });

    it("is a number >= 0 for failed validations", async () => {
      const wrapped = tool(echoContract);
      const result = await wrapped.invoke(false);
      expect(typeof result.report.duration).toBe("number");
      expect(result.report.duration).toBeGreaterThanOrEqual(0);
    });

    it("is a number >= 0 when execute() throws", async () => {
      const wrapped = tool(failingContract);
      const result = await wrapped.invoke("x");
      expect(typeof result.report.duration).toBe("number");
      expect(result.report.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("contract field preservation", () => {
    it("preserves name, description, input, execute, and meta unchanged", () => {
      const wrapped = tool(echoContract);

      expect(wrapped.name).toBe(echoContract.name);
      expect(wrapped.description).toBe(echoContract.description);
      expect(wrapped.input).toBe(echoContract.input);
      expect(wrapped.execute).toBe(echoContract.execute);
      expect(wrapped.meta).toEqual(echoContract.meta);
    });

    it("preserves a contract without optional meta field", () => {
      const noMetaContract = {
        name: "noMeta",
        description: "No meta field",
        input: stringSchema,
        execute: async (v: string) => v,
      };
      const wrapped = tool(noMetaContract);
      expect(wrapped.meta).toBeUndefined();
    });
  });

  describe("validation error formatting", () => {
    it("joins multiple validation issues with '; ' under a 'Validation failed:' prefix", async () => {
      const multiIssueSchema: StandardSchemaV1<{ a: string; b: string }> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => ({
            issues: [
              { message: "a is required" },
              { message: "b must be a string" },
              { message: "extra constraint failed" },
            ],
          }),
        },
      };

      const wrapped = tool({
        name: "multi",
        description: "multi-issue tool",
        input: multiIssueSchema,
        execute: async () => "never",
      });

      const result = await wrapped.invoke({});

      expect(result.error?.message).toBe(
        "Validation failed: a is required; b must be a string; extra constraint failed",
      );
      expect(result.error).toBeInstanceOf(SchemaValidationError);
      expect((result.error as SchemaValidationError).issues).toHaveLength(3);
      expect(result.data).toBeUndefined();
    });

    it("formats a single issue without trailing separator", async () => {
      const singleIssueSchema: StandardSchemaV1<string> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => ({ issues: [{ message: "expected string" }] }),
        },
      };

      const wrapped = tool({
        name: "single",
        description: "single-issue tool",
        input: singleIssueSchema,
        execute: async v => v,
      });

      const result = await wrapped.invoke(123);
      expect(result.error?.message).toBe("Validation failed: expected string");
      expect(result.error).toBeInstanceOf(SchemaValidationError);
    });

    it("wraps a schema that throws during validate() as SchemaValidationError with cause", async () => {
      const schemaThrowingContract = {
        name: "schemaThrow",
        description: "schema throws",
        input: throwingSchema,
        execute: async (v: string) => v,
      };
      const wrapped = tool(schemaThrowingContract);

      const result = await wrapped.invoke("anything");

      expect(result.error).toBeInstanceOf(SchemaValidationError);
      expect(result.error?.message).toContain("schema exploded");
      expect(
        (result.error as unknown as { cause: unknown }).cause,
      ).toBeInstanceOf(Error);
    });
  });

  describe("ai.tool", () => {
    it("ai.tool from @warlock.js/ai points to the same factory function", () => {
      expect(ai.tool).toBe(tool);
    });

    it("produces a working wrapped tool via ai.tool", async () => {
      const wrapped = ai.tool(echoContract);
      const result = await wrapped.invoke("via ai namespace");
      expect(result.data).toBe("echo: via ai namespace");
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 3.1 — unified report envelope
  // ---------------------------------------------------------------------------

  describe("unified ExecuteResult shape (Phase 3.1)", () => {
    it("leaf tool synthesizes a BaseReport with type 'tool', empty children, zero usage", async () => {
      const wrapped = tool(echoContract);
      const result = await wrapped.invoke("hi");

      expect(result.report.type).toBe("tool");
      expect(result.report.name).toBe("echo");
      expect(result.report.status).toBe("completed");
      expect(result.report.children).toEqual([]);
      expect(result.report.usage).toEqual({ input: 0, output: 0, total: 0 });
      expect(result.usage).toEqual({ input: 0, output: 0, total: 0 });
      expect(typeof result.report.runId).toBe("string");
      expect(result.report.runId.startsWith("tool_")).toBe(true);
    });

    it("failed leaf tool reports status: 'failed' with timing still populated", async () => {
      const wrapped = tool(failingContract);
      const result = await wrapped.invoke("boom");

      expect(result.report.status).toBe("failed");
      expect(result.report.type).toBe("tool");
      expect(result.report.children).toEqual([]);
      expect(result.report.duration).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeInstanceOf(ToolExecutionError);
    });

    it("schema-rejected input produces a failed report (no execute() called)", async () => {
      const wrapped = tool(echoContract);
      const result = await wrapped.invoke(42);

      expect(result.report.status).toBe("failed");
      expect(result.report.type).toBe("tool");
      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(SchemaValidationError);
    });
  });

  // ---------------------------------------------------------------------------
  // ToolContext threading (Phase 5 / decisions §35)
  // ---------------------------------------------------------------------------

  describe("ToolContext threading", () => {
    it("forwards the supplied ctx to execute() as the second argument", async () => {
      let seenCtx: unknown;
      const wrapped = tool({
        name: "ctxReader",
        description: "captures the ctx it receives",
        input: stringSchema,
        execute: async (_input: string, ctx) => {
          seenCtx = ctx;
          return "ok";
        },
      });

      const ctx = { artifacts: { hits: 1 } };
      const result = await wrapped.invoke("x", ctx);

      expect(result.error).toBeUndefined();
      expect(seenCtx).toBe(ctx);
    });

    it("supplies a degraded { artifacts: {} } ctx when none is threaded through", async () => {
      let seenCtx: { artifacts: Record<string, unknown> } | undefined;
      const wrapped = tool({
        name: "ctxDefault",
        description: "reads the default ctx",
        input: stringSchema,
        execute: async (_input: string, ctx) => {
          seenCtx = ctx as { artifacts: Record<string, unknown> };
          return "ok";
        },
      });

      await wrapped.invoke("x");

      expect(seenCtx).toBeDefined();
      expect(seenCtx?.artifacts).toEqual({});
    });

    it("artifact writes land on the caller-supplied bag (live reference)", async () => {
      const wrapped = tool({
        name: "artifactWriter",
        description: "writes a system-only artifact",
        input: stringSchema,
        execute: async (input: string, ctx) => {
          const bag = ctx!.artifacts as { blocks?: string[] };
          bag.blocks ??= [];
          bag.blocks.push(input);
          return { stored: true };
        },
      });

      const ctx = { artifacts: {} as { blocks?: string[] } };
      await wrapped.invoke("alpha", ctx);
      await wrapped.invoke("beta", ctx);

      // Both invocations accumulate into the same caller-owned bag.
      expect(ctx.artifacts.blocks).toEqual(["alpha", "beta"]);
    });

    it("artifact writes never leak into the returned data channel", async () => {
      const wrapped = tool({
        name: "splitChannels",
        description: "separates artifacts from return value",
        input: stringSchema,
        execute: async (_input: string, ctx) => {
          (ctx!.artifacts as Record<string, unknown>).secret = "hidden";
          return { visible: true };
        },
      });

      const ctx = { artifacts: {} as Record<string, unknown> };
      const result = await wrapped.invoke("x", ctx);

      expect(result.data).toEqual({ visible: true });
      expect(ctx.artifacts.secret).toBe("hidden");
    });
  });
});
