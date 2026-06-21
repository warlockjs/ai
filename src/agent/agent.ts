import type { StandardSchemaV1 } from "@standard-schema/spec";
import { log, type Logger } from "@warlock.js/logger";
import type {
  AgentContract,
  AgentEventHandler,
  AgentEventMap,
  AgentExecuteOptions,
  AgentResult,
  BaseReport,
  CompleteEvent,
  FinishReason,
  LLMTrip,
  Message,
  MiddlewareExecuteContext,
  MiddlewareState,
  MiddlewareToolContext,
  MiddlewareTripContext,
  ModelResponse,
  ModelToolCallRequest,
  StreamContract,
  StreamEventBody,
  StreamingToolGuardConfig,
  ToolCall,
  ToolEventMeta,
  Usage,
  UsageEvent,
  WithoutIdentity,
} from "../contracts";
import {
  AgentCancelledError,
  AgentExecutionError,
  AgentMaxTripsError,
  AIError,
  SchemaValidationError,
} from "../errors";
import type { AgentContract as AgentContractType } from "../contracts/agent/agent.contract";
import type { EvalOptions, EvalReport } from "../contracts/agent/eval.type";
import { runEval } from "../eval/eval-runner";
import { runPipeline } from "../middleware";
import { normalizeAgentTools } from "../tool/executable-as-tool";
import type { ToolContract, ToolInvokeResult } from "../tool/tool";
import {
  accumulateCost,
  computeCost,
  extractJsonPayload,
  generateRunId,
  safeJsonParse,
  stampReportLineage,
} from "../utils";
import type { AgentConfig } from "./agent-config.type";
import { buildAgentInputMessages } from "./agent-input-builder";
import { logAgentEvent } from "./agent-log-event";
import { createAgentStream, type StreamController } from "./agent-stream";
import { agentEventToStreamEvent } from "./agent-to-stream-event";
import { JsonStreamGuard } from "./json-stream-guard";

const LOG_MODULE = "ai.agent";

/**
 * Internal post-normalization view of an `AgentConfig`. The public
 * `tools` field accepts both built `ToolContract`s and raw executables
 * (`AgentToolEntry[]`); by the time the runtime sees the config every
 * entry has been adapted to a `ToolContract`, so `Execution` works
 * against this narrowed shape and never has to re-discriminate.
 */
type ResolvedAgentConfig<TOutput> = Omit<AgentConfig<TOutput>, "tools"> & {
  tools?: ToolContract<unknown, unknown>[];
};

/**
 * Detect abort-flavored errors surfaced by SDK HTTP layers — the
 * DOM `AbortError`, axios `ERR_CANCELED`, node-fetch's own
 * `AbortError`. Used to classify them as cancellation rather than
 * generic agent-execution failures.
 */
function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const e = err as { name?: unknown; code?: unknown };

  return e.name === "AbortError" || e.code === "ERR_CANCELED" || e.code === "ABORT_ERR";
}

/**
 * Readable synthetic name for agents constructed without an explicit
 * `name`. Format: `anon_<provider>_<model>[_<tool1>+<tool2>+...]` —
 * deterministic (same config → same name across restarts) and
 * human-readable in logs / workflow snapshots.
 *
 * Keeps drift detection honest for the `ai.agent({ model })`
 * one-liner without punishing it with a hashed id nobody can read.
 */
function synthesizeAgentName<T>(config: AgentConfig<T>): string {
  const provider = (config.model as unknown as { provider?: string })?.provider ?? "unknown";
  const model = config.model?.name ?? "unknown";
  const tools = (config.tools ?? [])
    .map((tool) => tool.name)
    .sort()
    .join("+");

  const base = `anon_${sanitize(provider)}_${sanitize(model)}`;
  return tools ? `${base}_${sanitize(tools, { keepPlus: true })}` : base;
}

function sanitize(value: string, opts: { keepPlus?: boolean } = {}): string {
  const allowed = opts.keepPlus ? /[^a-zA-Z0-9._+-]/g : /[^a-zA-Z0-9._-]/g;
  return value.replace(allowed, "-");
}

/**
 * Authoring-time check on the middleware array. Throws an
 * `AgentExecutionError` with `context: { authoring: true }` the
 * moment an invalid entry is found — the agent factory surface is
 * where config bugs should surface, not ten trips into a run.
 *
 * Validates:
 * - Every entry is a non-null object with a non-empty string `name`.
 * - No two entries share the same `name` (would silently collide on
 *   `ctx.state` keys and produce impossible-to-debug behavior).
 *
 * Does NOT validate that hook maps contain callable functions —
 * that would catch late-binding bugs but also reject legitimate
 * patterns like `before` being conditionally `undefined`. Runtime
 * dispatch handles missing hooks safely.
 */
function validateMiddleware(middleware: ReadonlyArray<unknown> | undefined): void {
  if (!middleware || middleware.length === 0) {
    return;
  }

  const seen = new Set<string>();

  for (let index = 0; index < middleware.length; index++) {
    const entry = middleware[index];

    if (!entry || typeof entry !== "object") {
      throw new AgentExecutionError(
        `middleware[${index}] must be an object; received ${entry === null ? "null" : typeof entry}`,
        { context: { authoring: true, index } },
      );
    }

    const name = (entry as { name?: unknown }).name;

    if (typeof name !== "string" || name.length === 0) {
      throw new AgentExecutionError(`middleware[${index}] must have a non-empty string "name"`, {
        context: { authoring: true, index },
      });
    }

    if (seen.has(name)) {
      throw new AgentExecutionError(
        `duplicate middleware name "${name}" — each middleware needs a unique name so ctx.state keys do not collide`,
        { context: { authoring: true, index, name } },
      );
    }

    seen.add(name);
  }
}

