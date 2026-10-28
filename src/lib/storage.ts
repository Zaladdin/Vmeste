import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { RECOGNITION_RETRY_DELAY_MS } from "./recognition-common";
import {
  parseTrip,
  sampleTrip,
  validateDocument,
  type Trip,
  type StoredDocument,
} from "./model";
import {
  buildImportPlan,
  recognitionResponseSchema,
  type ImportOptions,
  type RecognitionResult,
} from "./recognition";

interface VmesteDatabase extends DBSchema {
  trips: { key: string; value: Trip };
  settings: { key: string; value: boolean };
  documents: {
    key: string;
    value: StoredDocument;
    indexes: { "by-trip": string };
  };
}

let connection: Promise<IDBPDatabase<VmesteDatabase>> | undefined;

function database() {
  if (!connection) {
    connection = openDB<VmesteDatabase>("vmeste", 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("trips"))
          db.createObjectStore("trips", { keyPath: "id" });
        if (!db.objectStoreNames.contains("documents")) {
          const documents = db.createObjectStore("documents", {
            keyPath: "id",
          });
          documents.createIndex("by-trip", "tripId");
        }
        if (!db.objectStoreNames.contains("settings"))
          db.createObjectStore("settings");
      },
      terminated() {
        connection = undefined;
      },
    }).catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
  }
  return connection;
}

export async function initializeTrips(): Promise<Trip[]> {
  const db = await database();
  const transaction = db.transaction(["trips", "settings"], "readwrite");
  void transaction.done.catch(() => undefined);
  const trips = transaction.objectStore("trips");
  const settings = transaction.objectStore("settings");
  if (!(await settings.get("initialized"))) {
    if ((await trips.count()) === 0) await trips.put(parseTrip(sampleTrip));
    await settings.put(true, "initialized");
  }
  const result = await trips.getAll();
  await transaction.done;
  return result.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      a.title.localeCompare(b.title, "ru"),
  );
}

export async function saveTrip(trip: Trip): Promise<void> {
  const validated = parseTrip(trip);
  const db = await database();
  const transaction = db.transaction("trips", "readwrite");
  await Promise.all([transaction.store.put(validated), transaction.done]);
}

export async function loadTrips(): Promise<Trip[]> {
  const db = await database();
  return db.getAll("trips");
}

export async function removeTrip(id: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction(["trips", "documents"], "readwrite");
  void transaction.done.catch(() => undefined);
  const documents = transaction.objectStore("documents");
  const keys = await documents.index("by-trip").getAllKeys(id);
  await Promise.all([
    transaction.objectStore("trips").delete(id),
    ...keys.map((key) => documents.delete(key)),
  ]);
  await transaction.done;
}

function validateStoredDocument(document: StoredDocument): void {
  validateDocument(document);
  validateDocument({ type: document.blob.type, size: document.blob.size });
  if (
    document.size !== document.blob.size ||
    document.type !== document.blob.type
  ) {
    throw new Error("Размер или тип документа не соответствует файлу.");
  }
  if (
    document.eventIds &&
    (document.eventIds.length > 1000 ||
      document.eventIds.some((id) => typeof id !== "string" || !id))
  ) {
    throw new Error("Некорректные ссылки на события документа.");
  }
}

function assertDocumentLinks(
  trip: Trip | undefined,
  document: StoredDocument,
): asserts trip is Trip {
  if (
    !trip ||
    [document.eventId, ...(document.eventIds ?? [])].some(
      (id) => id && !trip.events.some((event) => event.id === id),
    )
  ) {
    throw new Error("Поездка или событие для документа не найдены.");
  }
}

export async function saveDocument(document: StoredDocument): Promise<void> {
  validateStoredDocument(document);
  const db = await database();
  const transaction = db.transaction(["trips", "documents"], "readwrite");
  void transaction.done.catch(() => undefined);
  const trip = await transaction.objectStore("trips").get(document.tripId);
  try {
    assertDocumentLinks(trip, document);
  } catch (error) {
    transaction.abort();
    await transaction.done.catch(() => undefined);
    throw error;
  }
  await transaction.objectStore("documents").put(document);
  await transaction.done;
}

