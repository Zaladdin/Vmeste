import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { sampleTrip, type StoredDocument } from "./model";
import { createAccountStorage } from "./storage";
const {
  confirmDocumentPeople,
  listDocuments,
  loadTrips,
  removeTrip,
  saveDocument,
  saveTrip,
} = createAccountStorage("33333333-3333-4333-8333-333333333333");

afterEach(async () => {
  for (const trip of await loadTrips()) await removeTrip(trip.id);
});

async function fixture() {
  const trip = {
    ...sampleTrip,
    id: crypto.randomUUID(),
    members: [{ id: "self", name: "Я" }],
    events: [{ ...sampleTrip.events[0], memberIds: ["self"] }],
  };
  await saveTrip(trip);
  const blob = new Blob(["synthetic PDF"], { type: "application/pdf" });
  const document: StoredDocument = {
    id: crypto.randomUUID(),
    tripId: trip.id,
    name: "legacy.pdf",
    type: blob.type,
    size: blob.size,
    blob,
    eventIds: [trip.events[0].id],
    recognition: {
      status: "needs_review",
      message: "Уточните год",
      result: { events: [], warnings: ["Уточните год"] },
    },
  };
  await saveDocument(document);
  return { trip, document };
}

describe("confirm document people separately from scheduling", () => {
  it("adds four people including an explicit self alias without changing recognition or event dates", async () => {
    const { trip, document } = await fixture();
    const updated = await confirmDocumentPeople(trip.id, [
      {
        documentId: document.id,
        names: [
          { name: "Alex Example", memberId: "self" },
          { name: "Elena Example" },
          { name: "Anna Example" },
          { name: "Maxim Example" },
        ],
      },
    ]);
    expect(updated.members).toHaveLength(4);
    expect(updated.members[0]).toEqual({ id: "self", name: "Я" });
    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].memberIds).toHaveLength(4);
    expect({ ...updated.events[0], memberIds: [] }).toEqual({
      ...trip.events[0],
      memberIds: [],
    });
    const [stored] = await listDocuments(trip.id);
    expect(stored.recognition).toEqual(document.recognition);
    expect(stored.people).toHaveLength(4);
    expect(stored.people?.[0]).toEqual({
      name: "Alex Example",
      memberId: "self",
    });
  });

  it("reuses exact names and confirmed aliases across multiple documents and repeated confirmation", async () => {
    const { trip, document } = await fixture();
    await confirmDocumentPeople(trip.id, [
      {
        documentId: document.id,
        names: [{ name: "Alex Example", memberId: "self" }],
      },
    ]);
    const next = { ...document, id: crypto.randomUUID(), eventIds: [] };
    await saveDocument(next);
    const selections = [
      {
        documentId: next.id,
        names: [
          { name: " ALEX   EXAMPLE " },
          { name: "Anna Example" },
          { name: "anna example" },
        ],
      },
    ];
    await confirmDocumentPeople(trip.id, selections);
    const repeated = await confirmDocumentPeople(trip.id, selections);
    expect(repeated.members).toHaveLength(2);
    expect(
      (await listDocuments(trip.id)).find((doc) => doc.id === next.id)?.people,
    ).toHaveLength(2);
  });

  it("adds people from a document with no events without importing unconfirmed dates", async () => {
    const { trip, document } = await fixture();
    await saveDocument({ ...document, eventIds: [] });
    const updated = await confirmDocumentPeople(trip.id, [
      { documentId: document.id, names: [{ name: "Anna Example" }] },
    ]);
    expect(updated.members).toHaveLength(2);
    expect(updated.events).toEqual(trip.events);
  });

  it("rejects deleted or foreign documents, nonexistent mappings and non-name input atomically", async () => {
    const { trip, document } = await fixture();
    const foreign = { ...trip, id: crypto.randomUUID() };
    await saveTrip(foreign);
    const other = { ...document, tripId: foreign.id, id: crypto.randomUUID() };
    await saveDocument(other);
    for (const invalid of [
      { documentId: "missing", names: [{ name: "Anna Example" }] },
      { documentId: other.id, names: [{ name: "Anna Example" }] },
      {
        documentId: document.id,
        names: [{ name: "Anna Example", memberId: "missing" }],
      },
      { documentId: document.id, names: [{ name: "passport12345" }] },
    ]) {
      await expect(
        confirmDocumentPeople(trip.id, [
          { documentId: document.id, names: [{ name: "Elena Example" }] },
          invalid,
        ]),
      ).rejects.toThrow();
      expect(
        (await loadTrips()).find((item) => item.id === trip.id)?.members,
      ).toEqual(trip.members);
      expect((await listDocuments(trip.id))[0].people).toBeUndefined();
    }
  });

  it("rejects exceeding trip capacity without partial people or document writes", async () => {
    const { trip, document } = await fixture();
    const names = Array.from({ length: 50 }, (_, i) => ({
      name: `Person ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
    }));
    await expect(
      confirmDocumentPeople(trip.id, [{ documentId: document.id, names }]),
    ).rejects.toThrow(/50/);
    expect((await loadTrips())[0].members).toHaveLength(1);
    expect((await listDocuments(trip.id))[0].people).toBeUndefined();
  });

  it("prunes confirmed source mappings when their participant is deliberately removed", async () => {
    const { trip, document } = await fixture();
    const updated = await confirmDocumentPeople(trip.id, [
      { documentId: document.id, names: [{ name: "Anna Example" }] },
    ]);
    await saveTrip({ ...updated, members: trip.members, events: trip.events });
    expect((await listDocuments(trip.id))[0].people).toEqual([]);
  });
});
