"use client";

import { useEffect, useRef, useState } from "react";
import { personNameOrderKey } from "@/lib/document-people";
import type { Trip } from "@/lib/model";
import { useAccountStorage } from "./account-storage";
import { RoomConfirmation } from "./room-confirmation";

export function PeopleDuplicates({
  trip,
  onApplied,
}: {
  trip: Trip;
  onApplied: (updated: Trip) => Promise<void>;
}) {
  const { mergePeople } = useAccountStorage();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<{
    tripId: string;
    key: string;
    keepId: string;
    mergeIds: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    generation.current++;
    setChoices({});
    setConfirmation(null);
    setError("");
    setNotice("");
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [trip.id]);

  const candidates = new Map<string, Trip["members"]>();
  for (const person of trip.members) {
    const key = personNameOrderKey(person.name);
    if (!key.startsWith("full:")) continue;
    candidates.set(key, [...(candidates.get(key) ?? []), person]);
  }
  const groups = [...candidates].filter(([, people]) => people.length > 1);
  async function merge() {
    const request = confirmation;
    if (!request || request.tripId !== trip.id || busy) return;
    const version = generation.current;
    let saved = false;
    setBusy(true);
    setError("");
    try {
      const updated = await mergePeople(
        request.tripId,
        request.keepId,
        request.mergeIds,
      );
      saved = true;
      if (version !== generation.current) return;
      await onApplied(updated);
      if (version !== generation.current) return;
      setConfirmation(null);
      setNotice(
        "Повторы объединены. Основной ID сохранён, билеты и документы остались у участника.",
      );
    } catch (failure) {
      if (version === generation.current)
        setError(
          saved
            ? "Участники объединены, но не удалось обновить экран. Обновите страницу."
            : failure instanceof Error
              ? failure.message
              : "Не удалось объединить участников. Обновите список и попробуйте снова.",
        );
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  if (!groups.length && !notice && !error) return null;
  return (
    <section
      className="people-discovery people-duplicates"
      aria-label="Повторы участников"
    >
      <h3>Возможные повторы участников</h3>
      {groups.length ? (
        <>
          <p>
            Одинаковые полные имена с разным порядком слов могут относиться к
            одному человеку. Объединяйте записи только если это один человек.
          </p>
          <p>
            Выберите основной ID, особенно если он уже связан с аккаунтом в
            комнате. После отдельной публикации обновлённого плана привязки
            удалённых ID в комнате будут сняты. Даты, события и оригиналы
            документов сохранятся.
          </p>
          <div className="discovered-people-list">
            {groups.map(([key, people]) => {
              const selected = people.some(
                (person) => person.id === choices[key],
              )
                ? choices[key]
                : "";
              return (
                <div className="discovered-person" key={key}>
                  <div>
                    <strong>
                      {people.map((person) => person.name).join(" / ")}
                    </strong>
                    <label className="discovered-member-select">
                      <span>Основной участник для {people[0].name}</span>
                      <select
                        aria-label={`Основной участник для ${people[0].name}`}
                        value={selected}
                        disabled={busy}
                        onChange={(event) => {
                          setConfirmation(null);
                          setChoices((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }));
                        }}
                      >
                        <option value="">Выберите основной ID</option>
                        {people.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name} · ID: {person.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !selected}
                      onClick={(event) => {
                        confirmationTrigger.current = event.currentTarget;
                        setError("");
                        setConfirmation({
                          tripId: trip.id,
                          key,
                          keepId: selected,
                          mergeIds: people
                            .filter((person) => person.id !== selected)
                            .map((person) => person.id),
                        });
                      }}
                    >
                      Объединить повторы
                    </button>
                    {confirmation?.tripId === trip.id &&
                    confirmation.key === key ? (
                      <RoomConfirmation
                        title="Объединить записи одного человека?"
                        description={`Будет сохранён ID ${confirmation.keepId}. События и имена из документов будут связаны с ним. Привязки аккаунтов в комнатах автоматически не переносятся.`}
                        confirmLabel="Да, объединить участников"
                        busy={busy}
                        onCancel={() => {
                          setConfirmation(null);
                          confirmationTrigger.current?.focus();
                        }}
                        onConfirm={() => void merge()}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
