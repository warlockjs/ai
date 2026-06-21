import type { StandardSchemaV1 } from "@standard-schema/spec";
import { agent } from "../agent/agent";
import type { AgentConfig } from "../agent/agent-config.type";
import type { AgentContract } from "../contracts/agent/agent.contract";
import { END } from "../contracts/end.type";
import type { Next } from "../contracts/supervisor/next.type";
import type { MockModelResponse } from "../mock/mock-config.type";
import { MockSDK } from "../mock/mock-sdk";

/**
 * Hand-rolled Standard Schema factory — mirrors
 * `workflow/_test-helpers.ts`. Lets supervisor specs build schemas
 * without pulling zod into the @warlock.js/ai test surface.
 */
export function schema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

export const passthrough = schema<unknown>(value => ({ value }));

/**
 * Build an agent whose responses are scripted by `MockModel`. Shortcut
 * wrapper around `ai.agent({ model: mockSDK.model(...) })` tuned for
 * supervisor specs — lets each test declare one line per agent.
 */
export function buildScriptedAgent<TOutput = unknown>(params: {
  name: string;
  description?: string;
  responses: MockModelResponse[];
  capabilities?: { structuredOutput?: boolean; vision?: boolean };
}): AgentContract<TOutput> {
  const sdk = MockSDK({
    responses: params.responses,
    capabilities: params.capabilities,
  });
  const model = sdk.model({ name: `${params.name}-model` });

  const config: AgentConfig<TOutput> = {
    name: params.name,
    description: params.description,
    model,
  };

  return agent<TOutput>(config);
}

/**
 * Router-agent response shape helper — produces a JSON body the
 * supervisor's router path can parse directly. Used when scripting
 * MockModel responses for router agents.
 */
export function routerDecision(next: Next, reasoning?: string): string {
  return JSON.stringify(reasoning ? { next, reasoning } : { next });
}

export const END_VALUE = END;

/**
 * Schema describing a router agent's output shape. Accepts `next`
 * (string | string[] | END) and optional `reasoning`.
 */
export const routerOutputSchema = schema<{ next: Next; reasoning?: string }>(
  value => {
    if (!value || typeof value !== "object") {
      return { issues: [{ message: "router output must be an object" }] };
    }

    const record = value as { next?: unknown; reasoning?: unknown };

    if (
      typeof record.next !== "string" &&
      !(
        Array.isArray(record.next) &&
        record.next.every(element => typeof element === "string")
      )
    ) {
      return {
        issues: [
          { message: "router output `next` must be string or string[]" },
        ],
      };
    }

    return {
      value: {
        next: record.next as Next,
        reasoning:
          typeof record.reasoning === "string" ? record.reasoning : undefined,
      },
    };
  },
);
