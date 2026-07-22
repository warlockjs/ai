import { describe, expect, it } from "vitest";
import { redact, redactError, redactHeaders, scrubSecrets } from "./redact";

describe("redact", () => {
  it("redacts values whose key matches a sensitive fragment", () => {
    const out = redact({
      apiKey: "sk-secret",
      Authorization: "Bearer abc",
      nested: { password: "hunter2", keep: "visible" },
      list: [{ token: "t" }, { ok: 1 }],
    });

    expect(out.apiKey).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.nested.password).toBe("[redacted]");
    expect(out.nested.keep).toBe("visible");
    expect((out.list[0] as { token: string }).token).toBe("[redacted]");
    expect((out.list[1] as { ok: number }).ok).toBe(1);
  });

  it("never guesses at bare string values", () => {
    // Key-driven only: a secret-looking value under an innocuous key stays.
    const out = redact({ note: "Bearer looks-like-a-token-but-isnt" });
    expect(out.note).toBe("Bearer looks-like-a-token-but-isnt");
  });

  it("handles circular references and depth without throwing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it("supports custom keys and placeholder", () => {
    const out = redact({ ssn: "123" }, { keys: ["ssn"], placeholder: "***" });
    expect(out.ssn).toBe("***");
  });

  it("preserves name/message/stack when redacting a raw Error (previously collapsed to {})", () => {
    const out = redact(new Error("boom")) as { name: string; message: string; stack: string };
    expect(out.name).toBe("Error");
    expect(out.message).toBe("boom");
    expect(typeof out.stack).toBe("string");
  });

  it("unwraps a nested Error cause the same way", () => {
    const inner = new Error("root cause");
    const outer = Object.assign(new Error("wrapper"), { cause: inner });
    const out = redact(outer) as { message: string; cause: { name: string; message: string } };
    expect(out.message).toBe("wrapper");
    expect(out.cause.name).toBe("Error");
    expect(out.cause.message).toBe("root cause");
  });
});

describe("scrubSecrets", () => {
  it("scrubs bearer tokens, api keys, and provider tokens from free text", () => {
    const bearer = scrubSecrets("call failed: Authorization: Bearer abc.def-123");
    expect(bearer).toContain("[redacted]");
    expect(bearer).not.toContain("abc.def-123");

    expect(scrubSecrets("key sk-ABCDEFGHIJKLMNOPqrstuvwx leaked")).not.toContain(
      "sk-ABCDEFGHIJKLMNOPqrstuvwx",
    );
    expect(scrubSecrets("x-api-key=supersecretvalue here")).not.toContain("supersecretvalue");
    expect(scrubSecrets("ghp_0123456789ABCDEFGHIJ0123456789ABCD")).toContain("[redacted]");
  });

  it("leaves innocuous text untouched", () => {
    expect(scrubSecrets("connection refused at 10.0.0.1:5432")).toBe(
      "connection refused at 10.0.0.1:5432",
    );
  });
});

describe("redactHeaders", () => {
  it("strips sensitive headers from a Headers instance", () => {
    const headers = new Headers({
      authorization: "Bearer x",
      "x-api-key": "k",
      "content-type": "application/json",
    });
    const out = redactHeaders(headers);
    expect(out.authorization).toBe("[redacted]");
    expect(out["x-api-key"]).toBe("[redacted]");
    expect(out["content-type"]).toBe("application/json");
  });

  it("strips sensitive headers from a plain record", () => {
    const out = redactHeaders({ Cookie: "sid=1", Accept: "*/*" });
    expect(out.Cookie).toBe("[redacted]");
    expect(out.Accept).toBe("*/*");
  });
});

describe("redactError", () => {
  it("serializes an error without the stack and redacts the cause", () => {
    const provider = {
      message: "401 Unauthorized",
      headers: { authorization: "Bearer leak", "x-request-id": "req_1" },
    };
    const error = Object.assign(new Error("auth failed"), {
      code: "PROVIDER_AUTH",
      cause: provider,
    });

    const out = redactError(error);

    expect(out.name).toBe("Error");
    expect(out.message).toBe("auth failed");
    expect(out.code).toBe("PROVIDER_AUTH");
    expect(out.stack).toBeUndefined();
    const cause = out.cause as { headers: Record<string, string> };
    expect(cause.headers.authorization).toBe("[redacted]");
    expect(cause.headers["x-request-id"]).toBe("req_1");
  });

  it("includes the stack only when explicitly requested", () => {
    const out = redactError(new Error("boom"), { includeStack: true });
    expect(typeof out.stack).toBe("string");
  });

  it("handles non-object errors", () => {
    const out = redactError("plain string");
    expect(out.message).toBe("plain string");
  });
});
