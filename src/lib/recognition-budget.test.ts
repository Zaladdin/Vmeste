import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecognitionBudgetStore } from "./recognition-budget";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vmeste-budget-test-"));
});
afterEach(async () => {
  if (
    path.dirname(root) === tmpdir() &&
    path.basename(root).startsWith("vmeste-budget-test-")
  )
    await rm(root, { recursive: true, force: true });
});
describe("persistent daily recognition limit", () => {
  it("reports a stuck lock and preserves usage during manual recovery", async () => {
    const store = createRecognitionBudgetStore(root);
    await store.reserve();
    const lockfile = path.join(root, "recognition-budget.lock");
    await writeFile(lockfile, "");
    await expect(store.get()).rejects.toThrow(/блокировку дневного лимита/);
    await rm(lockfile);
    expect(await store.get()).toMatchObject({ used: 1, remaining: 9 });
  });
  it("fails closed on an invalid calendar date without resetting usage", async () => {
    const store = createRecognitionBudgetStore(root);
    await store.reserve();
    const filename = path.join(root, "recognition-budget.json");
    await writeFile(
      filename,
      JSON.stringify({ version: 1, day: "2026-10-00", used: 10, limit: 10 }),
    );
    await expect(store.reserve()).rejects.toMatchObject({ status: 503 });
    expect(JSON.parse(await readFile(filename, "utf8")).used).toBe(10);
  });
  it("starts at ten attempts and persists across new instances", async () => {
    const store = createRecognitionBudgetStore(root);
    expect(await store.get()).toMatchObject({
      limit: 10,
      used: 0,
      remaining: 10,
      estimate: { model: "gpt-6.1-sol", credits: 0.65 },
    });
    await store.reserve();
    expect(await createRecognitionBudgetStore(root).get()).toMatchObject({
      used: 1,
      remaining: 9,
    });
  });
  it("never exceeds the limit with concurrent requests or independent instances", async () => {
    const first = createRecognitionBudgetStore(root),
      second = createRecognitionBudgetStore(root);
    await first.setLimit(2);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).reserve()),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    // Contention may fail closed with 503 before quota exhaustion yields 429.
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toHaveLength(6);
    expect(failures.every((r) => [429, 503].includes(r.reason.status))).toBe(
      true,
    );
    expect(await first.get()).toMatchObject({ used: 2, remaining: 0 });
  });
  it("keeps attempts when lowering/raising the limit and supports pausing", async () => {
    const store = createRecognitionBudgetStore(root);
    await store.reserve();
    await store.setLimit(0);
    await expect(store.reserve()).rejects.toMatchObject({ status: 429 });
    expect(await store.setLimit(3)).toMatchObject({ used: 1, remaining: 2 });
  });
  it("resets only at UTC midnight and retains the configured limit", async () => {
    let now = new Date("2026-10-28T23:59:59Z");
    const store = createRecognitionBudgetStore(root, () => now);
    await store.setLimit(2);
    await store.reserve();
    expect((await store.get()).resetAt).toBe("2026-10-29T00:00:00.000Z");
    now = new Date("2026-10-29T00:00:00Z");
    expect(await store.get()).toMatchObject({
      used: 0,
      remaining: 2,
      limit: 2,
    });
  });
  it.each([-1, 101, 1.5, NaN])("rejects invalid limit %s", async (limit) => {
    await expect(
      createRecognitionBudgetStore(root).setLimit(limit),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("fails closed on corrupt state instead of resetting the counter", async () => {
    const store = createRecognitionBudgetStore(root);
    await store.reserve();
    const filename = path.join(root, "recognition-budget.json");
    const before = await readFile(filename, "utf8");
    await writeFile(filename, "broken");
    await expect(store.reserve()).rejects.toMatchObject({ status: 503 });
    expect(await readFile(filename, "utf8")).toBe("broken");
    await writeFile(filename, before);
    expect(await store.get()).toMatchObject({ used: 1 });
  });
  it("refuses to reset when the clock moves back a day", async () => {
    let now = new Date("2026-10-29T10:00Z");
    const store = createRecognitionBudgetStore(root, () => now);
    await store.reserve();
    now = new Date("2026-10-28T10:00Z");
    await expect(store.reserve()).rejects.toMatchObject({ status: 503 });
  });
});