/**
 * Creates an executable AI agent from the given configuration.
 *
 * The agent runs a bounded trip loop: each trip calls the model, dispatches
 * any requested tool calls, then loops until the model stops or `maxTrips`
 * is reached. Each `execute()` / `stream()` call spawns a fresh internal
 * `Execution` instance — the factory itself holds no state across calls.
 *
 * `execute()` never throws — any error is attached to the returned result
 * under `result.error`. `stream()` surfaces errors both on the terminal
 * `error` stream event and via the `stream.result` promise.
 *
 * @example
 * const myAgent = agent({
 *   model: openai.model({ name: "gpt-4o" }),
 *   systemPrompt: "You are a helpful assistant.",
 *   tools: [searchTool],
 * });
 *
 * const result = await myAgent.execute("What is the capital of Egypt?");
 *
 * @example
 * const stream = myAgent.stream("Write a haiku about Cairo.");
 *
 * for await (const event of stream) {
 *   if (event.type === "streaming") process.stdout.write(event.delta);
 * }
 *
 * const result = await stream.result;
 */
export function agent<TOutput = unknown>(config: AgentConfig<TOutput>): AgentContract<TOutput> {
  // Authoring-time validation of the middleware array. Rejects two
  // classes of bug that would otherwise surface as opaque failures
  // mid-execution: (a) entries that aren't proper middleware
  // objects (null, undefined, missing `name`), and (b) two
  // middlewares sharing the same `name`, which would silently
  // collide on `ctx.state` keys. Fail fast, fail loud — per the
  // authoring-time rules in `domains/ai/conventions/errors.md`.
  validateMiddleware(config.middleware);

  // Resolve the agent's identity. Explicit `name` wins; otherwise we
  // synthesize a DETERMINISTIC fingerprint from the config's
  // identity-defining fields (model + provider + tool names). Same
  // config across process restarts produces the same synthetic name,
  // so workflow signature drift detection stays honest for agents
  // composed into workflows without explicit names.
  const isAnonymous = !config.name || typeof config.name !== "string";

  // Auto-adapt any raw executable (agent/workflow/supervisor) dropped
  // into `tools: []` into a `ToolContract` before the name is
  // synthesized — `synthesizeAgentName` reads `config.tools[].name`,
  // so the fingerprint must see the normalized entries. Built
  // `ToolContract`s (from `.asTool()` / `ai.tool()`) pass through
  // untouched, so this is a no-op for the existing surface.
  const tools = normalizeAgentTools(config.tools);
  const name = isAnonymous
    ? synthesizeAgentName({ ...config, tools })
    : (config.name as string);
  const resolvedConfig: ResolvedAgentConfig<TOutput> = { ...config, name, tools };

  // Instance-level handlers registered via `.on()`. Stored here
  // (factory-scope) so every `execute()` / `stream()` call on this
  // agent sees the same set. Each event name gets its own Set so
  // `off()` can remove a specific handler without disturbing others.
  const instanceHandlers = new Map<
    keyof AgentEventMap,
    Set<AgentEventHandler<keyof AgentEventMap>>
  >();

  function on<K extends keyof AgentEventMap>(event: K, handler: AgentEventHandler<K>): () => void {
    const existing = instanceHandlers.get(event);
    const bucket = existing ?? new Set<AgentEventHandler<keyof AgentEventMap>>();

    if (!existing) {
      instanceHandlers.set(event, bucket);
    }

    bucket.add(handler as AgentEventHandler<keyof AgentEventMap>);

    return () => off(event, handler);
  }

  function off<K extends keyof AgentEventMap>(event: K, handler: AgentEventHandler<K>): void {
    const bucket = instanceHandlers.get(event);

    if (!bucket) {
      return;
    }

    bucket.delete(handler as AgentEventHandler<keyof AgentEventMap>);

    if (bucket.size === 0) {
      instanceHandlers.delete(event);
    }
  }

  const agentContract: AgentContractType<TOutput> = {
    name,
    isAnonymous,
    description: config.description,
    async execute(
      input: string,
      options?: AgentExecuteOptions<TOutput>,
    ): Promise<AgentResult<TOutput>> {
      return new Execution<TOutput>(
        resolvedConfig,
        input,
        options,
        undefined,
        instanceHandlers,
      ).run();
    },

    stream(
      input: string,
      options?: AgentExecuteOptions<TOutput>,
    ): StreamContract<AgentResult<TOutput>> {
      const { controller, stream } = createAgentStream<AgentResult<TOutput>>();

      const execution = new Execution<TOutput>(
        resolvedConfig,
        input,
        options,
        controller,
        instanceHandlers,
      );

      void execution.run();

      return stream;
    },

    on,
    off,

    eval<TEval = TOutput>(options: EvalOptions<TEval>): Promise<EvalReport<TEval>> {
      return runEval<TEval>(agentContract as unknown as AgentContract<TEval>, options);
    },
  };

  return agentContract;
}

/**
 * Name → handler-set map shared between the `agent()` factory and its
 * per-call `Execution`. Each `.on()` registration mutates this map;
 * every `Execution` reads from the same reference so additions and
 * removals take effect mid-flight.
 */
type InstanceHandlerMap = Map<keyof AgentEventMap, Set<AgentEventHandler<keyof AgentEventMap>>>;

