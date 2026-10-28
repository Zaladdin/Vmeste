"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { STATIC_HOSTING } from "@/lib/deployment";

const budgetSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  limit: z.number().int().min(0).max(100).nullable(),
  unlimited: z.boolean().optional(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().min(0).max(100).nullable(),
  resetAt: z.string().datetime(),
  estimate: z.object({
    model: z.string().min(1).max(100),
    credits: z.number().finite().nonnegative(),
  }),
});
export type RecognitionBudgetStatus = z.infer<typeof budgetSchema>;

export function useRecognitionBudget() {
  const [status, setStatus] = useState<RecognitionBudgetStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!STATIC_HOSTING);
  const [saving, setSaving] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const updating = useRef(false);

  const request = useCallback(async (limit?: number) => {
    if (STATIC_HOSTING) return false;
    if (updating.current) return false;
    if (limit !== undefined) updating.current = true;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setError("");
    if (limit === undefined) setLoading(true);
    else setSaving(true);
    try {
      const response = await fetch("/api/recognize/budget", {
        method: limit === undefined ? "GET" : "PATCH",
        cache: "no-store",
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(8_000)]),
        ...(limit === undefined
          ? {}
          : {
              headers: {
                "content-type": "application/json",
                "x-vmeste-recognition": "1",
              },
              body: JSON.stringify({ limit }),
            }),
      });
      const raw: unknown = await response.json().catch(() => {
        throw new Error(
          "Не удалось прочитать настройки лимита. Попробуйте ещё раз.",
        );
      });
      if (!response.ok) {
        const failure = z.object({ error: z.string().max(500) }).safeParse(raw);
        throw new Error(
          failure.success
            ? failure.data.error
            : "Не удалось проверить дневной лимит.",
        );
      }
      const parsed = budgetSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error("Сервер вернул непонятные настройки лимита.");
      if (!current.signal.aborted) setStatus(parsed.data);
      return !current.signal.aborted;
    } catch (failure) {
      if (current.signal.aborted) return false;
      setError(
        failure instanceof Error &&
          !(failure instanceof TypeError) &&
          failure.name !== "TimeoutError"
          ? failure.message
          : "Нет связи с сервером. Документы можно сохранять без распознавания.",
      );
      return false;
    } finally {
      if (limit !== undefined) updating.current = false;
      if (controller.current === current) {
        setLoading(false);
        setSaving(false);
      }
    }
  }, []);

  const refresh = useCallback(() => request(), [request]);
  useEffect(() => {
    if (STATIC_HOSTING) return;
    void refresh();
    const reload = () => {
      void refresh();
    };
    window.addEventListener("focus", reload);
    window.addEventListener("online", reload);
    return () => {
      controller.current?.abort();
      window.removeEventListener("focus", reload);
      window.removeEventListener("online", reload);
    };
  }, [refresh]);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(
      () => {
        void refresh();
      },
      Math.min(
        86_400_000,
        Math.max(1000, new Date(status.resetAt).getTime() - Date.now() + 250),
      ),
    );
    return () => window.clearTimeout(timer);
  }, [status, refresh]);

  return { status, error, loading, saving, refresh, setLimit: request };
}

export function RecognitionBudget({
  budget,
  disabled,
}: {
  budget: ReturnType<typeof useRecognitionBudget>;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [validation, setValidation] = useState("");
  const helpId = useId();
  const status = budget.status;
  const value = draft ?? (status ? String(status.limit) : "");
  const reset = status
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(status.resetAt))
    : null;
  async function save() {
    if (!/^\d{1,3}$/.test(value) || Number(value) > 100) {
      setValidation("Введите целое число от 0 до 100.");
      return;
    }
    setValidation("");
    if (await budget.setLimit(Number(value))) setDraft(null);
  }
  return (
    <section
      className="recognition-budget"
      aria-label="Лимит и расход распознавания"
    >
      <div className="recognition-budget-summary">
        <strong>Дневной лимит распознавания</strong>
        <p aria-live="polite">
          {status
            ? status.unlimited
              ? `Дневной лимит отключён. Сегодня использовано попыток: ${status.used}.`
              : `Сегодня использовано: ${status.used} из ${status.limit}. Осталось попыток: ${status.remaining}.`
            : budget.loading
              ? "Проверяем дневной лимит…"
              : "Лимит проверяется сервером перед каждым распознаванием."}
        </p>
        {status ? (
          <p>
            Обновление счётчика: {reset}.{" "}
            {status.limit === 0
              ? "Распознавание приостановлено."
              : status.remaining === 0
                ? "Лимит исчерпан. Файлы можно сохранять без распознавания."
                : ""}
          </p>
        ) : null}
        <p>
          Ориентир: ≈
          {(status?.estimate.credits ?? 0.65).toLocaleString("ru-RU")} кредита
          за попытку через Codex для {status?.estimate.model ?? "gpt-6.1-sol"}{" "}
          на стандартной скорости. Это ориентир по тестовому билету, а не тариф
          OpenAI API. Фактический расход зависит от документа и модели.
          Повторная попытка по изображениям считается отдельно. Это лимит
          попыток, а не жёсткий предел кредитов.
        </p>
      </div>
      {!status?.unlimited ? (
        <div className="recognition-budget-controls">
          <label>
            Попыток в день
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={value}
              onChange={(event) => {
                setDraft(event.target.value);
                setValidation("");
              }}
              disabled={disabled || budget.loading || budget.saving || !status}
              aria-describedby={helpId}
            />
          </label>
          <button
            className="button secondary"
            onClick={() => void save()}
            disabled={
              disabled ||
              budget.loading ||
              budget.saving ||
              !status ||
              value === String(status.limit)
            }
          >
            {budget.saving ? "Сохраняем…" : "Сохранить лимит"}
          </button>
          <small id={helpId}>
            0 — остановить распознавание. Лимит общий для всех поездок на этом
            сервере.
          </small>
        </div>
      ) : null}
      {validation || budget.error ? (
        <p className="form-error" role="alert">
          {validation || budget.error}
          {budget.error ? (
            <>
              {" "}
              <button
                className="text-button"
                onClick={() => void budget.refresh()}
                disabled={disabled || budget.loading || budget.saving}
              >
                Повторить проверку
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
