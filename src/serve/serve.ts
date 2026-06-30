import type { IncomingMessage, ServerResponse } from "node:http";
import { streamToSSE, type StreamLike } from "./stream-to-sse";

/**
 * Anything `serve` can expose: a primitive whose `stream(input, options)`
 * returns a {@link StreamLike}. Agents, supervisors, and orchestrators all
 * satisfy it.
 */
export type ServableExecutable<TInput = unknown> = {
  stream(input: TInput, options?: Record<string, unknown>): StreamLike<{ type: string }, unknown>;
};

/** Options for {@link serve}. */
export type ServeOptions<TInput = unknown> = {
  /**
   * Bearer token required on every request. When set, a request must send
   * `Authorization: Bearer <token>`, else `401` (S4-style auth, the same
   * control the dashboard uses — fold this in for a production deploy).
   */
  authToken?: string;
  /**
   * Map the parsed JSON request body to the executable's input. Default:
   * `body.input`. Override to accept a different request shape.
   */
  toInput?: (body: Record<string, unknown>) => TInput;
  /**
   * Map the parsed body to per-call stream options (e.g. an orchestrator
   * `{ sessionId, history }` so a turn resumes the right session — A3
   * wiring). Default: pass `sessionId` / `history` straight through.
   */
  toOptions?: (body: Record<string, unknown>) => Record<string, unknown>;
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/**
 * Turn an executable into a `node:http` request handler that streams its
 * run to the client as Server-Sent Events (A3) — the production-serving
 * primitive. POST a JSON body (`{ input, sessionId?, history? }`); the
 * response is an `text/event-stream` of the primitive's events, the final
 * `result`, then `[DONE]`. Absorbs the auth-token control; pair with a
 * `sessionLock` + an orchestrator for durable multi-turn serving.
 *
 * @example
 * import { createServer } from "node:http";
 * createServer(ai.serve(myAgent, { authToken: process.env.TOKEN })).listen(8787);
 */
export function serve<TInput = unknown>(
  executable: ServableExecutable<TInput>,
  options: ServeOptions<TInput> = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const toInput = options.toInput ?? ((body) => body.input as TInput);
  const toOptions =
    options.toOptions ??
    ((body) => {
      const opts: Record<string, unknown> = {};
      if (body.sessionId !== undefined) opts.sessionId = body.sessionId;
      if (body.history !== undefined) opts.history = body.history;
      return opts;
    });

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }

      if (options.authToken && req.headers.authorization !== `Bearer ${options.authToken}`) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...SECURITY_HEADERS,
      });

      try {
        const stream = executable.stream(toInput(body), toOptions(body));
        for await (const frame of streamToSSE(stream)) {
          res.write(frame);
        }
      } catch (error) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          })}\n\n`,
        );
      } finally {
        res.end();
      }
    })();
  };
}

/** Read and JSON-parse a request body. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer | string) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}
