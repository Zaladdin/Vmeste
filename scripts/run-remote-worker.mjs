import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWorkerLock } from "./cloud-worker-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One private API and one queue consumer; a container restart never reclaims processing jobs. */
export async function superviseRemoteWorker({
  spawnImpl = spawn,
  fetcher = fetch,
  signals = /** @type {Pick<import("node:events").EventEmitter, "on" | "removeListener">} */ (process),
  cwd = root,
  startupTimeoutMs = 60_000,
  shutdownMs = 20_000,
  pollMs = 500,
} = {}) {
  const abort = new AbortController();
  let stopping = false,
    server,
    worker,
    resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  async function stopChild(child) {
    if (!child || child.closed) return;
    child.process.kill("SIGTERM");
    const expired = Symbol("expired");
    let timer;
    const result = await Promise.race([
      child.exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(expired), shutdownMs);
      }),
    ]);
    clearTimeout(timer);
    if (result === expired && !child.closed) {
      child.process.kill("SIGKILL");
      await child.exited;
    }
  }
  function stop(code) {
    if (stopping) return;
    stopping = true;
    abort.abort();
    // Keep the API alive while the consumer finishes or cancels an in-flight request.
    void (async () => {
      let status = code;
      try {
        await stopChild(worker);
      } catch {
        status = 1;
      }
      try {
        await stopChild(server);
      } catch {
        status = 1;
      }
      resolveDone(status);
    })();
  }
  function start(args) {
    const managed = { process: undefined, closed: false, exited: undefined };
    const child = spawnImpl(process.execPath, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    managed.process = child;
    managed.exited = new Promise((resolve) => {
      const closed = () => {
        if (managed.closed) return;
        managed.closed = true;
        resolve();
        if (!stopping) stop(1);
      };
      child.once("close", closed);
      child.once("error", closed);
    });
    return managed;
  }
  const terminate = () => stop(0);
  signals.on("SIGTERM", terminate);
  signals.on("SIGINT", terminate);
  try {
    server = start([
      path.join(cwd, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3000",
    ]);
    const deadline = Date.now() + startupTimeoutMs;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetcher("http://127.0.0.1:3000/api/recognize", {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        const configuration = response.ok ? await response.json() : null;
        if (
          configuration?.provider === "codex" &&
          configuration.configured === true
        ) {
          ready = true;
          break;
        }
      } catch {
        /* The private server may still be starting. */
      }
      await delay(pollMs, undefined, { signal: abort.signal }).catch(() => {});
    }
    if (!stopping) {
      if (ready) worker = start([path.join(cwd, "scripts/cloud-worker.mjs")]);
      else stop(1);
    }
  } catch {
    stop(1);
  }
  const code = await done;
  signals.removeListener("SIGTERM", terminate);
  signals.removeListener("SIGINT", terminate);
  return code;
}

function budgetState(raw) {
  if (Buffer.byteLength(raw, "utf8") > 4096)
    throw new Error("Некорректный файл лимита.");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Некорректный файл лимита.");
  }
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "day,limit,used,version" ||
    value.version !== 1 ||
    !Number.isInteger(value.limit) ||
    value.limit < 0 ||
    value.limit > 100 ||
    !Number.isSafeInteger(value.used) ||
    value.used < 0 ||
    typeof value.day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
  )
    throw new Error("Некорректный файл лимита.");
  const day = new Date(`${value.day}T00:00:00.000Z`);
  if (
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== value.day ||
    value.day > new Date().toISOString().slice(0, 10)
  )
    throw new Error("Некорректная дата файла лимита.");
  return value;
}

export async function restoreRecognitionBudget(raw, cwd = root) {
  const value = budgetState(raw);
  const directory = path.join(cwd, ".local");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lease = await acquireWorkerLock(cwd);
  let budgetLock;
  const temporary = path.join(directory, `restore-budget-${randomUUID()}.tmp`);
  try {
    budgetLock = await open(
      path.join(directory, "recognition-budget.lock"),
      "wx",
      0o600,
    );
    let previous;
    try {
      previous = budgetState(
        await readFile(path.join(directory, "recognition-budget.json"), "utf8"),
      );
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
    }
    if (
      previous &&
      ((previous.day === value.day && previous.used > value.used) ||
        (previous.day > value.day && previous.used > 0))
    )
      throw new Error("Нельзя уменьшать уже использованный дневной счётчик.");
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path.join(directory, "recognition-budget.json"));
  } finally {
    try {
      await rm(temporary, { force: true });
    } finally {
      try {
        if (budgetLock) {
          await budgetLock.close();
          await rm(path.join(directory, "recognition-budget.lock"), {
            force: true,
          });
        }
      } finally {
        await lease.release();
      }
    }
  }
}

async function main() {
  if (process.argv.includes("--restore-budget")) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > 4096)
        throw new Error("Некорректный файл лимита.");
    }
    await restoreRecognitionBudget(input);
    console.log("Дневной счётчик восстановлен. Обработчик не запускался.");
  } else process.exitCode = await superviseRemoteWorker();
}
async function entry() {
  // flock is a kernel lease shared by Docker containers using the state volume.
  // TCP single-instance locks alone cannot cross separate network namespaces.
  if (
    process.platform === "linux" &&
    !process.argv.includes("--kernel-lock-held")
  ) {
    await mkdir(path.join(root, ".local"), { recursive: true, mode: 0o700 });
    const child = spawn(
      "/usr/bin/flock",
      [
        "--nonblock",
        "--no-fork",
        path.join(root, ".local", "remote-runtime.lock"),
        process.execPath,
        fileURLToPath(import.meta.url),
        "--kernel-lock-held",
        ...process.argv.slice(2),
      ],
      { stdio: "inherit", shell: false },
    );
    const terminate = (signal) => child.kill(signal);
    const term = () => terminate("SIGTERM"),
      interrupt = () => terminate("SIGINT");
    process.on("SIGTERM", term);
    process.on("SIGINT", interrupt);
    process.exitCode = await new Promise((resolve) => {
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(code ?? 1));
    });
    process.removeListener("SIGTERM", term);
    process.removeListener("SIGINT", interrupt);
  } else await main();
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  entry().catch(() => {
    console.error(
      "Не удалось запустить закрытый обработчик или восстановить лимит. Проверьте docs/server-setup.md.",
    );
    process.exitCode = 1;
  });
}
