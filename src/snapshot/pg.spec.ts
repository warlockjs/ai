import { describe, expect, it } from "vitest";
import type { PgClientLike } from "../contracts/orchestrator/snapshot-store.contract";
import type { SupervisorSnapshot } from "../contracts/supervisor/supervisor-snapshot.type";
import { pg } from "./pg";

function makeSnapshot(
  overrides: Partial<SupervisorSnapshot> = {},
): SupervisorSnapshot {
  return {
    runId: "sess-1.unversioned.0",
    supervisorName: "support",
    signature: "sig-abc",
    input: "hello",
    iteration: 0,
    snapshots: [],
    status: "running",
    startedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

type StoredRow = { run_id: string; payload: string };

/**
 * A minimal in-memory fake of `pg.Pool` that satisfies {@link PgClientLike}.
 * It understands only the handful of statements the store issues, matched
 * by substring — enough to exercise the store's SQL without a real
 * database. Records every issued statement for assertion.
 */
function makeFakePg(): PgClientLike & {
  rows: Map<string, StoredRow>;
  statements: string[];
} {
  const rows = new Map<string, StoredRow>();
  const statements: string[] = [];

  async function query(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: unknown[] }> {
    statements.push(text);

    if (text.startsWith("INSERT INTO")) {
      const runId = params[0] as string;
      const payload = params[1] as string;
      rows.set(runId, { run_id: runId, payload });

      return { rows: [] };
    }

    if (text.startsWith("DELETE FROM")) {
      const runId = params[0] as string;
      rows.delete(runId);

      return { rows: [] };
    }

    if (text.startsWith("SELECT payload")) {
      const runId = params[0] as string;
      const row = rows.get(runId);

      return { rows: row ? [{ payload: row.payload }] : [] };
    }

    if (text.startsWith("SELECT run_id")) {
      if (text.includes("LIKE")) {
        const pattern = params[0] as string;
        const literalPrefix = pattern
          .replace(/\\([_%\\])/g, "$1")
          .replace(/%$/, "");
        const matched: { run_id: string }[] = [];

        for (const row of rows.values()) {
          if (row.run_id.startsWith(literalPrefix)) {
            matched.push({ run_id: row.run_id });
          }
        }

        return { rows: matched };
      }

      return {
        rows: Array.from(rows.values()).map((row) => ({ run_id: row.run_id })),
      };
    }

    return { rows: [] };
  }

  return { query, rows, statements };
}

describe("snapshot pg store", () => {
  it("should return undefined for an unknown runId", async () => {
    const client = makeFakePg();
    const store = pg({ client });

    const loaded = await store.load("missing");

    expect(loaded).toBeUndefined();
  });

  it("should round-trip a saved snapshot", async () => {
    const client = makeFakePg();
    const store = pg({ client });
    const snapshot = makeSnapshot({ iteration: 3 });

    await store.save(snapshot);
    const loaded = await store.load("sess-1.unversioned.0");

    expect(loaded).toEqual(snapshot);
  });

  it("should parse a payload handed back as an already-parsed object", async () => {
    const client = makeFakePg();
    const store = pg({ client });
    const snapshot = makeSnapshot({ iteration: 2 });

    await store.save(snapshot);
    // Some pool wrappers parse JSONB into a JS object before handing it
    // back — overwrite the stored string with the parsed value.
    const stored = client.rows.get("sess-1.unversioned.0");
    client.rows.set("sess-1.unversioned.0", {
      run_id: "sess-1.unversioned.0",
      payload: JSON.parse(stored!.payload),
    } as unknown as StoredRow);

    const loaded = await store.load("sess-1.unversioned.0");

    expect(loaded).toEqual(snapshot);
  });

  it("should overwrite the snapshot for the same runId", async () => {
    const client = makeFakePg();
    const store = pg({ client });

    await store.save(makeSnapshot({ iteration: 0, status: "running" }));
    await store.save(makeSnapshot({ iteration: 1, status: "completed" }));

    const loaded = await store.load("sess-1.unversioned.0");

    expect(loaded?.iteration).toBe(1);
    expect(loaded?.status).toBe("completed");
    expect(client.rows.size).toBe(1);
  });

  it("should issue an upsert on save", async () => {
    const client = makeFakePg();
    const store = pg({ client });

    await store.save(makeSnapshot());

    const insert = client.statements.find((statement) =>
      statement.startsWith("INSERT INTO"),
    );

    expect(insert).toContain("ON CONFLICT (run_id) DO UPDATE");
  });

  it("should delete a snapshot", async () => {
    const client = makeFakePg();
    const store = pg({ client });

    await store.save(makeSnapshot());
    await store.delete("sess-1.unversioned.0");

    expect(await store.load("sess-1.unversioned.0")).toBeUndefined();
  });

  it("should list known run ids", async () => {
    const client = makeFakePg();
    const store = pg({ client });

    await store.save(makeSnapshot({ runId: "a.unversioned.0" }));
    await store.save(makeSnapshot({ runId: "b.unversioned.0" }));

    const runIds = await store.list?.();

    expect(runIds?.sort()).toEqual(["a.unversioned.0", "b.unversioned.0"]);
  });

  it("should filter listed run ids by prefix", async () => {
    const client = makeFakePg();
    const store = pg({ client });

    await store.save(makeSnapshot({ runId: "sess-1.v1.0" }));
    await store.save(makeSnapshot({ runId: "sess-1.v1.1" }));
    await store.save(makeSnapshot({ runId: "sess-2.v1.0" }));

    const runIds = await store.list?.("sess-1.");

    expect(runIds?.sort()).toEqual(["sess-1.v1.0", "sess-1.v1.1"]);
  });

  it("should escape LIKE wildcards in the list prefix", async () => {
    const client = makeFakePg();
    const store = pg({ client });

    await store.save(makeSnapshot({ runId: "sess_1.v1.0" }));
    await store.save(makeSnapshot({ runId: "sessX1.v1.0" }));

    const runIds = await store.list?.("sess_1");

    expect(runIds).toEqual(["sess_1.v1.0"]);
  });

  it("should expose the default table in the DDL", () => {
    const client = makeFakePg();
    const store = pg({ client });

    const ddl = store.schema();

    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS warlock_supervisor_snapshots");
    expect(ddl).toContain("run_id    TEXT PRIMARY KEY");
    expect(ddl).toContain("payload   JSONB NOT NULL");
  });

  it("should honor a custom table name in queries and DDL", async () => {
    const client = makeFakePg();
    const store = pg({ client, table: "my_snapshots" });

    await store.save(makeSnapshot());

    expect(store.schema()).toContain(
      "CREATE TABLE IF NOT EXISTS my_snapshots",
    );
    expect(
      client.statements.some((statement) =>
        statement.includes("INSERT INTO my_snapshots"),
      ),
    ).toBe(true);
  });

  it("should reject an unsafe table name", () => {
    const client = makeFakePg();

    expect(() => pg({ client, table: "evil; DROP TABLE x" })).toThrow(
      /invalid table name/,
    );
  });

  it("should reject a missing client", () => {
    expect(() =>
      pg({ client: undefined as unknown as PgClientLike }),
    ).toThrow(/requires a 'client'/);
  });
});
