import type { SupervisorEventMap } from "../contracts/events/event-map.type";
import type { SupervisorResult } from "../contracts/result/supervisor-result.type";
import type { StreamContract } from "../contracts/stream/stream.contract";
import type { SupervisorIntentValue } from "../contracts/supervisor/intent-entry.type";
import type {
  SupervisorConfig,
  SupervisorEventHandler,
} from "../contracts/supervisor/supervisor-config.type";
import type {
  SupervisorExecuteOptions,
  SupervisorResumeOptions,
} from "../contracts/supervisor/supervisor-execute-options.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import type { SupervisorStreamEvent } from "../contracts/supervisor/supervisor-stream-event.type";
import type {
  SupervisorAsToolOptions,
  SupervisorContract,
} from "../contracts/supervisor/supervisor.contract";
import { SupervisorFailedError } from "../errors";
import type { ToolContract } from "../tool/tool";
import { asTool } from "./as-tool";
import { SupervisorEmitter } from "./emitter";
import { assertRouterDescriptions, resolveIntentEntries } from "./entries";
import { SupervisorExecution } from "./execution";
import { computeSignature } from "./signature";
import { loadSnapshotForResume } from "./snapshot";
import { createSupervisorStream } from "./supervisor-stream";

/**
 * `ai.supervisor(config)` — construct a `SupervisorContract`. Validates
 * the config at author time (throws `SupervisorFailedError` on bad
 * shape), resolves agent entries, computes a stable structural
 * signature, wires the three-tier event emitter, and returns an
 * instance that satisfies `ExecutableContract` so it can compose into
 * tools, outer agents, and (future) orchestrators uniformly.
 *
 * @example
 * const support = ai.supervisor({
 *   name: "customer-support",
 *   router: routerAgent,
 *   intents: { triage, orderLookup, billingLookup, resolver },
 *   evaluate: (ctx) => ctx.result.resolver?.output ? { satisfied: true } : undefined,
 *   output: z.object({ response: z.string(), refund: z.boolean() }),
 *   maxIterations: 6,
 * });
 */
export function supervisor<
  TOutput = unknown,
  TState = TOutput,
  TIntents extends Record<string, SupervisorIntentValue> = Record<string, SupervisorIntentValue>,
  TArtifacts = Record<string, unknown>,
>(config: SupervisorConfig<TOutput, TState, TIntents, TArtifacts>): SupervisorContract<TOutput> {
  validateFactoryConfig(config as unknown as SupervisorConfig<TOutput>);

  const entries = resolveIntentEntries(config.intents, config.name);

  assertRouterDescriptions(config as SupervisorConfig<unknown>, entries);

  if (config.initialAgent && !entries.has(config.initialAgent)) {
    throw new SupervisorFailedError(
      `ai.supervisor("${config.name}"): \`initialAgent\` "${config.initialAgent}" is not a key in \`intents\``,
      { context: { authoring: true } },
    );
  }

  const signature = computeSignature(config as SupervisorConfig<unknown>, entries);
  const emitter = new SupervisorEmitter(config.on);

  async function execute(
    input: SupervisorInput,
    options?: SupervisorExecuteOptions,
  ): Promise<SupervisorResult<TOutput>> {
    const runId = options?.runId ?? generateRunId();

    const execution = new SupervisorExecution<TOutput>({
      config: config as unknown as SupervisorConfig<TOutput>,
      entries,
      signature,
      emitter,
      input,
      runId,
      options,
    });

    return execution.run();
  }

  function stream(
    input: SupervisorInput,
    options?: SupervisorExecuteOptions,
  ): StreamContract<SupervisorResult<TOutput>, SupervisorStreamEvent> {
    const runId = options?.runId ?? generateRunId();
    const { controller, stream: contract } = createSupervisorStream<SupervisorResult<TOutput>>();

    const execution = new SupervisorExecution<TOutput>({
      config: config as unknown as SupervisorConfig<TOutput>,
      entries,
      signature,
      emitter,
      input,
      runId,
      options,
      streamController: controller,
    });

    void execution.run();

    return contract;
  }

  async function resume(
    runId: string,
    options?: SupervisorResumeOptions,
  ): Promise<SupervisorResult<TOutput>> {
    const snapshot = await loadSnapshotForResume({
      config: config as SupervisorConfig<unknown>,
      signature,
      runId,
      options,
    });

    const execution = new SupervisorExecution<TOutput>({
      config: config as unknown as SupervisorConfig<TOutput>,
      entries,
      signature,
      emitter,
      input: snapshot.input,
      runId,
      options,
      resumeFrom: snapshot,
    });

    return execution.run();
  }

  const instance: SupervisorContract<TOutput> = {
    name: config.name,
    inputSchema: config.inputSchema,
    signature,
    execute,
    stream,
    resume,
    on<K extends keyof SupervisorEventMap>(
      event: K,
      handler: SupervisorEventHandler<K>,
    ): () => void {
      return emitter.on(event, handler);
    },
    off<K extends keyof SupervisorEventMap>(event: K, handler: SupervisorEventHandler<K>): void {
      emitter.off(event, handler);
    },
    asTool<TToolInput = string>(
      options: SupervisorAsToolOptions<TToolInput>,
    ): ToolContract<TToolInput, TOutput> {
      return asTool<TOutput, TToolInput>(instance, options);
    },
  };

  return instance;
}

