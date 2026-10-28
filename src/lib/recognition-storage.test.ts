import "fake-indexeddb/auto";
import { RECOGNITION_RETRY_DELAY_MS } from "./recognition-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleTrip, type StoredDocument } from "./model";
import { type BookingDraft } from "./recognition";
import {
  applyRecognition,
  beginRecognition,
  failRecognition,
  getDocument,
  loadTrips,
  removeDocument,
  removeEvent,
  removeTrip,
  saveDocument,
  saveTrip,
  saveUploadedDocument,
  listDocuments,
  queueCloudRecognition,
  updateCloudRecognition,
} from "./storage";

const flight: BookingDraft = {
  kind: "flight",
  title: "Баку → Стамбул",
  date: "2027-05-10",
  time: "09:30",
  timeZone: "Asia/Baku",
  endDate: "2027-05-10",
  endTime: "11:40",
  endTimeZone: "Europe/Istanbul",
  location: "Istanbul Airport",
  details: "J2 077",
  needsReview: false,
  reviewReason: null,
};
const result = { events: [flight], warnings: [] };
async function setup(fingerprint = "a".repeat(64)) {
  const trip = { ...sampleTrip, id: crypto.randomUUID(), events: [] };
  await saveTrip(trip);
  const document: StoredDocument = {
    id: crypto.randomUUID(),
    tripId: trip.id,
    name: "ticket.pdf",
    type: "application/pdf",
    size: 3,
    blob: new Blob(["pdf"], { type: "application/pdf" }),
    fingerprint,
  };
  await saveDocument(document);
  return { trip, document };
}
describe("recognition repository", () => {
  it("ignores a late cloud completion after another tab imported and manually edited the event", async () => {
    const { document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const jobId = crypto.randomUUID(),
      userId = crypto.randomUUID();
    await queueCloudRecognition(document.id, attemptId, jobId, userId);
    const imported = await applyRecognition(
      document.id,
      attemptId,
      result,
      {},
      { jobId, userId },
    );
    await saveTrip({
      ...imported.trip,
      events: imported.trip.events.map((event) => ({
        ...event,
        title: "Мой исправленный перелёт",
      })),
    });
    const late = await applyRecognition(
      document.id,
      attemptId,
      result,
      {},
      { jobId, userId },
    );
    expect(late.added).toBe(0);
    expect(late.trip.events).toHaveLength(1);
    expect(late.trip.events[0].title).toBe("Мой исправленный перелёт");
  });
  it("does not restore a deleted event from a late cloud response but still permits explicit manual restoration", async () => {
    const { document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const jobId = crypto.randomUUID(),
      userId = crypto.randomUUID();
    await queueCloudRecognition(document.id, attemptId, jobId, userId);
    const imported = await applyRecognition(
      document.id,
      attemptId,
      result,
      {},
      { jobId, userId },
    );
    await removeEvent(imported.trip, imported.trip.events[0].id);
    const late = await applyRecognition(
      document.id,
      attemptId,
      result,
      {},
      { jobId, userId },
    );
    expect(late.added).toBe(0);
    expect(late.trip.events).toEqual([]);
    expect(late.document.recognition?.status).toBe("needs_review");
    expect(
      (
        await applyRecognition(document.id, attemptId, result, {
          reviewed: true,
        })
      ).added,
    ).toBe(1);
  });
  it("persists a cloud queue binding and blocks duplicate attempts after reload", async () => {
    const { document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const jobId = crypto.randomUUID(),
      userId = crypto.randomUUID();
    await queueCloudRecognition(document.id, attemptId, jobId, userId);
    expect((await getDocument(document.id))?.recognition).toMatchObject({
      status: "queued",
      cloudJobId: jobId,
      cloudUserId: userId,
      attemptId,
    });
    await expect(beginRecognition(document.id)).rejects.toThrow(/очереди/);
    await updateCloudRecognition(document.id, attemptId, jobId, "processing");
    await expect(beginRecognition(document.id)).rejects.toThrow(/очереди/);
    await updateCloudRecognition(document.id, attemptId, jobId, "failed");
    expect(
      (await beginRecognition(document.id)).document.recognition?.cloudJobId,
    ).toBeUndefined();
  });
  it("does not apply a stale cloud state to a newer request", async () => {
    const { document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const jobId = crypto.randomUUID();
    await queueCloudRecognition(
      document.id,
      attemptId,
      jobId,
      crypto.randomUUID(),
    );
    await updateCloudRecognition(
      document.id,
      attemptId,
      crypto.randomUUID(),
      "failed",
    );
    expect((await getDocument(document.id))?.recognition?.status).toBe(
      "queued",
    );
    await updateCloudRecognition(document.id, attemptId, jobId, "failed");
    const next = await beginRecognition(document.id);
    expect(next.attemptId).not.toBe(attemptId);
    await updateCloudRecognition(document.id, attemptId, jobId, "processing");
    expect((await getDocument(document.id))?.recognition?.attemptId).toBe(
      next.attemptId,
    );
  });
  it("persists CLI token usage with the original recognition result", async () => {
    const { document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const usage = {
      provider: "codex" as const,
      inputTokens: 1200,
      cachedInputTokens: 1000,
      outputTokens: 200,
    };
    await applyRecognition(document.id, attemptId, { ...result, usage });
    expect(
      (await getDocument(document.id))?.recognition?.result?.usage,
    ).toEqual(usage);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const trip of await loadTrips()) await removeTrip(trip.id);
  });
  it("deduplicates simultaneous identical files per trip", async () => {
    const { trip, document } = await setup();
    const repeated = { ...document, id: crypto.randomUUID() };
    const saved = await saveUploadedDocument(repeated);
    expect(saved.duplicate).toBe(true);
    expect(saved.document.id).toBe(document.id);
    await removeDocument(document.id);
    const [a, b] = await Promise.all([
      saveUploadedDocument(document),
      saveUploadedDocument(repeated),
    ]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await listDocuments(trip.id)).toHaveLength(1);
  });
  it("applies all legs atomically against latest trip and links existing matching events", async () => {
    const { trip, document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    await saveTrip({ ...trip, title: "Новый заголовок" });
    const second = {
      ...flight,
      title: "Стамбул → Баку",
      date: "2027-05-15",
      timeZone: "Europe/Istanbul",
      endDate: "2027-05-15",
      endTimeZone: "Asia/Baku",
      endTime: "17:50",
    };
    const imported = await applyRecognition(document.id, attemptId, {
      events: [flight, second],
      warnings: [],
    });
    expect(imported.trip.title).toBe("Новый заголовок");
    expect(imported.added).toBe(2);
    expect(imported.document.eventIds).toHaveLength(2);
    expect(imported.document.eventId).toBe(imported.document.eventIds![0]);
    const other = {
      ...document,
      id: crypto.randomUUID(),
      fingerprint: "b".repeat(64),
    };
    await saveDocument(other);
    const next = await beginRecognition(other.id);
    const repeated = await applyRecognition(other.id, next.attemptId, result);
    expect(repeated.added).toBe(0);
    expect(repeated.duplicates).toBe(1);
    expect(repeated.document.eventIds).toEqual([
      imported.document.eventIds![0],
    ]);
  });
  it("persists uncertain results without adding events then accepts completed review", async () => {
    const { document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const uncertain = {
      events: [
        {
          ...flight,
          time: null,
          needsReview: true,
          reviewReason: "Нет времени",
        },
      ],
      warnings: ["Проверьте данные"],
    };
    const pending = await applyRecognition(document.id, attemptId, uncertain);
    expect(pending.trip.events).toHaveLength(0);
    expect(pending.document.recognition?.status).toBe("needs_review");
    expect(pending.document.recognition?.result).toEqual(uncertain);
    const reviewed = await applyRecognition(document.id, attemptId, result, {
      reviewed: true,
    });
    expect(reviewed.added).toBe(1);
    expect(reviewed.document.recognition?.status).toBe("completed");
  });
  it("rejects old attempts and does not resurrect deleted files", async () => {
    const { document } = await setup();
    const first = await beginRecognition(document.id);
    await expect(beginRecognition(document.id)).rejects.toThrow();
    vi.spyOn(Date, "now").mockReturnValue(
      Date.now() + RECOGNITION_RETRY_DELAY_MS + 1000,
    );
    const second = await beginRecognition(document.id);
    await expect(
      applyRecognition(document.id, first.attemptId, result),
    ).rejects.toThrow();
    await failRecognition(document.id, first.attemptId, "old");
    expect((await getDocument(document.id))?.recognition?.attemptId).toBe(
      second.attemptId,
    );
    await removeDocument(document.id);
    await failRecognition(document.id, second.attemptId, "failed");
    await expect(
      applyRecognition(document.id, second.attemptId, result),
    ).rejects.toThrow();
    expect(await getDocument(document.id)).toBeUndefined();
  });
  it("preserves manual links, removes recognized links on event deletion, and bounds failure messages", async () => {
    const { trip, document } = await setup();
    await saveTrip({ ...trip, events: sampleTrip.events });
    await saveDocument({ ...document, eventId: "hotel" });
    const { attemptId } = await beginRecognition(document.id);
    const saved = await applyRecognition(document.id, attemptId, result);
    expect(saved.document.eventId).toBe("hotel");
    expect(saved.document.eventIds).toEqual(
      expect.arrayContaining(["hotel", "flight-out"]),
    );
    await removeEvent(saved.trip, "flight-out");
    expect((await getDocument(document.id))?.eventIds).toEqual(["hotel"]);
    const next = await beginRecognition(document.id);
    await failRecognition(document.id, next.attemptId, "x".repeat(1000));
    expect((await getDocument(document.id))?.recognition?.message).toHaveLength(
      500,
    );
  });
  it("rolls back event additions when the document write fails", async () => {
    const { trip, document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const req =
        key === undefined
          ? original.call(this, value)
          : original.call(this, value, key);
      if (this.name === "documents") this.transaction.abort();
      return req;
    });
    await expect(
      applyRecognition(document.id, attemptId, result),
    ).rejects.toThrow();
    vi.restoreAllMocks();
    expect(
      (await loadTrips()).find((t) => t.id === trip.id)?.events,
    ).toHaveLength(0);
    expect((await getDocument(document.id))?.recognition?.status).toBe(
      "processing",
    );
  });
  it("rejects invalid linked event IDs and invalid fingerprints before writing", async () => {
    const { document } = await setup();
    await expect(
      saveDocument({ ...document, eventIds: ["missing"] }),
    ).rejects.toThrow();
    await expect(
      saveUploadedDocument({ ...document, fingerprint: "invalid" }),
    ).rejects.toThrow();
  });
  it("records an empty recognized document without inventing events", async () => {
    const { document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const saved = await applyRecognition(document.id, attemptId, {
      events: [],
      warnings: ["Не билет"],
    });
    expect(saved.document.recognition?.status).toBe("empty");
    expect(saved.added).toBe(0);
  });
  it("keeps deleted recognized events as reviewable drafts and restores them only after confirmation", async () => {
    const { document } = await setup();
    const { attemptId } = await beginRecognition(document.id);
    const imported = await applyRecognition(document.id, attemptId, result);
    const originalId = imported.document.eventIds![0];
    const tripAfterDelete = await removeEvent(imported.trip, originalId);
    const saved = await getDocument(document.id);
    expect(tripAfterDelete.events).toEqual([]);
    expect(saved?.recognition?.status).toBe("needs_review");
    expect(saved?.recognition?.message).toBe(
      "Событие удалено из плана. Проверьте данные, чтобы добавить его снова.",
    );
    expect(saved?.recognition?.result).toEqual(result);
    expect(saved?.recognition?.attemptId).toBe(attemptId);
    expect(saved?.eventIds).toEqual([]);
    const restored = await applyRecognition(
      document.id,
      attemptId,
      saved!.recognition!.result!,
      { reviewed: true },
    );
    expect(restored.added).toBe(1);
    expect(restored.document.recognition?.status).toBe("completed");
    expect(restored.document.eventIds).toHaveLength(1);
    expect(restored.document.eventIds![0]).not.toBe(originalId);
    expect(restored.trip.events[0].id).toBe(restored.document.eventIds![0]);
  });
  it("does not create a recognition status for a manually linked document on event deletion", async () => {
    const { trip, document } = await setup();
    const withEvents = { ...trip, events: sampleTrip.events };
    await saveTrip(withEvents);
    await saveDocument({ ...document, eventId: "flight-out" });
    await removeEvent(withEvents, "flight-out");
    expect((await getDocument(document.id))?.recognition).toBeUndefined();
  });
});
