"use client";
import { useState, type FormEvent } from "react";
import { Dialog, Field, FormError } from "./dialog";
import {
  type BookingDraft,
  type ImportOptions,
  type RecognitionResult,
} from "@/lib/recognition";
import { eventKinds } from "@/lib/model";
import { completeReviewDate, parsePartialDate } from "@/lib/review-date";
import { documentPeople } from "@/lib/document-people";

function ReviewDate({
  value,
  required,
  onChange,
}: {
  value: string | null;
  required: boolean;
  onChange: (value: string) => void;
}) {
  const [originalValue] = useState(value);
  const [partial] = useState(() => parsePartialDate(value));
  const [text, setText] = useState(partial ?? "");
  if (partial)
    return (
      <>
        <span className="muted">
          В документе: {partial.slice(0, -1)} — уточните год
        </span>
        <input
          type="text"
          inputMode="numeric"
          required={required}
          pattern="[0-9]{2}\.[0-9]{2}\.[0-9]{4}"
          maxLength={10}
          placeholder="ДД.ММ.ГГГГ"
          title="Введите полную дату: ДД.ММ.ГГГГ"
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            const fullDate = completeReviewDate(next);
            e.currentTarget.setCustomValidity(
              fullDate ? "" : "Укажите существующую дату в формате ДД.ММ.ГГГГ",
            );
            onChange(fullDate ?? originalValue ?? "");
          }}
        />
      </>
    );
  return (
    <input
      type="date"
      required={required}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

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
  const [rowIds, setRowIds] = useState(() =>
    result.events.map(() => crypto.randomUUID()),
  );
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
            <fieldset className="recognition-draft" key={rowIds[index]}>
              <legend>
                {index + 1}. {eventKinds[draft.kind]}
              </legend>
              {draft.reviewReason ? (
                <p className="muted">{draft.reviewReason}</p>
              ) : null}
              {documentPeople(draft.details).length ? (
                <p className="recognized-people">
                  <strong>Пассажиры / гости:</strong>{" "}
                  {documentPeople(draft.details).join(" · ")}
                </p>
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
                  <ReviewDate
                    required
                    value={draft.date}
                    onChange={(value) => update(index, "date", value)}
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
                  <ReviewDate
                    required={draft.kind !== "transport" || !!draft.endTime}
                    value={draft.endDate}
                    onChange={(value) => update(index, "endDate", value)}
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
                onClick={() => {
                  setDrafts((current) => current.filter((_, i) => i !== index));
                  setRowIds((current) => current.filter((_, i) => i !== index));
                }}
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
