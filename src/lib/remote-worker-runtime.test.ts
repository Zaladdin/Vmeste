import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  superviseRemoteWorker,
  restoreRecognitionBudget,
} from "../../scripts/run-remote-worker.mjs";
import {
  acquireWorkerLock,
  inspectWorkerLock,
} from "../../scripts/cloud-worker-lock.mjs";

async function workspace() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const directory = await mkdtemp(
      path.join(tmpdir(), "vmeste-remote-budget-"),
    );
    try {
      if ((await inspectWorkerLock(directory)) === "available")
        return directory;
    } catch (error: any) {
      if (error.code !== "EACCES") throw error;
    }
    await rm(directory, { recursive: true, force: true });
  }
  throw new Error("No available test lock namespace");
}

function child() {
  const process = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
  };
  process.kill = vi.fn(() => {
    queueMicrotask(() => process.emit("close", 0));
    return true;
  });
  return process;
}

describe("private remote worker supervisor", () => {
  it("waits for the loopback API before starting the queue worker and stops both on SIGTERM", async () => {
    const server = child(),
      worker = child(),
      signals = new EventEmitter();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(server)
      .mockReturnValueOnce(worker);
    let ready!: (value: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          ready = resolve;
        }),
    );
    const running = superviseRemoteWorker({
      spawnImpl: spawn,
      fetcher,
      signals,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toContain("127.0.0.1");
    ready(Response.json({ provider: "codex", configured: true }));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    signals.emit("SIGTERM");
    expect(await running).toBe(0);
    expect(worker.kill).toHaveBeenCalledWith("SIGTERM");
    expect(server.kill).toHaveBeenCalledWith("SIGTERM");
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops the API and exits unsuccessfully when the queue worker exits unexpectedly", async () => {
    const server = child(),
      worker = child();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(server)
      .mockReturnValueOnce(worker);
    const running = superviseRemoteWorker({
      spawnImpl: spawn,
      signals: new EventEmitter(),
      fetcher: async () =>
        Response.json({ provider: "codex", configured: true }),
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    worker.emit("close", 0);
    expect(await running).toBe(1);
    expect(server.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("never starts a worker when API startup fails", async () => {
    const server = child();
    const spawn = vi.fn().mockReturnValue(server);
    const running = superviseRemoteWorker({
      spawnImpl: spawn,
      signals: new EventEmitter(),
      fetcher: async () => {
        throw new Error("not ready");
      },
      startupTimeoutMs: 1,
      pollMs: 1,
    });
    expect(await running).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(server.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops the queue worker if the API exits unexpectedly", async () => {
    const server = child(),
      worker = child();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(server)
      .mockReturnValueOnce(worker);
    const running = superviseRemoteWorker({
      spawnImpl: spawn,
      signals: new EventEmitter(),
      fetcher: async () =>
        Response.json({ provider: "codex", configured: true }),
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    server.emit("close", 1);
    expect(await running).toBe(1);
    expect(worker.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("imports the exact daily usage and rejects invalid replacement without losing it", async () => {
    const directory = await workspace();
    const state = {
      version: 1,
      day: new Date().toISOString().slice(0, 10),
      limit: 10,
      used: 10,
    };
    try {
      await restoreRecognitionBudget(JSON.stringify(state), directory);
      const filename = path.join(
        directory,
        ".local",
        "recognition-budget.json",
      );
      expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(state);
      await expect(
        restoreRecognitionBudget(
          JSON.stringify({ ...state, used: -1 }),
          directory,
        ),
      ).rejects.toThrow();
      await expect(
        restoreRecognitionBudget(
          JSON.stringify({ ...state, day: "2099-01-01" }),
          directory,
        ),
      ).rejects.toThrow();
      await expect(
        restoreRecognitionBudget(
          JSON.stringify({ ...state, extra: true }),
          directory,
        ),
      ).rejects.toThrow();
      await expect(
        restoreRecognitionBudget(
          JSON.stringify({ ...state, used: 9 }),
          directory,
        ),
      ).rejects.toThrow(/уменьшать/);
      expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(state);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses active worker or budget locks and preserves corrupted existing state", async () => {
    const directory = await workspace();
    const state = {
      version: 1,
      day: new Date().toISOString().slice(0, 10),
      limit: 10,
      used: 10,
    };
    try {
      const lease = await acquireWorkerLock(directory);
      try {
        await expect(
          restoreRecognitionBudget(JSON.stringify(state), directory),
        ).rejects.toThrow(/занят/);
      } finally {
        await lease.release();
      }
      const lock = path.join(directory, ".local", "recognition-budget.lock");
      await writeFile(lock, "");
      await expect(
        restoreRecognitionBudget(JSON.stringify(state), directory),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(lock, "utf8")).toBe("");
      await rm(lock);
      const filename = path.join(
        directory,
        ".local",
        "recognition-budget.json",
      );
      await writeFile(filename, "{broken");
      await expect(
        restoreRecognitionBudget(JSON.stringify(state), directory),
      ).rejects.toThrow();
      expect(await readFile(filename, "utf8")).toBe("{broken");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