/**
 * Per-call driver that owns the full lifecycle of a single
 * `agent.execute()` or `agent.stream()` invocation.
 *
 * **Role.** An `Execution` is the short-lived state container and phase
 * orchestrator for one agent run. The public `agent()` factory stays purely
 * functional — all mutable bookkeeping (trips, tool calls, usage totals,
 * message history, terminal error, parsed output) lives here so each call
 * gets a fresh, isolated instance.
 *
 * **Responsibility.**
 * - Owns: building the initial message list, driving the bounded trip loop,
 *   dispatching tool calls safely, parsing the final output against the
 *   caller's schema, emitting lifecycle events (to both the user handler
 *   and, in stream mode, the `StreamController`), and producing the
 *   `AgentResult`.
 * - Does NOT own: how the model produces responses (delegated to
 *   `ModelContract.complete` / `ModelContract.stream`), how tools execute
 *   (delegated to `ToolContract.invoke`), the async-queue plumbing for
 *   streaming (delegated to `createAgentStream`), or any cross-call state
 *   (factory-level concerns live in `agent()`).
 *
 * Streaming mode is opt-in via the fourth constructor argument: pass a
 * `StreamController` and every event is mirrored into it while model calls
 * are driven via `model.stream()` instead of `model.complete()`. The public
 * contract of `execute()` says it never throws — `Execution` enforces that
 * by funneling every unexpected error into `this.error` and returning a
 * well-formed result regardless of what went wrong.
 *
 * Not exported — consumers interact only with the `agent()` factory (see
 * §4.2 of code-style.md — "per-call execution state across phases").
 *
 * @example
 * // Non-streaming — inside agent.execute():
 * const result = await new Execution(config, input, options).run();
 *
 * @example
 * // Streaming — inside agent.stream():
 * const { controller, stream } = createAgentStream();
 * void new Execution(config, input, options, controller).run();
 * return stream;
 */
class Execution<TOutput> {
  private readonly trips: LLMTrip[] = [];
  private readonly toolCalls: ToolCall[] = [];
  private readonly usage: Usage = { input: 0, output: 0, total: 0 };
  private readonly messages: Message[] = [];
  private readonly maxTrips: number;
  private readonly startedAt = new Date();
  private readonly start = performance.now();
  private readonly runId = generateRunId("agent");
  private readonly logger: Logger = log;
  private readonly middleware: ReadonlyArray<
    NonNullable<AgentConfig<TOutput>["middleware"]>[number]
  >;
  private readonly middlewareState: MiddlewareState = new Map();

  private error?: AIError;
  private data?: TOutput;
  private responseSchema?: Record<string, unknown>;

  public constructor(
    private readonly config: ResolvedAgentConfig<TOutput>,
    private readonly input: string,
    private readonly options?: AgentExecuteOptions<TOutput>,
    private readonly streamController?: StreamController<AgentResult<TOutput>>,
    private readonly instanceHandlers?: InstanceHandlerMap,
  ) {
    this.maxTrips = config.maxTrips ?? 10;
    this.middleware = config.middleware ?? [];
  }

  /**
   * Base middleware context shared by every level. `state` is the
   * single mutable bag threaded through `execute`, `trip`, and `tool`
   * hooks for the lifetime of this execution — fresh per `execute()`
   * call, never reused across runs.
   */
  private buildExecuteContext(): MiddlewareExecuteContext {
    return {
      agent: {
        name: this.config.name ?? this.config.model.name,
        isAnonymous: !this.config.name,
      },
      model: {
        name: this.config.model.name,
        provider: this.config.model.provider,
      },
      input: this.input,
      options: this.options as AgentExecuteOptions<unknown> | undefined,
      state: this.middlewareState,
      signal: this.options?.signal,
    };
  }

  /**
   * Entry point for a single agent execution. Wraps the real work
   * (`runCore`) in the `execute`-level middleware pipeline, then
   * emits the terminal `agent.completed` / `agent.error` events and
   * closes the stream (if any) with the post-pipeline result — so
   * middleware that short-circuits or transforms the final result
   * still produces a well-formed public outcome.
   *
   * Must never throw: any error that escapes the pipeline is
   * converted into an `AgentResult` with `error` populated before
   * returning, preserving the `agent.execute()` public contract.
   */
  public async run(): Promise<AgentResult<TOutput>> {
    const context = this.buildExecuteContext();

    let result: AgentResult<TOutput>;

    try {
      result = (await runPipeline(
        this.middleware,
        "execute",
        context,
        () => this.runCore(),
        this.logger,
      )) as AgentResult<TOutput>;
    } catch (thrown) {
      this.error = this.toAIError(thrown);
      result = this.buildResult();
    }

    if (result.error) {
      this.emit("agent.error", { error: result.error });
    }

    this.emit("agent.completed", { result });

    // Fire the `onComplete` hook with a flat payload (runId +
    // durationMs pre-extracted) for audit-log consumers. Awaited but
    // errors swallowed so consumer bugs cannot crash the agent or
    // interfere with the result returned to the caller.
    await this.fireCompleteHook(result);

    this.streamController?.end(result);

    return result;
  }

  /**
   * Inner body wrapped by the `execute`-level pipeline. Drives the
   * full lifecycle — build messages → emit starting → run trip loop
   * → parse output → build result. Catches any unexpected throw and
   * funnels it into `this.error` so the returned result is always
   * well-formed; `execute`-level `after` hooks receive the result,
   * with `error` populated when things went wrong.
   */
  private async runCore(): Promise<AgentResult<TOutput>> {
    try {
      await this.buildInitialMessages();

      this.emit("agent.starting", { input: this.input });

      await this.runTripLoop();

      const parseOutcome = await this.parseOutput();

      if (parseOutcome === "failed" && this.options?.repair) {
        await this.runRepairLoop();
      }
    } catch (thrown) {
      this.error = this.toAIError(thrown);
    }

    return this.buildResult();
  }

  /**
   * Resolve the system prompt (string or `SystemPromptContract`), merge
   * placeholders from config + execute options, inject a structured-output
   * instruction when the caller wants typed output but the model can't
   * enforce it natively, prepend any conversation history, and append the
   * user input. Produces the initial `messages` array the first trip sends
   * to the model. Runs exactly once per execution.
   */
  private async buildInitialMessages(): Promise<void> {
    const { messages, responseSchema } = await buildAgentInputMessages({
      config: this.config,
      input: this.input,
      options: this.options,
    });
    this.messages.push(...messages);
    this.responseSchema = responseSchema;
  }