export async function listDocuments(tripId: string): Promise<StoredDocument[]> {
  const db = await database();
  return db.getAllFromIndex("documents", "by-trip", tripId);
}

export async function getDocument(
  id: string,
): Promise<StoredDocument | undefined> {
  const db = await database();
  return db.get("documents", id);
}

export async function removeDocument(id: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction("documents", "readwrite");
  await Promise.all([transaction.store.delete(id), transaction.done]);
}

export async function removeEvent(trip: Trip, eventId: string): Promise<Trip> {
  const db = await database();
  const transaction = db.transaction(["trips", "documents"], "readwrite");
  void transaction.done.catch(() => undefined);
  const current = await transaction.objectStore("trips").get(trip.id);
  if (!current) {
    transaction.abort();
    await transaction.done.catch(() => undefined);
    throw new Error("Поездка не найдена.");
  }
  const updated = parseTrip({
    ...current,
    events: current.events.filter((event) => event.id !== eventId),
  });
  const documents = transaction.objectStore("documents");
  const linked = await documents.index("by-trip").getAll(trip.id);
  await Promise.all([
    transaction.objectStore("trips").put(updated),
    ...linked
      .filter(
        (document) =>
          document.eventId === eventId || document.eventIds?.includes(eventId),
      )
      .map((document) => {
        const detached = { ...document };
        if (detached.eventIds)
          detached.eventIds = detached.eventIds.filter((id) => id !== eventId);
        if (detached.eventId === eventId) {
          delete detached.eventId;
          if (detached.eventIds?.length)
            detached.eventId = detached.eventIds[0];
        }
        if (
          detached.recognition?.status === "completed" &&
          detached.recognition.result
        ) {
          detached.recognition = {
            ...detached.recognition,
            status: "needs_review",
            message:
              "Событие удалено из плана. Проверьте данные, чтобы добавить его снова.",
          };
        }
        return documents.put(detached);
      }),
  ]);
  await transaction.done;
  return updated;
}

/** Fingerprint dedupe and write share one transaction, including simultaneous tabs. */
export async function saveUploadedDocument(
  document: StoredDocument,
): Promise<{ document: StoredDocument; duplicate: boolean }> {
  validateStoredDocument(document);
  if (!document.fingerprint || !/^[a-f0-9]{64}$/.test(document.fingerprint))
    throw new Error("Не удалось проверить содержимое документа.");
  const db = await database();
  const transaction = db.transaction(["trips", "documents"], "readwrite");
  void transaction.done.catch(() => undefined);
  try {
    const trip = await transaction.objectStore("trips").get(document.tripId);
    assertDocumentLinks(trip, document);
    const documents = transaction.objectStore("documents");
    const existing = (
      await documents.index("by-trip").getAll(document.tripId)
    ).find((item) => item.fingerprint === document.fingerprint);
    if (existing) {
      // Uploading from a different event links the existing file without discarding its old associations.
      const links = [
        ...new Set(
          [
            existing.eventId,
            ...(existing.eventIds ?? []),
            document.eventId,
            ...(document.eventIds ?? []),
          ].filter((id): id is string => !!id),
        ),
      ];
      const merged = {
        ...existing,
        ...(links.length
          ? { eventId: existing.eventId ?? links[0], eventIds: links }
          : {}),
      };
      await documents.put(merged);
      await transaction.done;
      return { document: merged, duplicate: true };
    }
    if (await documents.get(document.id))
      throw new Error("Документ с таким идентификатором уже существует.");
    await documents.put(document);
    await transaction.done;
    return { document, duplicate: false };
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* Already completed or aborted. */
    }
    await transaction.done.catch(() => undefined);
    throw error;
  }
}

