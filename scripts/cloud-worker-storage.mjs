import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const MAX_BYTES = 262144;
const error = () =>
  new Error(
    "Не удалось открыть защищённое хранилище входа обработчика. Повторите worker:login после проверки файла сессии.",
  );
const validKey = (key) =>
  typeof key === "string" &&
  /^[a-zA-Z0-9_.-]{1,200}$/.test(key) &&
  !["__proto__", "prototype", "constructor"].includes(key);
const powershellEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "systemroot",
        "windir",
        "userprofile",
        "appdata",
        "localappdata",
        "temp",
        "tmp",
      ].includes(key.toLowerCase()),
    ),
  );

// Only these fixed scripts execute. Token bytes travel over stdin, never argv.
const encryptScript = `Add-Type -AssemblyName System.Security; $raw = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $protected = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))`;
const decryptScript = `Add-Type -AssemblyName System.Security; $raw = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain))`;

function dpapi(bytes, encrypt) {
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) {
      reject(error());
      return;
    }
    const executable = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        encrypt ? encryptScript : decryptScript,
      ],
      {
        shell: false,
        windowsHide: true,
        env: powershellEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let settled = false,
      length = 0;
    const chunks = [];
    const finish = (failure, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(error());
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, 10000);
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_BYTES * 2) {
        child.kill();
        finish(true);
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(true));
    child.stdin.on("error", () => finish(true));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(true);
        return;
      }
      const value = Buffer.concat(chunks).toString("ascii").trim();
      if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        finish(true);
        return;
      }
      const decoded = Buffer.from(value, "base64");
      if (decoded.length > MAX_BYTES + 8192) {
        finish(true);
        return;
      }
      finish(false, decoded);
    });
    child.stdin.end(bytes.toString("base64"));
  });
}

/** SDK storage; Windows disk content is DPAPI CurrentUser ciphertext only. */
export function createWorkerStorage(projectRoot, { stateDirectory } = {}) {
  const projectId = createHash("sha256")
    .update(path.resolve(projectRoot))
    .digest("hex")
    .slice(0, 12);
  const windows = process.platform === "win32";
  const defaultRoot = windows
    ? path.join(
        process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
        "Vmeste",
        projectId,
      )
    : path.join(homedir(), ".local", "state", "vmeste", projectId);
  const directory = path.resolve(stateDirectory || defaultRoot);
  const sessionPath = path.join(
    directory,
    windows ? "worker-session.dpapi" : "worker-session.json",
  );
  let queue = Promise.resolve();
  let latest = queue;
  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw error();
    if (!windows) await chmod(directory, 0o700);
  }
  async function load() {
    await ensureDirectory();
    let info;
    try {
      info = await lstat(sessionPath);
    } catch (failure) {
      if (failure.code === "ENOENT") return Object.create(null);
      throw error();
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES + 8192)
      throw error();
    if (!windows) {
      await chmod(sessionPath, 0o600);
    }
    const raw = await readFile(sessionPath);
    const plain = windows ? await dpapi(raw, false) : raw;
    if (plain.length > MAX_BYTES) throw error();
    let values;
    try {
      values = JSON.parse(plain.toString("utf8"));
    } catch {
      throw error();
    }
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.entries(values).some(
        ([key, value]) => !validKey(key) || typeof value !== "string",
      )
    )
      throw error();
    return Object.assign(Object.create(null), values);
  }
  async function save(values) {
    await ensureDirectory();
    const plain = Buffer.from(JSON.stringify(values), "utf8");
    if (plain.length > MAX_BYTES) throw error();
    const bytes = windows ? await dpapi(plain, true) : plain;
    const temporary = path.join(
      directory,
      `worker-session-${randomUUID()}.tmp`,
    );
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, sessionPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  function serialize(action) {
    const current = queue.then(action, action).catch(() => {
      throw error();
    });
    latest = current;
    queue = current.catch(() => {});
    return current;
  }
  return {
    directory,
    sessionPath,
    getItem(key) {
      return serialize(async () => {
        if (!validKey(key)) throw error();
        const values = await load();
        return Object.hasOwn(values, key) ? values[key] : null;
      });
    },
    setItem(key, value) {
      return serialize(async () => {
        if (!validKey(key) || typeof value !== "string") throw error();
        const values = await load();
        values[key] = value;
        await save(values);
      });
    },
    removeItem(key) {
      return serialize(async () => {
        if (!validKey(key)) throw error();
        const values = await load();
        delete values[key];
        await save(values);
      });
    },
    flush() {
      return latest;
    },
  };
}
