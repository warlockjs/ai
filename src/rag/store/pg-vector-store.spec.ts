import { describe, expect, it, vi } from "vitest";
import {
  pgVectorStore,
  vectorLiteral,
  type PgClientLike,
} from "./pg-vector-store";

// Simulate `pg` NOT being installed: a dynamic `import("pg")` rejects, so
// the store's lazy loader must surface the curated install string — never
// a raw resolution error. Scoped to this file; the round-trip tests below
// use a passed-in `{ client }` and never trigger the dynamic import, so the
// mock leaves them untouched.
vi.mock("pg", () => {
  throw new Error("Cannot find module 'pg'");
});

/**
 * A single stored row in the fake — column names mirror the reference DDL.
 * `value` is held as the JSON string the driver writes (`$2::jsonb`),
 * `embedding` as the pgvector literal the driver sends (`$3::vector`), so
 * the fake exercises the same serialize/parse round-trip a real `pg`
 * client does.
 */
interface FakeRow {
  key: string;
  value: string;
  embedding: string;
  tags: string[];
}

/** Parse a pgvector text literal (`[1,2,3]`) back into a `number[]`. */
function parseVectorLiteral(literal: string): number[] {
  const inner = literal.slice(1, -1).trim();

  if (inner.length === 0) {
    return [];
  }

  return inner.split(",").map((component) => Number(component));
}

/** Cosine distance between two vectors — the `<=>` operator the store orders by. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 1;
  }

  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * In-memory {@link PgClientLike} that recognizes the exact query shapes the
 * pg vector store issues — the upsert INSERT, the cosine SELECT (with
 * optional threshold + tags filters), and the namespace DELETE. It is not a
 * SQL engine; it pattern-matches the store's own SQL so the test stays a
 * faithful contract check without a real database, and records every
 * `(text, params)` pair so tests can assert the SQL + bound parameters.
 */
class FakePgClient implements PgClientLike {
  public rows: FakeRow[] = [];

  public calls: { text: string; params: unknown[] }[] = [];

  public async query(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: unknown[] }> {
    this.calls.push({ text, params });
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO")) {
      return this.handleUpsert(params);
    }

    if (sql.startsWith("SELECT key, value")) {
      return this.handleQuery(sql, params);
    }

    if (sql.startsWith("DELETE FROM")) {
      return this.handleDelete(params);
    }

    throw new Error(`FakePgClient: unrecognized query: ${sql}`);
  }

  private handleUpsert(params: unknown[]): { rows: unknown[] } {
    const [key, value, embedding, tags] = params as [
      string,
      string,
      string,
      string[],
    ];

    const existing = this.rows.find((row) => row.key === key);

    if (existing) {
      existing.value = value;
      existing.embedding = embedding;
      existing.tags = tags;

      return { rows: [] };
    }

    this.rows.push({ key, value, embedding, tags });

    return { rows: [] };
  }

  private handleQuery(sql: string, params: unknown[]): { rows: unknown[] } {
    const queryVector = parseVectorLiteral(params[0] as string);
    const topK = params[1] as number;

    // Threshold ($3) and tags ($4) are appended in that order only when
    // present, so the placeholder index reveals which filters are live.
    let distanceBound: number | undefined;
    let tagsFilter: string[] | undefined;
    let nextParam = 2;

    if (sql.includes("<=> $1::vector) <= $")) {
      distanceBound = params[nextParam] as number;
      nextParam += 1;
    }

    if (sql.includes("tags && $")) {
      tagsFilter = params[nextParam] as string[];
    }

    let matched = this.rows.map((row) => ({
      row,
      distance: cosineDistance(queryVector, parseVectorLiteral(row.embedding)),
    }));

    if (distanceBound !== undefined) {
      matched = matched.filter((entry) => entry.distance <= distanceBound!);
    }

    if (tagsFilter !== undefined) {
      matched = matched.filter((entry) =>
        entry.row.tags.some((tag) => tagsFilter!.includes(tag)),
      );
    }

    matched.sort((left, right) => left.distance - right.distance);

    return {
      rows: matched.slice(0, topK).map((entry) => ({
        key: entry.row.key,
        value: entry.row.value,
        distance: String(entry.distance),
      })),
    };
  }

  private handleDelete(params: unknown[]): { rows: unknown[] } {
    const [exact, likePattern] = params as [string, string];

    // `<namespace>.%` → literal `<namespace>.` prefix once LIKE-escapes are
    // unwound; rows match on exact namespace OR that dotted prefix.
    const prefix = likePattern
      .replace(/\.%$/, ".")
      .replace(/\\_/g, "_")
      .replace(/\\%/g, "%")
      .replace(/\\\\/g, "\\");

    this.rows = this.rows.filter(
      (row) => row.key !== exact && !row.key.startsWith(prefix),
    );

    return { rows: [] };
  }
}

