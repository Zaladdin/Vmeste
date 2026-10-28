import "fake-indexeddb/auto";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  saveTrip,
  loadTrips,
  removeTrip,
  saveDocument,
  listDocuments,
  getDocument,
  removeDocument,
  removeEvent,
  initializeTrips,
} from "./storage";
import { sampleTrip } from "./model";

describe("local repository", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const trip of await loadTrips()) await removeTrip(trip.id);
  });

  it("persists trips and document blobs then deletes related documents", async () => {
    const trip = { ...sampleTrip, id: crypto.randomUUID() };
    await saveTrip(trip);
    expect((await loadTrips()).find((t) => t.id === trip.id)?.title).toBe(
      trip.title,
    );
    const file = {
      id: crypto.randomUUID(),
      tripId: trip.id,
      eventId: trip.events[0].id,
      name: "ticket.pdf",
      type: "application/pdf",
      size: 3,
      blob: new Blob(["pdf"], { type: "application/pdf" }),
    };
    await saveDocument(file);
    expect((await listDocuments(trip.id))[0].name).toBe("ticket.pdf");
    expect(await (await getDocument(file.id))?.blob.text()).toBe("pdf");
    await removeDocument(file.id);
    expect(await listDocuments(trip.id)).toEqual([]);
    await saveDocument(file);
    await removeTrip(trip.id);
    expect((await loadTrips()).some((t) => t.id === trip.id)).toBe(false);
    expect(await listDocuments(trip.id)).toEqual([]);
  });

  it("does not recreate the example after the last trip is deleted", async () => {
    expect((await initializeTrips()).map((trip) => trip.id)).toEqual([
      sampleTrip.id,
    ]);
    await removeTrip(sampleTrip.id);
    expect(await initializeTrips()).toEqual([]);
  });

  it("rejects invalid trips before writing", async () => {
    const trip = {
      ...sampleTrip,
      id: crypto.randomUUID(),
      endDate: "2027-05-01",
    };
    await expect(saveTrip(trip)).rejects.toThrow();
    expect((await loadTrips()).some((saved) => saved.id === trip.id)).toBe(
      false,
    );
  });

  it("does not save documents with missing trip or event references", async () => {
    const trip = { ...sampleTrip, id: crypto.randomUUID() };
    const file = {
      id: crypto.randomUUID(),
      tripId: trip.id,
      name: "ticket.pdf",
      type: "application/pdf",
      size: 3,
      blob: new Blob(["pdf"], { type: "application/pdf" }),
    };
    await expect(saveDocument(file)).rejects.toThrow("не найдены");
    await saveTrip(trip);
    await expect(
      saveDocument({ ...file, eventId: "missing-event" }),
    ).rejects.toThrow("не найдены");
    expect(await listDocuments(trip.id)).toEqual([]);
  });

  it("rejects unsupported or mismatched file metadata", async () => {
    const trip = { ...sampleTrip, id: crypto.randomUUID() };
    await saveTrip(trip);
    const file = {
      id: crypto.randomUUID(),
      tripId: trip.id,
      name: "ticket.pdf",
      type: "application/pdf",
      size: 3,
      blob: new Blob(["pdf"], { type: "application/pdf" }),
    };
    await expect(saveDocument({ ...file, type: "text/html" })).rejects.toThrow(
      "Поддерживаются",
    );
    await expect(saveDocument({ ...file, size: 1 })).rejects.toThrow(
      "не соответствует",
    );
    expect(await listDocuments(trip.id)).toEqual([]);
  });

  it("atomically unlinks documents when removing an event and preserves newer trip edits", async () => {
    const stale = { ...sampleTrip, id: crypto.randomUUID() };
    const current = { ...stale, title: "Обновлённый план" };
    await saveTrip(current);
    const file = {
      id: crypto.randomUUID(),
      tripId: current.id,
      eventId: current.events[0].id,
      name: "ticket.pdf",
      type: "application/pdf",
      size: 3,
      blob: new Blob(["pdf"], { type: "application/pdf" }),
    };
    await saveDocument(file);
    const updated = await removeEvent(stale, file.eventId);
    expect(updated.title).toBe(current.title);
    expect(updated.events.some((event) => event.id === file.eventId)).toBe(
      false,
    );
    const document = await getDocument(file.id);
    expect(document).not.toHaveProperty("eventId");
    expect(await document?.blob.text()).toBe("pdf");
    expect((await loadTrips()).find((trip) => trip.id === current.id)).toEqual(
      updated,
    );
  });

  it("rejects when an IndexedDB transaction aborts without committing partial changes", async () => {
    const trip = { ...sampleTrip, id: crypto.randomUUID() };
    await saveTrip(trip);
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const request =
        key === undefined
          ? originalPut.call(this, value)
          : originalPut.call(this, value, key);
      this.transaction.abort();
      return request;
    });
    await expect(
      saveTrip({ ...trip, title: "Не должно сохраниться" }),
    ).rejects.toThrow();
    expect(
      (await loadTrips()).find((saved) => saved.id === trip.id)?.title,
    ).toBe(trip.title);
  });

  it("rejects event deletion for a missing trip", async () => {
    await expect(
      removeEvent(
        { ...sampleTrip, id: crypto.randomUUID() },
        sampleTrip.events[0].id,
      ),
    ).rejects.toThrow("Поездка не найдена");
    expect(await getDocument("missing-document")).toBeUndefined();
  });
});
