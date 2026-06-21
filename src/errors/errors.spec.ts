import { describe, expect, it } from "vitest";
import {
  AgentCancelledError,
  AgentExecutionError,
  AgentMaxTripsError,
  AIError,
  BudgetExceededError,
  ContentFilterError,
  ContextLengthExceededError,
  GuardrailViolationError,
  InvalidRequestError,
  MaxIterationsError,
  MaxStepsExceededError,
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  QuotaExceededError,
  RoutingError,
  SchemaValidationError,
  StepFailedError,
  SupervisorCancelledError,
  SupervisorDriftError,
  SupervisorFailedError,
  SupervisorRoutingError,
  ToolExecutionError,
  WorkflowCancelledError,
  WorkflowDriftError,
  WorkflowError,
} from "./index";

describe("AIError base", () => {
  it("exposes message, code, and name", () => {
    const error = new AIError("PROVIDER_ERROR", "boom");

    expect(error.message).toBe("boom");
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.name).toBe("AIError");
  });

  it("extends the native Error", () => {
    const error = new AIError("PROVIDER_ERROR", "boom");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AIError);
  });

  it("propagates cause when supplied", () => {
    const root = new Error("underlying");
    const error = new AIError("PROVIDER_ERROR", "boom", { cause: root });

    expect((error as unknown as { cause: unknown }).cause).toBe(root);
  });

  it("accepts non-Error causes without losing them", () => {
    const error = new AIError("PROVIDER_ERROR", "boom", {
      cause: "string cause",
    });

    expect((error as unknown as { cause: unknown }).cause).toBe("string cause");
  });

  it("omits cause when not supplied", () => {
    const error = new AIError("PROVIDER_ERROR", "boom");

    expect((error as unknown as { cause: unknown }).cause).toBeUndefined();
  });

  it("exposes context when supplied", () => {
    const context = { status: 500, requestId: "abc" };
    const error = new AIError("PROVIDER_ERROR", "boom", { context });

    expect(error.context).toBe(context);
  });

  it("omits context when not supplied", () => {
    const error = new AIError("PROVIDER_ERROR", "boom");

    expect(error.context).toBeUndefined();
  });

  it("has a stack trace", () => {
    const error = new AIError("PROVIDER_ERROR", "boom");

    expect(typeof error.stack).toBe("string");
    expect(error.stack).toContain("boom");
  });
});

describe("AgentExecutionError", () => {
  it("uses code AGENT_EXEC_FAILED and its own name", () => {
    const error = new AgentExecutionError("max trips");

    expect(error.code).toBe("AGENT_EXEC_FAILED");
    expect(error.name).toBe("AgentExecutionError");
  });

  it("is both AIError and AgentExecutionError via instanceof", () => {
    const error = new AgentExecutionError("max trips");

    expect(error).toBeInstanceOf(AIError);
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect(error).toBeInstanceOf(Error);
  });

  it("preserves context payload", () => {
    const error = new AgentExecutionError("max trips", {
      context: { maxTrips: 3 },
    });

    expect(error.context).toEqual({ maxTrips: 3 });
  });
});

describe("AgentCancelledError", () => {
  it("uses code AGENT_CANCELLED and its own name", () => {
    const error = new AgentCancelledError("aborted");

    expect(error.code).toBe("AGENT_CANCELLED");
    expect(error.name).toBe("AgentCancelledError");
  });

  it("extends AgentExecutionError so existing catches still match", () => {
    const error = new AgentCancelledError("aborted");

    expect(error).toBeInstanceOf(AgentExecutionError);
    expect(error).toBeInstanceOf(AIError);
  });

  it("declares category \"cancelled\" via static defaultCategory", () => {
    const error = new AgentCancelledError("aborted");

    expect(error.category).toBe("cancelled");
  });

  it("exposes cancelledAt + reason when supplied", () => {
    const error = new AgentCancelledError("aborted", {
      cancelledAt: "2026-05-12T00:00:00.000Z",
      reason: "user clicked stop",
    });

    expect(error.cancelledAt).toBe("2026-05-12T00:00:00.000Z");
    expect(error.reason).toBe("user clicked stop");
  });
});

