import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import type { SupervisorConfig } from "../contracts/supervisor/supervisor-config.type";
import type {
  ResolvedAgentEntry,
  ResolvedCallbackEntry,
  ResolvedIntentEntry,
  ResolvedWorkflowEntry,
} from "./entries";
import { computeSignature } from "./signature";

/**
 * Build a minimal `SupervisorConfig` for signature tests. Only the
 * fields the fingerprint reads (`name`, `router`, `route`, `evaluate`,
 * `initialAgent`, `maxIterations`, `classifier`) matter — `intents` is
 * required by the type but irrelevant to `computeSignature` (which
 * reads the resolved `entries` map instead), so a stub satisfies it.
 */
function config(
  partial: Partial<SupervisorConfig<unknown>> & { name: string },
): SupervisorConfig<unknown> {
  return {
    intents: {},
    ...partial,
  } as SupervisorConfig<unknown>;
}

/** A resolved agent intent — the simplest dispatchable entry. */
function agentEntry(
  intent: string,
  unitName: string,
  description = "does things",
): ResolvedAgentEntry {
  return {
    intent,
    type: "agent",
    unit: { name: unitName } as ResolvedAgentEntry["unit"],
    description,
  };
}

/** A resolved workflow intent — fingerprinted by name + signature. */
function workflowEntry(
  intent: string,
  unitName: string,
  unitSignature: string,
  description = "runs a workflow",
): ResolvedWorkflowEntry {
  return {
    intent,
    type: "workflow",
    unit: {
      name: unitName,
      signature: unitSignature,
    } as ResolvedWorkflowEntry["unit"],
    description,
  };
}

/** A resolved callback intent — fingerprinted by the "callback" marker only. */
function callbackEntry(
  intent: string,
  description = "dev code",
): ResolvedCallbackEntry {
  return {
    intent,
    type: "callback",
    callback: () => undefined,
    description,
  };
}

/** Assemble an entries map preserving insertion order of the arguments. */
function entriesOf(
  ...list: ResolvedIntentEntry[]
): Map<string, ResolvedIntentEntry> {
  const map = new Map<string, ResolvedIntentEntry>();
  for (const entry of list) {
    map.set(entry.intent, entry);
  }
  return map;
}

/** A bare agent-shaped object usable as a `router` / `classifier` value. */
function agentLike(name: string): { name: string; execute: () => void } {
  return { name, execute: () => undefined };
}