  /**
   * Drive sequential trips up to `maxTrips`. Each trip may stop the loop
   * naturally (model returned a non-tool-call finish), abort it (model
   * threw), or continue it (model requested tools). When the loop exits
   * after the cap without a natural stop, records a "Max trips exceeded"
   * error so the caller can distinguish runaway tool loops from a real result.
   */
  private async runTripLoop(): Promise<void> {
    for (let tripIndex = 0; tripIndex < this.maxTrips; tripIndex++) {
      if (this.options?.signal?.aborted) {
        this.error = this.makeCancelledError();
        return;
      }

      const tripInput = tripIndex === 0 ? this.input : "[tool results]";
      const outcome = await this.runTrip(tripIndex, tripInput);

      if (outcome === "error" || outcome === "stop") {
        return;
      }
    }

    const lastTrip = this.trips[this.trips.length - 1];

    if (lastTrip?.finishReason === "tool_calls") {
      this.error = new AgentMaxTripsError("Max trips exceeded", {
        maxTrips: this.maxTrips,
      });
    }
  }

  /**
   * Execute one round-trip to the model. Aggregates usage into the running
   * total, dispatches any requested tool calls, appends the assistant +
   * tool-result messages for the next trip, and records an `LLMTrip`.
   * Returns an outcome that tells `runTripLoop` whether to continue, stop,
   * or abort.
   */
  private async runTrip(
    tripIndex: number,
    tripInput: string,
  ): Promise<"continue" | "stop" | "error"> {
    this.emit("agent.trip.started", { tripIndex, input: tripInput });

    const tripStartedAt = new Date();
    const tripStart = performance.now();

    let response: ModelResponse;

    try {
      response = await this.runTripThroughPipeline(tripIndex);
    } catch (thrown) {
      this.error = this.toAIError(thrown);

      const failedTrip: LLMTrip = {
        index: tripIndex,
        input: tripInput,
        output: "",
        finishReason: "error",
        startedAt: tripStartedAt.toISOString(),
        endedAt: new Date().toISOString(),
        duration: performance.now() - tripStart,
        usage: { input: 0, output: 0, total: 0 },
        error: this.error,
      };

      this.trips.push(failedTrip);

      this.emit("agent.trip.completed", { trip: failedTrip });
      this.emit("agent.error", { error: this.error });

      return "error";
    }

    // Attach per-trip cost breakdown using the model's pricing table
    // (when configured). Done at the framework boundary so stored trip
    // records carry historical cost — Panoptic and other archive
    // consumers never re-derive against today's pricing, and the
    // input/output/cached split stays queryable without joining to a
    // pricing table at all.
    if (response.usage.cost === undefined) {
      response.usage.cost = computeCost(response.usage, this.config.model.pricing);
    }

    this.usage.input += response.usage.input;
    this.usage.output += response.usage.output;
    this.usage.total += response.usage.total;
    if (response.usage.cachedTokens !== undefined) {
      this.usage.cachedTokens = (this.usage.cachedTokens ?? 0) + response.usage.cachedTokens;
    }
    this.usage.cost = accumulateCost(this.usage.cost, response.usage.cost);

    // Fire the `onUsage` hook with a flat, pre-packaged payload so
    // cost-ledger code receives stable identity (runId, model+provider)
    // without joining from elsewhere. Awaited but errors swallowed.
    await this.fireUsageHook(tripIndex, response.usage);

    const isToolCallTrip =
      response.finishReason === "tool_calls" &&
      response.toolCalls !== undefined &&
      response.toolCalls.length > 0;

    const tripToolCalls: ToolCall[] = [];

    if (isToolCallTrip) {
      this.messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const toolCallRequest of response.toolCalls!) {
        const record = await this.dispatchToolCall(toolCallRequest, tripIndex);

        tripToolCalls.push(record);
      }
    }

    const trip: LLMTrip = {
      index: tripIndex,
      input: tripInput,
      output: response.content,
      finishReason: response.finishReason,
      startedAt: tripStartedAt.toISOString(),
      endedAt: new Date().toISOString(),
      duration: performance.now() - tripStart,
      usage: response.usage,
      toolCalls: tripToolCalls.length > 0 ? tripToolCalls : undefined,
    };

    this.trips.push(trip);

    this.emit("agent.trip.completed", { trip });

    if (!isToolCallTrip) {
      return "stop";
    }

    // Terminate the trip loop when EVERY tool call this trip is
    // `mode: "silent"`. Silent tools don't feed their result back
    // to the model — the prose the model streamed alongside the
    // tool call IS the final reply. The "all" rule is load-bearing:
    // if any feedback tool was called too, its result still needs
    // to round-trip, so we must continue.
    //
    // Composite (`asTool`-wrapped) tools never set `mode: "silent"`
    // in v1 — silent-composite mechanics are deferred per plan
    // 2026-05-07-silent-tools.md (Q4). They behave as feedback.
    const allSilent = response.toolCalls!.every((request) => {
      const registered = this.config.tools?.find((tool) => tool.name === request.name);
      return registered?.mode === "silent";
    });

