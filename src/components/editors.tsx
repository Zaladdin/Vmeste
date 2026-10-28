"use client";
import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Dialog, Field, FormError } from "./dialog";
import { eventKinds, parseTrip, type Trip, type TripEvent } from "@/lib/model";

const zones = [
  "Europe/Istanbul",
  "Asia/Baku",
  "Europe/Moscow",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/London",
  "Asia/Dubai",
  "Asia/Tbilisi",
  "Asia/Tokyo",
  "America/New_York",
  "UTC",
];
function ZoneOptions() {
  return (
    <datalist id="timezones">
      {zones.map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
}
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Не удалось сохранить. Попробуйте ещё раз.";

export function TripEditor({
  item,
  onSave,
  onClose,
}: {
  item?: Trip;
  onSave: (trip: Trip) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    const form = new FormData(submitEvent.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onSave(
        parseTrip({
          id: item?.id ?? crypto.randomUUID(),
          title: form.get("title"),
          destination: form.get("destination"),
          startDate: form.get("startDate"),
          endDate: form.get("endDate"),
          timeZone: form.get("timeZone"),
          members: item?.members ?? [{ id: crypto.randomUUID(), name: "Вы" }],
          events: item?.events ?? [],
        }),
      );
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={item ? "Настройки поездки" : "Новая поездка"}
      onClose={onClose}
    >
      <form onSubmit={submit} className="editor">
        <p className="muted">
          {item
            ? "Название, направление и даты вашего путешествия."
            : "С чего начинается ваше следующее путешествие?"}
        </p>
        <Field label="Название">
          <input
            name="title"
            defaultValue={item?.title}
            placeholder="Например, выходные в Риме"
            maxLength={160}
            required
            autoFocus
          />
        </Field>
        <Field label="Город или направление">
          <input
            name="destination"
            defaultValue={item?.destination}
            placeholder="Рим, Италия"
            maxLength={160}
            required
          />
        </Field>
        <div className="form-grid">
          <Field label="Начало">
            <input
              type="date"
              name="startDate"
              defaultValue={item?.startDate}
              required
            />
          </Field>
          <Field label="Окончание">
            <input
              type="date"
              name="endDate"
              defaultValue={item?.endDate}
              required
            />
          </Field>
        </div>
        <Field
          label="Часовой пояс поездки"
          hint="Время событий можно настроить отдельно."
        >
          <input
            name="timeZone"
            list="timezones"
            defaultValue={item?.timeZone ?? "Europe/Istanbul"}
            required
          />
        </Field>
        <ZoneOptions />
        <FormError message={error} />
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Отмена
          </button>
          <button className="button primary" disabled={busy}>
            {busy
              ? item
                ? "Сохраняем…"
                : "Создаём…"
              : item
                ? "Сохранить поездку"
                : "Создать поездку"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function EventEditor({
  trip,
  date,
  item,
  initialKind,
  onSave,
  onDelete,
  onClose,
}: {
  trip: Trip;
  date: string;
  item?: TripEvent;
  initialKind?: TripEvent["kind"];
  onSave: (event: TripEvent) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    const endLocal = String(form.get("endLocal") || "");
    try {
      const data = {
        id: item?.id ?? crypto.randomUUID(),
        kind: form.get("kind"),
        title: form.get("title"),
        date: form.get("date"),
        time: form.get("time"),
        timeZone: form.get("timeZone"),
        location: form.get("location"),
        details: form.get("details"),
        memberIds: form.getAll("members"),
        ...(endLocal ? { endLocal, endTimeZone: form.get("endTimeZone") } : {}),
      };
      const validated = parseTrip({
        ...trip,
        events: [...trip.events.filter((e) => e.id !== data.id), data],
      });
      await onSave(validated.events[validated.events.length - 1]);
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await onDelete(item!.id);
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={item ? "Редактировать событие" : "Добавить событие"}
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="editor">
        <div className="form-grid">
          <Field label="Тип события">
            <select
              name="kind"
              defaultValue={item?.kind ?? initialKind ?? "activity"}
            >
              {Object.entries(eventKinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Название">
            <input
              name="title"
              defaultValue={item?.title}
              placeholder="Куда отправимся?"
              maxLength={160}
              required
              autoFocus
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Дата">
            <input
              type="date"
              name="date"
              min={trip.startDate}
              max={trip.endDate}
              defaultValue={item?.date ?? date}
              required
            />
          </Field>
          <Field label="Время начала">
            <input
              type="time"
              name="time"
              defaultValue={item?.time ?? "10:00"}
              required
            />
          </Field>
        </div>
        <Field label="Часовой пояс начала">
          <input
            name="timeZone"
            list="timezones"
            defaultValue={item?.timeZone ?? trip.timeZone}
            required
          />
        </Field>
        <div className="form-grid">
          <Field
            label="Окончание / прилёт"
            hint="Необязательно. Укажите местное время."
          >
            <input
              type="datetime-local"
              name="endLocal"
              defaultValue={item?.endLocal}
            />
          </Field>
          <Field label="Часовой пояс окончания">
            <input
              name="endTimeZone"
              list="timezones"
              defaultValue={item?.endTimeZone ?? trip.timeZone}
            />
          </Field>
        </div>
        <Field label="Место или адрес">
          <input
            name="location"
            defaultValue={item?.location}
            placeholder="Адрес отеля, аэропорт или название места"
            maxLength={300}
          />
        </Field>
        <Field label="Заметки">
          <textarea
            name="details"
            defaultValue={item?.details}
            placeholder="Номер рейса, детали бронирования, ваши идеи…"
            rows={3}
            maxLength={2000}
          />
        </Field>
        {trip.members.length ? (
          <fieldset className="member-checks">
            <legend>Кто участвует</legend>
            {trip.members.map((m) => (
              <label key={m.id}>
                <input
                  type="checkbox"
                  name="members"
                  value={m.id}
                  defaultChecked={item?.memberIds.includes(m.id)}
                />
                {m.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <ZoneOptions />
        <FormError message={error} />
        <div className="form-actions">
          {item ? (
            <button
              type="button"
              className="button danger-quiet"
              onClick={() => setConfirm(true)}
              disabled={busy}
            >
              <Trash2 size={16} />
              Удалить
            </button>
          ) : null}
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить событие"}
          </button>
        </div>
        {confirm ? (
          <div className="confirm-inline" role="alert">
            <p>
              Удалить это событие? Прикреплённые документы останутся в поездке.
            </p>
            <button
              type="button"
              className="button danger"
              onClick={remove}
              disabled={busy}
            >
              Да, удалить
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setConfirm(false)}
              disabled={busy}
            >
              Оставить
            </button>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

export function MembersEditor({
  trip,
  onSave,
  onClose,
}: {
  trip: Trip;
  onSave: (trip: Trip) => Promise<void>;
  onClose: () => void;
}) {
  const [members, setMembers] = useState(trip.members);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function add(e: FormEvent) {
    e.preventDefault();
    if (name.trim() && members.length < 50) {
      setMembers([...members, { id: crypto.randomUUID(), name: name.trim() }]);
      setName("");
    }
  }
  async function save() {
    setBusy(true);
    try {
      const ids = new Set(members.map((m) => m.id));
      await onSave(
        parseTrip({
          ...trip,
          members,
          events: trip.events.map((e) => ({
            ...e,
            memberIds: e.memberIds.filter((id) => ids.has(id)),
          })),
        }),
      );
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }
  return (
    <Dialog title="Участники поездки" onClose={onClose}>
      <p className="muted">
        Добавьте имена, чтобы отмечать участников событий. Список хранится
        здесь; приглашения и совместный доступ ещё не подключены.
      </p>
      <div className="member-list">
        {members.map((member, index) => (
          <div className="member-row" key={member.id}>
            <span className={`avatar avatar-${index % 3}`}>
              {member.name[0].toUpperCase()}
            </span>
            <span>{member.name}</span>
            <button
              className="icon-button"
              aria-label={`Убрать ${member.name}`}
              onClick={() =>
                setMembers(members.filter((m) => m.id !== member.id))
              }
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
      </div>
      <form className="member-add" onSubmit={add}>
        <input
          aria-label="Имя участника"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Имя участника"
          maxLength={60}
          required
        />
        <button className="button secondary" disabled={members.length >= 50}>
          <Plus size={18} />
          Добавить
        </button>
      </form>
      <FormError message={error} />
      <div className="form-actions">
        <button className="button primary" onClick={save} disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить участников"}
        </button>
      </div>
    </Dialog>
  );
}
