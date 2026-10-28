"use client";
import { useEffect, useRef, useState } from "react";
import {
  Upload,
  FileText,
  ArrowUpRight,
  Trash2,
  Paperclip,
  ScanLine,
  Check,
  LoaderCircle,
} from "lucide-react";
import {
  type Trip,
  type StoredDocument,
  validateDocument,
  formatDate,
  linkedEventIds,
} from "@/lib/model";
import {
  getDocument,
  removeDocument,
  saveUploadedDocument,
  beginRecognition,
  applyRecognition,
  failRecognition,
} from "@/lib/storage";
import { fileFingerprint, recognizeFile } from "@/lib/recognition-client";
import { type BookingDraft, type ImportOptions } from "@/lib/recognition";
import { RecognitionReview } from "./recognition-review";
import { RecognitionBudget, useRecognitionBudget } from "./recognition-budget";
import { STATIC_HOSTING } from "@/lib/deployment";
export function Documents({
  trip,
  documents,
  eventId,
  onRefresh,
  onImported,
  onProcessing,
  onPlan,
}: {
  trip: Trip;
  documents: StoredDocument[];
  eventId?: string;
  onRefresh: () => Promise<void>;
  onImported: (trip: Trip) => void;
  onProcessing: (processing: boolean) => void;
  onPlan: (eventId?: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(eventId ?? "");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [autoRecognize, setAutoRecognize] = useState(!STATIC_HOSTING);
  const [phase, setPhase] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<StoredDocument | null>(null);
  const operation = useRef(false);
  const budget = useRecognitionBudget();
  const [provider, setProvider] = useState<"codex" | "openai" | null>(null);
  useEffect(() => {
    if (STATIC_HOSTING || !navigator.onLine) return;
    const controller = new AbortController();
    fetch("/api/recognize", { cache: "no-store", signal: controller.signal })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (
          !controller.signal.aborted &&
          (data?.provider === "codex" || data?.provider === "openai")
        )
          setProvider(data.provider);
      })
      .catch(() => {
        /* Offline: documents remain usable without provider status. */
      });
    return () => controller.abort();
  }, []);
  const message = (e: unknown) =>
    e instanceof Error
      ? e.message
      : "Не удалось обработать документ. Попробуйте ещё раз.";
  async function upload(file?: File) {
    if (!file || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPhase("Сохраняем документ…");
    try {
      validateDocument(file);
      const saved = await saveUploadedDocument({
        id: crypto.randomUUID(),
        tripId: trip.id,
        ...(link ? { eventId: link } : {}),
        name: file.name,
        type: file.type,
        size: file.size,
        blob: file,
        fingerprint: await fileFingerprint(file),
      });
      await onRefresh();
      if (
        saved.duplicate &&
        ["completed", "needs_review", "empty"].includes(
          saved.document.recognition?.status ?? "",
        )
      ) {
        setNotice("Этот документ уже загружен. Повторные события не созданы.");
        if (saved.document.recognition?.status === "needs_review")
          setReview(saved.document);
      } else if (autoRecognize && budget.status?.remaining === 0) {
        setNotice(
          "Документ сохранён. Дневной лимит распознавания исчерпан или приостановлен; распознать можно позже.",
        );
      } else if (autoRecognize) await processRecognition(saved.document.id);
      else
        setNotice(
          saved.duplicate
            ? "Этот документ уже есть в поездке."
            : STATIC_HOSTING
              ? "Документ сохранён на этом устройстве. Добавьте событие в план вручную."
              : "Документ сохранён. Распознать его можно позже.",
        );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      operation.current = false;
      setPhase("");
      if (input.current) input.current.value = "";
    }
  }
  async function processRecognition(id: string) {
    if (STATIC_HOSTING)
      throw new Error(
        "Автоматическое распознавание доступно в локальной версии приложения.",
      );
    if (budget.status?.remaining === 0)
      throw new Error(
        "Дневной лимит распознавания исчерпан или приостановлен. Документ сохранён.",
      );
    let attemptId: string | undefined;
    onProcessing(true);
    setPhase("Распознаём билет или бронь…");
    try {
      const started = await beginRecognition(id);
      attemptId = started.attemptId;
      await onRefresh();
      const result = await recognizeFile(started.document);
      setPhase("Добавляем события в план…");
      const applied = await applyRecognition(id, attemptId, result);
      onImported(applied.trip);
      await onRefresh();
      setNotice(applied.document.recognition?.message ?? "");
      if (applied.document.recognition?.status === "needs_review")
        setReview(applied.document);
    } catch (e) {
      if (attemptId)
        await failRecognition(id, attemptId, message(e)).catch(() => undefined);
      await onRefresh();
      throw e;
    } finally {
      await budget.refresh();
      onProcessing(false);
    }
  }
  async function retry(id: string) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await processRecognition(id);
    } catch (e) {
      setError(message(e));
    } finally {
      operation.current = false;
      setBusy(false);
      setPhase("");
    }
  }
  async function confirmRecognition(
    drafts: BookingDraft[],
    options: ImportOptions,
  ) {
    if (!review?.recognition?.attemptId)
      throw new Error(
        "Результат распознавания устарел. Попробуйте распознать документ снова.",
      );
    if (operation.current)
      throw new Error("Дождитесь завершения текущего действия");
    operation.current = true;
    setBusy(true);
    onProcessing(true);
    try {
      const result = {
        events: drafts,
        warnings: review.recognition.result?.warnings ?? [],
        usage: review.recognition.result?.usage,
      };
      const applied = await applyRecognition(
        review.id,
        review.recognition.attemptId,
        result,
        options,
      );
      onImported(applied.trip);
      await onRefresh();
      if (applied.document.recognition?.status === "needs_review")
        throw new Error(applied.document.recognition.message);
      setNotice(
        applied.document.recognition?.message ?? "События добавлены в план",
      );
    } finally {
      operation.current = false;
      setBusy(false);
      onProcessing(false);
    }
  }
  async function open(id: string) {
    setError("");
    try {
      const doc = await getDocument(id);
      if (!doc) throw new Error("Документ не найден на этом устройстве");
      const url = URL.createObjectURL(doc.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = doc.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(message(e));
    }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      await removeDocument(id);
      await onRefresh();
      setConfirm(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="documents-section">
      <div className="section-heading">
        <div>
          <h2>Документы поездки</h2>
          <p className="muted">Билеты и бронирования всегда рядом с планом.</p>
        </div>
      </div>
      {STATIC_HOSTING ? (
        <p className="recognition-notice">
          План и документы хранятся в браузере этого устройства. Добавляйте
          события вручную. Автоматическое распознавание доступно в локальной
          версии приложения.
        </p>
      ) : (
        <RecognitionBudget budget={budget} disabled={busy} />
      )}
      <div
        className="upload-area"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy) void upload(e.dataTransfer.files[0]);
        }}
      >
        <span className="upload-icon">
          <Upload size={26} strokeWidth={1.5} />
        </span>
        <h3>Добавьте билет или бронь отеля</h3>
        <p>PDF, JPG, PNG или WebP · до 20 МБ</p>
        {!STATIC_HOSTING ? (
          <label className="recognition-check">
            <input
              type="checkbox"
              checked={autoRecognize}
              onChange={(e) => setAutoRecognize(e.target.checked)}
              disabled={busy}
            />
            <span>Автоматически добавлять события в план</span>
          </label>
        ) : null}
        <label className="document-association">
          Связать с событием
          <select
            value={link}
            onChange={(e) => setLink(e.target.value)}
            disabled={busy}
          >
            <option value="">Вся поездка</option>
            {trip.events.map((e) => (
              <option key={e.id} value={e.id}>
                {formatDate(e.date)} · {e.title}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          onClick={() => input.current?.click()}
          disabled={busy}
        >
          <PlusIcon />
          {busy ? phase || "Сохраняем…" : "Выбрать файл"}
        </button>
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          hidden
          onChange={(e) => void upload(e.target.files?.[0])}
        />
        <small>
          {STATIC_HOSTING
            ? "Файл сохраняется только в этом браузере. Синхронизации с другими устройствами пока нет."
            : provider === "codex"
              ? "Распознавание через твой аккаунт Codex: расходуются его лимиты и кредиты. Требуется интернет. Файл сохраняется в этом браузере."
              : provider === "openai"
                ? "Файл сохранится в этом браузере. Для распознавания документ отправляется в OpenAI API; требуется интернет и баланс API."
                : "Файл сохранится в этом браузере. Для распознавания документ передаётся выбранному AI-сервису; нужен интернет."}
        </small>
      </div>
      {busy && phase ? (
        <p className="recognition-progress" role="status">
          <LoaderCircle size={17} />
          {phase}
        </p>
      ) : null}
      {notice ? (
        <div className="recognition-notice" role="status">
          <Check size={18} />
          <span>{notice}</span>
          <button className="text-button" onClick={() => onPlan()}>
            Открыть план
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="documents-list">
        {documents.length ? (
          documents.map((doc) => (
            <article className="document-row" key={doc.id}>
              <span className="event-icon">
                <FileText size={22} />
              </span>
              <div className="document-info">
                <strong>{doc.name}</strong>
                <p className="muted">
                  {linkedEventIds(doc)
                    .map(
                      (id) =>
                        trip.events.find((event) => event.id === id)?.title,
                    )
                    .filter(Boolean)
                    .join(" · ") || "Документ поездки"}{" "}
                  ·{" "}
                  {doc.size < 1024 * 1024
                    ? `${Math.max(1, Math.round(doc.size / 1024))} КБ`
                    : `${(doc.size / 1024 / 1024).toFixed(1)} МБ`}
                </p>
                {doc.recognition ? (
                  <p
                    className={`recognition-status recognition-${doc.recognition.status}`}
                  >
                    {doc.recognition.message}
                  </p>
                ) : null}
                {doc.recognition?.result?.usage ? (
                  <p className="document-meta">
                    Codex:{" "}
                    {(
                      doc.recognition.result.usage.inputTokens +
                      doc.recognition.result.usage.outputTokens
                    ).toLocaleString("ru-RU")}{" "}
                    токенов
                    {" · вход: "}
                    {doc.recognition.result.usage.inputTokens.toLocaleString(
                      "ru-RU",
                    )}
                    {" · выход: "}
                    {doc.recognition.result.usage.outputTokens.toLocaleString(
                      "ru-RU",
                    )}
                    {doc.recognition.result.usage.cachedInputTokens !==
                    undefined
                      ? ` · из входных в кэше: ${doc.recognition.result.usage.cachedInputTokens.toLocaleString("ru-RU")}`
                      : ""}
                  </p>
                ) : null}
              </div>
              <div className="document-recognition-actions">
                {doc.recognition?.status === "needs_review" &&
                doc.recognition.result ? (
                  <button
                    className="button secondary"
                    onClick={() => setReview(doc)}
                    disabled={busy}
                  >
                    <ScanLine size={15} />
                    Уточнить
                  </button>
                ) : doc.recognition?.status === "completed" ? (
                  <button
                    className="button secondary"
                    onClick={() => onPlan(linkedEventIds(doc)[0])}
                  >
                    <Check size={15} />В плане
                  </button>
                ) : null}
                {!STATIC_HOSTING &&
                doc.recognition?.status !== "completed" &&
                doc.recognition?.status !== "needs_review" ? (
                  <button
                    className="button secondary"
                    onClick={() => void retry(doc.id)}
                    disabled={busy || budget.status?.remaining === 0}
                  >
                    <ScanLine size={15} />
                    {doc.recognition?.status === "processing"
                      ? "Повторить"
                      : "Распознать"}
                  </button>
                ) : null}
              </div>
              <button
                className="button secondary"
                onClick={() => void open(doc.id)}
                aria-label={`Скачать ${doc.name}`}
              >
                Скачать
                <ArrowUpRight size={15} />
              </button>
              <button
                className="icon-button"
                onClick={() => setConfirm(doc.id)}
                aria-label={`Удалить ${doc.name}`}
                disabled={busy}
              >
                <Trash2 size={17} />
              </button>
              {confirm === doc.id ? (
                <div className="confirm-inline">
                  <p>Удалить файл «{doc.name}» с этого устройства?</p>
                  <button
                    className="button danger"
                    onClick={() => void remove(doc.id)}
                    disabled={busy}
                  >
                    Удалить файл
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => setConfirm(null)}
                    disabled={busy}
                  >
                    Отмена
                  </button>
                </div>
              ) : null}
            </article>
          ))
        ) : (
          <p className="empty-note">
            <Paperclip size={16} />
            Документов пока нет. Добавьте первый файл выше.
          </p>
        )}
      </div>
      {review?.recognition?.result ? (
        <RecognitionReview
          key={review.id}
          result={review.recognition.result}
          message={review.recognition.message}
          onApply={confirmRecognition}
          onClose={() => setReview(null)}
        />
      ) : null}
    </section>
  );
}
function PlusIcon() {
  return <Upload size={17} />;
}
