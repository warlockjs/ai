import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import type { RouteContext } from "../contracts/supervisor/route-context.type";
import { buildScriptedAgent } from "../supervisor/_test-helpers";
import { supervisor } from "../supervisor/supervisor";
import { mockRouter } from "./mock-router";

function scripted(name: string) {
  return buildScriptedAgent({
    name,
    description: `${name} agent`,
    responses: [{ content: `${name}-out`, finishReason: "stop" }],
  });
}

describe("mockRouter", () => {
  it("should replay decisions one per iteration", () => {
    const route = mockRouter(["writer", "critic", END]);
    const ctx = (iteration: number): RouteContext =>
      ({ iteration }) as unknown as RouteContext;

    expect(route(ctx(0))).toBe("writer");
    expect(route(ctx(1))).toBe("critic");
    expect(route(ctx(2))).toBe(END);
  });

  it("should evaluate a function decision against the live context", () => {
    const route = mockRouter<{ done?: boolean }>([
      (ctx) => (ctx.state.done ? END : "writer"),
    ]);

    const decision = route({ iteration: 0, state: { done: true } } as RouteContext<{
      done?: boolean;
    }>);

    expect(decision).toBe(END);
  });

  it("should END by default once decisions are exhausted", () => {
    const route = mockRouter(["writer"]);
    const ctx = (iteration: number): RouteContext =>
      ({ iteration }) as unknown as RouteContext;

    expect(route(ctx(0))).toBe("writer");
    expect(route(ctx(1))).toBe(END);
    expect(route(ctx(2))).toBe(END);
  });

  it("should repeat the last decision when onExhausted is repeat", () => {
    const route = mockRouter(["writer"], { onExhausted: "repeat" });
    const ctx = (iteration: number): RouteContext =>
      ({ iteration }) as unknown as RouteContext;

    expect(route(ctx(0))).toBe("writer");
    expect(route(ctx(1))).toBe("writer");
    expect(route(ctx(2))).toBe("writer");
  });

  it("should throw when onExhausted is throw and the queue runs out", () => {
    const route = mockRouter(["writer"], { onExhausted: "throw" });
    const ctx = (iteration: number): RouteContext =>
      ({ iteration }) as unknown as RouteContext;

    expect(route(ctx(0))).toBe("writer");
    expect(() => route(ctx(1))).toThrow(/exhausted/);
  });

  it("should drive a real supervisor through a canned sequence", async () => {
    const writer = scripted("writer");
    const critic = scripted("critic");

    const sup = supervisor({
      name: "canned",
      intents: { writer, critic },
      route: mockRouter(["writer", "critic", END]),
    });

    const result = await sup.execute("draft a post");

    expect(result.error).toBeUndefined();
    expect(result.report.status).toBe("completed");

    const dispatched = result.report.snapshots.flatMap((snapshot) =>
      Object.keys(snapshot.result),
    );

    expect(dispatched).toContain("writer");
    expect(dispatched).toContain("critic");
  });

  it("should terminate a real supervisor immediately on END", async () => {
    const writer = scripted("writer");

    const sup = supervisor({
      name: "instant-end",
      intents: { writer },
      route: mockRouter([END]),
    });

    const result = await sup.execute("nothing to do");

    expect(result.report.status).toBe("completed");
    expect(result.report.terminatedBy).toBe("route");
  });
});
