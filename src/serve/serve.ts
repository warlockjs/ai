import { randomUUID, timingSafeEqual } from "node:crypto";
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
  toOptions?: (context: ServeRequestContext) => Record<string, unknown>;
  /** Server-owned conversation state. Defaults to a fresh ID and no history. */
  session?: ServeSessionOptions;
  /** Maximum accepted JSON request size in bytes. Defaults to 1 MiB. */
  maxBodyBytes?: number;
};

/** Trusted request data available while configuring a served execution. */
export type ServeRequestContext = {
  req: IncomingMessage;
  sessionId: string;
  history: unknown;
  signal: AbortSignal;
};

/** Server-side sources for per-request session state. */
export type ServeSessionOptions = {
  createId?: (req: IncomingMessage) => string;
  loadHistory?: (context: Pick<ServeRequestContext, "req" | "sessionId">) => unknown;
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

class ClientDisconnectedError extends Error {
  override name = "ClientDisconnectedError";
}

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
  const toOptions = options.toOptions ?? (() => ({}));
  const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes);

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }

      if (options.authToken && !hasValidBearerToken(req.headers.authorization, options.authToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const controller = new AbortController();
      const abortForDisconnect = () => {
        if (!controller.signal.aborted) controller.abort(new ClientDisconnectedError());
      };
      const onResponseClose = () => {
        if (!res.writableEnded) abortForDisconnect();
      };
      req.once("aborted", abortForDisconnect);
      res.once("close", onResponseClose);
      const removeDisconnectListeners = () => {
        req.removeListener("aborted", abortForDisconnect);
        res.removeListener("close", onResponseClose);
      };

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req, maxBodyBytes, controller.signal);
      } catch (error) {
        removeDisconnectListeners();
        if (controller.signal.aborted || error instanceof ClientDisconnectedError) return;
        sendJson(res, error instanceof BodyTooLargeError ? 413 : 400, {
          error: error instanceof BodyTooLargeError ? "payload_too_large" : "invalid_json",
        });
        return;
      }

      if (controller.signal.aborted) {
        removeDisconnectListeners();
        return;
      }

      const sessionId = options.session?.createId?.(req) ?? randomUUID();
      const history = options.session?.loadHistory?.({ req, sessionId });
      const context: ServeRequestContext = { req, sessionId, history, signal: controller.signal };

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...SECURITY_HEADERS,
      });

      try {
        const stream = executable.stream(toInput(body), {
          ...toOptions(context),
          sessionId,
          history,
          signal: controller.signal,
        });
        for await (const frame of streamToSSE(stream)) {
          if (controller.signal.aborted) break;
          res.write(frame);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
            })}\n\n`,
          );
        }
      } finally {
        removeDisconnectListeners();
        if (!res.writableEnded && !controller.signal.aborted) res.end();
      }
    })();
  };
}

/** Read a bounded JSON object request body. */
function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBodyBytes) {
        rejectOnce(new BodyTooLargeError());
        req.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const value: unknown = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value === null || Array.isArray(value) || typeof value !== "object") {
          throw new TypeError("JSON request body must be an object");
        }
        resolve(value as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => rejectOnce(error);
    const onAbort = () => rejectOnce(new ClientDisconnectedError());

    if (signal.aborted || req.aborted) {
      onAbort();
      return;
    }

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeMaxBodyBytes(value: number | undefined): number {
  const maxBodyBytes = value ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new RangeError("maxBodyBytes must be a non-negative safe integer");
  }
  return maxBodyBytes;
}

function hasValidBearerToken(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined) return false;
  const actual = Buffer.from(authorization, "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}
