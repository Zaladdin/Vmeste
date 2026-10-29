"use client";

import { useEffect, useId, useRef } from "react";

export function RoomConfirmation({
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <section
      className="room-confirmation"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <h4 id={titleId}>{title}</h4>
      <p id={descriptionId}>{description}</p>
      <div className="room-actions">
        <button
          ref={cancel}
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Отмена
        </button>
        <button
          type="button"
          className="button danger-quiet"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Удаляем…" : confirmLabel}
        </button>
      </div>
    </section>
  );
}
