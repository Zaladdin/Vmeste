import { createWorkerStorage } from "./cloud-worker-storage.mjs";
import { createClient } from "@supabase/supabase-js";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  localServerOrigin,
  processNextCloudJob,
} from "./cloud-worker-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateDirectory = path.join(root, ".local");
const lockFile = path.join(privateDirectory, "cloud-worker.lock");
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());
const storage = createWorkerStorage(root);
async function passwordPrompt() {
  if (!process.stdin.isTTY)
    throw new Error("Выполните worker:login в интерактивном терминале.");
  process.stdout.write("Пароль (ввод скрыт): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", input);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const input = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          finish(new Error("Вход отменён."));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", input);
  });
}
async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error(
      "Добавьте Project URL и публичный Publishable key Supabase в .env.local по инструкции docs/cloud-setup.md.",
    );
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Укажите HTTPS Project URL Supabase.");
  if (key.startsWith("sb_secret_"))
    throw new Error(
      "Обработчик использует только публичный ключ и вход пользователя; service_role не нужен.",
    );
  if (key.split(".").length === 3) {
    try {
      if (
        JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())
          .role !== "anon"
      )
        throw new Error();
    } catch {
      throw new Error("Используйте публичный anon/Publishable key.");
    }
  }
  const origin = localServerOrigin(process.env.VMESTE_LOCAL_SERVER_URL);
  await mkdir(privateDirectory, { recursive: true });
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch {
    throw new Error(
      "Обработчик уже запущен или осталась блокировка после сбоя. См. docs/cloud-setup.md.",
    );
  }
  let client;
  try {
    client = createClient(url, key, {
      auth: {
        storage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input, options = {}) =>
          fetch(input, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
              : AbortSignal.timeout(30000),
          }),
      },
    });
    if (process.argv.includes("--login")) {
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const email = (
        await terminal.question("Email аккаунта приложения: ")
      ).trim();
      terminal.close();
      const password = await passwordPrompt();
      const signed = await client.auth.signInWithPassword({ email, password });
      if (signed.error)
        throw new Error(
          "Не удалось войти. Проверьте email, пароль и подтверждение почты.",
        );
      await storage.flush();
      console.log(
        "Вход обработчика сохранён локально. Codex использует свой прежний вход ChatGPT.",
      );
      return;
    }
    const verified = await client.auth.getUser();
    if (verified.error || !verified.data.user)
      throw new Error("Сначала войдите: npm run worker:login.");
    const userId = verified.data.user.id;
    const once = process.argv.includes("--once");
    let previous = "";
    console.log(
      "Обработчик запущен. Только задания вошедшего пользователя; остановка Ctrl+C.",
    );
    do {
      let ready = false;
      try {
        const [provider, budget] = await Promise.all([
          fetch(`${origin}/api/recognize`, {
            signal: AbortSignal.timeout(5000),
          }),
          fetch(`${origin}/api/recognize/budget`, {
            signal: AbortSignal.timeout(5000),
          }),
        ]);
        const configuration = provider.ok ? await provider.json() : null;
        const allowance = budget.ok ? await budget.json() : null;
        if (configuration?.provider !== "codex") throw new Error();
        ready =
          Number.isInteger(allowance?.remaining) && allowance.remaining > 0;
      } catch {
        if (previous !== "server")
          console.log(
            "Ожидаем локальный сервер Codex. Запустите npm run build и npm start.",
          );
        previous = "server";
      }
      if (ready) {
        const status = await processNextCloudJob(client, userId, {
          origin,
          signal: stop.signal,
        });
        if (status !== "idle" || previous !== status)
          console.log(
            status === "completed"
              ? "Задание обработано и результат сохранён."
              : status === "failed"
                ? "Задание завершилось ошибкой; автоматического повтора нет."
                : "Ожидаем задания.",
          );
        previous = status;
      } else if (previous !== "server" && previous !== "paused") {
        console.log("Ожидаем доступного дневного лимита локального сервера.");
        previous = "paused";
      }
      if (once || stop.signal.aborted) break;
      await delay(5000, undefined, { signal: stop.signal }).catch(() => {});
    } while (!stop.signal.aborted);
  } finally {
    client?.auth.stopAutoRefresh();
    try {
      await storage.flush();
    } finally {
      await lock.close();
      await rm(lockFile, { force: true });
    }
  }
}
main().catch((error) => {
  if (!stop.signal.aborted)
    console.error(
      error instanceof Error && /^[А-ЯЁ]/u.test(error.message)
        ? error.message
        : "Не удалось запустить обработчик. Проверьте настройки; секреты в журнал не выводятся.",
    );
  process.exitCode = 1;
});
