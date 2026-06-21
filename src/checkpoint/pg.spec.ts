import { describe, expect, it } from "vitest";
import type { CheckpointRecord } from "../contracts/orchestrator/checkpoint-store.contract";
import type { PgClientLike } from "../contracts/orchestrator/snapshot-store.contract";
import { pg } from "./pg";

/**
 * A single stored row in the fake — column names mirror the §8.6 DDL.
 * `state` is held as the JSON string the driver writes (`$4::jsonb`), so
 * the fake exercises the same serialize/parse round-trip a real `pg`
 * client does.
 */
type FakeRow = {
  orchestrator_name: string;
  session_id: string;
  turn_index: number;
  state: string;
  last_route: string | null;
  signature: string;
  version: string | null;
  summarized_through: number | null;
  lock_acquired_at: string | null;
  lock_expires_at: string | null;
  saved_at: string;
};

/**
 * In-memory {@link PgClientLike} that recognizes the exact query shapes
 * the pg checkpoint store issues — INSERT, latest-turn SELECT, DELETE,
 * DISTINCT-session list (with/without LIKE), and the retention prune.
 * It is not a SQL engine; it pattern-matches the store's own SQL so the
 * test stays a faithful contract check without a real database.
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
      return this.handleInsert(params);
    }

    if (sql.startsWith("SELECT * FROM")) {
      return this.handleLoad(params);
    }

    if (sql.startsWith("SELECT DISTINCT session_id")) {
      return this.handleList(sql, params);
    }

    if (sql.startsWith("DELETE FROM") && sql.includes("turn_index < (")) {
      return this.handlePrune(params);
    }

    if (sql.startsWith("DELETE FROM")) {
      return this.handleDelete(params);
    }

    throw new Error(`FakePgClient: unrecognized query: ${sql}`);
  }

  private handleInsert(params: unknown[]): { rows: unknown[] } {
    this.rows.push({
      orchestrator_name: params[0] as string,
      session_id: params[1] as string,
      turn_index: params[2] as number,
      state: params[3] as string,
      last_route: params[4] as string | null,
      signature: params[5] as string,
      version: params[6] as string | null,
      summarized_through: params[7] as number | null,
      lock_acquired_at: params[8] as string | null,
      lock_expires_at: params[9] as string | null,
      saved_at: params[10] as string,
    });

    return { rows: [] };
  }

  private handleLoad(params: unknown[]): { rows: unknown[] } {
    const [orchestratorName, sessionId] = params as [string, string];

    const matches = this.rows
      .filter(
        (row) =>
          row.orchestrator_name === orchestratorName &&
          row.session_id === sessionId,
      )
      .sort((left, right) => right.turn_index - left.turn_index);

    return { rows: matches.length > 0 ? [matches[0]] : [] };
  }

  private handleList(sql: string, params: unknown[]): { rows: unknown[] } {
    const orchestratorName = params[0] as string;
    const matches = this.rows.filter(
      (row) => row.orchestrator_name === orchestratorName,
    );

    let sessionIds = [...new Set(matches.map((row) => row.session_id))];

    if (sql.includes("LIKE")) {
      const escapedPattern = params[1] as string;
      const prefix = escapedPattern
        .replace(/%$/, "")
        .replace(/\\_/g, "_")
        .replace(/\\%/g, "%")
        .replace(/\\\\/g, "\\");
      sessionIds = sessionIds.filter((id) => id.startsWith(prefix));
    }

    return { rows: sessionIds.map((session_id) => ({ session_id })) };
  }

  private handleDelete(params: unknown[]): { rows: unknown[] } {
    const [orchestratorName, sessionId] = params as [string, string];

    this.rows = this.rows.filter(
      (row) =>
        !(
          row.orchestrator_name === orchestratorName &&
          row.session_id === sessionId
        ),
    );

    return { rows: [] };
  }

  private handlePrune(params: unknown[]): { rows: unknown[] } {
    const [orchestratorName, sessionId, keepSnapshots] = params as [
      string,
      string,
      number,
    ];

    const sessionRows = this.rows.filter(
      (row) =>
        row.orchestrator_name === orchestratorName &&
        row.session_id === sessionId,
    );

    if (sessionRows.length === 0) {
      return { rows: [] };
    }

    const maxTurnIndex = Math.max(
      ...sessionRows.map((row) => row.turn_index),
    );
    const threshold = maxTurnIndex - keepSnapshots;

    this.rows = this.rows.filter(
      (row) =>
        !(
          row.orchestrator_name === orchestratorName &&
          row.session_id === sessionId &&
          row.turn_index < threshold
        ),
    );

    return { rows: [] };
  }
}

function makeRecord(
  overrides: Partial<CheckpointRecord> = {},
): CheckpointRecord {
  return {
    orchestrator_name: "support",
    session_id: "sess-1",
    turn_index: 0,
    state: { count: 0 },
    last_route: null,
    signature: "sig-abc",
    version: null,
    summarized_through: null,
    lock_acquired_at: null,
    lock_expires_at: null,
    saved_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("checkpoint pg store", () => {
  it("should throw when no client is provided", () => {
    expect(() => pg({} as never)).toThrow(/client/);
  });

  it("should reject an unsafe table name", () => {
    const client = new FakePgClient();

    expect(() => pg({ client, table: "bad; DROP TABLE x" })).toThrow(
      /invalid table name/,
    );
  });

  it("should emit DDL matching the §8.6 reference for the configured table", () => {
    const client = new FakePgClient();
    const store = pg({ client, table: "warlock_orchestrator_sessions" });

    const ddl = store.schema();

    expect(ddl).toContain(
      "CREATE TABLE IF NOT EXISTS warlock_orchestrator_sessions",
    );
    expect(ddl).toContain(
      "PRIMARY KEY (orchestrator_name, session_id, turn_index)",
    );
    expect(ddl).toContain("state                JSONB NOT NULL");
    expect(ddl).toContain(
      "idx_warlock_orchestrator_sessions_lookup",
    );
  });

  it("should return undefined for an unknown session", async () => {
    const store = pg({ client: new FakePgClient() });

    const loaded = await store.load("support", "missing");

    expect(loaded).toBeUndefined();
  });

  it("should round-trip a saved checkpoint", async () => {
    const store = pg({ client: new FakePgClient() });
    const record = makeRecord({ state: { count: 7 } });

    await store.save(record);
    const loaded = await store.load("support", "sess-1");

    expect(loaded).toEqual(record);
  });

  it("should return the latest turn for a session", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeRecord({ turn_index: 0, state: { count: 0 } }));
    await store.save(makeRecord({ turn_index: 1, state: { count: 1 } }));
    await store.save(makeRecord({ turn_index: 2, state: { count: 2 } }));

    const loaded = await store.load("support", "sess-1");

    expect(loaded?.turn_index).toBe(2);
    expect(loaded?.state).toEqual({ count: 2 });
  });

  it("should round-trip a fan-out last_route array", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeRecord({ last_route: ["lookup", "process"] }));
    const loaded = await store.load("support", "sess-1");

    expect(loaded?.last_route).toEqual(["lookup", "process"]);
  });

  it("should isolate sessions by orchestrator name", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(
      makeRecord({ orchestrator_name: "support", session_id: "a" }),
    );
    await store.save(
      makeRecord({ orchestrator_name: "billing", session_id: "a" }),
    );

    const supportSession = await store.load("support", "a");
    const billingSession = await store.load("billing", "a");

    expect(supportSession?.orchestrator_name).toBe("support");
    expect(billingSession?.orchestrator_name).toBe("billing");
  });

  it("should delete every row for a session", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeRecord({ turn_index: 0 }));
    await store.save(makeRecord({ turn_index: 1 }));
    await store.delete("support", "sess-1");

    expect(await store.load("support", "sess-1")).toBeUndefined();
  });

  it("should list distinct session ids scoped to an orchestrator", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeRecord({ session_id: "a", turn_index: 0 }));
    await store.save(makeRecord({ session_id: "a", turn_index: 1 }));
    await store.save(makeRecord({ session_id: "b", turn_index: 0 }));
    await store.save(
      makeRecord({ orchestrator_name: "billing", session_id: "c" }),
    );

    const supportSessions = await store.list?.("support");

    expect(supportSessions?.sort()).toEqual(["a", "b"]);
  });

  it("should filter listed sessions by prefix", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeRecord({ session_id: "user-1" }));
    await store.save(makeRecord({ session_id: "user-2" }));
    await store.save(makeRecord({ session_id: "guest-1" }));

    const userSessions = await store.list?.("support", "user-");

    expect(userSessions?.sort()).toEqual(["user-1", "user-2"]);
  });

  it("should treat underscores in the list prefix as literals", async () => {
    const store = pg({ client: new FakePgClient() });

    await store.save(makeRecord({ session_id: "a_1" }));
    await store.save(makeRecord({ session_id: "ax1" }));

    const matches = await store.list?.("support", "a_");

    expect(matches).toEqual(["a_1"]);
  });

  it("should prune turns below max - keepSnapshots", async () => {
    const client = new FakePgClient();
    const store = pg({ client });

    for (let turn = 0; turn <= 5; turn++) {
      await store.save(makeRecord({ turn_index: turn }));
    }

    const pruneable = store as unknown as {
      prune(name: string, sessionId: string, keep: number): Promise<void>;
    };
    await pruneable.prune("support", "sess-1", 2);

    const remaining = client.rows
      .map((row) => row.turn_index)
      .sort((left, right) => left - right);

    expect(remaining).toEqual([3, 4, 5]);
  });

  it("should no-op prune for a non-finite keep bound", async () => {
    const client = new FakePgClient();
    const store = pg({ client });

    await store.save(makeRecord({ turn_index: 0 }));
    await store.save(makeRecord({ turn_index: 1 }));

    const pruneable = store as unknown as {
      prune(name: string, sessionId: string, keep: number): Promise<void>;
    };
    await pruneable.prune("support", "sess-1", Number.POSITIVE_INFINITY);

    expect(client.rows).toHaveLength(2);
    expect(
      client.queries.some((query) => query.includes("turn_index < (")),
    ).toBe(false);
  });
});