describe("vectorLiteral", () => {
  it("serializes a number[] to a bracketed pgvector literal", () => {
    expect(vectorLiteral([1, 2, 3])).toBe("[1,2,3]");
    expect(vectorLiteral([1, 0.5, -2])).toBe("[1,0.5,-2]");
    expect(vectorLiteral([])).toBe("[]");
  });

  it("rejects non-finite components", () => {
    expect(() => vectorLiteral([1, Number.NaN, 3])).toThrow(/not finite/);
    expect(() => vectorLiteral([Number.POSITIVE_INFINITY])).toThrow(/not finite/);
  });
});

describe("pgVectorStore construction", () => {
  it("throws when neither client nor connectionString is given", () => {
    expect(() => pgVectorStore({})).toThrow(/'client' or a 'connectionString'/);
  });

  it("rejects a client missing query()", () => {
    expect(() =>
      pgVectorStore({ client: {} as unknown as PgClientLike }),
    ).toThrow(/client/);
  });

  it("rejects an unsafe table name", () => {
    const client = new FakePgClient();

    expect(() => pgVectorStore({ client, table: "bad; DROP TABLE x" })).toThrow(
      /invalid table name/,
    );
  });
});

describe("pgVectorStore.ensureSchema", () => {
  it("emits the extension, table, and an HNSW index by default", () => {
    const store = pgVectorStore({ client: new FakePgClient(), dimensions: 1536 });

    const ddl = store.ensureSchema();

    expect(ddl).toContain("CREATE EXTENSION IF NOT EXISTS vector;");
    expect(ddl).toContain(
      "CREATE TABLE IF NOT EXISTS warlock_ai_rag_vectors",
    );
    expect(ddl).toContain("key        TEXT PRIMARY KEY");
    expect(ddl).toContain("value      JSONB NOT NULL");
    expect(ddl).toContain("embedding  vector(1536) NOT NULL");
    expect(ddl).toContain("tags       TEXT[] NOT NULL DEFAULT '{}'");
    expect(ddl).toContain("USING gin (tags)");
    expect(ddl).toContain("USING hnsw (embedding vector_cosine_ops)");
  });

  it("schema() and ensureSchema() return identical DDL", () => {
    const store = pgVectorStore({ client: new FakePgClient() });

    expect(store.ensureSchema()).toBe(store.schema());
  });

  it("emits an ivfflat index with the configured list count", () => {
    const store = pgVectorStore({
      client: new FakePgClient(),
      table: "custom_vectors",
      index: "ivfflat",
      ivfflatLists: 200,
    });

    const ddl = store.ensureSchema();

    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS custom_vectors");
    expect(ddl).toContain(
      "USING ivfflat (embedding vector_cosine_ops)",
    );
    expect(ddl).toContain("WITH (lists = 200)");
  });

  it("emits no ANN index when index is 'none'", () => {
    const store = pgVectorStore({ client: new FakePgClient(), index: "none" });

    const ddl = store.ensureSchema();

    expect(ddl).not.toContain("USING hnsw");
    expect(ddl).not.toContain("USING ivfflat");
    expect(ddl).toContain('index: "none"');
  });
});

