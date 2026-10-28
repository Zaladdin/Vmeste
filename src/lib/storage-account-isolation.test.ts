import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it, vi } from "vitest";
import { createAccountStorage } from "./storage";
import { createBackup, restoreBackup } from "./backup";
import { sampleTrip, type StoredDocument, type Trip } from "./model";
import type { RecognitionResult } from "./recognition";

function fixture(title: string): { trip: Trip; document: StoredDocument } {
  const trip = { ...sampleTrip, id: "same-trip", title };
  const blob = new Blob([`${title} private ticket`], {
    type: "application/pdf",
  });
  return {
    trip,
    document: {
      id: "same-document",
      tripId: trip.id,
      eventId: trip.events[0].id,
      name: `${title}.pdf`,
      type: blob.type,
      size: blob.size,
      blob,
      people: [{ name: "Alex Example", memberId: trip.members[0].id }],
    },
  };
}

describe("account-scoped local repository", () => {
  it("isolates trips, original files, aliases and recognition state even with matching IDs", async () => {
    const accountA = createAccountStorage(crypto.randomUUID());
    const accountB = createAccountStorage(crypto.randomUUID());
    const first = fixture("Account A");
    const second = fixture("Account B");
    first.document.recognition = {
      status: "queued",
      message: "Ожидает распознавания",
      attemptId: crypto.randomUUID(),
      cloudJobId: crypto.randomUUID(),
      cloudUserId: crypto.randomUUID(),
    };
    await accountA.saveTrip(first.trip);
    await accountA.saveDocument(first.document);

    expect(await accountB.initializeTrips()).toEqual([]);
    expect(await accountB.listDocuments(first.trip.id)).toEqual([]);
    expect(await accountB.getDocument(first.document.id)).toBeUndefined();

    await accountB.saveTrip(second.trip);
    await accountB.saveDocument({ ...second.document, people: [] });
    expect((await accountA.loadTrips())[0].title).toBe("Account A");
    expect((await accountB.loadTrips())[0].title).toBe("Account B");
    expect(
      await (await accountA.getDocument(first.document.id))?.blob.text(),
    ).toBe("Account A private ticket");
    expect(
      await (await accountB.getDocument(second.document.id))?.blob.text(),
    ).toBe("Account B private ticket");
    expect(
      (await accountA.getDocument(first.document.id))?.people,
    ).toHaveLength(1);
    expect((await accountB.getDocument(second.document.id))?.people).toEqual(
      [],
    );
    expect(
      (await accountB.getDocument(second.document.id))?.recognition,
    ).toBeUndefined();

    await accountB.removeDocument(second.document.id);
    await accountB.removeTrip(second.trip.id);
    expect(await accountB.loadTrips()).toEqual([]);
    expect(
      (await accountA.getDocument(first.document.id))?.recognition?.status,
    ).toBe("queued");
    expect((await accountA.loadTrips())[0].title).toBe("Account A");
  });

  it("reopens the same account without leaking to another account and canonicalizes UUID case", async () => {
    const userId = crypto.randomUUID();
    const first = createAccountStorage(userId);
    const { trip, document } = fixture("Returning owner");
    await first.saveTrip(trip);
    await first.saveDocument(document);
    const reopened = createAccountStorage(userId.toUpperCase());
    expect((await reopened.loadTrips())[0].title).toBe(trip.title);
    expect(await (await reopened.getDocument(document.id))?.blob.text()).toBe(
      await document.blob.text(),
    );
    expect(
      await createAccountStorage(crypto.randomUUID()).initializeTrips(),
    ).toEqual([]);
  });

  it("keeps a delayed backup restore bound to its original account", async () => {
    const accountA = createAccountStorage(crypto.randomUUID());
    const accountB = createAccountStorage(crypto.randomUUID());
    const { trip, document } = fixture("Backup owner");
    await accountA.saveTrip(trip);
    await accountA.saveDocument(document);
    const backup = await createBackup(trip.id, accountA);
    const serialized = await backup.text();
    const delayedFile = new Blob([serialized], { type: "application/json" });
    let release!: (value: string) => void;
    vi.spyOn(delayedFile, "text").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const pending = restoreBackup(delayedFile, accountA);
    await accountB.initializeTrips();
    release(serialized);
    const restored = await pending;
    expect((await accountA.loadTrips()).map((saved) => saved.id)).toContain(
      restored.id,
    );
    expect(await accountA.listDocuments(restored.id)).toHaveLength(1);
    expect(await accountB.loadTrips()).toEqual([]);
    expect(await accountB.listDocuments(restored.id)).toEqual([]);
  });

  it("keeps a late recognition completion in A and rejects A's attempt in B", async () => {
    const accountA = createAccountStorage(crypto.randomUUID());
    const first = fixture("Recognition owner A");
    await accountA.saveTrip({ ...first.trip, events: [] });
    await accountA.saveDocument({ ...first.document, eventId: undefined });
    const startedA = await accountA.beginRecognition(first.document.id);

    let complete!: (result: RecognitionResult) => void;
    const modelResult = new Promise<RecognitionResult>((resolve) => {
      complete = resolve;
    });
    const pendingA = modelResult.then((result) =>
      accountA.applyRecognition(first.document.id, startedA.attemptId, result),
    );

    const accountB = createAccountStorage(crypto.randomUUID());
    await accountB.initializeTrips();
    const second = fixture("Recognition owner B");
    await accountB.saveTrip({ ...second.trip, events: [] });
    await accountB.saveDocument({ ...second.document, eventId: undefined });
    const startedB = await accountB.beginRecognition(second.document.id);
    expect(startedB.attemptId).not.toBe(startedA.attemptId);
    const beforeB = await accountB.tripSnapshot(second.trip.id);
    const result: RecognitionResult = {
      events: [
        {
          kind: "flight",
          title: "Private flight A",
          date: "2027-05-10",
          time: "09:30",
          timeZone: "Asia/Baku",
          endDate: "2027-05-10",
          endTime: "11:40",
          endTimeZone: "Europe/Istanbul",
          location: "Istanbul Airport",
          details: "",
          needsReview: false,
          reviewReason: null,
        },
      ],
      warnings: [],
    };
    complete(result);
    const applied = await pendingA;
    expect(applied.added).toBe(1);
    expect((await accountA.loadTrips())[0].events[0].title).toBe(
      "Private flight A",
    );
    expect(
      (await accountA.getDocument(first.document.id))?.recognition?.status,
    ).toBe("completed");
    expect(await accountB.tripSnapshot(second.trip.id)).toEqual(beforeB);

    await expect(
      accountB.applyRecognition(second.document.id, startedA.attemptId, result),
    ).rejects.toThrow(/устарел/);
    expect(await accountB.tripSnapshot(second.trip.id)).toEqual(beforeB);
    expect(
      (await accountB.getDocument(second.document.id))?.recognition?.attemptId,
    ).toBe(startedB.attemptId);
  });

  it("does not expose or change unowned legacy data", async () => {
    const legacy = await openDB("vmeste", 2, {
      upgrade(db) {
        db.createObjectStore("trips", { keyPath: "id" });
        const documents = db.createObjectStore("documents", { keyPath: "id" });
        documents.createIndex("by-trip", "tripId");
        db.createObjectStore("settings");
      },
    });
    try {
      const { trip, document } = fixture("Unassigned legacy owner");
      await legacy.put("trips", trip);
      await legacy.put("documents", document);
      const accountA = createAccountStorage(crypto.randomUUID());
      const accountB = createAccountStorage(crypto.randomUUID());
      expect(await accountA.initializeTrips()).toEqual([]);
      expect(await accountB.initializeTrips()).toEqual([]);
      expect(await accountA.getDocument(document.id)).toBeUndefined();
      expect(await accountB.listDocuments(trip.id)).toEqual([]);
      await accountA.saveTrip(fixture("New owner").trip);
      expect((await legacy.get("trips", trip.id)).title).toBe(trip.title);
      expect(
        await (await legacy.get("documents", document.id)).blob.text(),
      ).toBe(await document.blob.text());
    } finally {
      legacy.close();
    }
  });

  it.each(["", "guest", "../vmeste", "not-a-user-id"])(
    "rejects an invalid account ID: %s",
    (id) => {
      expect(() => createAccountStorage(id)).toThrow();
    },
  );
  it.each([undefined, null, 42, {}])(
    "rejects a non-string account identity: %j",
    (id) => {
      expect(() => createAccountStorage(id as unknown as string)).toThrow();
    },
  );
});