    return allSilent ? "stop" : "continue";
  }

  /**
   * Route `getModelResponse` through the `trip`-level middleware
   * pipeline. `trip.before` hooks can short-circuit the trip by
   * returning a synthetic `ModelResponse` (semantic cache hit).
   * `trip.after` hooks can transform the response before the trip
   * record is built or any tool calls are dispatched. `trip.onError`
   * hooks can recover from provider failures (fallback chain).
   */
  private async runTripThroughPipeline(tripIndex: number): Promise<ModelResponse> {
    const context: MiddlewareTripContext = {
      ...this.buildExecuteContext(),
      tripIndex,
      messages: this.messages,
    };

    return (await runPipeline(
      this.middleware,
      "trip",
      context,
      () => this.getModelResponse(tripIndex),
      this.logger,
    )) as ModelResponse;
  }

  /**
   * Produce the `ModelResponse` for the current trip. In non-streaming
   * mode, delegates straight to `model.complete()`. In streaming mode,
   * drains `model.stream()` while emitting `streaming` events per delta
   * and accumulates the chunks into the same `ModelResponse` shape, so the
   * rest of the trip pipeline (tool dispatch, trip record, usage
   * aggregation) stays identical between the two modes.
   */
  private async getModelResponse(tripIndex: number): Promise<ModelResponse> {
    const callOptions = {
      ...this.config.modelOptions,
      tools: this.config.tools ?? [],
      ...(this.responseSchema ? { responseSchema: this.responseSchema } : {}),
      ...(this.options?.signal ? { signal: this.options.signal } : {}),
    };

    if (!this.streamController) {
      return this.config.model.complete(this.messages, callOptions);
    }

    let content = "";
    let finishReason: FinishReason = "stop";
    let usage: Usage = { input: 0, output: 0, total: 0 };
    const toolCalls: ModelToolCallRequest[] = [];
    const recoveredCalls: ModelToolCallRequest[] = [];

    const guardConfig = this.resolveStreamingToolGuard();
    const guard = guardConfig
      ? new JsonStreamGuard({
          tools: (this.config.tools ?? []) as ReadonlyArray<ToolContract<unknown, unknown>>,
          maxBufferBytes: guardConfig.maxBufferBytes,
          onSafeDelta: (delta) => {
            content += delta;

            this.emit("agent.trip.streaming", { delta, tripIndex });
          },
          onRecoveredCall: (request) => {
            recoveredCalls.push(request);
          },
        })
      : undefined;

    for await (const chunk of this.config.model.stream(this.messages, callOptions)) {
      // Mid-stream abort — break out cleanly instead of continuing to
      // consume the iterator. The underlying fetch is already
      // cancelled via `signal` forwarded in callOptions; this covers
      // adapters that don't honor signal natively and keeps mock
      // models consistent under cancellation tests.
      if (this.options?.signal?.aborted) {
        throw this.makeCancelledError();
      }

      if (chunk.type === "delta") {
        if (guard) {
          await guard.feed(chunk.content);
        } else {
          content += chunk.content;

          this.emit("agent.trip.streaming", { delta: chunk.content, tripIndex });
        }

        continue;
      }

      if (chunk.type === "tool-call") {
        toolCalls.push({
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
          ...(chunk.providerMetadata ? { providerMetadata: chunk.providerMetadata } : {}),
        });

        continue;
      }

      finishReason = chunk.finishReason;
      usage = chunk.usage;
    }

    if (guard) {
      await guard.finalize();
    }

    // Dedupe synthesized calls against real ones the provider streamed
    // structurally — the model occasionally emits BOTH channels for
    // the same call (real tool-call chunk + narrated JSON envelope).
    // Real wins; the synthesized duplicate is dropped so dispatch
    // doesn't run twice. See plan 2026-05-22 §Q5.
    const dedupedRecovered = recoveredCalls.filter(
      (recovered) => !isDuplicateToolCall(recovered, toolCalls),
    );

    const mergedToolCalls = [...toolCalls, ...dedupedRecovered];

    // When the guard recovered any calls but the model reported a
    // natural `"stop"`, override to `"tool_calls"` so the agent's
    // dispatch loop (`runTrip` → `isToolCallTrip`) actually fires.
    // Without this the guard silently suppresses the leaked JSON but
    // never dispatches the real action — chips never render.
    const resolvedFinishReason: FinishReason =
      dedupedRecovered.length > 0 && finishReason === "stop" ? "tool_calls" : finishReason;

    return {
      content,
      finishReason: resolvedFinishReason,
      usage,
      toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : undefined,
    };
  }

  /**
   * Resolve the effective `streamingToolGuard` for this trip.
   * Per-call options win over the agent-level config when the key is
   * explicitly present on options (including the explicit `undefined`
   * "disable for this call" form). Returns `undefined` when no guard
   * should run.
   */
  private resolveStreamingToolGuard(): StreamingToolGuardConfig | undefined {
    if (
      this.options !== undefined &&
      Object.prototype.hasOwnProperty.call(this.options, "streamingToolGuard")
    ) {
      return this.options.streamingToolGuard;
    }

    return this.config.streamingToolGuard;
  }

  /**
   * Dispatch a single tool call requested by the model. Looks up the tool
   * by name, invokes it via the safe `ToolContract.invoke` entry, pushes a
   * matching tool-result message into `this.messages` so the next trip can
   * see it, and emits the right lifecycle event (`tool-called` on success,
   * `tool-calling-failed` when the tool is unregistered or invoke returned
   * an error). Never throws — always returns a `ToolCall` record.
   */
  private async dispatchToolCall(
    toolCallRequest: ModelToolCallRequest,
    tripIndex: number,
  ): Promise<ToolCall> {
    const registeredTool = this.config.tools?.find((tool) => tool.name === toolCallRequest.name);

    if (!registeredTool) {
      const error = new AgentExecutionError(`Tool not registered: ${toolCallRequest.name}`, {
        context: { toolName: toolCallRequest.name, tripIndex },
      });

      const nowIso = new Date().toISOString();

      const record: ToolCall = {
        runId: generateRunId("tool"),
        rootRunId: this.runId,
        name: toolCallRequest.name,
        type: "tool",
        status: "failed",
        startedAt: nowIso,
        endedAt: nowIso,
        duration: 0,
        usage: { input: 0, output: 0, total: 0 },
        children: [],
        tripIndex,
        input: toolCallRequest.input,
        error,
        ...(toolCallRequest.recoveredFrom ? { recoveredFrom: toolCallRequest.recoveredFrom } : {}),
      };

      this.toolCalls.push(record);

      this.messages.push({
        role: "tool",
        toolCallId: toolCallRequest.id,
        content: JSON.stringify({ error: error.message }),
      });

      // Stub meta — there's no real tool to describe. Carries the
      // requested name for log correlation and an explanatory
      // description so consumers don't see an empty string.
      this.emit("agent.tool.failed", {
        tool: {
          name: toolCallRequest.name,
          description: "(unregistered tool — no description available)",
        },
        input: toolCallRequest.input,
        error,
        tripIndex,
      });

      return record;
    }

    // Build the lightweight event meta once. Resolves `action` to a
    // string here so consumers receive plain data rather than having
    // to re-evaluate a callback on every event.
    const toolMeta: ToolEventMeta = {
      name: registeredTool.name,
      description: registeredTool.description,
      action: resolveToolAction(registeredTool, toolCallRequest.input),
    };

    this.emit("agent.tool.calling", {
      tool: toolMeta,
      input: toolCallRequest.input,
      tripIndex,
    });

    const toolContext: MiddlewareToolContext = {
      ...this.buildExecuteContext(),
      tripIndex,
      messages: this.messages,
      tool: {
        name: registeredTool.name,
        description: registeredTool.description,
        mode: registeredTool.mode,
      },
      request: toolCallRequest,
    };

    let invokeResult: ToolInvokeResult<unknown>;

    try {
      invokeResult = (await runPipeline(
        this.middleware,
        "tool",
        toolContext,
        () => registeredTool.invoke(toolCallRequest.input, this.options?.toolCtx),
        this.logger,
      )) as ToolInvokeResult<unknown>;
    } catch (thrown) {
      // A `tool`-level middleware hook threw. The real invoke never
      // throws (it funnels errors into `result.error`), so only a
      // middleware abort or a bug reaches this branch. Synthesize a
      // failed-invoke record so the tool-call trace stays consistent.
      const error = this.toAIError(thrown);
      const nowIso = new Date().toISOString();
      const emptyUsage: Usage = { input: 0, output: 0, total: 0 };

      const failedRunId = generateRunId("tool");
      invokeResult = {
        error,
        usage: emptyUsage,
        report: {
          runId: failedRunId,
          rootRunId: failedRunId,
          name: registeredTool.name,
          version: registeredTool.version,
          type: "tool",
          status: "failed",
          startedAt: nowIso,
          endedAt: nowIso,
          duration: 0,
          usage: emptyUsage,
          children: [],
        },
      };
    }

    // The agent-level ToolCall record merges the tool's own invocation
    // report with agent-side enrichments (tripIndex, input, output,
    // error). When the underlying tool was an `asTool`-wrapped
    // composite, its inner report becomes the sole child of this
    // ToolCall — preserving the full nested tree while keeping this
    // node's own `type` as `"tool"` (from the agent's POV it *was* a
    // tool dispatch).
    const innerReport = invokeResult.report;
    const isComposite = innerReport.type !== "tool";

    const record: ToolCall = {
      runId: innerReport.runId,
      rootRunId: this.runId,
      name: toolCallRequest.name,
      version: registeredTool.version,
      type: "tool",
      status: innerReport.status,
      startedAt: innerReport.startedAt,
      endedAt: innerReport.endedAt,
      duration: innerReport.duration,
      usage: invokeResult.usage,
      children: isComposite ? [innerReport] : innerReport.children,
      tripIndex,
      input: toolCallRequest.input,
      output: invokeResult.data,
      error: invokeResult.error,
      ...(toolCallRequest.recoveredFrom ? { recoveredFrom: toolCallRequest.recoveredFrom } : {}),
    };

    this.toolCalls.push(record);

    // Roll child usage into the agent's accumulator. Leaf tools
    // contribute zero; `asTool`-wrapped composites contribute the
    // full cost of the inner agent/workflow/supervisor run.
    this.usage.input += invokeResult.usage.input;
    this.usage.output += invokeResult.usage.output;
    this.usage.total += invokeResult.usage.total;
    this.usage.cost = accumulateCost(this.usage.cost, invokeResult.usage.cost);

    this.messages.push({
      role: "tool",
      toolCallId: toolCallRequest.id,
      content: invokeResult.error
        ? JSON.stringify({ error: invokeResult.error.message })
        : JSON.stringify(invokeResult.data ?? null),
    });

    if (invokeResult.error) {
      this.emit("agent.tool.failed", {
        tool: toolMeta,
        input: toolCallRequest.input,
        error: invokeResult.error,
        tripIndex,
      });
    } else {
      this.emit("agent.tool.called", { ...record, tool: toolMeta });
    }

    return record;
  }

  /**
   * Parse the final trip output against the user-supplied schema (if any).
   * Failures populate `this.error` but never throw. Returns an outcome the
   * caller uses to decide whether self-repair is worth attempting:
   *
   * - `"skipped"` — no schema, or a prior trip-level error already set
   *   `this.error` (model crash, max trips). Not repairable; the failure
   *   isn't a parse problem the model can fix by re-asking.
   * - `"failed"` — schema present, output text either failed JSON.parse
   *   or failed `~standard.validate`. Repairable via `runRepairLoop`.
   * - `"success"` — parsed and validated; `this.data` populated.
   */
  private async parseOutput(): Promise<"success" | "failed" | "skipped"> {
    const schema = this.options?.output ?? this.config.output;

    if (!schema || this.error) {
      return "skipped";
    }

    const finalTrip = this.trips[this.trips.length - 1];
    const text = finalTrip?.output ?? "";

    if (!text) {
      return "skipped";
    }

    const payload = extractJsonPayload(text);
    const sentinel = Symbol("parse-failed");
    const parsed = safeJsonParse<unknown>(payload, sentinel);

    if (parsed === sentinel) {
      this.error = new SchemaValidationError("Failed to parse model output as JSON", {
        context: { text },
      });
      return "failed";
    }

    const validation = await (schema as StandardSchemaV1<TOutput>)["~standard"].validate(parsed);

    if (validation.issues) {
      const summary = validation.issues.map((issue) => issue.message).join("; ");
      this.error = new SchemaValidationError(summary, {
        issues: validation.issues,
      });
      return "failed";
    }

    this.data = validation.value;
    return "success";
  }

  /**
   * Opt-in self-repair loop for `output` schema failures. Triggered only
   * when `options.repair` is set and `parseOutput()` returned `"failed"`.
   *
   * Each attempt:
   * 1. Pushes the bad assistant response into `this.messages` (so the
   *    model can see what it just produced).
   * 2. Pushes a corrective user message naming the validation/parse error.
   * 3. Runs another trip — counted against the same `maxTrips` cap as
   *    normal trips so a stuck model can't loop forever.
   * 4. Re-parses. Stops on success, on a trip-level error, or when
   *    either `maxAttempts` or `maxTrips` is exhausted.
   *
   * Resets `this.error` and `this.data` before each attempt so the final
   * outcome (success or last failure) is what surfaces to the caller.
   */
  private async runRepairLoop(): Promise<void> {
    const maxAttempts = this.options?.repair?.maxAttempts ?? 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.trips.length >= this.maxTrips) {
        return;
      }

      const lastTrip = this.trips[this.trips.length - 1];
      const badResponse = lastTrip?.output ?? "";
      const failureReason = this.error?.message ?? "unknown validation failure";

      this.error = undefined;
      this.data = undefined;

      this.messages.push({ role: "assistant", content: badResponse });

      this.messages.push({
        role: "user",
        content: [
          `Your previous response failed validation: ${failureReason}.`,
          "Respond again with valid JSON only — no prose, no markdown fences, no commentary.",
        ].join(" "),
      });

      const tripIndex = this.trips.length;

      this.logger.warn(LOG_MODULE, "repair.attempting", "retrying after validation failure", {
        attempt: attempt + 1,
        maxAttempts,
        reason: failureReason,
      });

      const outcome = await this.runTrip(tripIndex, "[repair attempt]");

      if (outcome === "error") {
        return;
      }

      const parseOutcome = await this.parseOutput();

      if (parseOutcome === "success") {
        return;
      }
    }
  }

  /**
   * Build the final `AgentResult` snapshot from accumulated state
   * (trips, tool calls, data/error, usage, timing).
   *
   * Pure — no side effects. `run()` owns terminal event emission and
   * stream closure so the post-pipeline result (possibly transformed
   * or short-circuited by an `execute`-level middleware) is what
   * flows out to consumers and listeners.
   *
   * Trips, tool calls, status, and timing live under `report` so the
   * root stays focused on the four things callers reach for most:
   * `data`, `text`, `usage`, `error`.
   */
  private buildResult(): AgentResult<TOutput> {
    const finalTrip = this.trips[this.trips.length - 1];
    const endedAt = new Date();

    const agentName = this.config.name ?? this.config.model.name;
    const status: BaseReport["status"] = this.error
      ? this.error instanceof AgentCancelledError
        ? "cancelled"
        : "failed"
      : "completed";

    const report = {
      runId: this.runId,
      rootRunId: this.runId,
      name: agentName,
      version: this.config.version,
      type: "agent" as const,
      status,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      duration: performance.now() - this.start,
      usage: this.usage,
      children: this.toolCalls,
      model: {
        name: this.config.model.name,
        provider: this.config.model.provider,
      },
      trips: this.trips,
    };

    // Stamp lineage on the assembled tree exactly once per run.
    // Rewrites any inner self-roots from composite children to this
    // run's id, stamps `reportSchemaVersion` on the root, and
    // propagates `sessionId` to every node.
    stampReportLineage(report, {
      rootRunId: this.runId,
      sessionId: this.options?.sessionId,
    });

    return {
      type: "agent",
      data: this.data,
      text: finalTrip?.output,
      report,
      usage: this.usage,
      error: this.error,
    };
  }

  /**
   * Normalize any thrown value into an `AIError`. `AIError` instances
   * pass through untouched; provider-adapter SDK errors are caught by
   * the adapter and already arrive typed, so this branch mainly
   * handles runtime crashes (TypeError, ReferenceError) inside
   * model.complete / model.stream and non-Error values (`throw "bad"`).
   */
  private toAIError(thrown: unknown): AIError {
    if (thrown instanceof AIError) {
      return thrown;
    }

    // Classify abort-flavored errors (DOMException "AbortError",
    // node-fetch's `FetchError` with name "AbortError", `ERR_CANCELED`
    // from the OpenAI SDK's axios-ish layer) as cancelled instead of
    // a generic exec failure so callers can route retries correctly.
    if (isAbortLike(thrown)) {
      return this.makeCancelledError();
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);

    return new AgentExecutionError(message, { cause: thrown });
  }

  /**
   * Build the typed cancelled error that both the trip-loop guard
   * and the mid-stream guard emit. Captures the abort reason when
   * one was supplied to `controller.abort(reason)` so logs and
   * telemetry can see what cancelled the run.
   */
  private makeCancelledError(): AgentCancelledError {
    const reason = this.options?.signal?.reason;
    const reasonText = reason === undefined ? "" : String(reason);

    return new AgentCancelledError("agent execution cancelled", {
      cause: reason,
      cancelledAt: new Date().toISOString(),
      reason: reasonText,
    });
  }

  /**
   * Fire a single event through all three subscription tiers in order
   * — factory → instance → per-call — and mirror it into the
   * `StreamController` when streaming is active. A throwing user
   * handler must never crash the agent, so every dispatch is wrapped
   * in `safeCall`. Stream events are converted from the internal
   * `AgentEventMap` payload to the public `StreamEvent` shape because
   * some of them differ (e.g. the tool-called payload vs stream
   * event).
   */
  private emit<K extends keyof AgentEventMap>(
    event: K,
    payload: WithoutIdentity<AgentEventMap[K]>,
  ): void {
    // Inject run identity once, here, so every subscription tier and
    // the stream see it. `rootRunId === runId` for a standalone run;
    // nested propagation lands in a follow-up.
    const fullPayload = {
      ...payload,
      runId: this.runId,
      rootRunId: this.runId,
    } as AgentEventMap[K];

    this.logEvent(event, fullPayload);

    const factoryHandler = this.config.on?.[event] as AgentEventHandler<K> | undefined;

    if (factoryHandler) {
      safeCall(factoryHandler, fullPayload);
    }

    const bucket = this.instanceHandlers?.get(event);

    if (bucket) {
      for (const handler of bucket) {
        safeCall(handler as AgentEventHandler<K>, fullPayload);
      }
    }

    const perCallHandler = this.options?.on?.[event] as AgentEventHandler<K> | undefined;

    if (perCallHandler) {
      safeCall(perCallHandler, fullPayload);
    }

    if (this.streamController) {
      const body = this.toStreamEvent(event, fullPayload);

      if (body) {
        this.streamController.push({
          runId: this.runId,
          rootRunId: this.runId,
          ...body,
        });
      }
    }
  }

  /**
   * Emit a structured log line for a lifecycle event. The action
   * string mirrors the event name with the `agent.` prefix stripped
   * (`agent.trip.started` → `trip.started`) so log grep filters and
   * event handlers read the same vocabulary. Level mapping follows
   * the convention documented on `@warlock.js/logger`'s `Logger`.
   */
  private logEvent<K extends keyof AgentEventMap>(event: K, payload: AgentEventMap[K]): void {
    const agentName = this.config.name || this.config.model.name;
    logAgentEvent(
      this.logger,
      {
        module: `${LOG_MODULE}.${agentName}`,
        maxTrips: this.maxTrips,
        modelName: this.config.model.name,
        totalUsage: this.usage,
        totalDurationMs: performance.now() - this.start,
        trips: this.trips,
        toolCalls: this.toolCalls,
      },
      event,
      payload,
    );
  }

  private toStreamEvent<K extends keyof AgentEventMap>(
    event: K,
    payload: AgentEventMap[K],
  ): StreamEventBody | undefined {
    return agentEventToStreamEvent(event, payload);
  }

  /**
   * Invoke the `onUsage` hook (when configured) with a flat payload
   * carrying stable identity. Awaits the handler so async ledger
   * writes complete before the next trip starts; swallows any throw
   * so consumer bugs cannot crash the agent. Sync handlers wrapped
   * via `Promise.resolve()` so the await is safe in either case.
   */
  private async fireUsageHook(tripIndex: number, tripUsage: Usage): Promise<void> {
    const handler = this.config.onUsage;
    if (!handler) return;

    const event: UsageEvent = {
      runId: this.runId,
      tripIndex,
      model: {
        name: this.config.model.name,
        provider: this.config.model.provider,
      },
      usage: { ...tripUsage },
      timestamp: new Date().toISOString(),
    };

    try {
      await Promise.resolve(handler(event));
    } catch (err) {
      this.logger.warn(LOG_MODULE, "onUsage.hook.error", "onUsage handler threw", {
        runId: this.runId,
        tripIndex,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Invoke the `onComplete` hook (when configured) once at the end
   * of every run. Receives the full `AgentResult` plus pre-extracted
   * `runId` and `durationMs`. Same swallow-and-log error policy as
   * `fireUsageHook`.
   */
  private async fireCompleteHook(result: AgentResult<TOutput>): Promise<void> {
    const handler = this.config.onComplete;
    if (!handler) return;

    const event: CompleteEvent<TOutput> = {
      result,
      runId: this.runId,
      durationMs: performance.now() - this.start,
    };

    try {
      await Promise.resolve(handler(event));
    } catch (err) {
      this.logger.warn(LOG_MODULE, "onComplete.hook.error", "onComplete handler threw", {
        runId: this.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Decide whether a guard-synthesized tool call duplicates a real one
 * the provider already streamed structurally. Match key is
 * `name + key-sorted JSON of input` so identical calls (regardless of
 * argument key order) collapse, but two legitimate calls to the same
 * tool with different inputs still both dispatch.
 */
function isDuplicateToolCall(
  recovered: ModelToolCallRequest,
  realCalls: ReadonlyArray<ModelToolCallRequest>,
): boolean {
  const recoveredKey = `${recovered.name}|${stableStringify(recovered.input)}`;

  for (const real of realCalls) {
    const realKey = `${real.name}|${stableStringify(real.input)}`;

    if (realKey === recoveredKey) {
      return true;
    }
  }

  return false;
}

/**
 * `JSON.stringify` variant that sorts object keys at every nesting
 * level so structurally-equal inputs serialize to identical strings.
 * Used only for dedupe-key comparison; never surfaces to consumers.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const source = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};

      for (const key of Object.keys(source).sort()) {
        sorted[key] = source[key];
      }

      return sorted;
    }

    return val;
  });
}

/**
 * Invoke a user-supplied event handler without letting exceptions
 * escape the agent. Thrown errors are swallowed — structured logging
 * attaches here in Phase 0.5 so operators still see the failure.
 */
function safeCall<T>(handler: (payload: T) => void, payload: T): void {
  try {
    handler(payload);
  } catch {
    // Intentionally swallowed — user handlers never crash the agent.
  }
}

/**
 * Resolve a tool's `action` declaration into a plain string for
 * inclusion in `ToolEventMeta`. Static strings pass through;
 * function-shaped actions are invoked with the validated input.
 *
 * Defensive: if the user's callback throws, swallow and return
 * `undefined` rather than crashing the agent — UI strings are not
 * worth aborting an LLM dispatch over.
 */
function resolveToolAction(
  tool: ToolContract<unknown, unknown>,
  input: unknown,
): string | undefined {
  if (tool.action === undefined) return undefined;
  if (typeof tool.action === "string") return tool.action;
  try {
    return tool.action(input);
  } catch {
    return undefined;
  }
}
