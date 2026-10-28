"use client";
import { useState, type FormEvent } from "react";
import { Dialog, Field, FormError } from "./dialog";
import {
  type BookingDraft,
  type ImportOptions,
  type RecognitionResult,
} from "@/lib/recognition";
import { eventKinds } from "@/lib/model";

export function RecognitionReview({
  result,
  message,
  onApply,
  onClose,
}: {
  result: RecognitionResult;
  message: string;
  onApply: (drafts: BookingDraft[], options: ImportOptions) => Promise<void>;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState(result.events);
  const [expandDates, setExpandDates] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function update(index: number, key: keyof BookingDraft, value: string) {
    setDrafts((current) =>
      current.map((draft, i) =>
        i === index
          ? { ...draft, [key]: key === "title" ? value : value || null }
          : draft,
      ),
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onApply(
        drafts.map((draft) => ({
          ...draft,
          needsReview: false,
          reviewReason: null,
        })),
        { reviewed: true, expandDates },
      );
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Не удалось добавить события. Проверьте поля.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Проверьте распознанные события"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form className="editor" onSubmit={submit}>
        <p className="muted">
          {message ||
            "Уточните пропущенные поля и подтвердите данные из документа."}
        </p>
        {result.warnings.length ? (
          <div className="recognition-warning">
            {result.warnings.map((warning, i) => (
              <p key={i}>{warning}</p>
            ))}
          </div>
        ) : null}
        <div className="recognition-drafts">
          {drafts.map((draft, index) => (
            <fieldset className="recognition-draft" key={index}>
              <legend>
                {index + 1}. {eventKinds[draft.kind]}
              </legend>
              {draft.reviewReason ? (
                <p className="muted">{draft.reviewReason}</p>
              ) : null}
              <Field label="Название">
                <input
                  required
                  maxLength={160}
                  value={draft.title}
                  onChange={(e) => update(index, "title", e.target.value)}
                />
              </Field>
              <div className="form-grid">
                <Field label="Дата начала">
                  <input
                    type="date"
                    required
                    value={draft.date ?? ""}
                    onChange={(e) => update(index, "date", e.target.value)}
                  />
                </Field>
                <Field label="Время начала">
                  <input
                    type="time"
                    required
                    value={draft.time ?? ""}
                    onChange={(e) => update(index, "time", e.target.value)}
                  />
                </Field>
              </div>
              <Field
                label="Часовой пояс начала"
                hint="Например, Asia/Baku или Europe/Istanbul"
              >
                <input
                  required
                  placeholder="Europe/Istanbul"
                  value={draft.timeZone ?? ""}
                  onChange={(e) => update(index, "timeZone", e.target.value)}
                />
              </Field>
              <div className="form-grid">
                <Field
                  label={
                    draft.kind === "stay"
                      ? "Дата выселения"
                      : "Дата окончания / прилёта"
                  }
                >
                  <input
                    type="date"
                    required={draft.kind !== "transport" || !!draft.endTime}
                    value={draft.endDate ?? ""}
                    onChange={(e) => update(index, "endDate", e.target.value)}
                  />
                </Field>
                <Field
                  label={
                    draft.kind === "stay"
                      ? "Время выселения"
                      : "Время окончания / прилёта"
                  }
                >
                  <input
                    type="time"
                    required={draft.kind !== "transport" || !!draft.endDate}
                    value={draft.endTime ?? ""}
                    onChange={(e) => update(index, "endTime", e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Часовой пояс окончания">
                <input
                  required={
                    draft.kind !== "transport" ||
                    !!draft.endDate ||
                    !!draft.endTime
                  }
                  value={draft.endTimeZone ?? ""}
                  onChange={(e) => update(index, "endTimeZone", e.target.value)}
                />
              </Field>
              <Field label="Место или адрес">
                <input
                  maxLength={300}
                  value={draft.location}
                  onChange={(e) =>
                    setDrafts((current) =>
                      current.map((item, i) =>
                        i === index
                          ? { ...item, location: e.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Заметки">
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={draft.details}
                  onChange={(e) =>
                    setDrafts((current) =>
                      current.map((item, i) =>
                        i === index
                          ? { ...item, details: e.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </Field>
              <button
                type="button"
                className="text-button danger-text"
                onClick={() =>
                  setDrafts((current) => current.filter((_, i) => i !== index))
                }
                disabled={busy}
              >
                Исключить это событие
              </button>
            </fieldset>
          ))}
        </div>
        <label className="recognition-check">
          <input
            type="checkbox"
            checked={expandDates}
            onChange={(e) => setExpandDates(e.target.checked)}
          />
          <span>Разрешить расширить даты поездки по бронированию</span>
        </label>
        <FormError message={error} />
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Позже
          </button>
          <button className="button primary" disabled={busy || !drafts.length}>
            {busy ? "Добавляем…" : "Добавить в план"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
