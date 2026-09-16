import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { cascadeScopedBudgetStore } from "./cascade-scoped-budget-store";

const suite = process.env.AI_CASCADE_MONGO_TESTS === "1" ? describe : describe.skip;
const port = 27121;
const database = "ai_scoped_budget_test";
const table = "ai_scoped_budget_ledger";

type MongoHarness = {
  close(): Promise<void>;
  dropCollection(): Promise<void>;
  createUniqueIndex(): Promise<void>;
};

suite("cascadeScopedBudgetStore against MongoDB", () => {
  let mongod: ChildProcess | undefined;
  let dbpath: string | undefined;
  let harness: MongoHarness;

  beforeAll(async () => {
    dbpath = await mkdtemp(join(tmpdir(), "warlock-ai-scoped-budget-"));
    mongod = spawn(
      "D:/MongoDB/bin/mongod.exe",
      ["--dbpath", dbpath, "--port", String(port), "--quiet"],
      {
        stdio: "ignore",
      },
    );
    await waitForMongo();
    harness = await startMongoHarness();
    await harness.dropCollection();
    await harness.createUniqueIndex();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
    await stopMongo(mongod);
    if (dbpath) {
      await rm(dbpath, { recursive: true, force: true });
    }
  });

  it("allows exactly ten of fifty parallel reservations", async () => {
    const store = await cascadeScopedBudgetStore({ table });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.reserve({
          key: "tenant.concurrent",
          windowStart: Date.UTC(2026, 8, 17),
          unit: "tokens",
          amount: 1,
          limit: 10,
        }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
  });
});

async function stopMongo(process: ChildProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
    process.kill("SIGKILL");
  });
}

async function waitForMongo(): Promise<void> {
  const { MongoClient } = await import("mongodb");
  const uri = `mongodb://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const client = new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 250 });
    try {
      await client.connect();
      await client.close();
      return;
    } catch {
      await client.close().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error("Timed out waiting for the scoped-budget MongoDB test server.");
}

async function startMongoHarness(): Promise<MongoHarness> {
  const cascade = await import("@warlock.js/cascade");
  const driver = new cascade.MongoDbDriver({
    uri: `mongodb://127.0.0.1:${port}`,
    database,
    logging: false,
    clientOptions: { directConnection: true },
  });
  await driver.connect();
  cascade.dataSourceRegistry.register(
    new cascade.DataSource({ name: "ai-scoped-budget-test", driver, isDefault: true }),
  );
  const collection = driver.getDatabase().collection(table);

  return {
    close: async () => {
      await driver.disconnect();
      cascade.dataSourceRegistry.clear();
    },
    dropCollection: async () => {
      await collection.drop().catch(() => undefined);
    },
    createUniqueIndex: async () => {
      await collection.createIndex({ key: 1, windowStart: 1, unit: 1 }, { unique: true });
    },
  };
}
