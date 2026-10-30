import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createAccountStorage } from "./storage";
import { sampleTrip, type StoredDocument, type Trip } from "./model";

async function fixture() {
  const ownerId = crypto.randomUUID();
  const storage = createAccountStorage(ownerId);
  const trip: Trip = {
    ...sampleTrip,
    id: crypto.randomUUID(),
    members: [
      { id: "keep", name: "Anna Ivanova" },
      { id: "duplicate", name: "IVANOVA ANNA" },
      { id: "other", name: "Maxim Petrov" },
    ],
    events: [
      { ...sampleTrip.events[0], memberIds: ["duplicate", "keep", "other"] },
    ],
  };
  await storage.saveTrip(trip);
  const bytes = new Uint8Array([0, 255, 4, 120]);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const document: StoredDocument = {
    id: crypto.randomUUID(),
    tripId: trip.id,
    eventIds: [trip.events[0].id],
    name: "original.pdf",
    type: blob.type,
    size: blob.size,
    blob,
    people: [
      { name: "Anna Ivanova", memberId: "keep" },
      { name: "IVANOVA ANNA", memberId: "duplicate" },
      { name: "Maxim Petrov", memberId: "other" },
    ],
    recognition: {
      status: "needs_review",
      message: "Проверьте даты",
      result: { events: [], warnings: ["Уточните год"] },
    },
  };
  await storage.saveDocument(document);
  return { ownerId, storage, trip, document, bytes };
}

describe("explicit duplicate people merge", () => {
  it("reuses a confirmed self alias for a later reversed recognition result", async () => {
    const { storage, trip, document } = await fixture();
    const self = { ...trip, members: [{ id: "self", name: "Я" }], events: [] };
    await storage.saveTrip(self);
    await storage.saveDocument({
      ...document,
      eventIds: [],
      people: [{ name: "Anna Ivanova", memberId: "self" }],
    });
    const next = {
      ...document,
      id: crypto.randomUUID(),
      eventIds: [],
      people: undefined,
      recognition: undefined,
    };
    await storage.saveDocument(next);
    const started = await storage.beginRecognition(next.id);
    const applied = await storage.applyRecognition(next.id, started.attemptId, {
      events: [
        {
          kind: "flight",
          title: "Новый перелёт",
          date: trip.startDate,
          time: "09:30",
          timeZone: "Asia/Baku",
          endDate: trip.startDate,
          endTime: "11:40",
          endTimeZone: "Europe/Istanbul",
          location: "Airport",
          details: "Участники: IVANOVA ANNA",
          needsReview: false,
          reviewReason: null,
        },
      ],
      warnings: [],
    });
    expect(applied.trip.members).toEqual(self.members);
    expect(applied.trip.events[0].memberIds).toEqual(["self"]);
  });
  it("retains the selected identity, all event links, original aliases and exact file bytes", async () => {
    const { storage, trip, document, bytes } = await fixture();
    const updated = await storage.mergePeople(trip.id, "keep", ["duplicate"]);
    expect(updated.members).toEqual([trip.members[0], trip.members[2]]);
    expect(updated.events[0].memberIds).toEqual(["keep", "other"]);
    expect({ ...updated.events[0], memberIds: [] }).toEqual({
      ...trip.events[0],
      memberIds: [],
    });
    const stored = await storage.getDocument(document.id);
    expect(stored?.people).toEqual([
      { name: "Anna Ivanova", memberId: "keep" },
      { name: "IVANOVA ANNA", memberId: "keep" },
      { name: "Maxim Petrov", memberId: "other" },
    ]);
    expect(stored?.recognition).toEqual(document.recognition);
    expect(new Uint8Array(await stored!.blob.arrayBuffer())).toEqual(bytes);
    expect(stored?.eventIds).toEqual(document.eventIds);
  });
  it("allows keeping the reversed spelling and its existing ID instead", async () => {
    const { storage, trip } = await fixture();
    const updated = await storage.mergePeople(trip.id, "duplicate", ["keep"]);
    expect(updated.members).toEqual([trip.members[1], trip.members[2]]);
    expect(updated.events[0].memberIds).toEqual(["duplicate", "other"]);
  });
  it("rejects stale, mismatched or invalid selections without partial writes", async () => {
    const { storage, trip, document } = await fixture();
    for (const [keepId, mergeIds] of [
      ["keep", ["missing"]],
      ["missing", ["duplicate"]],
      ["keep", ["other"]],
      ["keep", []],
      ["keep", ["keep"]],
      ["keep", ["duplicate", "duplicate"]],
    ] as [string, string[]][]) {
      await expect(
        storage.mergePeople(trip.id, keepId, mergeIds),
      ).rejects.toThrow();
      expect((await storage.loadTrips())[0]).toEqual(trip);
      expect((await storage.getDocument(document.id))?.people).toEqual(
        document.people,
      );
    }
    await storage.mergePeople(trip.id, "keep", ["duplicate"]);
    const snapshot = await storage.tripSnapshot(trip.id);
    await expect(
      storage.mergePeople(trip.id, "keep", ["duplicate"]),
    ).rejects.toThrow();
    expect((await storage.tripSnapshot(trip.id)).trip).toEqual(snapshot.trip);
  });
  it("does not merge abbreviated or different names even when explicitly requested", async () => {
    const { storage, trip } = await fixture();
    for (const name of ["A. Ivanova", "Anna", "Anna Ivanoff"]) {
      const changed = {
        ...trip,
        members: trip.members.map((member) =>
          member.id === "duplicate" ? { ...member, name } : member,
        ),
      };
      await storage.saveTrip(changed);
      await expect(
        storage.mergePeople(trip.id, "keep", ["duplicate"]),
      ).rejects.toThrow();
      expect((await storage.loadTrips())[0]).toEqual(changed);
    }
  });
  it("rolls back all document rewrites if a later document write fails", async () => {
    const { storage, trip, document } = await fixture();
    const second = { ...document, id: crypto.randomUUID() };
    await storage.saveDocument(second);
    const original = IDBObjectStore.prototype.put;
    let writes = 0;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof original>
      ) {
        if (this.name === "documents" && ++writes === 2)
          throw new Error("synthetic write failure");
        return original.apply(this, args);
      });
    try {
      await expect(
        storage.mergePeople(trip.id, "keep", ["duplicate"]),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect((await storage.loadTrips())[0]).toEqual(trip);
    expect((await storage.getDocument(document.id))?.people).toEqual(
      document.people,
    );
    expect((await storage.getDocument(second.id))?.people).toEqual(
      second.people,
    );
  });
  it("does not modify another account or a different trip", async () => {
    const { storage, trip, document } = await fixture();
    const other = createAccountStorage(crypto.randomUUID());
    await other.saveTrip(trip);
    await other.saveDocument(document);
    const anotherTrip = { ...trip, id: crypto.randomUUID() };
    await storage.saveTrip(anotherTrip);
    await storage.mergePeople(trip.id, "keep", ["duplicate"]);
    expect((await other.loadTrips())[0]).toEqual(trip);
    expect((await other.getDocument(document.id))?.people).toEqual(
      document.people,
    );
    expect(
      (await storage.loadTrips()).find((saved) => saved.id === anotherTrip.id),
    ).toEqual(anotherTrip);
  });
});
