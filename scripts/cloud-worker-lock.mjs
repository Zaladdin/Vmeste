import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const occupied = () =>
  new Error(
    "Локальный порт блокировки занят: возможно, обработчик уже запущен или порт использует другое приложение.",
  );
const legacy = () =>
  new Error(
    "Найдена блокировка старой версии. Сначала остановите все старые обработчики этого проекта, затем выполните npm run worker -- --recover-lock. См. docs/cloud-setup.md.",
  );

async function location(root) {
  const canonical = await realpath(root);
  const identity =
    process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const port =
    20000 +
    (createHash("sha256").update(identity).digest().readUInt32BE() % 20000);
  return {
    filename: path.join(canonical, ".local", "cloud-worker.lock"),
    port,
  };
}

async function hasLegacyLock(filename, port) {
  let raw;
  try {
    raw = await readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const value = JSON.parse(raw);
    return value.version !== 2 || value.port !== port;
  } catch {
    return true;
  }
}

// The socket, not this file, is the lock. The OS releases it even after a crash.
async function bind(port) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = (error) => {
      server.removeListener("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.removeListener("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
  let closing;
  return {
    release: () =>
      (closing ??= new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })),
  };
}

export async function acquireWorkerLock(root, { recoverLegacy = false } = {}) {
  const { filename, port } = await location(root);
  let lease;
  try {
    lease = await bind(port);
  } catch (error) {
    if (error.code === "EADDRINUSE") throw occupied();
    throw error;
  }
  try {
    if ((await hasLegacyLock(filename, port)) && !recoverLegacy) throw legacy();
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(
      filename,
      JSON.stringify({ version: 2, port, pid: process.pid }),
      { mode: 0o600 },
    );
    return lease;
  } catch (error) {
    await lease.release();
    throw error;
  }
}

// This checks exclusion only, never readiness, credentials or the paid queue.
export async function inspectWorkerLock(root) {
  const { filename, port } = await location(root);
  let lease;
  try {
    lease = await bind(port);
  } catch (error) {
    if (error.code === "EADDRINUSE") return "busy";
    throw error;
  }
  try {
    return (await hasLegacyLock(filename, port)) ? "legacy" : "available";
  } finally {
    await lease.release();
  }
}
