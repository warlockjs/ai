import { describe, expect, it, vi } from "vitest";
import type {
  PendingInterrupt,
  PgClientLike,
} from "../contracts/interrupt-store.contract";
import { pg } from "./pg";

// Simulate `pg` NOT being installed: a dynamic `import("pg")` rejects, so
// the store's lazy loader must surface the curated install string — never
// a raw resolution error. Scoped to this file; the round-trip tests below
// use a passed-in `{ client }` and never trigger the dynamic import, so the
// mock leaves them untouched.
vi.mock("pg", () => {
  throw new Error("Cannot find module 'pg'");
});

/**
 * A single stored row in the fake — column names mirror the reference
 * DDL. `request` is held as the JSON string the driver writes
 * (`$2::jsonb`), so the fake exercises the same serialize/parse round-trip
 * a real `pg` client does.
 */
interface FakeRow {
  interrupt_id: string;
  request: string;
  status: string;
  saved_at: string;
}

/**
 * In-memory {@link PgClientLike} that recognizes the exact query shapes the
 * pg interrupt store issues — the upsert INSERT, the by-id SELECT, the
 * DELETE, and the id list (with/without LIKE). It is not a SQL engine; it
 * pattern-matches the store's own SQL so the test stays a faithful
 * contract check without a real database.
 */
class FakePgClient implements PgClientLike {
  public rows: FakeRow[] = [];

  public queries: string[] = [];

  public async query(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: unknown[] }> {
    this.queries.push(text);
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO")) {
      return this.handleUpsert(params);
    }

    if (sql.startsWith("SELECT interrupt_id, request")) {
      return this.handleLoad(params);
    }

    if (sql.startsWith("SELECT interrupt_id FROM")) {
      return this.handleList(sql, params);
    }

    if (sql.startsWith("DELETE FROM")) {
      return this.handleDelete(params);
    }

    throw new Error(`FakePgClient: unrecognized query: ${sql}`);
  }

  private handleUpsert(params: unknown[]): { rows: unknown[] } {
    const [interruptId, request, status, savedAt] = params as [
      string,
      string,
      string,
      string,
    ];

    const existing = this.rows.find((row) => row.interrupt_id === interruptId);

    if (existing) {
      existing.request = request;
      existing.status = status;
      existing.saved_at = savedAt;

      return { rows: [] };
    }

    this.rows.push({
      interrupt_id: interruptId,
      request,
      status,
      saved_at: savedAt,
    });

    return { rows: [] };
  }

  private handleLoad(params: unknown[]): { rows: unknown[] } {
    const [interruptId] = params as [string];
    const match = this.rows.find((row) => row.interrupt_id === interruptId);

    return { rows: match ? [match] : [] };
  }

  private handleList(sql: string, params: unknown[]): { rows: unknown[] } {
    let ids = this.rows.map((row) => row.interrupt_id);

    if (sql.includes("LIKE")) {
      const escapedPattern = params[0] as string;
      const prefix = escapedPattern
        .replace(/%$/, "")
        .replace(/\\_/g, "_")
        .replace(/\\%/g, "%")
        .replace(/\\\\/g, "\\");
      ids = ids.filter((id) => id.startsWith(prefix));
    }

    return { rows: ids.map((interrupt_id) => ({ interrupt_id })) };
  }

  private handleDelete(params: unknown[]): { rows: unknown[] } {
    const [interruptId] = params as [string];

    this.rows = this.rows.filter((row) => row.interrupt_id !== interruptId);

    return { rows: [] };
  }
}

function makeInterrupt(
  overrides: Partial<PendingInterrupt> = {},
): PendingInterrupt {
  return {
    interruptId: "support.sess-1.0.abc",
    request: {
      interruptId: "support.sess-1.0.abc",
      toolName: "refundCustomer",
      args: { orderId: "4821", amount: 50 },
      context: { agentName: "support", tripIndex: 0, sessionId: "sess-1" },
      requestedAt: new Date().toISOString(),
    },
    status: "pending",
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("pg interrupt store", () => {
  it("should throw when neither client nor connectionString is given", () => {
    expect(() => pg({})).toThrow(/'client' or a 'connectionString'/);
  });

  it("should reject a client missing query()", () => {
    expect(() =>
      pg({ client: {} as unknown as PgClientLike }),
    ).toThrow(/client/);
  });

  it("should reject an unsafe table name", () => {
    const client = new FakePgClient();

    expect(() => pg({ client, table: "bad; DROP TABLE x" })).toThrow(
      /invalid table name/,
    );
  });

  it("should emit DDL for the configured table", () => {
    const client = new FakePgClient();
    const store = pg({ client, table: "warlock_ai_human_interrupts" });

    const ddl = store.schema();

    expect(ddl).toContain(
      "CREATE TABLE IF NOT EXISTS warlock_ai_human_interrupts",
    );
    expect(ddl).toContain("interrupt_id  TEXT PRIMARY KEY");
    expect(ddl).toContain("request       JSONB NOT NULL");
    expect(ddl).toContain("idx_warlock_ai_human_interrupts_saved_at");
  });

  it("should return undefined for an unknown interrupt id", async () => {
    const store = pg({ client: new FakePgClient() });

    expect(await store.load("missing")).toBeUndefined();
  });

  it("should round-trip a saved interrupt", async () => {
    const store = pg({ client: new FakePgClient() });
    const record = makeInterrupt();

    await store.save(record);
    const loaded = await store.load(record.interruptId);

    expect(loaded).toEqual(record);
  });

  it("should upsert (overwrite) the record for the same id", async () => {
    const client = new FakePgClient();
    const store = pg({ client });

    await store.save(makeInterrupt({ status: "pending" }));
    await store.save(makeInterrupt({ status: "resolved" }));

    const loaded = await store.load("support.sess-1.0.abc");

    expect(loaded?.status).toBe("resolved");
    expect(client.rows).toHaveLength(1);
  });

  it("should delete a record, leaving load undefined", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeInterrupt({ interruptId: "a" }));
    await store.delete("a");

    expect(await store.load("a")).toBeUndefined();
  });

  it("should list every known interrupt id", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeInterrupt({ interruptId: "a" }));
    await store.save(makeInterrupt({ interruptId: "b" }));

    expect((await store.list?.())?.sort()).toEqual(["a", "b"]);
  });

  it("should filter listed ids by prefix", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeInterrupt({ interruptId: "support.1" }));
    await store.save(makeInterrupt({ interruptId: "support.2" }));
    await store.save(makeInterrupt({ interruptId: "billing.1" }));

    const supportIds = await store.list?.("support.");

    expect(supportIds?.sort()).toEqual(["support.1", "support.2"]);
  });

  it("should treat underscores in the list prefix as literals", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeInterrupt({ interruptId: "a_1" }));
    await store.save(makeInterrupt({ interruptId: "ax1" }));

    expect(await store.list?.("a_")).toEqual(["a_1"]);
  });

  it("should surface the curated install string when pg is absent", async () => {
    // No `client` — the store lazily `import("pg")`, which the mock above
    // makes reject; the loader rethrows the curated install string on the
    // first operation that needs the client.
    const store = pg({ connectionString: "postgres://localhost/db" });

    await expect(store.save(makeInterrupt())).rejects.toThrow(
      /requires the pg package/,
    );
  });
});
