import { describe, expect, it } from "vitest";
import type { RetryConfig } from "../contracts/workflow/retry-config.type";
import {
  DEFAULT_BACKOFF_CAP_MS,
  isAbortError,
  resolveBackoff,
  resolveRetryConfig,
} from "./retry";

describe("resolveBackoff", () => {
  it('"none" is always zero regardless of attempt', () => {
    expect(resolveBackoff(1, "none")).toBe(0);
    expect(resolveBackoff(5, "none")).toBe(0);
  });

  it('"linear" scales by attempt * 500ms', () => {
    expect(resolveBackoff(1, "linear")).toBe(500);
    expect(resolveBackoff(2, "linear")).toBe(1000);
    expect(resolveBackoff(3, "linear")).toBe(1500);
  });

  it('"exponential" doubles from 500ms (500, 1000, 2000, 4000)', () => {
    expect(resolveBackoff(1, "exponential")).toBe(500);
    expect(resolveBackoff(2, "exponential")).toBe(1000);
    expect(resolveBackoff(3, "exponential")).toBe(2000);
    expect(resolveBackoff(4, "exponential")).toBe(4000);
  });

  it("an undefined strategy defaults to exponential", () => {
    expect(resolveBackoff(1, undefined)).toBe(resolveBackoff(1, "exponential"));
    expect(resolveBackoff(3, undefined)).toBe(resolveBackoff(3, "exponential"));
  });

  it("a custom function is invoked with the 1-based attempt", () => {
    const seen: number[] = [];
    const custom = (attempt: number) => {
      seen.push(attempt);
      return attempt * 123;
    };

    expect(resolveBackoff(2, custom)).toBe(246);
    expect(seen).toEqual([2]);
  });

  it("caps any strategy at DEFAULT_BACKOFF_CAP_MS (30s)", () => {
    // Exponential grows past 30s by attempt 8 (500 * 2^7 = 64000).
    expect(resolveBackoff(8, "exponential")).toBe(DEFAULT_BACKOFF_CAP_MS);
    // Linear past the cap (attempt 100 * 500 = 50000).
    expect(resolveBackoff(100, "linear")).toBe(DEFAULT_BACKOFF_CAP_MS);
    // A custom function that returns an absurd value is also clamped.
    expect(resolveBackoff(1, () => 9_999_999)).toBe(DEFAULT_BACKOFF_CAP_MS);
  });

  it("floors a negative custom value at zero", () => {
    expect(resolveBackoff(1, () => -500)).toBe(0);
  });
});

describe("resolveRetryConfig", () => {
  it("`retry: false` on the step disables retries (attempts: 1)", () => {
    expect(resolveRetryConfig({ retry: false }, undefined)).toEqual({
      attempts: 1,
    });
  });

  it("`retry: false` on the step wins even when a workflow default exists", () => {
    const workflowDefault: RetryConfig = { attempts: 5, backoff: "linear" };

    expect(resolveRetryConfig({ retry: false }, workflowDefault)).toEqual({
      attempts: 1,
    });
  });

  it("a step-level config takes precedence over the workflow default", () => {
    const stepRetry: RetryConfig = { attempts: 3, backoff: "exponential" };
    const workflowDefault: RetryConfig = { attempts: 10 };

    expect(resolveRetryConfig({ retry: stepRetry }, workflowDefault)).toBe(
      stepRetry,
    );
  });

  it("falls back to the workflow default when the step has no retry", () => {
    const workflowDefault: RetryConfig = { attempts: 4, backoff: "none" };

    expect(resolveRetryConfig({}, workflowDefault)).toBe(workflowDefault);
    expect(resolveRetryConfig(undefined, workflowDefault)).toBe(workflowDefault);
  });

  it("defaults to a single attempt when neither step nor workflow configures retry", () => {
    expect(resolveRetryConfig(undefined, undefined)).toEqual({ attempts: 1 });
    expect(resolveRetryConfig({}, undefined)).toEqual({ attempts: 1 });
  });

  it("treats a workflow default of `false` like no default", () => {
    expect(resolveRetryConfig({}, false)).toEqual({ attempts: 1 });
  });
});

describe("isAbortError", () => {
  it("is true for an error whose name is AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";

    expect(isAbortError(err)).toBe(true);
  });

  it("is false for an ordinary error", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
  });

  it("is false for non-object inputs", () => {
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });

  it("recognizes a plain object carrying name: AbortError", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });
});
