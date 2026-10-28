import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import net from "node:net";
import {
  acquireWorkerLock,
  inspectWorkerLock,
} from "../../scripts/cloud-worker-lock.mjs";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const directories: string[] = [];
const releases: Array<() => Promise<void>> = [];
async function workspace() {
  // Random test paths can hash to ports reserved by Windows or another app.
  // Production never skips a busy lock; fixtures choose an unused namespace.
  for (let attempt = 0; attempt < 20; attempt++) {
    const root = await mkdtemp(path.join(tmpdir(), "vmeste-lock-test-"));
    directories.push(root);
    try {
      if ((await inspectWorkerLock(root)) === "available") return root;
    } catch (error: any) {
      if (error.code !== "EACCES") throw error;
    }
  }
  throw new Error("No available test lock namespace");
}
afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()));
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("worker process lifetime lock", () => {
  it("allows exactly one simultaneous acquisition", async () => {
    const root = await workspace();
    const results = await Promise.allSettled([
      acquireWorkerLock(root),
      acquireWorkerLock(root),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    for (const result of winners) {
      if (result.status === "fulfilled") releases.push(result.value.release);
    }
    expect(winners).toHaveLength(1);
  });

  it("excludes a second worker even with explicit legacy recovery", async () => {
    const root = await workspace();
    const lock = await acquireWorkerLock(root);
    releases.push(lock.release);
    await expect(acquireWorkerLock(root)).rejects.toThrow(/занят/);
    await expect(
      acquireWorkerLock(root, { recoverLegacy: true }),
    ).rejects.toThrow(/занят/);
    expect(await inspectWorkerLock(root)).toBe("busy");
  });

  it("restarts after clean shutdown without deleting metadata", async () => {
    const root = await workspace();
    const first = await acquireWorkerLock(root);
    await first.release();
    expect(
      JSON.parse(
        await readFile(path.join(root, ".local/cloud-worker.lock"), "utf8"),
      ).version,
    ).toBe(2);
    expect(await inspectWorkerLock(root)).toBe("available");
    const second = await acquireWorkerLock(root);
    releases.push(second.release);
  });

  it("requires explicit migration of a legacy empty lock and status does not alter it", async () => {
    const root = await workspace();
    await mkdir(path.join(root, ".local"));
    const filename = path.join(root, ".local/cloud-worker.lock");
    await writeFile(filename, "");
    expect(await inspectWorkerLock(root)).toBe("legacy");
    await expect(acquireWorkerLock(root)).rejects.toThrow(/recover-lock/);
    expect(await readFile(filename, "utf8")).toBe("");
    const lock = await acquireWorkerLock(root, { recoverLegacy: true });
    releases.push(lock.release);
  });

  it("fails closed for unreadable metadata format until explicit recovery", async () => {
    const root = await workspace();
    await mkdir(path.join(root, ".local"));
    await writeFile(path.join(root, ".local/cloud-worker.lock"), "{broken");
    await expect(acquireWorkerLock(root)).rejects.toThrow(/recover-lock/);
  });

  it("status on a new workspace creates no local files", async () => {
    const root = await workspace();
    expect(await inspectWorkerLock(root)).toBe("available");
    await expect(
      readFile(path.join(root, ".local/cloud-worker.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on metadata filesystem errors and releases the socket", async () => {
    const root = await workspace();
    const filename = path.join(root, ".local/cloud-worker.lock");
    await mkdir(filename, { recursive: true });
    await expect(inspectWorkerLock(root)).rejects.toMatchObject({
      code: "EISDIR",
    });
    await expect(
      acquireWorkerLock(root, { recoverLegacy: true }),
    ).rejects.toMatchObject({ code: "EISDIR" });
    await rm(filename, { recursive: true });
    const lock = await acquireWorkerLock(root);
    releases.push(lock.release);
  });

  it("closes connections without exposing an API or holding shutdown open", async () => {
    const root = await workspace();
    const lock = await acquireWorkerLock(root);
    releases.push(lock.release);
    const { port } = JSON.parse(
      await readFile(path.join(root, ".local/cloud-worker.lock"), "utf8"),
    );
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const closed = once(socket, "close");
    await closed;
    expect(socket.destroyed).toBe(true);
    await lock.release();
  });

  it("refuses a port occupied by an unrelated service", async () => {
    const root = await workspace();
    const first = await acquireWorkerLock(root);
    const { port } = JSON.parse(
      await readFile(path.join(root, ".local/cloud-worker.lock"), "utf8"),
    );
    await first.release();
    const server = net.createServer();
    const listening = once(server, "listening");
    server.listen({ host: "127.0.0.1", port, exclusive: true });
    await listening;
    try {
      expect(await inspectWorkerLock(root)).toBe("busy");
      await expect(
        acquireWorkerLock(root, { recoverLegacy: true }),
      ).rejects.toThrow(/другое приложение/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("releases the socket if writing metadata fails", async () => {
    const root = await workspace();
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("write failed"));
    await expect(acquireWorkerLock(root)).rejects.toThrow("write failed");
    const lock = await acquireWorkerLock(root);
    releases.push(lock.release);
  });

  it("releases the OS lock after an unclean process termination", async () => {
    const root = await workspace();
    const moduleUrl = pathToFileURL(
      path.resolve("scripts/cloud-worker-lock.mjs"),
    ).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { acquireWorkerLock } = await import(${JSON.stringify(moduleUrl)}); await acquireWorkerLock(${JSON.stringify(root)}); console.log('ready');`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const ready = await Promise.race([
        once(child.stdout!, "data").then(([data]) => String(data).trim()),
        once(child, "exit").then(() => "exited"),
      ]);
      expect(ready).toBe("ready");
      await expect(acquireWorkerLock(root)).rejects.toThrow(/занят/);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const lock = await acquireWorkerLock(root);
      releases.push(lock.release);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
});