describe("pgVectorStore.upsert", () => {
  it("issues an ON CONFLICT upsert with json + vector + tags params", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0], ["docs"]);

    const insert = client.calls.find((call) =>
      call.text.includes("INSERT INTO"),
    );

    expect(insert).toBeDefined();
    expect(insert!.text).toContain("ON CONFLICT (key) DO UPDATE");
    expect(insert!.text).toContain("$2::jsonb");
    expect(insert!.text).toContain("$3::vector");
    expect(insert!.text).toContain("$4::text[]");
    expect(insert!.params[0]).toBe("ns.a");
    expect(insert!.params[1]).toBe(JSON.stringify({ text: "alpha" }));
    expect(insert!.params[2]).toBe("[1,0,0]");
    expect(insert!.params[3]).toEqual(["docs"]);
  });

  it("defaults tags to an empty array when none are given", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0]);

    expect(client.rows[0].tags).toEqual([]);
  });

  it("overwrites (upserts) the row for the same key", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ns.a", { text: "first" }, [1, 0, 0]);
    await store.upsert("ns.a", { text: "second" }, [0, 1, 0]);

    expect(client.rows).toHaveLength(1);
    expect(JSON.parse(client.rows[0].value)).toEqual({ text: "second" });
    expect(client.rows[0].embedding).toBe("[0,1,0]");
  });
});

describe("pgVectorStore.query", () => {
  it("round-trips upsert → query, mapping cosine distance to a [0,1] score", async () => {
    const store = pgVectorStore({ client: new FakePgClient() });

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0]);
    await store.upsert("ns.b", { text: "beta" }, [0, 1, 0]);

    const hits = await store.query<{ text: string }>([1, 0, 0], { topK: 5 });

    expect(hits[0].key).toBe("ns.a");
    expect(hits[0].value.text).toBe("alpha");
    // Identical vector → distance 0 → score 1.
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits.every((hit) => hit.score >= 0 && hit.score <= 1)).toBe(true);
  });

  it("caps the result at topK via LIMIT $2", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ns.a", { text: "a" }, [1, 0, 0]);
    await store.upsert("ns.b", { text: "b" }, [0.9, 0.1, 0]);
    await store.upsert("ns.c", { text: "c" }, [0.8, 0.2, 0]);

    const hits = await store.query<{ text: string }>([1, 0, 0], { topK: 2 });

    const select = client.calls.find((call) =>
      call.text.includes("SELECT key, value"),
    );

    expect(select!.text).toContain("LIMIT $2");
    expect(select!.params[1]).toBe(2);
    expect(hits).toHaveLength(2);
  });

  it("translates a similarity threshold into a distance bound (1 - threshold)", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0]);
    await store.upsert("ns.b", { text: "beta" }, [0, 1, 0]);

    const hits = await store.query<{ text: string }>([1, 0, 0], {
      topK: 5,
      threshold: 0.9,
    });

    const select = client.calls.find((call) =>
      call.text.includes("SELECT key, value"),
    );

    // similarity >= 0.9  ⇔  distance <= 0.1
    expect(select!.text).toContain("(embedding <=> $1::vector) <= $3");
    expect(select!.params[2]).toBeCloseTo(0.1, 10);
    expect(hits.every((hit) => hit.score >= 0.9)).toBe(true);
    expect(hits.some((hit) => hit.key === "ns.b")).toBe(false);
  });

  it("restricts to tagged rows via array overlap when tags are given", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0], ["docs"]);
    await store.upsert("ns.b", { text: "beta" }, [1, 0, 0], ["tickets"]);

    const hits = await store.query<{ text: string }>([1, 0, 0], {
      topK: 5,
      tags: ["docs"],
    });

    const select = client.calls.find((call) =>
      call.text.includes("SELECT key, value"),
    );

    expect(select!.text).toContain("tags && $3::text[]");
    expect(select!.params[2]).toEqual(["docs"]);
    expect(hits.map((hit) => hit.key)).toEqual(["ns.a"]);
  });

  it("binds threshold to $3 and tags to $4 when both are present", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0], ["docs"]);

    await store.query<{ text: string }>([1, 0, 0], {
      topK: 5,
      threshold: 0.5,
      tags: ["docs"],
    });

    const select = client.calls.find((call) =>
      call.text.includes("SELECT key, value"),
    );

    expect(select!.text).toContain("(embedding <=> $1::vector) <= $3");
    expect(select!.text).toContain("tags && $4::text[]");
    expect(select!.params[2]).toBeCloseTo(0.5, 10);
    expect(select!.params[3]).toEqual(["docs"]);
  });

  it("emits no WHERE clause when neither threshold nor tags are given", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ns.a", { text: "alpha" }, [1, 0, 0]);
    await store.query<{ text: string }>([1, 0, 0], { topK: 5 });

    const select = client.calls.find((call) =>
      call.text.includes("SELECT key, value"),
    );

    expect(select!.text).not.toContain("WHERE");
  });

  it("parses a value handed back as a raw JSON string", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    // The fake stores `value` as the JSON string the driver wrote, so this
    // exercises the string branch of parseValue (some pool wrappers do not
    // auto-parse JSONB).
    await store.upsert("ns.a", { nested: { ok: true } }, [1, 0, 0]);

    const hits = await store.query<{ nested: { ok: boolean } }>([1, 0, 0], {
      topK: 1,
    });

    expect(hits[0].value.nested.ok).toBe(true);
  });
});