export async function beginRecognition(
  id: string,
): Promise<{ document: StoredDocument; attemptId: string }> {
  const db = await database();
  const transaction = db.transaction("documents", "readwrite");
  void transaction.done.catch(() => undefined);
  try {
    const document = await transaction.store.get(id);
    if (!document) throw new Error("Документ не найден на этом устройстве.");
    const now = Date.now();
    if (
      document.recognition?.status === "processing" &&
      document.recognition.startedAt &&
      now - document.recognition.startedAt < RECOGNITION_RETRY_DELAY_MS
    )
      throw new Error("Распознавание уже выполняется. Подождите немного.");
    const attemptId = crypto.randomUUID();
    const updated: StoredDocument = {
      ...document,
      recognition: {
        ...document.recognition,
        status: "processing",
        message: "Распознаём билеты и бронирования…",
        attemptId,
        startedAt: now,
      },
    };
    await transaction.store.put(updated);
    await transaction.done;
    return { document: updated, attemptId };
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* Already completed or aborted. */
    }
    await transaction.done.catch(() => undefined);
    throw error;
  }
}

export async function applyRecognition(
  id: string,
  attemptId: string,
  raw: RecognitionResult,
  options: ImportOptions = {},
): Promise<{
  trip: Trip;
  document: StoredDocument;
  added: number;
  duplicates: number;
}> {
  const result = recognitionResponseSchema.parse(raw);
  const db = await database();
  const transaction = db.transaction(["trips", "documents"], "readwrite");
  void transaction.done.catch(() => undefined);
  try {
    const documents = transaction.objectStore("documents");
    const document = await documents.get(id);
    if (!document)
      throw new Error("Документ был удалён. События не добавлены.");
    if (document.recognition?.attemptId !== attemptId)
      throw new Error(
        "Результат устарел. Используйте последнюю попытку распознавания.",
      );
    const trip = await transaction.objectStore("trips").get(document.tripId);
    if (!trip) throw new Error("Поездка была удалена. События не добавлены.");
    const plan = buildImportPlan(trip, result.events, options);
    const links = [
      ...new Set(
        [
          document.eventId,
          ...(document.eventIds ?? []),
          ...plan.eventIds,
        ].filter(
          (eventId): eventId is string =>
            !!eventId && plan.trip.events.some((event) => event.id === eventId),
        ),
      ),
    ];
    const status = plan.needsReview
      ? "needs_review"
      : result.events.length === 0
        ? "empty"
        : "completed";
    const message = plan.needsReview
      ? plan.reasons.join(" ")
      : result.events.length === 0
        ? "Билеты или бронирования в документе не найдены."
        : plan.added
          ? `Добавлено событий: ${plan.added}. Проверьте даты и время в плане.`
          : "События уже есть в плане. Документ привязан к ним.";
    const updated: StoredDocument = {
      ...document,
      eventIds: links,
      recognition: {
        ...document.recognition,
        status,
        message: message.slice(0, 500),
        result,
      },
    };
    if (!updated.eventId && links.length) updated.eventId = links[0];
    await transaction.objectStore("trips").put(plan.trip);
    await documents.put(updated);
    await transaction.done;
    return {
      trip: plan.trip,
      document: updated,
      added: plan.added,
      duplicates: plan.duplicates,
    };
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* Already completed or aborted. */
    }
    await transaction.done.catch(() => undefined);
    throw error;
  }
}

export async function failRecognition(
  id: string,
  attemptId: string,
  message: string,
): Promise<void> {
  const db = await database();
  const transaction = db.transaction("documents", "readwrite");
  void transaction.done.catch(() => undefined);
  const document = await transaction.store.get(id);
  if (
    document?.recognition?.attemptId === attemptId &&
    document.recognition.status === "processing"
  ) {
    await transaction.store.put({
      ...document,
      recognition: {
        ...document.recognition,
        status: "failed",
        message: message.slice(0, 500),
      },
    });
  }
  await transaction.done;
}
