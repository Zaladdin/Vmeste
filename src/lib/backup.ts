import { z } from "zod";
import {
  exportTrip,
  importTrip,
  linkedEventIds,
  parseTrip,
  validateDocument,
  type StoredDocument,
  type Trip,
} from "./model";
import { recognitionResponseSchema } from "./recognition";
import { restoreTripCopy, tripSnapshot } from "./storage";

export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const attachmentSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(300),
    type: z.string().max(100),
    size: z.number().int().nonnegative(),
    eventIds: z.array(z.string().min(1).max(100)).max(1000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    data: z.string(),
    result: recognitionResponseSchema.optional(),
    people: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            memberId: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();
const backupSchema = z
  .object({
    format: z.literal("vmeste-backup"),
    version: z.literal(1),
    trip: z.unknown(),
    documents: z.array(attachmentSchema).max(1000),
  })
  .strict();
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function encode(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export async function createBackup(tripId: string): Promise<Blob> {
  const snapshot = await tripSnapshot(tripId);
  if (
    snapshot.documents.reduce((sum, doc) => sum + doc.size, 0) >
    90 * 1024 * 1024
  )
    throw new Error("Вложения слишком велики для копии (максимум 90 МБ).");
  const documents = await Promise.all(
    snapshot.documents.map(async (doc) => {
      const bytes = new Uint8Array(await doc.blob.arrayBuffer());
      return {
        id: doc.id,
        name: doc.name,
        type: doc.type,
        size: doc.size,
        eventIds: linkedEventIds(doc),
        sha256: await digest(bytes),
        data: encode(bytes),
        ...(doc.people ? { people: doc.people } : {}),
        ...(doc.recognition?.result
          ? { result: recognitionResponseSchema.parse(doc.recognition.result) }
          : {}),
      };
    }),
  );
  const blob = new Blob(
    [
      JSON.stringify({
        format: "vmeste-backup",
        version: 1,
        trip: snapshot.trip,
        documents,
      }),
    ],
    { type: "application/json" },
  );
  if (blob.size > MAX_BACKUP_BYTES)
    throw new Error("Копия должна быть не больше 128 МБ.");
  return blob;
}
export async function restoreBackup(file: Blob): Promise<Trip> {
  if (file.size > MAX_BACKUP_BYTES)
    throw new Error("Копия должна быть не больше 128 МБ.");
  const parsed = backupSchema.safeParse(JSON.parse(await file.text()));
  if (!parsed.success) throw new Error("Неверный формат резервной копии.");
  const source = parseTrip(parsed.data.trip);
  const trip = importTrip(exportTrip(source));
  const eventIds = new Map(
    source.events.map((event, index) => [event.id, trip.events[index].id]),
  );
  const memberIds = new Map(
    source.members.map((member, index) => [member.id, trip.members[index].id]),
  );
  const documents: StoredDocument[] = [];
  const ids = new Set<string>();
  for (const doc of parsed.data.documents) {
    validateDocument(doc);
    if (
      ids.has(doc.id) ||
      doc.eventIds.some((id) => !eventIds.has(id)) ||
      doc.people?.some((person) => !memberIds.has(person.memberId))
    )
      throw new Error("Некорректные связи документов.");
    ids.add(doc.id);
    if (
      doc.data.length !== 4 * Math.ceil(doc.size / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(doc.data)
    )
      throw new Error("Повреждено содержимое документа.");
    const bytes = Uint8Array.from(atob(doc.data), (c) => c.charCodeAt(0));
    if (bytes.length !== doc.size || (await digest(bytes)) !== doc.sha256)
      throw new Error("Проверка целостности документа не пройдена.");
    const links = [...new Set(doc.eventIds.map((id) => eventIds.get(id)!))];
    documents.push({
      id: crypto.randomUUID(),
      tripId: trip.id,
      name: doc.name,
      type: doc.type,
      size: doc.size,
      blob: new Blob([bytes], { type: doc.type }),
      fingerprint: doc.sha256,
      eventIds: links,
      ...(doc.people
        ? {
            people: doc.people.map((person) => ({
              ...person,
              memberId: memberIds.get(person.memberId)!,
            })),
          }
        : {}),
      ...(links.length ? { eventId: links[0] } : {}),
      ...(doc.result
        ? {
            recognition: {
              status: "needs_review",
              attemptId: crypto.randomUUID(),
              message:
                "Восстановлено из копии. Проверьте распознанные данные перед повторным добавлением.",
              result: doc.result,
            } as const,
          }
        : {}),
    });
  }
  await restoreTripCopy(trip, documents);
  return trip;
}
