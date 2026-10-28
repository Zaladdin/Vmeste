import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { RECOGNITION_RETRY_DELAY_MS } from "./recognition-common";
import {
  documentPeople,
  documentPeopleError,
  normalizePersonName,
} from "./document-people";
import {
  parseTrip,
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

export type DocumentPeopleSelection = {
  documentId: string;
  names: { name: string; memberId?: string }[];
};

/** Every operation, including delayed work, stays bound to this verified account. */
export function createAccountStorage(userId: string) {
  if (
    typeof userId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId)
  )
    throw new Error("Для открытия поездок нужен действующий аккаунт.");
  const databaseName = `vmeste-account:${userId.toLowerCase()}`;
  let connection: Promise<IDBPDatabase<VmesteDatabase>> | undefined;

  function database() {
    if (!connection) {
      connection = openDB<VmesteDatabase>(databaseName, 2, {
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

  async function initializeTrips(): Promise<Trip[]> {
    const db = await database();
    const transaction = db.transaction(["trips", "settings"], "readwrite");
    void transaction.done.catch(() => undefined);
    const trips = transaction.objectStore("trips");
    const settings = transaction.objectStore("settings");
    if (!(await settings.get("initialized"))) {
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

  async function saveTrip(trip: Trip): Promise<void> {
    const validated = parseTrip(trip);
    const db = await database();
    const transaction = db.transaction(["trips", "documents"], "readwrite");
    void transaction.done.catch(() => undefined);
    try {
      const memberIds = new Set(validated.members.map((member) => member.id));
      const documents = transaction.objectStore("documents");
      await transaction.objectStore("trips").put(validated);
      for (const document of await documents.index("by-trip").getAll(trip.id)) {
        if (!document.people) continue;
        const people = document.people.filter((person) =>
          memberIds.has(person.memberId),
        );
        if (people.length !== document.people.length)
          await documents.put({ ...document, people });
      }
      await transaction.done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already aborted. */
      }
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  function confirmedName(raw: string): string {
    if (typeof raw !== "string") throw new Error("Проверьте имя участника.");
    const value = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const line = `Участники: ${value}`;
    const parsed = documentPeople(line);
    if (documentPeopleError(line) || parsed.length !== 1 || parsed[0] !== value)
      throw new Error(
        "Проверьте имя участника: нужны имя и фамилия без номеров и контактов.",
      );
    return value;
  }

  /** Confirm people independently of scheduling or paid document recognition. */
  async function confirmDocumentPeople(
    tripId: string,
    selections: DocumentPeopleSelection[],
  ): Promise<Trip> {
    if (!Array.isArray(selections) || selections.length > 1000)
      throw new Error("Слишком много документов.");
    const db = await database();
    const tx = db.transaction(["trips", "documents"], "readwrite");
    void tx.done.catch(() => undefined);
    try {
      const source = await tx.objectStore("trips").get(tripId);
      if (!source) throw new Error("Поездка не найдена.");
      const trip = parseTrip(source);
      const members = [...trip.members];
      const memberIds = new Set(members.map((member) => member.id));
      const known = new Map(
        members.map((member) => [normalizePersonName(member.name), member.id]),
      );
      const documentStore = tx.objectStore("documents");
      const documents = new Map(
        (await documentStore.index("by-trip").getAll(tripId)).map((doc) => [
          doc.id,
          doc,
        ]),
      );
      for (const doc of documents.values()) {
        for (const person of doc.people ?? []) {
          if (
            memberIds.has(person.memberId) &&
            !known.has(normalizePersonName(person.name))
          )
            known.set(normalizePersonName(person.name), person.memberId);
        }
      }
      const changed = new Set<string>();
      const events = trip.events.map((event) => ({
        ...event,
        memberIds: [...event.memberIds],
      }));
      for (const selection of selections) {
        const doc = documents.get(selection.documentId);
        if (!doc)
          throw new Error("Документ удалён или относится к другой поездке.");
        if (!Array.isArray(selection.names) || selection.names.length > 50)
          throw new Error("В документе можно подтвердить до 50 участников.");
        const people = new Map(
          (doc.people ?? [])
            .filter((person) => memberIds.has(person.memberId))
            .map((person) => [normalizePersonName(person.name), person]),
        );
        for (const requested of selection.names) {
          const name = confirmedName(requested.name);
          const key = normalizePersonName(name);
          const match = known.get(key);
          let memberId = requested.memberId ?? match;
          if (
            requested.memberId !== undefined &&
            !memberIds.has(requested.memberId)
          )
            throw new Error("Участник для сопоставления не найден.");
          if (requested.memberId && match && match !== requested.memberId)
            throw new Error("Это имя уже связано с другим участником.");
          if (!memberId) {
            if (members.length >= 50)
              throw new Error(
                "В одной поездке можно сохранить до 50 участников.",
              );
            memberId = crypto.randomUUID();
            members.push({ id: memberId, name });
            memberIds.add(memberId);
          }
          known.set(key, memberId);
          people.set(key, people.get(key) ?? { name, memberId });
          if (people.size > 50)
            throw new Error("В документе можно подтвердить до 50 участников.");
          for (const event of events) {
            if (
              (doc.eventId === event.id || doc.eventIds?.includes(event.id)) &&
              !event.memberIds.includes(memberId)
            )
              event.memberIds.push(memberId);
          }
        }
        const updated = { ...doc, people: [...people.values()] };
        validateStoredDocument(updated);
        documents.set(doc.id, updated);
        changed.add(doc.id);
      }
      const updated = parseTrip({ ...trip, members, events });
      for (const id of changed) await documentStore.put(documents.get(id)!);
      await tx.objectStore("trips").put(updated);
      await tx.done;
      return updated;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already aborted. */
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async function loadTrips(): Promise<Trip[]> {
    const db = await database();
    return db.getAll("trips");
  }

  /** One consistent snapshot, including concurrent writes from other tabs. */
  async function tripSnapshot(id: string) {
    const db = await database();
    const tx = db.transaction(["trips", "documents"], "readonly");
    const [trip, documents] = await Promise.all([
      tx.objectStore("trips").get(id),
      tx.objectStore("documents").index("by-trip").getAll(id),
    ]);
    await tx.done;
    if (!trip) throw new Error("Поездка не найдена.");
    return { trip, documents };
  }

  /** Restore only a new copy; an invalid attachment cannot leave a partial trip. */
  async function restoreTripCopy(trip: Trip, documents: StoredDocument[]) {
    const validated = parseTrip(trip);
    if (new Set(documents.map((doc) => doc.id)).size !== documents.length)
      throw new Error("Повторяющиеся документы.");
    for (const doc of documents) {
      validateStoredDocument(doc);
      if (doc.tripId !== trip.id) throw new Error("Документ другой поездки.");
      assertDocumentLinks(validated, doc);
    }
    const db = await database();
    const tx = db.transaction(["trips", "documents"], "readwrite");
    void tx.done.catch(() => undefined);
    try {
      await tx.objectStore("trips").add(validated);
      await Promise.all(
        documents.map((doc) => tx.objectStore("documents").add(doc)),
      );
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already aborted. */
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async function removeTrip(id: string): Promise<void> {
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
    if (document.people) {
      if (!Array.isArray(document.people) || document.people.length > 50)
        throw new Error("Некорректные участники документа.");
      const names = new Set<string>();
      for (const person of document.people) {
        const name = confirmedName(person.name);
        if (
          typeof person.memberId !== "string" ||
          !person.memberId ||
          person.memberId.length > 100 ||
          names.has(normalizePersonName(name))
        )
          throw new Error("Некорректные участники документа.");
        names.add(normalizePersonName(name));
      }
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
      ) ||
      document.people?.some(
        (person) =>
          !trip?.members.some((member) => member.id === person.memberId),
      )
    ) {
      throw new Error("Поездка или событие для документа не найдены.");
    }
  }

  async function saveDocument(document: StoredDocument): Promise<void> {
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

  async function listDocuments(tripId: string): Promise<StoredDocument[]> {
    const db = await database();
    return db.getAllFromIndex("documents", "by-trip", tripId);
  }

  async function getDocument(id: string): Promise<StoredDocument | undefined> {
    const db = await database();
    return db.get("documents", id);
  }

  async function removeDocument(id: string): Promise<void> {
    const db = await database();
    const transaction = db.transaction("documents", "readwrite");
    await Promise.all([transaction.store.delete(id), transaction.done]);
  }

  async function removeEvent(trip: Trip, eventId: string): Promise<Trip> {
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
            document.eventId === eventId ||
            document.eventIds?.includes(eventId),
        )
        .map((document) => {
          const detached = { ...document };
          if (detached.eventIds)
            detached.eventIds = detached.eventIds.filter(
              (id) => id !== eventId,
            );
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
  async function saveUploadedDocument(
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

  async function beginRecognition(
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
        document.recognition?.status === "queued" ||
        (document.recognition?.cloudJobId &&
          document.recognition.status === "processing")
      )
        throw new Error(
          "Документ уже в очереди распознавания. Дождитесь результата.",
        );
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
          cloudJobId: undefined,
          cloudUserId: undefined,
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

  /** Bind before upload/enqueue so a lost HTTP response cannot orphan a queued job. */
  async function queueCloudRecognition(
    id: string,
    attemptId: string,
    jobId: string,
    userId: string,
  ): Promise<void> {
    const db = await database();
    const tx = db.transaction("documents", "readwrite");
    void tx.done.catch(() => undefined);
    try {
      const document = await tx.store.get(id);
      if (
        !document ||
        document.recognition?.attemptId !== attemptId ||
        document.recognition.status !== "processing"
      )
        throw new Error("Попытка распознавания устарела.");
      await tx.store.put({
        ...document,
        recognition: {
          ...document.recognition,
          status: "queued",
          cloudJobId: jobId,
          cloudUserId: userId,
          message:
            "Ожидает распознавания на компьютере. Компьютер должен быть включён.",
        },
      });
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async function updateCloudRecognition(
    id: string,
    attemptId: string,
    jobId: string,
    status: "queued" | "processing" | "failed",
    message?: string,
  ): Promise<void> {
    const db = await database();
    const tx = db.transaction("documents", "readwrite");
    void tx.done.catch(() => undefined);
    try {
      const document = await tx.store.get(id);
      if (
        document?.recognition?.attemptId === attemptId &&
        document.recognition.cloudJobId === jobId &&
        ["queued", "processing"].includes(document.recognition.status)
      ) {
        await tx.store.put({
          ...document,
          recognition: {
            ...document.recognition,
            status,
            message: (
              message ??
              (status === "processing"
                ? "Компьютер распознаёт документ…"
                : status === "failed"
                  ? "Не удалось распознать документ. Можно повторить попытку."
                  : "Ожидает распознавания на компьютере.")
            ).slice(0, 500),
          },
        });
      }
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async function applyRecognition(
    id: string,
    attemptId: string,
    raw: RecognitionResult,
    options: ImportOptions = {},
    expectedCloud?: { jobId: string; userId: string },
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
      if (expectedCloud) {
        if (
          document.recognition?.cloudJobId !== expectedCloud.jobId ||
          document.recognition.cloudUserId !== expectedCloud.userId
        )
          throw new Error("Результат относится к другому облачному заданию.");
        // The read/write transaction serializes browser tabs. Only a pending
        // matching job may auto-import; terminal/manual state is never replayed.
        if (!["queued", "processing"].includes(document.recognition.status)) {
          await transaction.done;
          return { trip, document, added: 0, duplicates: 0 };
        }
      }
      const plan = buildImportPlan(trip, result.events, options);
      const links = [
        ...new Set(
          [
            document.eventId,
            ...(document.eventIds ?? []),
            ...plan.eventIds,
          ].filter(
            (eventId): eventId is string =>
              !!eventId &&
              plan.trip.events.some((event) => event.id === eventId),
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

  async function failRecognition(
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

  return {
    initializeTrips,
    saveTrip,
    confirmDocumentPeople,
    loadTrips,
    tripSnapshot,
    restoreTripCopy,
    removeTrip,
    saveDocument,
    listDocuments,
    getDocument,
    removeDocument,
    removeEvent,
    saveUploadedDocument,
    beginRecognition,
    queueCloudRecognition,
    updateCloudRecognition,
    applyRecognition,
    failRecognition,
  };
}

export type AccountStorage = ReturnType<typeof createAccountStorage>;
