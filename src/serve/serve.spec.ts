import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { encodeSSE } from "./sse";
import { serve, type ServableExecutable } from "./serve";
import { streamToSSE, type StreamLike } from "./stream-to-sse";

describe("encodeSSE", () => {
  it("formats an event + JSON data frame", () => {
    expect(encodeSSE({ event: "delta", data: { d: "Hi" } })).toBe(
      'event: delta\ndata: {"d":"Hi"}\n\n',
    );
  });

  it("splits multi-line data across data: lines", () => {
    expect(encodeSSE({ data: "a\nb" })).toBe("data: a\ndata: b\n\n");
  });
});

/** Build a StreamLike from a fixed event list + result. */
function fakeStream(
  events: Array<{ type: string }>,
  result: unknown,
): StreamLike<{ type: string }, unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    result: Promise.resolve(result),
  };
}

describe("streamToSSE (A3)", () => {
  it("emits a frame per event, then result, then [DONE]", async () => {
    const frames: string[] = [];
    for await (const frame of streamToSSE(
      fakeStream([{ type: "agent.trip.streaming" }, { type: "agent.completed" }], { ok: true }),
    )) {
      frames.push(frame);
    }

    expect(frames[0]).toContain("event: agent.trip.streaming");
    expect(frames[1]).toContain("event: agent.completed");
    expect(frames[2]).toContain("event: result");
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });
});

/** Minimal writable response capturing status, headers, and body. */
function fakeRes() {
  const res = new EventEmitter() as unknown as ServerResponse & {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  res.status = 0;
  res.headers = {};
  res.body = "";
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    res.status = status;
    Object.assign(res.headers, headers ?? {});
    return res;
  }) as typeof res.writeHead;
  res.write = ((chunk: string) => {
    res.body += chunk;
    return true;
  }) as ServerResponse["write"];
  res.end = ((chunk?: string) => {
    if (chunk) res.body += chunk;
    return res;
  }) as typeof res.end;
  return res;
}

/** Drive a POST request with a JSON body through a handler. */
function post(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = "POST";
  req.headers = headers;
  req.resume = (() => req) as IncomingMessage["resume"];
  const res = fakeRes();
  handler(req, res);
  req.emit("data", JSON.stringify(body));
  req.emit("end");
  return res;
}

const mockAgent: ServableExecutable = {
  stream(input: unknown) {
    return fakeStream([{ type: "agent.trip.streaming" }, { type: "agent.completed" }], {
      echoed: input,
    });
  },
};

describe("serve (A3)", () => {
  it("streams an executable run as SSE over POST", async () => {
    const res = post(serve(mockAgent), { input: "hello" });
    await new Promise((r) => setTimeout(r, 10));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: agent.trip.streaming");
    expect(res.body).toContain('"echoed":"hello"');
    expect(res.body.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  it("rejects a non-POST method with 405", () => {
    const handler = serve(mockAgent);
    const req = new EventEmitter() as unknown as IncomingMessage;
    req.method = "GET";
    req.headers = {};
    const res = fakeRes();
    handler(req, res);
    expect(res.status).toBe(405);
  });

  it("requires the bearer token when authToken is set", async () => {
    const res = post(serve(mockAgent, { authToken: "t" }), { input: "x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(res.status).toBe(401);
  });

  it("accepts the request with a valid bearer token", async () => {
    const res = post(
      serve(mockAgent, { authToken: "t" }),
      { input: "x" },
      {
        authorization: "Bearer t",
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(res.status).toBe(200);
  });

  it("ignores client session state and supplies only server-owned state", async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const executable: ServableExecutable = {
      stream(_input, streamOptions) {
        receivedOptions = streamOptions;
        return fakeStream([], { ok: true });
      },
    };

    post(
      serve(executable, {
        session: {
          createId: () => "server-session",
          loadHistory: () => [{ role: "user", content: "trusted" }],
        },
      }),
      { input: "hello", sessionId: "client-session", history: ["untrusted"] },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(receivedOptions).toMatchObject({
      sessionId: "server-session",
      history: [{ role: "user", content: "trusted" }],
    });
    expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects request bodies over the configured byte limit", async () => {
    const res = post(serve(mockAgent, { maxBodyBytes: 10 }), { input: "too large" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(res.status).toBe(413);
    expect(res.body).toContain("payload_too_large");
  });

  it("uses a 1 MiB default request-body limit", async () => {
    const res = post(serve(mockAgent), { input: "x".repeat(1024 * 1024) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(res.status).toBe(413);
    expect(res.body).toContain("payload_too_large");
  });

  it("aborts the stream signal when the response closes before completion", async () => {
    let receivedSignal: AbortSignal | undefined;
    const executable: ServableExecutable = {
      stream(_input, streamOptions) {
        receivedSignal = streamOptions?.signal as AbortSignal;
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              receivedSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        };
      },
    };
    const req = new EventEmitter() as unknown as IncomingMessage;
    req.method = "POST";
    req.headers = {};
    const res = fakeRes();
    serve(executable)(req, res);
    req.emit("data", JSON.stringify({ input: "hello" }));
    req.emit("end");
    await new Promise((resolve) => setTimeout(resolve, 0));
    res.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(receivedSignal?.aborted).toBe(true);
  });
});