describe("computeSignature (supervisor)", () => {
  it("produces an 8-char lowercase hex string", () => {
    const sig = computeSignature(
      config({ name: "sup", route: () => END }),
      entriesOf(agentEntry("a", "agentA")),
    );

    expect(sig).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic — identical definitions hash identically", () => {
    const a = computeSignature(
      config({ name: "sup", route: () => END }),
      entriesOf(agentEntry("a", "agentA"), agentEntry("b", "agentB")),
    );
    const b = computeSignature(
      config({ name: "sup", route: () => END }),
      entriesOf(agentEntry("a", "agentA"), agentEntry("b", "agentB")),
    );

    expect(a).toBe(b);
  });

  it("changes when the supervisor name changes", () => {
    const a = computeSignature(
      config({ name: "alpha", route: () => END }),
      entriesOf(agentEntry("a", "agentA")),
    );
    const b = computeSignature(
      config({ name: "beta", route: () => END }),
      entriesOf(agentEntry("a", "agentA")),
    );

    expect(a).not.toBe(b);
  });

  describe("intents", () => {
    it("changes when an intent is added", () => {
      const one = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const two = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA"), agentEntry("b", "agentB")),
      );

      expect(one).not.toBe(two);
    });

    it("changes when an intent key is renamed", () => {
      const a = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("renamed", "agentA")),
      );

      expect(a).not.toBe(b);
    });

    it("is insensitive to intent insertion order (sorted by key)", () => {
      // The fingerprint sorts entries by key before hashing, so the
      // same set of intents hashes identically regardless of the
      // Map's insertion order.
      const ab = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA"), agentEntry("b", "agentB")),
      );
      const ba = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("b", "agentB"), agentEntry("a", "agentA")),
      );

      expect(ab).toBe(ba);
    });

    it("changes when an intent's resolved description changes", () => {
      const a = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA", "original description")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA", "edited description")),
      );

      expect(a).not.toBe(b);
    });

    it("changes when an agent intent's underlying unit name changes", () => {
      const a = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "writer")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "editor")),
      );

      expect(a).not.toBe(b);
    });

    it("distinguishes a workflow intent from an agent intent of the same name", () => {
      const agentType = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("task", "unit")),
      );
      const workflowType = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(workflowEntry("task", "unit", "abc12345")),
      );

      expect(agentType).not.toBe(workflowType);
    });

    it("includes a workflow intent's nested signature in the fingerprint", () => {
      // Two workflows with the same name but different structural
      // signatures must hash differently — drift in a child workflow
      // propagates up to the supervisor signature.
      const a = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(workflowEntry("task", "wf", "11111111")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(workflowEntry("task", "wf", "22222222")),
      );

      expect(a).not.toBe(b);
    });

    it("distinguishes a callback intent from an agent intent", () => {
      const callbackType = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(callbackEntry("task")),
      );
      const agentType = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("task", "unit")),
      );

      expect(callbackType).not.toBe(agentType);
    });

    it("a callback intent's fingerprint ignores its function body (closures are not hashable)", () => {
      // Both callbacks share the "callback" marker — the closure itself
      // can't be hashed deterministically, so swapping the body alone
      // leaves the signature stable. Drift detection covers add / remove
      // / rename of callback intents, not edits to the function body.
      const a = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf({
          intent: "task",
          type: "callback",
          callback: () => ({ first: true }),
          description: "same description",
        }),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf({
          intent: "task",
          type: "callback",
          callback: () => ({ second: true }),
          description: "same description",
        }),
      );

      expect(a).toBe(b);
    });
  });

  describe("dispatch mode", () => {
    it("the presence of a `route` callback is structural (route vs no route)", () => {
      // `rc: config.route ? 1 : 0` — only presence is fingerprinted.
      // A no-route config can only exist with a classifier (the factory
      // requires a dispatch source), so compare route-present against a
      // classifier-only config that has neither route nor router.
      const withRoute = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const withClassifierOnly = computeSignature(
        config({ name: "sup", classifier: agentLike("classify") }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(withRoute).not.toBe(withClassifierOnly);
    });

    it("ignores the `route` callback's BODY — only its presence matters", () => {
      // Two different route callbacks → identical signature. `route` is
      // dev code; the fingerprint records a boolean, never the closure.
      const a = computeSignature(
        config({ name: "sup", route: () => "a" }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(a).toBe(b);
    });

    it("includes the router agent's name (bare-agent router form)", () => {
      const a = computeSignature(
        config({ name: "sup", router: agentLike("routerA") as never }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({ name: "sup", router: agentLike("routerB") as never }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(a).not.toBe(b);
    });

    it("reads the router name from the `{ agent }` entry form", () => {
      // RouterEntry shape: `{ agent }`. resolveRouterName falls through
      // the bare-agent branch (no top-level `execute`) and reads
      // `router.agent.name`.
      const bareForm = computeSignature(
        config({ name: "sup", router: agentLike("router") as never }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const entryForm = computeSignature(
        config({
          name: "sup",
          router: { agent: agentLike("router") } as never,
        }),
        entriesOf(agentEntry("a", "agentA")),
      );

      // Same underlying router name → same fingerprint regardless of
      // whether the bare or entry form was used.
      expect(bareForm).toBe(entryForm);
    });

    it("a router-driven supervisor differs from a route-driven one", () => {
      const routerDriven = computeSignature(
        config({ name: "sup", router: agentLike("router") as never }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const routeDriven = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(routerDriven).not.toBe(routeDriven);
    });
  });

  describe("evaluate", () => {
    it("the presence of an `evaluate` callback is structural", () => {
      const withEvaluate = computeSignature(
        config({
          name: "sup",
          route: () => END,
          evaluate: () => ({ satisfied: true }),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const without = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(withEvaluate).not.toBe(without);
    });

    it("ignores the `evaluate` callback's body — only its presence matters", () => {
      const a = computeSignature(
        config({
          name: "sup",
          route: () => END,
          evaluate: () => ({ satisfied: true }),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({
          name: "sup",
          route: () => END,
          evaluate: () => ({ feedback: "different body entirely" }),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(a).toBe(b);
    });
  });

  describe("initialAgent + maxIterations", () => {
    it("changes when initialAgent is set vs unset", () => {
      const withInitial = computeSignature(
        config({ name: "sup", route: () => END, initialAgent: "a" }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const without = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(withInitial).not.toBe(without);
    });

    it("changes when initialAgent points at a different intent", () => {
      const a = computeSignature(
        config({ name: "sup", route: () => END, initialAgent: "a" }),
        entriesOf(agentEntry("a", "agentA"), agentEntry("b", "agentB")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END, initialAgent: "b" }),
        entriesOf(agentEntry("a", "agentA"), agentEntry("b", "agentB")),
      );

      expect(a).not.toBe(b);
    });

    it("changes when maxIterations changes (a semantic shape change)", () => {
      const six = computeSignature(
        config({ name: "sup", route: () => END, maxIterations: 6 }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const ten = computeSignature(
        config({ name: "sup", route: () => END, maxIterations: 10 }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(six).not.toBe(ten);
    });

    it("treats omitted maxIterations as null — distinct from any explicit value", () => {
      const omitted = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const explicit = computeSignature(
        config({ name: "sup", route: () => END, maxIterations: 10 }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(omitted).not.toBe(explicit);
    });
  });

  describe("classifier (Phase 7 / decisions §37)", () => {
    it("the presence of a classifier is structural", () => {
      const withClassifier = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: agentLike("classify"),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const without = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(withClassifier).not.toBe(without);
    });

    it("includes the classifier agent's name (agent form)", () => {
      const a = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: agentLike("classifyA"),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: agentLike("classifyB"),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(a).not.toBe(b);
    });

    it("reads the classifier name from the `{ agent }` entry form", () => {
      const bareForm = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: agentLike("classify"),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const entryForm = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: { agent: agentLike("classify") },
        }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(bareForm).toBe(entryForm);
    });

    it("distinguishes a callback classifier from an agent classifier", () => {
      const agentForm = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: agentLike("classify"),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const callbackForm = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: () => ({ intent: "a" }),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(agentForm).not.toBe(callbackForm);
    });

    it("the bare-function and `{ run }` classifier forms share the callback marker", () => {
      // Both resolve to `{ t: "callback" }` — bare function and run-entry
      // are indistinguishable to the fingerprint (closures aren't hashable).
      const bareFn = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: () => ({ intent: "a" }),
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const runEntry = computeSignature(
        config({
          name: "sup",
          route: () => END,
          classifier: { run: () => ({ intent: "a" }) },
        }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(bareFn).toBe(runEntry);
    });
  });

  describe("non-structural fields (drift-irrelevant runtime knobs)", () => {
    it("ignores the supervisor's version string", () => {
      const v1 = computeSignature(
        config({ name: "sup", route: () => END, version: "1.0.0" }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const v2 = computeSignature(
        config({ name: "sup", route: () => END, version: "2.0.0" }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(v1).toBe(v2);
    });

    it("ignores the supervisor's own systemPrompt text", () => {
      const a = computeSignature(
        config({
          name: "sup",
          route: () => END,
          systemPrompt: "You coordinate a team.",
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({
          name: "sup",
          route: () => END,
          systemPrompt: "Entirely different prompt copy.",
        }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(a).toBe(b);
    });

    it("ignores the `goal` field (re-resolved on resume, never persisted)", () => {
      const a = computeSignature(
        config({ name: "sup", route: () => END, goal: "ship the thing" }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END, goal: "a totally other goal" }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(a).toBe(b);
    });

    it("ignores factory-level history", () => {
      const a = computeSignature(
        config({
          name: "sup",
          route: () => END,
          history: [{ role: "user", content: "hi" }],
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END, history: [] }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(a).toBe(b);
    });

    it("ignores the historyWindow knobs", () => {
      const a = computeSignature(
        config({
          name: "sup",
          route: () => END,
          historyWindow: { router: 5, agents: 10 },
        }),
        entriesOf(agentEntry("a", "agentA")),
      );
      const b = computeSignature(
        config({ name: "sup", route: () => END }),
        entriesOf(agentEntry("a", "agentA")),
      );

      expect(a).toBe(b);
    });
  });
});