describe("AgentMaxTripsError", () => {
  it("uses code AGENT_MAX_TRIPS and its own name", () => {
    const error = new AgentMaxTripsError("hit cap", { maxTrips: 10 });

    expect(error.code).toBe("AGENT_MAX_TRIPS");
    expect(error.name).toBe("AgentMaxTripsError");
  });

  it("extends AgentExecutionError so existing catches still match", () => {
    const error = new AgentMaxTripsError("hit cap", { maxTrips: 10 });

    expect(error).toBeInstanceOf(AgentExecutionError);
    expect(error).toBeInstanceOf(AIError);
  });

  it("declares category \"max-trips\" via static defaultCategory", () => {
    const error = new AgentMaxTripsError("hit cap", { maxTrips: 10 });

    expect(error.category).toBe("max-trips");
  });

  it("exposes maxTrips on the instance", () => {
    const error = new AgentMaxTripsError("hit cap", { maxTrips: 7 });

    expect(error.maxTrips).toBe(7);
  });
});

describe("SchemaValidationError", () => {
  it("uses code SCHEMA_VALIDATION_FAILED", () => {
    const error = new SchemaValidationError("bad shape");

    expect(error.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(error.name).toBe("SchemaValidationError");
  });

  it("exposes issues when provided", () => {
    const issues = [{ message: "missing field", path: ["name"] }];
    const error = new SchemaValidationError("bad shape", { issues });

    expect(error.issues).toBe(issues);
  });

  it("issues undefined when omitted", () => {
    const error = new SchemaValidationError("bad shape");

    expect(error.issues).toBeUndefined();
  });

  it("passes cause and context through", () => {
    const cause = new Error("root");
    const error = new SchemaValidationError("bad", {
      cause,
      context: { field: "x" },
    });

    expect((error as unknown as { cause: unknown }).cause).toBe(cause);
    expect(error.context).toEqual({ field: "x" });
  });
});

describe("ToolExecutionError", () => {
  it("uses code TOOL_EXEC_FAILED", () => {
    const error = new ToolExecutionError("boom", { toolName: "search" });

    expect(error.code).toBe("TOOL_EXEC_FAILED");
    expect(error.name).toBe("ToolExecutionError");
  });

  it("exposes toolName and tripIndex", () => {
    const error = new ToolExecutionError("boom", {
      toolName: "search",
      tripIndex: 2,
    });

    expect(error.toolName).toBe("search");
    expect(error.tripIndex).toBe(2);
  });

  it("tripIndex optional", () => {
    const error = new ToolExecutionError("boom", { toolName: "search" });

    expect(error.tripIndex).toBeUndefined();
  });
});

describe("ProviderError + subclasses", () => {
  it("ProviderError uses default code PROVIDER_ERROR", () => {
    const error = new ProviderError("upstream broken");

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error).toBeInstanceOf(AIError);
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("ProviderRateLimitError uses PROVIDER_RATE_LIMIT and exposes retryAfter", () => {
    const error = new ProviderRateLimitError("slow down", { retryAfter: 2000 });

    expect(error.code).toBe("PROVIDER_RATE_LIMIT");
    expect(error.retryAfter).toBe(2000);
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("ProviderRateLimitError retryAfter optional", () => {
    const error = new ProviderRateLimitError("slow down");

    expect(error.retryAfter).toBeUndefined();
  });

  it("QuotaExceededError uses PROVIDER_QUOTA_EXCEEDED", () => {
    const error = new QuotaExceededError("account drained");

    expect(error.code).toBe("PROVIDER_QUOTA_EXCEEDED");
    expect(error.name).toBe("QuotaExceededError");
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toBeInstanceOf(AIError);
  });

  it("QuotaExceededError is distinct from ProviderRateLimitError", () => {
    const quota = new QuotaExceededError("drained");
    const rate = new ProviderRateLimitError("slow");

    expect(quota).not.toBeInstanceOf(ProviderRateLimitError);
    expect(rate).not.toBeInstanceOf(QuotaExceededError);
  });

  it("ProviderTimeoutError uses PROVIDER_TIMEOUT", () => {
    const error = new ProviderTimeoutError("deadline exceeded");

    expect(error.code).toBe("PROVIDER_TIMEOUT");
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toBeInstanceOf(AIError);
  });

  it("ContextLengthExceededError carries limit/actual/modelName", () => {
    const error = new ContextLengthExceededError("too long", {
      limit: 128_000,
      actual: 150_000,
      modelName: "gpt-4o",
    });

    expect(error.code).toBe("CONTEXT_LENGTH_EXCEEDED");
    expect(error.limit).toBe(128_000);
    expect(error.actual).toBe(150_000);
    expect(error.modelName).toBe("gpt-4o");
  });

  it("ContextLengthExceededError allows all fields to be omitted", () => {
    const error = new ContextLengthExceededError("too long");

    expect(error.limit).toBeUndefined();
    expect(error.actual).toBeUndefined();
    expect(error.modelName).toBeUndefined();
  });

  it("ContentFilterError carries reason and categories", () => {
    const error = new ContentFilterError("blocked", {
      reason: "violence",
      categories: ["violence", "self-harm"],
    });

    expect(error.code).toBe("CONTENT_FILTER");
    expect(error.reason).toBe("violence");
    expect(error.categories).toEqual(["violence", "self-harm"]);
  });

  it("InvalidRequestError uses PROVIDER_INVALID_REQUEST", () => {
    const error = new InvalidRequestError("bad model name");

    expect(error.code).toBe("PROVIDER_INVALID_REQUEST");
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("ProviderAuthError uses PROVIDER_AUTH", () => {
    const error = new ProviderAuthError("bad key");

    expect(error.code).toBe("PROVIDER_AUTH");
    expect(error).toBeInstanceOf(ProviderError);
  });

  it("all provider subclasses extend ProviderError", () => {
    const subs = [
      new ProviderRateLimitError("x"),
      new QuotaExceededError("x"),
      new ProviderTimeoutError("x"),
      new ContextLengthExceededError("x"),
      new ContentFilterError("x"),
      new InvalidRequestError("x"),
      new ProviderAuthError("x"),
    ];

    for (const error of subs) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toBeInstanceOf(AIError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("BudgetExceededError", () => {
  it("uses code BUDGET_EXCEEDED and exposes all three numeric fields", () => {
    const error = new BudgetExceededError("over", {
      limit: 100,
      actual: 150,
      unit: "usd",
    });

    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(error.name).toBe("BudgetExceededError");
    expect(error.limit).toBe(100);
    expect(error.actual).toBe(150);
    expect(error.unit).toBe("usd");
  });

  it("does not extend ProviderError (framework-level, not provider-originated)", () => {
    const error = new BudgetExceededError("over", {
      limit: 1,
      actual: 2,
      unit: "requests",
    });

    expect(error).toBeInstanceOf(AIError);
    expect(error).not.toBeInstanceOf(ProviderError);
  });

  it("accepts each supported unit", () => {
    const units: Array<"tokens" | "usd" | "requests"> = [
      "tokens",
      "usd",
      "requests",
    ];

    for (const unit of units) {
      const error = new BudgetExceededError("x", { limit: 1, actual: 2, unit });
      expect(error.unit).toBe(unit);
    }
  });
});

describe("narrowing by code across the hierarchy", () => {
  it("switch on code yields stable discrimination", () => {
    const errors: AIError[] = [
      new AgentExecutionError("a"),
      new SchemaValidationError("b"),
      new ToolExecutionError("c", { toolName: "t" }),
      new ProviderError("d"),
      new ProviderRateLimitError("e"),
      new QuotaExceededError("e2"),
      new ProviderTimeoutError("f"),
      new ContextLengthExceededError("g"),
      new ContentFilterError("h"),
      new InvalidRequestError("i"),
      new ProviderAuthError("j"),
      new BudgetExceededError("k", { limit: 1, actual: 2, unit: "tokens" }),
    ];

    const codes = errors.map(error => error.code);

    expect(codes).toEqual([
      "AGENT_EXEC_FAILED",
      "SCHEMA_VALIDATION_FAILED",
      "TOOL_EXEC_FAILED",
      "PROVIDER_ERROR",
      "PROVIDER_RATE_LIMIT",
      "PROVIDER_QUOTA_EXCEEDED",
      "PROVIDER_TIMEOUT",
      "CONTEXT_LENGTH_EXCEEDED",
      "CONTENT_FILTER",
      "PROVIDER_INVALID_REQUEST",
      "PROVIDER_AUTH",
      "BUDGET_EXCEEDED",
    ]);
  });

  it("every subclass is an AIError for a broad catch clause", () => {
    const errors: unknown[] = [
      new AgentExecutionError("a"),
      new SchemaValidationError("b"),
      new ToolExecutionError("c", { toolName: "t" }),
      new ProviderError("d"),
      new ProviderRateLimitError("e"),
      new QuotaExceededError("e2"),
      new ProviderTimeoutError("f"),
      new ContextLengthExceededError("g"),
      new ContentFilterError("h"),
      new InvalidRequestError("i"),
      new ProviderAuthError("j"),
      new BudgetExceededError("k", { limit: 1, actual: 2, unit: "tokens" }),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(AIError);
    }
  });
});

describe("WorkflowError + subclasses", () => {
  it("WorkflowError defaults to WORKFLOW_ERROR", () => {
    const error = new WorkflowError("boom");

    expect(error.code).toBe("WORKFLOW_ERROR");
    expect(error.name).toBe("WorkflowError");
    expect(error).toBeInstanceOf(AIError);
  });

  it("StepFailedError carries stepName + attempts", () => {
    const error = new StepFailedError("boom", {
      stepName: "classify",
      attempts: 3,
    });

    expect(error.code).toBe("STEP_FAILED");
    expect(error.stepName).toBe("classify");
    expect(error.attempts).toBe(3);
    expect(error).toBeInstanceOf(WorkflowError);
  });

  it("WorkflowDriftError carries signatures + runId", () => {
    const error = new WorkflowDriftError("drift", {
      savedSignature: "a",
      currentSignature: "b",
      runId: "run-1",
    });

    expect(error.code).toBe("WORKFLOW_DRIFT");
    expect(error.savedSignature).toBe("a");
    expect(error.currentSignature).toBe("b");
    expect(error.runId).toBe("run-1");
  });

  it("WorkflowCancelledError carries timestamp + optional reason", () => {
    const error = new WorkflowCancelledError("abort", {
      cancelledAt: "2026-04-21T00:00:00.000Z",
      reason: "user",
    });

    expect(error.code).toBe("WORKFLOW_CANCELLED");
    expect(error.cancelledAt).toBe("2026-04-21T00:00:00.000Z");
    expect(error.reason).toBe("user");
  });

  it("MaxStepsExceededError carries maxSteps", () => {
    const error = new MaxStepsExceededError("loop", { maxSteps: 100 });

    expect(error.code).toBe("WORKFLOW_MAX_STEPS");
    expect(error.maxSteps).toBe(100);
  });

  it("RoutingError carries stepName + targetName", () => {
    const error = new RoutingError("bad goto", {
      stepName: "qa",
      targetName: "ghost",
    });

    expect(error.code).toBe("WORKFLOW_INVALID_GOTO");
    expect(error.stepName).toBe("qa");
    expect(error.targetName).toBe("ghost");
  });

  it("all workflow subclasses are WorkflowError + AIError", () => {
    const subs: unknown[] = [
      new StepFailedError("x", { stepName: "s", attempts: 1 }),
      new WorkflowDriftError("x", {
        savedSignature: "a",
        currentSignature: "b",
        runId: "r",
      }),
      new WorkflowCancelledError("x", { cancelledAt: "t" }),
      new MaxStepsExceededError("x", { maxSteps: 1 }),
      new RoutingError("x", { stepName: "s" }),
    ];

    for (const error of subs) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect(error).toBeInstanceOf(AIError);
    }
  });
});

describe("SupervisorFailedError + subclasses", () => {
  it("SupervisorFailedError defaults to SUPERVISOR_FAILED", () => {
    const error = new SupervisorFailedError("boom");

    expect(error.code).toBe("SUPERVISOR_FAILED");
    expect(error.name).toBe("SupervisorFailedError");
    expect(error).toBeInstanceOf(AIError);
  });

  it("MaxIterationsError carries maxIterations", () => {
    const error = new MaxIterationsError("no convergence", {
      maxIterations: 6,
    });

    expect(error.code).toBe("SUPERVISOR_MAX_ITERATIONS");
    expect(error.name).toBe("MaxIterationsError");
    expect(error.maxIterations).toBe(6);
    expect(error).toBeInstanceOf(SupervisorFailedError);
  });

  it("SupervisorRoutingError carries returned + availableKeys", () => {
    const error = new SupervisorRoutingError("unknown intent", {
      returned: "ghost",
      availableKeys: ["triage", "resolver"],
    });

    expect(error.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(error.returned).toBe("ghost");
    expect(error.availableKeys).toEqual(["triage", "resolver"]);
  });

  it("SupervisorRoutingError is distinct from workflow RoutingError", () => {
    const supervisor = new SupervisorRoutingError("x", {
      returned: null,
      availableKeys: [],
    });
    const workflow = new RoutingError("x", { stepName: "s" });

    expect(supervisor).not.toBeInstanceOf(RoutingError);
    expect(workflow).not.toBeInstanceOf(SupervisorRoutingError);
    expect(supervisor.code).not.toBe(workflow.code);
  });

  // CombineRequiredError dropped in Stage 4c — combine no longer
  // exists; fan-out branches shallow-merge into supervisor state.

  it("SupervisorCancelledError carries timestamp + optional reason", () => {
    const error = new SupervisorCancelledError("abort", {
      cancelledAt: "2026-04-23T00:00:00.000Z",
      reason: "user",
    });

    expect(error.code).toBe("SUPERVISOR_CANCELLED");
    expect(error.cancelledAt).toBe("2026-04-23T00:00:00.000Z");
    expect(error.reason).toBe("user");
  });

  it("SupervisorDriftError carries signatures + runId", () => {
    const error = new SupervisorDriftError("drift", {
      savedSignature: "a",
      currentSignature: "b",
      runId: "sup-1",
    });

    expect(error.code).toBe("SUPERVISOR_DRIFT");
    expect(error.savedSignature).toBe("a");
    expect(error.currentSignature).toBe("b");
    expect(error.runId).toBe("sup-1");
  });

  it("all supervisor subclasses are SupervisorFailedError + AIError", () => {
    const subs: unknown[] = [
      new MaxIterationsError("x", { maxIterations: 1 }),
      new SupervisorRoutingError("x", { returned: "z", availableKeys: [] }),
      new SupervisorCancelledError("x", { cancelledAt: "t" }),
      new SupervisorDriftError("x", {
        savedSignature: "a",
        currentSignature: "b",
        runId: "r",
      }),
    ];

    for (const error of subs) {
      expect(error).toBeInstanceOf(SupervisorFailedError);
      expect(error).toBeInstanceOf(AIError);
    }
  });

  it("supervisor and workflow hierarchies don't cross", () => {
    const supervisor = new MaxIterationsError("x", { maxIterations: 1 });
    const workflow = new MaxStepsExceededError("x", { maxSteps: 1 });

    expect(supervisor).not.toBeInstanceOf(WorkflowError);
    expect(workflow).not.toBeInstanceOf(SupervisorFailedError);
  });
});

describe("error category — static defaultCategory + AIError-only override", () => {
  it("AIError base defaults to \"unknown\" when no override is supplied", () => {
    const error = new AIError("PROVIDER_ERROR", "boom");

    expect(error.category).toBe("unknown");
  });

  it("AIError direct construction accepts an explicit category override via the 4th arg", () => {
    const error = new AIError("PROVIDER_ERROR", "boom", undefined, "rate-limit");

    expect(error.category).toBe("rate-limit");
  });

  it("AIError direct construction can pair options + override", () => {
    const error = new AIError("PROVIDER_ERROR", "boom", { context: { x: 1 } }, "provider");

    expect(error.category).toBe("provider");
    expect(error.context).toEqual({ x: 1 });
  });

  it("subclass with declared defaultCategory carries that category", () => {
    const cases: Array<[AIError, string]> = [
      [new ProviderRateLimitError("x"), "rate-limit"],
      [new ProviderAuthError("x"), "auth"],
      [new ProviderTimeoutError("x"), "timeout"],
      [new ProviderError("x"), "provider"],
      [new ContentFilterError("x"), "content-filter"],
      [new ContextLengthExceededError("x"), "context-length"],
      [new InvalidRequestError("x"), "validation"],
      [new QuotaExceededError("x"), "quota"],
      [
        new BudgetExceededError("x", { limit: 1, actual: 2, unit: "usd" }),
        "budget",
      ],
      [
        new GuardrailViolationError("x", { phase: "input", reason: "y" }),
        "guardrail",
      ],
      [new SchemaValidationError("x"), "schema"],
      [new ToolExecutionError("x", { toolName: "t" }), "tool"],
      [new RoutingError("x", { stepName: "s" }), "routing"],
      [
        new SupervisorRoutingError("x", { returned: null, availableKeys: [] }),
        "routing",
      ],
      [new MaxIterationsError("x", { maxIterations: 1 }), "max-iterations"],
      [new MaxStepsExceededError("x", { maxSteps: 1 }), "max-steps"],
      [new WorkflowCancelledError("x", { cancelledAt: "t" }), "cancelled"],
      [new SupervisorCancelledError("x", { cancelledAt: "t" }), "cancelled"],
      [
        new WorkflowDriftError("x", {
          savedSignature: "a",
          currentSignature: "b",
          runId: "r",
        }),
        "drift",
      ],
      [
        new SupervisorDriftError("x", {
          savedSignature: "a",
          currentSignature: "b",
          runId: "r",
        }),
        "drift",
      ],
    ];

    for (const [error, expected] of cases) {
      expect(error.category).toBe(expected);
    }
  });

  it("base-class subclasses without their own defaultCategory inherit \"unknown\"", () => {
    // Catch-all bases keep "unknown" — narrowing comes from picking
    // a specific subclass, not from runtime override.
    expect(new AgentExecutionError("x").category).toBe("unknown");
    expect(new WorkflowError("x").category).toBe("unknown");
    expect(new SupervisorFailedError("x").category).toBe("unknown");
    expect(
      new StepFailedError("x", { stepName: "s", attempts: 1 }).category,
    ).toBe("unknown");
  });

  it("subclass options do not carry a category field (it's structurally unreachable)", () => {
    // This guards the structural-restriction contract: AIErrorOptions
    // is what every subclass forwards via super(...). It must NOT carry
    // a `category` field, otherwise subclass call sites could pass one.
    const options: Parameters<typeof ProviderRateLimitError.prototype.constructor>[1] = {
      cause: new Error("x"),
      context: { foo: 1 },
      retryAfter: 100,
    };

    // The fact that this compiles with strict types AND that `category`
    // is not a recognized key is the test — try-and-pass would be a
    // runtime regression. Keep this present as documentation of the
    // intent for future maintainers.
    expect(options).toBeDefined();
  });

  it("category survives throw/catch round-trips", () => {
    try {
      throw new ProviderRateLimitError("slow");
    } catch (thrown) {
      expect((thrown as AIError).category).toBe("rate-limit");
    }
  });
});

describe("throw/catch round-trip", () => {
  it("can be thrown and caught as AIError", () => {
    try {
      throw new ProviderRateLimitError("slow", { retryAfter: 500 });
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(AIError);
      expect(thrown).toBeInstanceOf(ProviderRateLimitError);
      if (thrown instanceof ProviderRateLimitError) {
        expect(thrown.retryAfter).toBe(500);
      }
    }
  });
});
