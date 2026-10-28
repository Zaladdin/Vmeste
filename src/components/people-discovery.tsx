"use client";
import { useEffect, useState } from "react";
import { FileSearch, Check, RotateCw } from "lucide-react";
import { documentPeople } from "@/lib/document-people";
import { discoverPdfPeople } from "@/lib/pdf-people-client";
import {
  groupDiscoveredPeople,
  remainingDocumentPeople,
  existingDiscoveryMember,
  type DiscoveredPerson,
} from "@/lib/people-discovery";
import { useAccountStorage } from "./account-storage";
import type { Trip, StoredDocument } from "@/lib/model";

export function PeopleDiscovery({
  trip,
  documents,
  onApplied,
}: {
  trip: Trip;
  documents: StoredDocument[];
  onApplied: (trip: Trip) => Promise<void>;
}) {
  const { confirmDocumentPeople } = useAccountStorage();
  const [groups, setGroups] = useState<DiscoveredPerson[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setGroups([]);
    setChoices({});
    setExcluded(new Set());
    setError("");
    (async () => {
      const found: { documentId: string; names: string[] }[] = [];
      let unread = 0;
      for (const [index, document] of documents.entries()) {
        if (!active) return;
        const known =
          document.recognition?.result?.events.flatMap((event) =>
            documentPeople(event.details),
          ) ?? [];
        // Confirmed sources do not need to be re-read on every visit.
        if (document.people?.length && scan === 0) continue;
        setProgress(
          `Проверяем документы: ${index + 1} из ${documents.length}…`,
        );
        let names = known;
        if (document.type === "application/pdf") {
          try {
            names = [
              ...known,
              ...(await discoverPdfPeople(document.blob, controller.signal)),
            ];
          } catch {
            if (!active) return;
          }
        } else if (!known.length) unread++;
        const remaining = remainingDocumentPeople(
          names,
          document.people?.map((person) => person.name) ?? [],
        );
        if (remaining.length)
          found.push({ documentId: document.id, names: remaining });
        else if (
          !names.length &&
          document.type === "application/pdf" &&
          !known.length
        )
          unread++;
      }
      if (!active) return;
      setGroups(groupDiscoveredPeople(found));
      setProgress("");
      setNotice(
        unread
          ? `Не удалось извлечь имена из ${unread} документов. В сканах без текстового слоя имена можно добавить вручную.`
          : "",
      );
    })().catch(() => {
      if (active) {
        setProgress("");
        setError("Не удалось проверить документы. Можно повторить проверку.");
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [documents, trip.id, scan]);

  function memberFor(group: DiscoveredPerson): string {
    return (
      choices[group.key] ??
      existingDiscoveryMember(group, trip.members, documents) ??
      "new"
    );
  }
  async function confirm() {
    if (busy || progress) return;
    setBusy(true);
    setError("");
    try {
      const selections = new Map<
        string,
        { documentId: string; names: { name: string; memberId?: string }[] }
      >();
      for (const group of groups) {
        if (excluded.has(group.key)) continue;
        const memberId = memberFor(group);
        for (const documentId of group.documentIds) {
          let selection = selections.get(documentId);
          if (!selection) {
            selection = { documentId, names: [] };
            selections.set(documentId, selection);
          }
          selection.names.push({
            name: group.name,
            ...(memberId === "new" ? {} : { memberId }),
          });
        }
      }
      const next = await confirmDocumentPeople(trip.id, [
        ...selections.values(),
      ]);
      await onApplied(next);
      setGroups([]);
      setNotice("Участники из документов добавлены. Даты и время не изменены.");
    } catch {
      setError(
        "Не удалось сохранить участников. Проверьте список и повторите попытку.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!documents.length) return null;
  return (
    <section className="people-discovery" aria-label="Люди из документов">
      <div className="people-discovery-heading">
        <FileSearch size={22} />
        <div>
          <h3>Люди из документов</h3>
          <p>
            Проверяем сохранённые файлы на устройстве — без Codex и расхода
            кредитов.
          </p>
        </div>
      </div>
      {progress ? (
        <p role="status">{progress}</p>
      ) : groups.length ? (
        <>
          <p>
            Найдены имена: {groups.length}. Подтвердите участников поездки и
            связанных событий документов. Если вы уже есть в поездке, выберите
            своё имя вместо добавления нового участника.
          </p>
          <div className="discovered-people-list">
            {groups.map((group) => (
              <div className="discovered-person" key={group.key}>
                <label className="discovered-person-check">
                  <input
                    type="checkbox"
                    checked={!excluded.has(group.key)}
                    disabled={busy}
                    onChange={(event) =>
                      setExcluded((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  />
                  <span>
                    <strong>{group.name}</strong>
                    <small>
                      {group.documentIds
                        .map(
                          (id) =>
                            documents.find((document) => document.id === id)
                              ?.name,
                        )
                        .filter(Boolean)
                        .join(" · ")}
                      {group.variants.length > 1
                        ? ` · Также: ${group.variants.slice(1).join("; ")}`
                        : ""}
                    </small>
                  </span>
                </label>
                <label className="discovered-member-select">
                  <span>Участник для {group.name}</span>
                  <select
                    value={memberFor(group)}
                    disabled={busy || excluded.has(group.key)}
                    onChange={(event) =>
                      setChoices((current) => ({
                        ...current,
                        [group.key]: event.target.value,
                      }))
                    }
                  >
                    <option value="new">Добавить нового</option>
                    {trip.members.map((person) => (
                      <option key={person.id} value={person.id}>
                        Уже в поездке: {person.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
          <button
            className="button primary"
            onClick={() => void confirm()}
            disabled={busy || groups.every((group) => excluded.has(group.key))}
          >
            <Check size={18} />
            {busy ? "Сохраняем…" : "Подтвердить участников"}
          </button>
        </>
      ) : (
        <p>
          {notice ||
            "Новых имён для подтверждения нет. Участников можно добавить вручную."}
        </p>
      )}
      {notice && groups.length ? <p>{notice}</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="text-button"
        disabled={busy || !!progress}
        onClick={() => setScan((current) => current + 1)}
      >
        <RotateCw size={15} />
        Проверить ещё раз
      </button>
    </section>
  );
}
