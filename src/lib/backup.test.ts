import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBackup as createScopedBackup,
  restoreBackup as restoreScopedBackup,
} from "./backup";
import { sampleTrip } from "./model";
import { createAccountStorage } from "./storage";
const storage = createAccountStorage("44444444-4444-4444-8444-444444444444");
const { saveTrip, saveDocument, loadTrips, listDocuments, removeTrip } =
  storage;
const createBackup = (tripId: string) => createScopedBackup(tripId, storage);
const restoreBackup = (file: Blob) => restoreScopedBackup(file, storage);
afterEach(async () => {
  for (const trip of await loadTrips()) await removeTrip(trip.id);
});
async function fixture() {
  const trip = { ...sampleTrip, id: crypto.randomUUID() };
  await saveTrip(trip);
  const bytes = new Uint8Array([0, 255, 127, 13, 10, 99]);
  const doc = {
    id: crypto.randomUUID(),
    tripId: trip.id,
    eventIds: [trip.events[0].id],
    name: "original.pdf",
    type: "application/pdf",
    size: bytes.length,
    blob: new Blob([bytes], { type: "application/pdf" }),
  };
  await saveDocument(doc);
  return { trip, doc, bytes };
}
describe("complete trip backup", () => {
  it("preserves confirmed document aliases and remaps their member IDs", async () => {
    const { trip, doc } = await fixture();
    await saveDocument({
      ...doc,
      people: [{ name: "Alex Example", memberId: trip.members[0].id }],
    });
    const backup = await createBackup(trip.id);
    const restored = await restoreBackup(backup);
    const [attachment] = await listDocuments(restored.id);
    expect(attachment.people).toEqual([
      { name: "Alex Example", memberId: restored.members[0].id },
    ]);
    expect(attachment.people?.[0].memberId).not.toBe(trip.members[0].id);
  });
  it("restores exact binary originals and participant/event associations as independent copies", async () => {
    const { trip, doc, bytes } = await fixture();
    const backup = await createBackup(trip.id);
    const restored = await restoreBackup(backup);
    expect(restored.id).not.toBe(trip.id);
    expect(restored.members[0].id).not.toBe(trip.members[0].id);
    expect(restored.events[0].memberIds).toEqual(
      trip.events[0].memberIds.map(
        (id) => restored.members[trip.members.findIndex((m) => m.id === id)].id,
      ),
    );
    const [attachment] = await listDocuments(restored.id);
    expect(attachment.id).not.toBe(doc.id);
    expect(attachment.eventIds).toEqual([restored.events[0].id]);
    expect(new Uint8Array(await attachment.blob.arrayBuffer())).toEqual(bytes);
    await removeTrip(trip.id);
    expect(await listDocuments(restored.id)).toHaveLength(1);
    await restoreBackup(backup);
    expect(await loadTrips()).toHaveLength(2);
  });
  it("rejects corrupted bytes, duplicate IDs and dangling links without partial writes", async () => {
    const { trip } = await fixture();
    const original = JSON.parse(await (await createBackup(trip.id)).text());
    for (const mutate of [
      (copy: typeof original) => {
        copy.documents[0].data = "AQID";
      },
      (copy: typeof original) => {
        copy.documents.push(copy.documents[0]);
      },
      (copy: typeof original) => {
        copy.documents[0].eventIds = ["missing"];
      },
      (copy: typeof original) => {
        copy.version = 99;
      },
      (copy: typeof original) => {
        copy.documents[0].people = [
          { name: "Anna Example", memberId: "missing" },
        ];
      },
      (copy: typeof original) => {
        copy.documents[0].people = [
          { name: "passport12345", memberId: copy.trip.members[0].id },
        ];
      },
    ]) {
      const copy = structuredClone(original);
      mutate(copy);
      await expect(
        restoreBackup(new Blob([JSON.stringify(copy)])),
      ).rejects.toThrow();
      expect(await loadTrips()).toHaveLength(1);
    }
  });
  it("does not restore queue IDs or resume model processing", async () => {
    const { trip, doc } = await fixture();
    await saveDocument({
      ...doc,
      recognition: {
        status: "processing",
        message: "pending",
        cloudJobId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
      },
    });
    const backup = await createBackup(trip.id);
    expect(await backup.text()).not.toContain("cloudJobId");
    const restored = await restoreBackup(backup);
    expect((await listDocuments(restored.id))[0].recognition).toBeUndefined();
  });
});
