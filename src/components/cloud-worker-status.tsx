"use client";
import { useEffect, useState } from "react";
import {
  readWorkerStatus,
  workerIsFresh,
  type WorkerStatus,
} from "@/lib/cloud-client";

export function CloudWorkerStatus({ userId }: { userId: string }) {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true,
      pending = false;
    setStatus(null);
    setError("");
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const next = await readWorkerStatus(userId);
        if (active) {
          setStatus(next);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Статус неизвестен.");
      } finally {
        pending = false;
        if (active) setNow(Date.now());
      }
    }
    void poll();
    const timer = setInterval(() => {
      setNow(Date.now());
      void poll();
    }, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [userId]);
  const fresh = status && !error && workerIsFresh(status, now);
  return (
    <aside
      className="recognition-notice"
      aria-label="Обработчик и лимит распознавания"
    >
      <p>
        {fresh
          ? status.state === "available"
            ? "Обработчик доступен для распознавания."
            : status.state === "paused"
              ? "Распознавание приостановлено: проверьте дневной лимит."
              : "Обработчик запущен, но сервис распознавания недоступен."
          : "Доступность обработчика неизвестна: свежего подтверждения нет."}
      </p>
      {status ? (
        <p>
          Обновлено: {new Date(status.observed_at).toLocaleString("ru-RU")}
          {!fresh ? " · данные устарели или не подтверждены" : ""}.
          {fresh && status.remaining !== null && status.daily_limit !== null
            ? ` Осталось попыток: ${status.remaining} из ${status.daily_limit}.`
            : ""}
        </p>
      ) : null}
      {error ? <p>{error}</p> : null}
      <p>
        Ориентир до отправки: около 0,65 кредита за запуск gpt-6.1-sol; документ
        может потребовать несколько запусков. Это оценка, не баланс аккаунта и
        не точная стоимость. Лимит проверяется перед запуском распознавания.
      </p>
    </aside>
  );
}