describe("pgVectorStore.removeNamespace", () => {
  it("deletes the exact namespace and its dotted-prefix children", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("scope.one", { text: "x" }, [1, 0, 0]);
    await store.upsert("scope.two", { text: "y" }, [1, 0, 0]);
    await store.upsert("scope", { text: "self" }, [1, 0, 0]);

    await store.removeNamespace("scope");

    const remaining = await store.query<{ text: string }>([1, 0, 0], { topK: 5 });

    expect(remaining).toHaveLength(0);

    const del = client.calls.find((call) => call.text.includes("DELETE FROM"));

    expect(del!.text).toContain("key = $1 OR key LIKE $2 ESCAPE '\\'");
    expect(del!.params[0]).toBe("scope");
    expect(del!.params[1]).toBe("scope.%");
  });

  it("does not delete a sibling namespace sharing a prefix", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("ai.rag.docs.g.0", { text: "keep-not" }, [1, 0, 0]);
    await store.upsert("ai.rag.docs2.g.0", { text: "keep" }, [1, 0, 0]);

    await store.removeNamespace("ai.rag.docs");

    const remaining = await store.query<{ text: string }>([1, 0, 0], { topK: 5 });

    expect(remaining.map((hit) => hit.key)).toEqual(["ai.rag.docs2.g.0"]);
  });

  it("escapes LIKE wildcards in the namespace so they match literally", async () => {
    const client = new FakePgClient();
    const store = pgVectorStore({ client });

    await store.upsert("a_x.0", { text: "underscore" }, [1, 0, 0]);
    await store.upsert("abx.0", { text: "literal-x" }, [1, 0, 0]);

    await store.removeNamespace("a_x");

    const del = client.calls.find((call) => call.text.includes("DELETE FROM"));

    // `_` escaped to `\_` so it is not treated as a single-char wildcard.
    expect(del!.params[1]).toBe("a\\_x.%");

    const remaining = await store.query<{ text: string }>([1, 0, 0], { topK: 5 });

    expect(remaining.map((hit) => hit.key)).toEqual(["abx.0"]);
  });
});

describe("pgVectorStore lazy pg import", () => {
  it("surfaces the curated install string when pg is absent", async () => {
    // No `client` — the store lazily `import("pg")`, which the mock above
    // makes reject; the loader rethrows the curated install string on the
    // first operation that needs the client.
    const store = pgVectorStore({ connectionString: "postgres://localhost/db" });

    await expect(
      store.upsert("k", {}, [1, 0, 0]),
    ).rejects.toThrow(/requires the pg package/);
  });
});