/**
 * Factory-time validation. Enforces the XOR + pairing rules the design
 * locked in §2 and surfaces any violation as a typed
 * `SupervisorFailedError` tagged `authoring: true`.
 */
function validateFactoryConfig<T>(config: SupervisorConfig<T>): void {
  if (!config.name || typeof config.name !== "string") {
    throw new SupervisorFailedError("ai.supervisor: `name` is required and must be a string", {
      context: { authoring: true },
    });
  }

  if (!config.intents || typeof config.intents !== "object") {
    throw new SupervisorFailedError(`ai.supervisor("${config.name}"): \`intents\` is required`, {
      context: { authoring: true },
    });
  }

  const hasRoute = typeof config.route === "function";
  const hasRouter = !!config.router;

  if (hasRouter) {
    const router = config.router as { execute?: unknown } | { agent?: { execute?: unknown } };
    const isBareAgent = typeof (router as { execute?: unknown }).execute === "function";
    const isEntryForm =
      !isBareAgent &&
      typeof (router as { agent?: { execute?: unknown } }).agent === "object" &&
      typeof (router as { agent?: { execute?: unknown } }).agent?.execute === "function";

    if (!isBareAgent && !isEntryForm) {
      throw new SupervisorFailedError(
        `ai.supervisor("${config.name}"): \`router\` must be an agent contract or a \`{ agent, placeholders?, input? }\` entry`,
        { context: { authoring: true } },
      );
    }
  }

  if (hasRoute && hasRouter) {
    throw new SupervisorFailedError(
      `ai.supervisor("${config.name}"): \`route\` and \`router\` are mutually exclusive — configure exactly one`,
      { context: { authoring: true } },
    );
  }

  // Phase 7 / decisions §37 — `classifier` is the iter-0 prelude;
  // satisfies the "must have a dispatch source" rule on its own.
  // Composes with router/route (classifier drives iter 0; router/route
  // takes iter 1+). When configured alone, supervisor terminates after
  // iter 0's branch settles.
  const hasClassifier = config.classifier !== undefined;

  if (!hasRoute && !hasRouter && !hasClassifier) {
    throw new SupervisorFailedError(
      `ai.supervisor("${config.name}"): one of \`route\`, \`router\`, or \`classifier\` is required`,
      { context: { authoring: true } },
    );
  }

  // Phase 7 — classifier and initialAgent both decide what runs first.
  // Coexistence is meaningless; throw loudly.
  if (hasClassifier && config.initialAgent) {
    throw new SupervisorFailedError(
      `ai.supervisor("${config.name}"): \`classifier\` and \`initialAgent\` are mutually exclusive — both decide which intent runs first. Pick one.`,
      { context: { authoring: true } },
    );
  }

  // Phase 3.4 (Q9) — evaluate now pairs with both `route` and
  // `router`. State-driven termination is useful in either dispatch
  // mode; the historical router-only restriction was incidental,
  // not principled.

  if (config.ack !== undefined) {
    const ack = config.ack;
    const isCallback = typeof ack === "function";
    const isAgentEntry =
      typeof ack === "object" &&
      ack !== null &&
      typeof (ack as { agent?: { execute?: unknown } }).agent?.execute === "function";
    const isRunEntry =
      typeof ack === "object" &&
      ack !== null &&
      typeof (ack as { run?: unknown }).run === "function";

    if (!isCallback && !isAgentEntry && !isRunEntry) {
      throw new SupervisorFailedError(
        `ai.supervisor("${config.name}"): \`ack\` must be an \`{ agent, ... }\` entry, an \`{ run, ... }\` entry, or a bare callback function`,
        { context: { authoring: true } },
      );
    }

    if (isAgentEntry && isRunEntry) {
      throw new SupervisorFailedError(
        `ai.supervisor("${config.name}"): \`ack\` cannot declare both \`agent\` and \`run\` — pick one`,
        { context: { authoring: true } },
      );
    }
  }

  if (config.maxIterations !== undefined && config.maxIterations < 1) {
    throw new SupervisorFailedError(
      `ai.supervisor("${config.name}"): \`maxIterations\` must be >= 1`,
      { context: { authoring: true, maxIterations: config.maxIterations } },
    );
  }
}

function generateRunId(): string {
  return `sup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
