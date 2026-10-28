import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkerStorage } from "../../scripts/cloud-worker-storage.mjs";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vmeste-session-test-"));
});
afterEach(async () => {
  if (
    path.dirname(root) === tmpdir() &&
    path.basename(root).startsWith("vmeste-session-test-")
  )
    await rm(root, { recursive: true, force: true });
});
describe("private worker session storage", () => {
  it("roundtrips synthetic sessions and encrypts all disk content on Windows", async () => {
    const storage = createWorkerStorage("E:/synthetic-project", {
      stateDirectory: path.join(root, "state"),
    });
    const secret = "dummy-refresh-token-for-storage-tests-only";
    await storage.setItem("auth", secret);
    await storage.flush();
    expect(await storage.getItem("auth")).toBe(secret);
    const raw = await readFile(storage.sessionPath);
    if (process.platform === "win32") {
      expect(raw.toString("utf8")).not.toContain(secret);
      expect(storage.sessionPath).toMatch(/\.dpapi$/);
    }
    const reopened = createWorkerStorage("E:/synthetic-project", {
      stateDirectory: path.join(root, "state"),
    });
    expect(await reopened.getItem("auth")).toBe(secret);
  }, 15000);
  it("serializes writes and removes only the selected SDK key without temp files", async () => {
    const storage = createWorkerStorage("E:/synthetic-project", {
      stateDirectory: path.join(root, "state"),
    });
    await Promise.all([
      storage.setItem("first", "one"),
      storage.setItem("second", "two"),
    ]);
    await storage.removeItem("first");
    await storage.flush();
    expect(await storage.getItem("first")).toBeNull();
    expect(await storage.getItem("second")).toBe("two");
    expect(await readdir(storage.directory)).toEqual([
      path.basename(storage.sessionPath),
    ]);
  }, 20000);
  it("fails closed on corrupted ciphertext or invalid JSON", async () => {
    const storage = createWorkerStorage("E:/synthetic-project", {
      stateDirectory: path.join(root, "state"),
    });
    await storage.setItem("auth", "dummy");
    await writeFile(storage.sessionPath, "corrupt");
    await expect(storage.getItem("auth")).rejects.toThrow(/хранилище/);
    await expect(storage.flush()).rejects.toThrow(/хранилище/);
  }, 15000);
  it("rejects dangerous map keys and non-string values", async () => {
    const storage = createWorkerStorage("E:/synthetic-project", {
      stateDirectory: path.join(root, "state"),
    });
    await expect(storage.setItem("__proto__", "dummy")).rejects.toThrow();
    await expect(
      storage.setItem("auth", 123 as unknown as string),
    ).rejects.toThrow();
  });
});
